/**
 * Library entrypoint for deploying a directory to GitHub Pages.
 *
 * This module is intentionally environment-agnostic: it never reads workflow
 * inputs, never writes outputs and never throws workflow-level failures. All
 * behavior is controlled through {@link DeployOptions} and callers receive the
 * deployment result (or an exception) directly, so the same code can be reused
 * both by the bundled `scripts/deploy.ts` action wrapper and by external
 * callers that inject their own `ACTIONS_RUNTIME_TOKEN`.
 *
 * Flow:
 *   1. Archive `filePath` as a tar (platform-specific flags) and wrap it in a
 *      zip, since GitHub Pages only accepts zip artifacts.
 *   2. Upload the zip through `./artifact-minify.ts` and obtain the artifact id.
 *   3. `POST {apiBaseUrl}/repos/{owner}/{repo}/pages/deployments`.
 *   4. Poll the returned `status_url` until a terminal status. When
 *      `expireTime` is a positive number the artifact is deleted as soon as the
 *      deployment no longer needs it (and after the deadline); when it is `0`
 *      or omitted the artifact is never deleted.
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  deleteSpecificArtifact,
  uploadArtifact,
  type UploadConfig,
} from "./artifact-minify.ts";

/** GitHub REST API version header sent with every request. */
const GITHUB_API_VERSION = "2026-03-10";

/** Controls a single Pages deployment performed by {@link deploy}. */
export interface DeployOptions {
  /**
   * Runtime token (`ACTIONS_RUNTIME_TOKEN`) used to upload and delete the
   * artifact. Passed explicitly so the library does not depend on the runner
   * environment.
   */
  actionsRuntimeToken: string;

  /** GitHub token used to call the Pages REST API. */
  githubToken: string;

  /** OIDC token placed in the `pages/deployments` request body. */
  oidcToken: string;

  /** Directory whose contents are deployed. */
  filePath: string;

  /**
   * Repository owner. Defaults to `GITHUB_REPOSITORY_OWNER` when omitted.
   */
  owner?: string;

  /**
   * Repository name. Defaults to the part after `/` in `GITHUB_REPOSITORY`.
   */
  repo?: string;

  /**
   * Value for `pages_build_version`. Defaults to `GITHUB_SHA`.
   */
  buildVersion?: string;

  /** Artifact name; a random three-segment name is generated when omitted. */
  artifactName?: string;

  /**
   * Number of seconds to poll the deployment status. When `0` or omitted the
   * deployment is polled until a terminal status but the artifact is **never
   * deleted**; when positive the artifact is deleted once it is no longer
   * needed (or the deadline is reached).
   */
  expireTime?: number;

  /**
   * Directory used for the intermediate `artifact.tar` / `artifact.zip`.
   * Defaults to `os.tmpdir()`.
   */
  tempDir?: string;

  /**
   * GitHub REST API base URL. Defaults to `https://api.github.com`; override
   * for GitHub Enterprise Server.
   */
  apiBaseUrl?: string;

  /** Pages environment name. Defaults to `"github-pages"`. */
  environment?: string;

  /** Artifact retention in seconds. Defaults to one day (`86400`). */
  retentionSeconds?: number;

  /**
   * Additional `./artifact-minify.ts` configuration overrides, e.g.
   * `result_url_origin` or `twirp_service`.
   */
  artifactConfig?: Partial<UploadConfig>;

  /** Logger callback. Defaults to `console.log`. */
  log?: (message: string) => void;
}

/** Outcome of a successful {@link deploy} call. */
export interface DeployResult {
  /** URL the site is served from (`page_url`). */
  pageUrl: string;
  /** Numeric id of the Pages deployment. */
  deploymentId: number;
  /** Final observed deployment status, or `undefined` when not polled. */
  status?: string;
  /** Id of the deleted artifact, when `expireTime` enabled deletion. */
  deletedArtifactId?: number;
}

/**
 * Deploys a directory to GitHub Pages.
 *
 * @param options - Deployment configuration; see {@link DeployOptions}.
 * @returns The deployment result once a terminal status is observed.
 * @throws On any archive, upload, API or status-polling failure.
 */
