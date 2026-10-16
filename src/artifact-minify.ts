/**
 * A trimmed-down, dependency-free implementation of the GitHub Actions
 * artifact protocol (the same wire protocol as `./artifact.ts`, but without
 * zip creation, validation or retry logic).
 *
 * The uploaded file is sent as-is: callers must provide an already-archived
 * file (e.g. a zip) when the deployment target requires one. The complete flow
 * for a single artifact is:
 *
 *   1. `CreateArtifact` -> `{ signed_upload_url }` (Azure Blob SAS URL).
 *   2. Upload the file bytes to the SAS URL as an Azure block blob
 *      ("Put Block" per chunk, then "Put Block List").
 *   3. `FinalizeArtifact` with the byte size and `sha256:<hex>` digest ->
 *      `{ artifact_id }`.
 *
 * Deletion is also supported, either by resolving an artifact name
 * (`deleteArtifact`) or by targeting a known backend id directly
 * (`deleteSpecificArtifact`).
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * MIME types accepted by the artifact service for `CreateArtifact`.
 *
 * @see {@link MimeType}
 */
export const VALID_MIME_TYPE = [
  "application/gzip",
  "application/javascript",
  "application/json",
  "application/msword",
  "application/octet-stream",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.ms-fontobject",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.rar",
  "application/wasm",
  "application/xml",
  "application/zip",
  "audio/flac",
  "audio/mpeg",
  "audio/ogg",
  "font/otf",
  "font/ttf",
  "font/woff",
  "font/woff2",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/webp",
  "text/css",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/xml",
  "video/mp4",
  "video/quicktime",
] as const;

/** A MIME type that the artifact service accepts. */
export type MimeType = typeof VALID_MIME_TYPE[number];

/** Tunables shared by every operation in this module. */
export interface UploadConfig {
  /** Origin (scheme + host) of the results service, e.g. `ACTIONS_RESULTS_URL`. */
  result_url_origin: string;
  /** Twirp service path segment, e.g. `github.actions.results.api.v1.ArtifactService`. */
  twirp_service: string;
  /** Artifact format version understood by the service (currently `7`). */
  artifact_version: number;
  /** Azure block blob chunk size in bytes; must stay constant within a blob. */
  block_size: number;
  /** Declared MIME type of the uploaded payload. */
  mime_type: MimeType;
  /** Artifact lifetime in seconds; converted to an RFC 3339 expiry timestamp. */
  retention_seconds: number;
}

/**
 * Backend identifiers used to address a specific artifact, or a runtime token
 * from which those identifiers can be derived.
 *
 * All fields are optional: when the two backend ids are both supplied they are
 * used directly; otherwise they are resolved from `actions_runtime_token`.
 */
export interface SpecificBackendIdOrToken {
  /** Runtime token whose `scp` claim carries the backend ids. */
  actions_runtime_token?: string;
  /** Backend id of the workflow run that owns the artifact. */
  workflow_run_backend_id?: string;
  /** Backend id of the workflow job run that owns the artifact. */
  workflow_job_run_backend_id?: string;
}

/** Default configuration, matching the production results service. */
const DEFAULT = {
  result_url_origin: "https://results-receiver.actions.githubusercontent.com/",
  twirp_service: "github.actions.results.api.v1.ArtifactService",
  artifact_version: 7,
  block_size: 8 * 1024 * 1024, // 8 kB
  mime_type: "application/octet-stream", // keep-as-it-is
  retention_seconds: 7 * 86400, // 7 days
} as const satisfies UploadConfig;

/**
 * Uploads a single file as a workflow artifact.
 *
 * The file is read from disk and uploaded byte-for-byte; it is **not** zipped.
 * When the deployment target expects an archive, compress it beforehand.
 *
 * @param actions_runtime_token - Runtime token (`ACTIONS_RUNTIME_TOKEN`); its
 * `scp` claim supplies the run/job backend ids and it authenticates the calls.
 * @param file_path - Path of the file to upload.
 * @param upload_name - Artifact name; defaults to the file's basename.
 * @param config - Optional overrides for the default {@link UploadConfig}.
 * @returns The numeric artifact id assigned by the service.
 */
