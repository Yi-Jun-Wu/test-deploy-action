/**
 * A small, dependency-free subset of the GitHub Actions toolkit
 * (`@actions/core`), covering the functions that are commonly needed from a
 * workflow step: reading inputs and environment, writing outputs, emitting
 * workflow commands (annotations, masking, groups) and requesting OIDC ID
 * tokens.
 *
 * Every function is a straight re-implementation of the documented behavior;
 * no external runtime dependency is required.
 */

import { appendFileSync } from "fs";
import { EOL } from "os";

/** Options accepted by {@link getInput} (and {@link getBooleanInput}). */
export interface InputOptions {
  /** When `true`, an empty input throws instead of returning `""`. */
  required?: boolean;
  /** When `false`, leading/trailing whitespace is preserved. Defaults to `true`. */
  trimWhitespace?: boolean;
}

/**
 * Performs an authenticated `GET` request and decodes the JSON body.
 *
 * The bearer token is taken from the `ACTIONS_ID_TOKEN_REQUEST_TOKEN` runtime
 * environment variable, which the runner injects for workflows that request an
 * OIDC token. When `ACTIONS_ORCHESTRATION_ID` is set it is appended (sanitized)
 * to the `User-Agent` header so requests can be correlated.
 *
 * @typeParam JsonData - Expected shape of the decoded response body.
 * @param url - Absolute URL to request.
 * @param headers - Extra headers to merge into the request.
 * @param userAgent - Base value for the `User-Agent` header.
 * @returns The parsed JSON body.
 * @throws If the token is missing or the response status is not ok.
 */
export async function getHttpRequest<JsonData = any>(
  url: string,
  headers: Record<string, string> = {},
  userAgent?: string,
): Promise<JsonData> {
  // Build the request headers
  const token = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (!token) {
    throw new Error(
      "Unable to get ACTIONS_ID_TOKEN_REQUEST_TOKEN env variable",
    );
  }
  headers["Authorization"] = `Bearer ${token}`;

  // Set the User-Agent header, including the orchestration ID if available
  userAgent ||= "actions/http-client";
  const orchId = process.env["ACTIONS_ORCHESTRATION_ID"];
  if (orchId) {
    // Sanitize the orchestration ID to ensure it contains only valid characters
    // Valid characters: 0-9, a-z, _, -, .
    const sanitizedId = orchId.replace(/[^a-z0-9_.-]/gi, "_");
    userAgent += ` actions_orchestration_id/${sanitizedId}`;
  }
  headers["User-Agent"] = userAgent;

  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    throw new Error(`Request ${url} error! Status: ${response.status}`);
  }
  return await response.json();
}

/**
 * Requests a GitHub Actions OIDC ID token for the given audience.
 *
 * The token is read from the endpoint advertised in
 * `ACTIONS_ID_TOKEN_REQUEST_URL` (injected when the workflow has
 * `id-token: write`). The returned token is automatically masked in the logs
 * via {@link setSecret}.
 *
 * @param audience - Optional audience; appended as the `audience` query param.
 * @returns The signed, compact JWT ID token.
 * @throws If the request URL is missing or the response has no `value` field.
 */
export async function getIDToken(audience?: string): Promise<string> {
  let idTokenUrl = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  if (!idTokenUrl) {
    throw new Error("Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable");
  }
  if (audience && audience.length > 0) {
    idTokenUrl = `${idTokenUrl}&audience=${encodeURIComponent(audience)}`;
  }

  try {
    const id_token = await getHttpRequest<{ value: string }>(idTokenUrl);
    if (!id_token || !id_token.value) {
      throw new Error("Response json body do not have ID Token field");
    }
    const idToken = id_token.value;
    setSecret(idToken);
    return idToken;
  } catch (error) {
    throw new Error(`Failed to get ID Token. \nError: ${error}`);
  }
}

/**
 * Registers a value to be masked from the logs using the `::add-mask::`
 * workflow command.
 *
 * @param secret - The value to mask.
 */
export function setSecret(secret: string): void {
  const cmd = `::add-mask::${escapeData(secret)}${EOL}`;
  process.stdout.write(cmd);
}

/**
 * Sets an action output.
 *
 * Writes `name=value` to the file named by `GITHUB_OUTPUT` when available,
 * otherwise falls back to the deprecated `::set-output` workflow command.
 *
 * @param name - Output name.
 * @param value - Output value; non-strings are JSON-encoded.
 */
export function setOutput(name: string, value: any): void {
  const OUTPUT_ENV_FILE = process.env["GITHUB_OUTPUT"];
  if (OUTPUT_ENV_FILE) {
    appendFileSync(OUTPUT_ENV_FILE, `${name}=${escapeData(value)}${EOL}`);
  } else {
    const cmd = `::set-output name=${name}::${escapeData(value)}${EOL}`;
    process.stdout.write(cmd);
  }
}