export async function deploy(options: DeployOptions): Promise<DeployResult> {
  const log = options.log ?? ((message: string) => console.log(message));

  const owner = options.owner ?? process.env["GITHUB_REPOSITORY_OWNER"];
  if (!owner) {
    throw new Error(
      "deploy: `owner` is required (or set GITHUB_REPOSITORY_OWNER)",
    );
  }
  const repo = options.repo ??
    process.env["GITHUB_REPOSITORY"]?.split("/")[1];
  if (!repo) {
    throw new Error("deploy: `repo` is required (or set GITHUB_REPOSITORY)");
  }
  const buildVersion = options.buildVersion ?? process.env["GITHUB_SHA"];
  if (!buildVersion) {
    throw new Error(
      "deploy: `buildVersion` is required (or set GITHUB_SHA)",
    );
  }

  const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  const environment = options.environment ?? "github-pages";
  const artifactName = options.artifactName ??
    Array.from(
      { length: 3 },
      () => Math.random().toString(36).slice(2, 10),
    ).join("-");

  const manageArtifact = typeof options.expireTime === "number" &&
    options.expireTime > 0;

  const tempDir = options.tempDir ?? tmpdir();
  const tarPath = join(tempDir, "artifact.tar");
  const zipPath = join(tempDir, "artifact.zip");

  // Package the directory as a tar (platform-specific flags), then wrap it in a
  // zip: GitHub Pages only accepts zip artifacts, and the tar must remain the
  // single top-level entry inside it.
  switch (platform()) {
    case "win32":
      execSync(
        `tar --dereference --hard-dereference --directory "${options.filePath}" -cvf "${tarPath}" ` +
          `--exclude=.git --exclude=.github --exclude=".[^/]*" --force-local .`,
      );
      break;
    case "darwin":
      execSync(
        `gtar --dereference --hard-dereference --directory "${options.filePath}" -cvf "${tarPath}" ` +
          `--exclude=.git --exclude=.github --exclude=".[^/]*" .`,
      );
      break;
    case "linux":
    default:
      execSync(
        `tar --dereference --hard-dereference --directory "${options.filePath}" -cvf "${tarPath}" ` +
          `--exclude=.git --exclude=.github --exclude=".[^/]*" .`,
      );
      break;
  }
  execSync(`zip artifact.zip artifact.tar`, { cwd: tempDir });

  const artifactConfig: Partial<UploadConfig> = {
    mime_type: "application/zip",
    retention_seconds: options.retentionSeconds ?? 86400,
    ...options.artifactConfig,
  };

  const artifactId = await uploadArtifact(
    options.actionsRuntimeToken,
    zipPath,
    artifactName,
    artifactConfig,
  );
  log(`Uploaded Artifact ID: ${artifactId}`);

  const startTime = performance.now();

  const headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${options.githubToken}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };

  const deployResponse = await fetch(
    `${apiBaseUrl}/repos/${owner}/${repo}/pages/deployments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        artifact_id: artifactId,
        environment,
        pages_build_version: buildVersion,
        oidc_token: options.oidcToken,
      }),
    },
  );
  if (!deployResponse.ok) {
    throw new Error(
      `Failed to deploy pages: ${deployResponse.status} ${deployResponse.statusText} - ${await deployResponse.text()}`,
    );
  }
  const { id: deploymentId, status_url, page_url } = await deployResponse.json();
  log(`Deploying Pages to: ${page_url} Deployment ID: ${deploymentId}`);

  let deletedArtifactId: number | undefined;
  const deleteUploadedArtifact = async (): Promise<void> => {
    deletedArtifactId = await deleteSpecificArtifact(
      options.actionsRuntimeToken,
      artifactName,
      artifactConfig,
    );
    log(`Deleted Artifact ID: ${deletedArtifactId}`);
    log(`Artifact Existing Time: ${performance.now() - startTime} ms`);
  };

  let fileDeleted = false;
  let status: string | undefined = undefined;
  let sleepTime = 20;
  const deadline = manageArtifact
    ? startTime + options.expireTime! * 1000
    : Infinity;

  try {
    while (performance.now() < deadline) {
      await sleep(sleepTime);
      sleepTime = Math.min(Math.round(sleepTime * 1.5), 5000);

      const statusResponse = await fetch(status_url, { headers });
      if (!statusResponse.ok) {
        throw new Error(
          `Failed to get deployment status: ${statusResponse.status} ${statusResponse.statusText} - ${await statusResponse.text()}`,
        );
      }
      const statusData = await statusResponse.json();
      if (statusData.status !== status) {
        log(`Deployment status: ${statusData.status}`);
        status = statusData.status;
      }

      let terminal = false;
      switch (status) {
        case "deployment_queued":
        case "deployment_in_progress":
        case "syncing_files":
          // The artifact is still needed; wait for the next status update.
          break;
        case "succeed":
          terminal = true;
        // fall through
        case "finished_file_sync":
        case "updating_pages":
        case "purging_cdn":
          // The artifact is no longer needed for the deployment.
          if (manageArtifact && !fileDeleted) {
            await deleteUploadedArtifact();
            fileDeleted = true;
          }
          break;
        case "deployment_attempt_error":
          log("Deploy attempt error, retrying");
          break;
        case "deployment_cancelled":
        case "deployment_failed":
        case "deployment_content_failed":
        case "deployment_lost":
          terminal = true;
          break;
        default:
          log(`Unknown status: ${status}`);
          break;
      }
      if (terminal) {
        break;
      }
    }
  } catch (error) {
    log(`Error occurred while waiting for deployment: ${error}`);
  }

  // Clean up when the deployment did not already delete the artifact.
  if (manageArtifact && !fileDeleted) {
    await deleteUploadedArtifact();
  }

  return {
    pageUrl: page_url ?? "",
    deploymentId,
    status,
    deletedArtifactId,
  };
}
