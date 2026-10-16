/**
 * Composite-action wrapper around the `deploy` library function.
 *
 * This is the runtime entrypoint that gets bundled into the action: it reads
 * action inputs, resolves the runtime and OIDC tokens from the runner
 * environment, calls {@link deploy} and publishes the result as a step output.
 *
 * Inputs (`INPUT_<NAME>`):
 *   - `token`  GitHub token for the Pages REST API.
 *   - `path`   directory whose contents are deployed.
 *   - `expire` number of seconds to poll; `0`/omitted leaves the artifact in
 *              place.
 *
 * Outputs:
 *   - `page_url`.
 */

import { getIDToken, getInput, setFailed, setOutput } from "../src/core.ts";
import { deploy } from "../src/deploy.ts";

/** Deployment statuses that indicate the deployment did not succeed. */
const FAILED_STATUSES = new Set([
  "deployment_cancelled",
  "deployment_failed",
  "deployment_content_failed",
  "deployment_lost",
]);

async function main(): Promise<void> {
  const githubToken = getInput("token");
  const filePath = getInput("path");

  const expire = parseFloat(getInput("expire"));
  const expireTime = Number.isFinite(expire) && expire > 0 ? expire : undefined;

  const actionsRuntimeToken = process.env["ACTIONS_RUNTIME_TOKEN"];
  if (!actionsRuntimeToken) {
    throw new Error("Unable to get the ACTIONS_RUNTIME_TOKEN env variable");
  }

  const oidcToken = await getIDToken();

  const result = await deploy({
    actionsRuntimeToken,
    githubToken,
    oidcToken,
    filePath,
    expireTime,
  });

  setOutput("page_url", result.pageUrl);

  if (result.status && FAILED_STATUSES.has(result.status)) {
    setFailed(`Deployment failed with status: ${result.status}`);
  }
}

main().catch((error: unknown) => {
  setFailed(error instanceof Error ? error.message : String(error));
});
