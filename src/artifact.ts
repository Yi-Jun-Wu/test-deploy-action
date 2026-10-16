/**
 * A dependency-free re-implementation of the GitHub Actions artifact upload
 * protocol (the code path behind `@actions/artifact`'s `uploadArtifact`).
 *
 * The wire protocol, reverse engineered from `@actions/artifact@6.3.1`:
 *
 *   1. `ACTIONS_RUNTIME_TOKEN` is a JWT whose `scp` claim carries the scope
 *      `Actions.Results:<workflowRunBackendId>:<workflowJobRunBackendId>`.
 *   2. `POST {ACTIONS_RESULTS_URL}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`
 *      (JSON, `Authorization: Bearer <token>`) -> `{ ok, signed_upload_url }`.
 *      The request declares `version: 7` and the artifact `mime_type`.
 *   3. The artifact payload is uploaded to `signed_upload_url`, which is an Azure
 *      Blob Storage SAS URL for a block blob. Uploads always go through
 *      "Put Block" (`?comp=block&blockid=<base64>`) followed by
 *      "Put Block List" (`?comp=blocklist`), never a single "Put Blob".
 *   4. `POST .../FinalizeArtifact` with `size` and `hash: "sha256:<hex>"` ->
 *      `{ ok, artifact_id }`.
 *
 * Artifacts are always zipped, matching the toolkit's default (`skipArchive`
 * is not implemented), and paths inside the archive are relative to
 * `rootDirectory`.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const TWIRP_SERVICE = "github.actions.results.api.v1.ArtifactService";

/** Artifact format version understood by the results service. */
const ARTIFACT_VERSION = 7;

/** Artifact payload is always a zip. */
const ARTIFACT_CONTENT_TYPE = "application/zip";

/** Block size for the Azure block blob upload (matches the toolkit's chunk size). */
const BLOCK_SIZE = 8 * 1024 * 1024;

const USER_AGENT = "actions-artifact-upload/1.0";

/** Fallback `x-ms-version` when the SAS URL does not advertise one. */
const DEFAULT_BLOB_SERVICE_VERSION = "2021-08-06";

const MAX_ATTEMPTS = 5;
const BASE_RETRY_INTERVAL_MS = 8000;
const RETRY_MULTIPLIER = 1.5;
const RETRY_TIMEOUT_MS = 120000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "EPIPE",
]);

const INVALID_ARTIFACT_NAME_CHARACTERS = [
  '"',
  ":",
  "<",
  ">",
  "|",
  "*",
  "?",
  "\r",
  "\n",
  "\\",
  "/",
];

const INVALID_FILE_PATH_CHARACTERS = INVALID_ARTIFACT_NAME_CHARACTERS.filter(
  (character) => character !== "\\" && character !== "/",
);

export interface UploadArtifactOptions {
  /** Days to keep the artifact. Capped by the repository retention setting. */
  retentionDays?: number;
}

export interface UploadArtifactResponse {
  /** The id assigned to the artifact by the service. */
  id: number;
  /** Number of bytes uploaded. */
  size: number;
  /** `sha256:<hex>` digest of the uploaded archive. */
  digest: string;
}

interface BackendIds {
  workflowRunBackendId: string;
  workflowJobRunBackendId: string;
}

interface CreateArtifactResponse {
  ok: boolean;
  signed_upload_url: string;
}

interface FinalizeArtifactResponse {
  ok: boolean;
  artifact_id: string;
}

interface ZipEntry {
  /** Path inside the archive, always `/`-separated and relative. */
  name: string;
  data: Buffer;
  /** Modification time, used for the DOS timestamps in the zip headers. */
  mtime: Date;
}

/**
 * Uploads a single file (or a list of files) as a GitHub Actions artifact.
 *
 * @param name artifact name
 * @param files files to upload; every path must live under `rootDirectory`
 * @param rootDirectory common parent directory trimmed from the archive paths
 */
