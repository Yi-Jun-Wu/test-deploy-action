import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

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
export type MimeType = typeof VALID_MIME_TYPE[number];

export interface UploadConfig {
  result_url_origin: string;
  twirp_service: string;
  artifact_version: number;
  block_size: number;
  mime_type: MimeType;
  retention_seconds: number;
}

export interface SpecificBackendIdOrToken {
  actions_runtime_token?: string;
  workflow_run_backend_id?: string;
  workflow_job_run_backend_id?: string;
}

const DEFAULT = {
  result_url_origin: "https://results-receiver.actions.githubusercontent.com/",
  twirp_service: "github.actions.results.api.v1.ArtifactService",
  artifact_version: 7,
  block_size: 8 * 1024 * 1024, // 8 kB
  mime_type: "application/octet-stream", // keep-as-it-is
  retention_seconds: 7 * 86400, // 7 days
} as const satisfies UploadConfig;

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

function appendQuery(url: string, parameters: string[]): string {
  const parsed = new URL(url);
  parsed.search = [parsed.search.replace(/^\?/, ""), ...parameters]
    .filter((part) => part.length > 0)
    .join("&");
  return parsed.toString();
}

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
      getBackendIdsFromToken(config?.actions_runtime_token ?? actions_runtime_token);
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