export async function uploadArtifact(
  actions_runtime_token: string,
  file_path: string,
  upload_name?: string,
  config?: Partial<UploadConfig>,
): Promise<number> {
  const name = upload_name ?? basename(file_path);
  const CONFIG: UploadConfig = {
    result_url_origin: config?.result_url_origin || DEFAULT.result_url_origin,
    twirp_service: config?.twirp_service || DEFAULT.twirp_service,
    artifact_version: config?.artifact_version || DEFAULT.artifact_version,
    block_size: config?.block_size || DEFAULT.block_size,
    mime_type: config?.mime_type || DEFAULT.mime_type,
    retention_seconds: config?.retention_seconds || DEFAULT.retention_seconds,
  };

  const archive = await readFile(file_path);
  const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  const twirpUrl = `${
    new URL(CONFIG.result_url_origin).origin
  }/twirp/${CONFIG.twirp_service}`;
  const [workflowRunBackendId, workflowJobRunBackendId] =
    getBackendIdsFromToken(actions_runtime_token);
  const expiration = (new Date(Date.now() + CONFIG.retention_seconds * 1000))
    .toISOString();

  const created = await twirp(
    twirpUrl,
    actions_runtime_token,
    "CreateArtifact",
    {
      workflow_run_backend_id: workflowRunBackendId,
      workflow_job_run_backend_id: workflowJobRunBackendId,
      name,
      version: CONFIG.artifact_version,
      mime_type: CONFIG.mime_type,
      expires_at: expiration,
    },
  );

  await uploadToBlob(created.signed_upload_url, archive, CONFIG);

  const finalized = await twirp(
    twirpUrl,
    actions_runtime_token,
    "FinalizeArtifact",
    {
      workflow_run_backend_id: workflowRunBackendId,
      workflow_job_run_backend_id: workflowJobRunBackendId,
      name,
      size: String(archive.length),
      hash: digest,
    },
  );

  return Number(finalized.artifact_id);
}

/**
 * Extracts the workflow run / job run backend ids from a runtime token.
 *
 * Reads the (unverified) `scp` claim and returns the pair encoded in the
 * `Actions.Results:<runId>:<jobRunId>` scope.
 *
 * @param token - Runtime JWT (`ACTIONS_RUNTIME_TOKEN`).
 * @returns `[workflowRunBackendId, workflowJobRunBackendId]`.
 * @throws If the token has no valid `Actions.Results` scope.
 */
function getBackendIdsFromToken(token: string): [string, string] {
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
  for (const scope of String(payload["scp"]).split(" ")) {
    const parts = scope.split(":");
    if (parts[0] === "Actions.Results") {
      return [parts[1], parts[2]];
    }
  }
  throw new Error("Invalid token: missing Actions.Results scope");
}

/**
 * Invokes a Twirp method on the artifact service with a JSON body.
 *
 * @typeParam T - Expected shape of the JSON response.
 * @param twirpUrl - Base URL, i.e. `{origin}/twirp/{service}`.
 * @param token - Bearer token used for authorization.
 * @param method - Twirp method name, e.g. `CreateArtifact`.
 * @param body - JSON-serializable request body.
 * @returns The parsed JSON response.
 * @throws If the HTTP response status is not ok.
 */