export async function uploadArtifact(
  name: string,
  files: string[],
  rootDirectory: string,
  options: UploadArtifactOptions = {},
): Promise<UploadArtifactResponse> {
  validateArtifactName(name);

  const entries = await collectZipEntries(files, rootDirectory);
  if (entries.length === 0) {
    throw new Error("No files were found to upload");
  }

  const archive = createZip(entries);
  const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;

  const token = getRuntimeToken();
  const resultsServiceOrigin = getResultsServiceUrl();
  const backendIds = getBackendIdsFromToken(token);

  const expiresAt = getExpiration(options.retentionDays);

  log(`Uploading artifact: ${name}.zip (${archive.length} bytes)`);

  const createArtifactResp = await withRetry(
    "CreateArtifact",
    () =>
      twirpRequest<CreateArtifactResponse>(
        token,
        resultsServiceOrigin,
        "CreateArtifact",
        {
          workflow_run_backend_id: backendIds.workflowRunBackendId,
          workflow_job_run_backend_id: backendIds.workflowJobRunBackendId,
          name,
          version: ARTIFACT_VERSION,
          mime_type: ARTIFACT_CONTENT_TYPE,
          ...(expiresAt ? { expires_at: expiresAt } : {}),
        },
      ),
  );

  if (!createArtifactResp.ok) {
    throw new Error("CreateArtifact: response from backend was not ok");
  }

  await withRetry("blob upload", () =>
    uploadToBlobStorage(
      createArtifactResp.signed_upload_url,
      archive,
      ARTIFACT_CONTENT_TYPE,
    ));

  log(`Finalizing artifact upload`);

  const finalizeArtifactResp = await withRetry(
    "FinalizeArtifact",
    () =>
      twirpRequest<FinalizeArtifactResponse>(
        token,
        resultsServiceOrigin,
        "FinalizeArtifact",
        {
          workflow_run_backend_id: backendIds.workflowRunBackendId,
          workflow_job_run_backend_id: backendIds.workflowJobRunBackendId,
          name,
          size: String(archive.length),
          hash: digest,
        },
      ),
  );

  if (!finalizeArtifactResp.ok) {
    throw new Error("FinalizeArtifact: response from backend was not ok");
  }

  const artifactId = Number(finalizeArtifactResp.artifact_id);
  log(`Artifact ${name} successfully finalized. Artifact ID ${artifactId}`);

  return { id: artifactId, size: archive.length, digest };
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

function getRuntimeToken(): string {
  const token = process.env["ACTIONS_RUNTIME_TOKEN"];
  if (!token) {
    throw new Error("Unable to get the ACTIONS_RUNTIME_TOKEN env variable");
  }
  return token;
}

function getResultsServiceUrl(): string {
  const resultsUrl = process.env["ACTIONS_RESULTS_URL"];
  if (!resultsUrl) {
    throw new Error("Unable to get the ACTIONS_RESULTS_URL env variable");
  }
  return new URL(resultsUrl).origin;
}

function log(message: string): void {
  console.log(message);
}

/* -------------------------------------------------------------------------- */
/* Authentication                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Extracts the workflow run / job run backend ids from the runtime token.
 *
 * The `scp` claim looks like:
 * `Actions.ExampleScope Actions.Results:<runId>:<jobRunId>`
 */
function getBackendIdsFromToken(token: string): BackendIds {
  const claims = decodeJwtPayload(token);

  const scp = claims["scp"];
  if (typeof scp !== "string" || scp.length === 0) {
    throw invalidJwtError();
  }

  for (const scope of scp.split(" ")) {
    const parts = scope.split(":");
    if (parts[0] !== "Actions.Results") {
      continue;
    }
    if (parts.length !== 3) {
      throw invalidJwtError();
    }
    return {
      workflowRunBackendId: parts[1],
      workflowJobRunBackendId: parts[2],
    };
  }

  throw invalidJwtError();
}

function invalidJwtError(): Error {
  return new Error(
    "Failed to get backend IDs: The provided JWT token is invalid and/or missing claims",
  );
}

/** Decodes the payload of a JWT. The signature is not (and cannot be) verified. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw invalidJwtError();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    );
  } catch {
    throw invalidJwtError();
  }

  if (typeof payload !== "object" || payload === null) {
    throw invalidJwtError();
  }
  return payload as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Twirp service calls                                                        */
/* -------------------------------------------------------------------------- */

async function twirpRequest<T>(
  token: string,
  resultsServiceOrigin: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const url = `${resultsServiceOrigin}/twirp/${TWIRP_SERVICE}/${method}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(payload),
  });

  const rawBody = await response.text();

  if (!response.ok) {
    if (rawBody.includes("insufficient usage")) {
      throw new Error(
        "Artifact storage quota has been hit. Unable to upload any new artifacts.",
      );
    }
    const detail = parseTwirpError(rawBody);
    throw new HttpError(
      response.status,
      response.statusText,
      detail ? `${detail}` : rawBody,
      getRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }

  return JSON.parse(rawBody) as T;
}

function parseTwirpError(rawBody: string): string | undefined {
  try {
    const body: unknown = JSON.parse(rawBody);
    if (typeof body === "object" && body !== null && "msg" in body) {
      const { msg } = body as { msg?: unknown };
      return typeof msg === "string" ? msg : undefined;
    }
  } catch {
    // fall through, the raw body is reported as-is
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Azure Blob Storage upload (block blob)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Uploads the payload with the Azure block blob protocol: every chunk is
 * staged with "Put Block", then all chunks are committed with "Put Block List".
 * The SAS signature covers only the resource and the signed query parameters,
 * so `comp` / `blockid` can be appended without invalidating it.
 */
async function uploadToBlobStorage(
  signedUploadUrl: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const serviceVersion = new URL(signedUploadUrl).searchParams.get("sv") ??
    DEFAULT_BLOB_SERVICE_VERSION;
  const blockIdPrefix = randomUUID();
  const blockIds: string[] = [];

  for (
    let index = 0, offset = 0;
    offset < body.length;
    index++, offset += BLOCK_SIZE
  ) {
    const chunk = body.subarray(
      offset,
      Math.min(offset + BLOCK_SIZE, body.length),
    );
    // Block ids must be base64 encoded and identical in length across a blob.
    const blockId = Buffer.from(
      `${blockIdPrefix}-${String(index).padStart(6, "0")}`,
    ).toString("base64");

    await putBlock(signedUploadUrl, blockId, chunk, serviceVersion);
    blockIds.push(blockId);
    log(`Uploaded bytes ${Math.min(offset + BLOCK_SIZE, body.length)}`);
  }

  await putBlockList(signedUploadUrl, blockIds, contentType, serviceVersion);
}

async function putBlock(
  signedUploadUrl: string,
  blockId: string,
  chunk: Buffer,
  serviceVersion: string,
): Promise<void> {
  const url = appendQuery(signedUploadUrl, [
    "comp=block",
    `blockid=${encodeURIComponent(blockId)}`,
  ]);

  await expectCreated(
    "Put Block",
    url,
    {
      "x-ms-version": serviceVersion,
      "x-ms-date": httpDate(),
      "Content-Type": "application/octet-stream",
    },
    chunk,
  );
}

async function putBlockList(
  signedUploadUrl: string,
  blockIds: string[],
  contentType: string,
  serviceVersion: string,
): Promise<void> {
  const xml = `<BlockList>${
    blockIds
      .map((blockId) => `<Latest>${blockId}</Latest>`)
      .join("")
  }</BlockList>`;

  await expectCreated(
    "Put Block List",
    appendQuery(signedUploadUrl, ["comp=blocklist"]),
    {
      "x-ms-version": serviceVersion,
      "x-ms-date": httpDate(),
      "Content-Type": "application/xml; charset=utf-8",
      "x-ms-blob-content-type": contentType,
    },
    Buffer.from(xml, "utf8"),
  );
}

async function expectCreated(
  operation: string,
  url: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<void> {
  const response = await fetch(url, { method: "PUT", headers, body });

  if (response.status !== 201) {
    const rawBody = await response.text();
    throw new HttpError(
      response.status,
      response.statusText,
      `${operation} failed: ${rawBody}`,
      getRetryAfterSeconds(response.headers.get("retry-after")),
    );
  }
}

/**
 * Appends query parameters without re-serializing the existing ones, so the
 * SAS signature parameters are passed through byte for byte.
 */
function appendQuery(url: string, parameters: string[]): string {
  const parsed = new URL(url);
  const query = [parsed.search.replace(/^\?/, ""), ...parameters]
    .filter((part) => part.length > 0)
    .join("&");
  parsed.search = query;
  return parsed.toString();
}

function httpDate(): string {
  return new Date().toUTCString();
}

/* -------------------------------------------------------------------------- */
/* Retry                                                                      */
/* -------------------------------------------------------------------------- */

class HttpError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    statusText: string,
    detail: string,
    retryAfterSeconds?: number,
  ) {
    super(`(${status}) ${statusText}: ${detail}`);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return RETRYABLE_STATUS_CODES.has(error.status);
  }
  const code = (error as { code?: string } | undefined)?.code ??
    (error as { cause?: { code?: string } } | undefined)?.cause?.code;
  return typeof code === "string" && NETWORK_ERROR_CODES.has(code);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message
      ? `${error.message}: ${cause.message}`
      : error.message;
  }
  return String(error);
}

async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  let totalRetryWaitMs = 0;

  for (let attempt = 0;; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error)) {
        throw error;
      }

      const message = errorMessage(error);
      if (attempt + 1 === MAX_ATTEMPTS) {
        throw new Error(
          `Failed to ${operation} after ${MAX_ATTEMPTS} attempts: ${message}`,
        );
      }

      const retryAfterSeconds = error instanceof HttpError
        ? error.retryAfterSeconds
        : undefined;
      const retryWaitMs = retryAfterSeconds !== undefined
        ? retryAfterSeconds * 1000
        : getExponentialRetryTimeMs(attempt);

      if (totalRetryWaitMs + retryWaitMs > RETRY_TIMEOUT_MS) {
        throw new Error(
          `Retry wait of ${retryWaitMs} ms would exceed the maximum total retry wait of ${RETRY_TIMEOUT_MS} ms: ${message}`,
        );
      }

      log(
        `Attempt ${
          attempt + 1
        } of ${MAX_ATTEMPTS} failed with error: ${message}. Retrying ${operation} in ${retryWaitMs} ms...`,
      );
      await sleep(retryWaitMs);
      totalRetryWaitMs += retryWaitMs;
    }
  }
}

function getExponentialRetryTimeMs(attempt: number): number {
  if (attempt === 0) {
    return BASE_RETRY_INTERVAL_MS;
  }
  const min = BASE_RETRY_INTERVAL_MS * RETRY_MULTIPLIER ** attempt;
  const max = min * RETRY_MULTIPLIER;
  return Math.trunc(Math.random() * (max - min) + min);
}

function getRetryAfterSeconds(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  const value = header.trim();
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* Input collection and validation                                           */
/* -------------------------------------------------------------------------- */

async function collectZipEntries(
  files: string[],
  rootDirectory: string,
): Promise<ZipEntry[]> {
  const root = path.resolve(rootDirectory);
  const rootStats = await stat(root).catch(() => undefined);
  if (!rootStats) {
    throw new Error(
      `The provided rootDirectory ${rootDirectory} does not exist`,
    );
  }
  if (!rootStats.isDirectory()) {
    throw new Error(
      `The provided rootDirectory ${rootDirectory} is not a valid directory`,
    );
  }

  const entries: ZipEntry[] = [];

  for (const file of files) {
    const stats = await lstat(file, { throwIfNoEntry: false });
    if (!stats) {
      throw new Error(`File ${file} does not exist`);
    }
    if (stats.isDirectory()) {
      throw new Error(
        `File ${file} is a directory, only files can be uploaded`,
      );
    }

    const absolute = path.resolve(file);
    if (!absolute.startsWith(root)) {
      throw new Error(
        `The rootDirectory: ${root} is not a parent directory of the file: ${absolute}`,
      );
    }

    const archivePath = path
      .relative(root, absolute)
      .split(path.sep)
      .join("/");
    if (archivePath.length === 0) {
      throw new Error(
        `The file: ${absolute} is the rootDirectory and cannot be uploaded`,
      );
    }
    validateFilePath(archivePath);

    // Follow symlinks, like the toolkit does.
    const source = stats.isSymbolicLink() ? await realpath(absolute) : absolute;
    const sourceStats = await stat(source);

    entries.push({
      name: archivePath,
      data: await readFile(source),
      mtime: sourceStats.mtime,
    });
  }

  return entries;
}

function validateArtifactName(name: string): void {
  if (!name) {
    throw new Error("Provided artifact name input during validation is empty");
  }

  for (const character of INVALID_ARTIFACT_NAME_CHARACTERS) {
    if (name.includes(character)) {
      throw new Error(
        `The artifact name is not valid: ${name}. Contains the following character: ${character}`,
      );
    }
  }
}

function validateFilePath(archivePath: string): void {
  for (const character of INVALID_FILE_PATH_CHARACTERS) {
    if (archivePath.includes(character)) {
      throw new Error(
        `The path for one of the files in artifact is not valid: ${archivePath}. Contains the following character: ${character}`,
      );
    }
  }
}

/** Retention expiry as an RFC 3339 timestamp, capped by the repo's maximum. */
function getExpiration(retentionDays?: number): string | undefined {
  if (!retentionDays) {
    return undefined;
  }

  let days = retentionDays;
  const maxRetentionDays = getRepositoryRetentionDays();
  if (maxRetentionDays !== undefined && maxRetentionDays < days) {
    log(
      `Retention days cannot be greater than the maximum allowed retention set within the repository. Using ${maxRetentionDays} instead.`,
    );
    days = maxRetentionDays;
  }

  const expirationDate = new Date();
  expirationDate.setDate(expirationDate.getDate() + days);
  return expirationDate.toISOString();
}

function getRepositoryRetentionDays(): number | undefined {
  const retentionDays = process.env["GITHUB_RETENTION_DAYS"];
  if (!retentionDays) {
    return undefined;
  }
  const days = Number.parseInt(retentionDays, 10);
  return Number.isNaN(days) ? undefined : days;
}

/* -------------------------------------------------------------------------- */
/* Minimal zip writer                                                         */
/* -------------------------------------------------------------------------- */

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

/** Compression level used by the toolkit (`DEFAULT_COMPRESSION_LEVEL`). */
const COMPRESSION_LEVEL = 6;

/**
 * Builds a zip archive from memory. Uses raw deflate, falling back to stored
 * entries when compression does not pay off.
 */
function createZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const deflated = deflateRawSync(entry.data, { level: COMPRESSION_LEVEL });
    const compressed = deflated.length < entry.data.length;
    const payload = compressed ? deflated : entry.data;
    const method = compressed ? 8 : 0;
    const crc = crc32(entry.data);
    const { dosDate, dosTime } = toDosDateTime(entry.mtime);

    // Flags bit 11 marks the name (and comment) as UTF-8.
    const flags = 0x0800;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_HEADER_SIGNATURE, 0);
    centralHeader.writeUInt16LE(0x031e, 4); // version made by: unix, zip 3.0
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    // external attributes: unix mode 0644 for a regular file
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    parts.push(localHeader, nameBuffer, payload);
    centralDirectory.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + payload.length;
  }

  const centralDirectoryBuffer = Buffer.concat(centralDirectory);

  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4); // number of this disk
  endOfCentralDirectory.writeUInt16LE(0, 6); // disk with the central directory
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryBuffer.length, 12);
  endOfCentralDirectory.writeUInt32LE(offset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([
    ...parts,
    centralDirectoryBuffer,
    endOfCentralDirectory,
  ]);
}

/** Converts a date into the MS-DOS date/time pair used by zip headers. */
function toDosDateTime(date: Date): { dosDate: number; dosTime: number } {
  const year = date.getFullYear();
  // The MS-DOS epoch starts in 1980, earlier years are clamped.
  const dosYear = year < 1980 ? 0 : year - 1980;
  return {
    dosDate: (dosYear << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    dosTime: (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      (date.getSeconds() >> 1),
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
