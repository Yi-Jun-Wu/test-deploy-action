/**
 * GitHub Pages deployment entrypoint, built on the dependency-free
 * implementations in `./artifact-minify.ts` and `./core.ts`.
 *
 * This is the standalone equivalent of the official Pages deploy action: it
 * packages the configured directory, uploads it as a workflow artifact and
 * asks the Pages API to deploy it. Once the deployment no longer needs the
 * artifact, the artifact is deleted.
 *
 * Inputs (read from `INPUT_<NAME>` via `getInput`):
 *   - `token`  GitHub token used for the Pages REST API.
 *   - `path`   directory whose contents are deployed.
 *   - `expire` maximum number of seconds to poll before giving up.
 *
 * Output:
 *   - `page_url` the URL the site is served from.
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { platform } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { getIDToken, getInput, setFailed, setOutput } from "./core.ts";
import {
  deleteSpecificArtifact,
  uploadArtifact,
  type UploadConfig,
} from "./artifact-minify.ts";

const GITHUB_API_VERSION = "2026-03-10";

async function main(): Promise<void> {
  const githubToken = getInput("token");
  const filePath = getInput("path");
  let expireTime = parseFloat(getInput("expire"));
  if (expireTime < 0 || isNaN(expireTime) || !isFinite(expireTime)) {
    expireTime = 0.5;
  }

  const buildVersion = process.env["GITHUB_SHA"]!;
  const idToken = await getIDToken();
  const auth = process.env["ACTIONS_RUNTIME_TOKEN"]!;
  const artifactName = Array.from(
    { length: 3 },
    () => Math.random().toString(36).slice(2, 10),
  ).join("-");
  const runnerTemp = process.env["RUNNER_TEMP"] ?? ".";
  const tarPath = join(runnerTemp, "artifact.tar");
  const zipPath = join(runnerTemp, "artifact.zip");

  // Package the directory as a tar (platform-specific flags), then wrap it in a
  // zip: GitHub Pages only accepts zip artifacts, and the tar must remain the
  // single top-level entry inside it.
  switch (platform()) {
    case "win32":
      execSync(
        `tar --dereference --hard-dereference --directory "${filePath}" -cvf "${tarPath}" ` +
          `--exclude=.git --exclude=.github --exclude=".[^/]*" --force-local .`,
      );
      break;
    case "darwin":
      execSync(
        `gtar --dereference --hard-dereference --directory "${filePath}" -cvf "${tarPath}" ` +
          `--exclude=.git --exclude=.github --exclude=".[^/]*" .`,
      );
      break;
    case "linux":
    default:
      execSync(
        `tar --dereference --hard-dereference --directory "${filePath}" -cvf "${tarPath}" ` +
          `--exclude=.git --exclude=.github --exclude=".[^/]*" .`,
      );
      break;
  }
  execSync(`zip artifact.zip artifact.tar`, { cwd: runnerTemp });

  // The artifact service can be redirected through ACTIONS_RESULTS_URL;
  // otherwise artifact-minify's production default is used.
  const resultsUrl = process.env["ACTIONS_RESULTS_URL"];
  const artifactConfig: Partial<UploadConfig> = {
    mime_type: "application/zip",
    retention_seconds: 86400, // 1 day
    ...(resultsUrl ? { result_url_origin: resultsUrl } : {}),
  };

  const artifactId = await uploadArtifact(auth, zipPath, artifactName, artifactConfig);
  console.log("Uploaded Artifact ID:", artifactId);

  const startTime = performance.now();

  const owner = process.env["GITHUB_REPOSITORY_OWNER"]!;
  const repo = process.env["GITHUB_REPOSITORY"]!.split("/")[1]!;
  const headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${githubToken}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };

  const deployResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pages/deployments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        artifact_id: artifactId,
        environment: "github-pages",
        pages_build_version: buildVersion,
        oidc_token: idToken,
      }),
    },
  );
  if (!deployResponse.ok) {
    throw new Error(
      `Failed to deploy pages: ${deployResponse.status} ${deployResponse.statusText} - ${await deployResponse.text()}`,
    );
  }
  const { id, status_url, page_url } = await deployResponse.json();
  console.log("Deploying Pages to:", page_url, "Deployment ID:", id);

  const deleteUploadedArtifact = async (): Promise<void> => {
    const deletedId = await deleteSpecificArtifact(auth, artifactName, artifactConfig);
    console.log("Deleted Artifact ID:", deletedId);
    console.log("Artifact Existing Time:", performance.now() - startTime, "ms");
  };

  let fileDeleted = false;
  let failed = false;
  let lastStatus: string | undefined = undefined;
  let sleepTime = 20;

  try {
    while (performance.now() - startTime < expireTime * 1000) {
      await sleep(sleepTime);
      sleepTime = Math.min(Math.round(sleepTime * 1.5), 5000);

      const statusResponse = await fetch(status_url, { headers });
      if (!statusResponse.ok) {
        throw new Error(
          `Failed to get deployment status: ${statusResponse.status} ${statusResponse.statusText} - ${await statusResponse.text()}`,
        );
      }
      const statusData = await statusResponse.json();
      if (statusData.status !== lastStatus) {
        console.log("Deployment status:", statusData.status);
        lastStatus = statusData.status;
      }

      let canExit = false;
      switch (lastStatus) {
        case "deployment_queued":
        case "deployment_in_progress":
        case "syncing_files":
          // The artifact is still needed; wait for the next status update.
          break;
        case "succeed":
          canExit = true;
        // fall through
        case "finished_file_sync":
        case "updating_pages":
        case "purging_cdn":
          // The artifact is no longer needed for the deployment.
          if (!fileDeleted) {
            await deleteUploadedArtifact();
            fileDeleted = true;
          }
          break;
        case "deployment_attempt_error":
          console.warn("Deploy attempt error, retrying");
          break;
        case "deployment_cancelled":
        case "deployment_failed":
        case "deployment_content_failed":
        case "deployment_lost":
          console.error("Deployment failed. Reason:", statusData.status);
          failed = true;
          canExit = true;
          break;
        default:
          console.warn("Unknown status:", statusData.status);
          break;
      }
      if (canExit || failed) {
        break;
      }
    }
  } catch (error) {
    console.error("Error occurred while waiting for deployment:", error);
  }

  // Clean up even when the deployment did not finish or the polling errored.
  if (!fileDeleted) {
    await deleteUploadedArtifact();
  }

  if (failed) {
    setFailed("Deployment failed. See the logs for the reported status.");
  }

  setOutput("page_url", page_url ?? "");
}

main().catch((error: unknown) => {
  setFailed(error instanceof Error ? error.message : String(error));
});