async function twirp(
  twirpUrl: string,
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(`${twirpUrl}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `${method} failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.json();
}

/**
 * Uploads `body` to an Azure Blob Storage SAS URL using the block blob
 * protocol: each chunk is staged with "Put Block" and then all chunks are
 * committed with "Put Block List".
 *
 * The SAS signature covers only the resource and the signed query parameters,
 * so `comp` / `blockid` can be appended without invalidating it.
 *
 * @param signedUrl - SAS URL returned by `CreateArtifact`.
 * @param body - Complete payload to upload.
 * @param CONFIG - Configuration supplying the block size and content type.
 * @throws If any block upload or the block list commit does not return 201.
 */
async function uploadToBlob(
  signedUrl: string,
  body: Buffer,
  CONFIG: UploadConfig,
): Promise<void> {
  const version = new URL(signedUrl).searchParams.get("sv") ?? "2021-08-06";
  const prefix = randomUUID();
  const blockIds: string[] = [];

  for (
    let i = 0, offset = 0;
    offset < body.length;
    i++, offset += CONFIG.block_size
  ) {
    const chunk = body.subarray(
      offset,
      Math.min(offset + CONFIG.block_size, body.length),
    );
    const blockId = Buffer.from(`${prefix}-${String(i).padStart(6, "0")}`)
      .toString("base64");
    const response = await fetch(
      appendQuery(signedUrl, [
        "comp=block",
        `blockid=${encodeURIComponent(blockId)}`,
      ]),
      {
        method: "PUT",
        headers: {
          "x-ms-version": version,
          "x-ms-date": new Date().toUTCString(),
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(chunk),
      },
    );
    if (response.status !== 201) {
      throw new Error(
        `Put Block failed (${response.status}): ${await response.text()}`,
      );
    }
    blockIds.push(blockId);
  }

  const xml = `<BlockList>${
    blockIds.map((id) => `<Latest>${id}</Latest>`).join("")
  }</BlockList>`;
  const response = await fetch(appendQuery(signedUrl, ["comp=blocklist"]), {
    method: "PUT",
    headers: {
      "x-ms-version": version,
      "x-ms-date": new Date().toUTCString(),
      "Content-Type": "application/xml; charset=utf-8",
      "x-ms-blob-content-type": CONFIG.mime_type,
    },
    body: Buffer.from(xml, "utf8"),
  });
  if (response.status !== 201) {
    throw new Error(
      `Put Block List failed (${response.status}): ${await response.text()}`,
    );
  }
}

/**
 * Appends query parameters to a URL without re-serializing the existing ones,
 * so the SAS signature parameters are passed through byte for byte.
 *
 * @param url - URL to extend.
 * @param parameters - Already-encoded `key=value` fragments to append.
 * @returns The URL with the extra parameters.
 */
function appendQuery(url: string, parameters: string[]): string {
  const parsed = new URL(url);
  parsed.search = [parsed.search.replace(/^\?/, ""), ...parameters]
    .filter((part) => part.length > 0)
    .join("&");
  return parsed.toString();
}

/**
 * Deletes an artifact, resolving its name to a specific artifact first.
 *
 * `ListArtifacts` is called with a `name_filter`; when several artifacts share
 * the name the newest one (highest `database_id`) is chosen. `DeleteArtifact`
 * is then keyed by the backend ids **reported by the artifact itself**, which
 * may differ from the caller's run/job.
 *
 * @param actions_runtime_token - Runtime token; supplies the caller's backend
 * ids for the listing and authenticates both calls.
 * @param name - Name of the artifact to delete.
 * @param config - Optional overrides for the default {@link UploadConfig}.
 * @returns The numeric id of the deleted artifact.
 * @throws If no artifact matches `name`.
 */
export async function deleteArtifact(
  actions_runtime_token: string,
  name: string,
  config?: Partial<UploadConfig>,
): Promise<number> {
  const CONFIG: UploadConfig = {
    ...DEFAULT,
    ...config,
  };

  const twirpUrl = `${
    new URL(CONFIG.result_url_origin).origin
  }/twirp/${CONFIG.twirp_service}`;
  const [workflowRunBackendId, workflowJobRunBackendId] =
    getBackendIdsFromToken(actions_runtime_token);

  const listed = await twirp(
    twirpUrl,
    actions_runtime_token,
    "ListArtifacts",
    {
      workflow_run_backend_id: workflowRunBackendId,
      workflow_job_run_backend_id: workflowJobRunBackendId,
      name_filter: name,
    },
  );

  const artifacts: any[] = listed.artifacts ?? [];
  if (artifacts.length === 0) {
    throw new Error(`Artifact not found for name: ${name}`);
  }

  const artifact = artifacts.length > 1
    ? [...artifacts].sort(
      (a, b) => Number(b.database_id) - Number(a.database_id),
    )[0]
    : artifacts[0];

  const deleted = await twirp(
    twirpUrl,
    actions_runtime_token,
    "DeleteArtifact",
    {
      workflow_run_backend_id: artifact.workflow_run_backend_id,
      workflow_job_run_backend_id: artifact.workflow_job_run_backend_id,
      name: artifact.name,
    },
  );

  return Number(deleted.artifact_id);
}

/**
 * Deletes an artifact addressed by explicit backend ids, without listing or
 * filtering.
 *
 * By default the artifact is assumed to belong to the caller's own run/job,
 * whose backend ids are derived from `actions_runtime_token`. Supplying
 * `workflow_run_backend_id` and `workflow_job_run_backend_id` in `config`
 * targets another backend instead; `config.actions_runtime_token` can override
 * the token used to derive the ids.
 *
 * @param actions_runtime_token - Runtime token used to authenticate the call.
 * @param name - Name of the artifact to delete.
 * @param config - Optional backend ids / token and {@link UploadConfig} overrides.
 * @returns The numeric id of the deleted artifact.
 */
export async function deleteSpecificArtifact(
  actions_runtime_token: string,
  name: string,
  config?: Partial<UploadConfig & SpecificBackendIdOrToken>,
): Promise<number> {
  const CONFIG: UploadConfig = {
    ...DEFAULT,
    ...config,
  };

  // 如果提供了独立的 backend_id, 使用独立的 id 代替默认 id
  let workflow_run_backend_id = config?.workflow_run_backend_id;
  let workflow_job_run_backend_id = config?.workflow_job_run_backend_id;
  if (!workflow_run_backend_id || !workflow_job_run_backend_id) {
    // 如果独立 id 不完整, 先尝试从提供的 token 中获取, 否则采用默认的 token
    [workflow_run_backend_id, workflow_job_run_backend_id] =
      getBackendIdsFromToken(
        config?.actions_runtime_token ?? actions_runtime_token,
      );
  }

  const twirpUrl = `${
    new URL(CONFIG.result_url_origin).origin
  }/twirp/${CONFIG.twirp_service}`;

  const deleted = await twirp(
    twirpUrl,
    actions_runtime_token,
    "DeleteArtifact",
    {
      workflow_run_backend_id,
      workflow_job_run_backend_id,
      name,
    },
  );

  return Number(deleted.artifact_id);
}