/**
 * Sets an environment variable for subsequent steps in the job.
 *
 * The value is written to the file named by `GITHUB_ENV` (so later steps see
 * it) and also set on the current process.
 *
 * @param name - Variable name.
 * @param val - Variable value; non-strings are JSON-encoded.
 */
export function exportVariable(name: string, val: any): void {
  const converted = toCommandValue(val);
  process.env[name] = converted;

  const envFile = process.env["GITHUB_ENV"];
  if (envFile) {
    appendFileSync(envFile, `${name}=${escapeProperty(converted)}${EOL}`);
  }
}

/**
 * Reads an action input from the `INPUT_<NAME>` environment variable.
 *
 * @param name - Input name; spaces become underscores and it is uppercased.
 * @param options - Optional `required` / `trimWhitespace` behavior.
 * @returns The (optionally trimmed) input value, or `""` if unset.
 * @throws If `options.required` is set and the value is empty.
 */
export function getInput(name: string, options?: InputOptions): string {
  const val = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ||
    "";
  if (options && options.required && !val) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return options?.trimWhitespace === false ? val : val.trim();
}

/**
 * Reads an action input and parses it as a boolean.
 *
 * Accepts `true`/`false` in any of the runner's recognized casings.
 *
 * @param name - Input name.
 * @param options - Optional `required` / `trimWhitespace` behavior.
 * @returns The parsed boolean value.
 * @throws If the value is not a recognized boolean literal.
 */
export function getBooleanInput(name: string, options?: InputOptions): boolean {
  const trueValue = ["true", "True", "TRUE"];
  const falseValue = ["false", "False", "FALSE"];
  const val = getInput(name, options);
  if (trueValue.includes(val)) {
    return true;
  }
  if (falseValue.includes(val)) {
    return false;
  }
  throw new TypeError(
    `Input does not meet YAML 1.2 "Core Schema" specification: ${name}\n` +
      `Support boolean input list: \`true | True | TRUE | false | False | FALSE\``,
  );
}

/**
 * Emits a `::error::` annotation and marks the step as failed.
 *
 * Sets `process.exitCode` to `1` so the runner reports a failure once the
 * process exits.
 *
 * @param message - Error message, or an `Error` whose message is used.
 */
export function setFailed(message: string | Error): void {
  process.exitCode = 1;
  error(message);
}

/**
 * Emits a `::error::` annotation.
 *
 * @param message - Error message, or an `Error` whose message is used.
 */
export function error(message: string | Error): void {
  const msg = message instanceof Error ? message.message : message;
  process.stdout.write(`::error::${escapeData(msg)}${EOL}`);
}

/**
 * Emits a `::warning::` annotation.
 *
 * @param message - Warning message, or an `Error` whose message is used.
 */
export function warning(message: string | Error): void {
  const msg = message instanceof Error ? message.message : message;
  process.stdout.write(`::warning::${escapeData(msg)}${EOL}`);
}

/**
 * Emits a `::notice::` annotation.
 *
 * @param message - Notice message, or an `Error` whose message is used.
 */
export function notice(message: string | Error): void {
  const msg = message instanceof Error ? message.message : message;
  process.stdout.write(`::notice::${escapeData(msg)}${EOL}`);
}

/**
 * Emits a `::debug::` message, but only when debug logging is enabled.
 *
 * @param message - Message to log.
 */
export function debug(message: string): void {
  if (!isDebug()) {
    return;
  }
  process.stdout.write(`::debug::${escapeData(message)}${EOL}`);
}

/**
 * Whether step debug logging is enabled.
 *
 * Enabled by `ACTIONS_STEP_DEBUG=true` or `RUNNER_DEBUG=1`.
 *
 * @returns `true` when debug logging is on.
 */
export function isDebug(): boolean {
  return process.env["RUNNER_DEBUG"] === "1" ||
    process.env["ACTIONS_STEP_DEBUG"] === "true";
}

/**
 * Starts a collapsible log group (`::group::`).
 *
 * @param name - Group title.
 */
export function startGroup(name: string): void {
  process.stdout.write(`::group::${escapeData(name)}${EOL}`);
}

/** Ends the current log group (`::endgroup::`). */
export function endGroup(): void {
  process.stdout.write(`::endgroup::${EOL}`);
}

/**
 * Escapes a value for use in a workflow command's data section.
 *
 * @param s - Value to escape.
 * @returns The escaped string.
 */
function escapeData(s: any): string {
  return toCommandValue(s)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

/**
 * Escapes a value for use in a workflow command's property section.
 *
 * @param s - Value to escape.
 * @returns The escaped string.
 */
function escapeProperty(s: any): string {
  return toCommandValue(s)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

/**
 * Normalizes an arbitrary value into the string representation used by
 * workflow commands.
 *
 * @param input - Value to convert.
 * @returns `""` for nullish input, the string itself for strings, otherwise
 * the JSON encoding.
 */
function toCommandValue(input: any): string {
  if (input === null || input === undefined) {
    return "";
  } else if (typeof input === "string") {
    return input;
  } else if (input instanceof String) {
    return input.toString();
  }
  return JSON.stringify(input);
}
