import { execSync } from "node:child_process";
import { uploadArtifact } from "./artifact-minify.ts";
import { getIDToken, setOutput } from "./core.ts";
import { setTimeout } from "node:timers/promises";

// ========== Prepare ==========
execSync(`mkdir deploy`);
execSync(`cp README.md deploy/`);
execSync(`cp index.html deploy/`);
execSync(
  `tar --dereference --hard-dereference --directory "deploy" -cvf "artifact.tar" .`,
);

// #ifndef USE_OLD_METHOD

execSync(`zip page.zip artifact.tar`); // 压缩两次, 以满足deployment的要求
const auth = process.env["MY_ACTIONS_RUNTIME_TOKEN"]!;
const artifactId = await uploadArtifact(auth, "page.zip", "artifact", {
  mime_type: "application/zip",
});

// #else

// import { uploadArtifact as uploadArtifactOld } from "./artifact.ts";
// process.env["ACTIONS_RESULTS_URL"] = process.env["MY_ACTIONS_RESULTS_URL"]!;
// process.env["ACTIONS_RUNTIME_TOKEN"] = process.env["MY_ACTIONS_RUNTIME_TOKEN"]!;
// const resp = await uploadArtifactOld("page", ["artifact.tar"], "./");
// const artifactId = resp.id;

// #endif

const idToken = await getIDToken();
const TOKEN = process.env["GITHUB_TOKEN"]!;
const OWNER = process.env["GITHUB_REPOSITORY_OWNER"]!;
const REPO = process.env["GITHUB_REPOSITORY"]!.split("/")[1]!;
const GITHUB_SHA = process.env["GITHUB_SHA"]!;

const pageDeploymentsUrl =
  `https://api.github.com/repos/${OWNER}/${REPO}/pages/deployments`;
const response = await fetch(pageDeploymentsUrl, {
  method: "POST",
  headers: {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${TOKEN}`,
    "X-GitHub-Api-Version": "2026-03-10",
  },
  body: JSON.stringify({
    artifact_id: artifactId,
    environment: "github-pages",
    pages_build_version: GITHUB_SHA,
    oidc_token: idToken,
  }),
});
if (!response.ok) {
  const errorText = await response.text();
  throw new Error(
    `Failed to deploy pages: ${response.status} ${response.statusText} - ${errorText}`,
  );
}
const { id, status_url, page_url } = await response.json();
console.log(
  "Deploying Pages to:",
  page_url,
  "Deployment ID:",
  id,
  "Status URL:",
  status_url,
);

// polling the status of the deployment until it is completed
let last_status = undefined;
let sleep_time = 20;
while (true) {
  await setTimeout(sleep_time); // 100ms
  sleep_time = Math.min(Math.round(sleep_time * 1.5), 5000);
  const statusResponse = await fetch(status_url, {
    method: "GET",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  if (!statusResponse.ok) {
    const errorText = await statusResponse.text();
    throw new Error(
      `Failed to get deployment status: ${statusResponse.status} ${statusResponse.statusText} - ${errorText}`,
    );
  }
  const statusData = await statusResponse.json();
  if (last_status !== statusData.status) {
    console.log("Deployment status:", statusData.status);
    last_status = statusData.status;
  }
  let can_exit = false;
  switch (last_status) {
    case "deployment_queued":
    case "deployment_in_progress":
    case "syncing_files":
      // CANNOT delete the artifact yet, because the deployment is still in progress. Wait for the next status update.
      break;
    case "succeed":
      can_exit = true;
    // fall through
    case "finished_file_sync":
    case "updating_pages":
    case "purging_cdn":
      // // CAN delete the artifact now, because the artifact is no longer needed for the deployment.
      // if (!file_deleted) {
      //   const { id } = await artifact.deleteArtifact(artifactName);
      //   const finishTime = performance.now();
      //   console.log("Deleted Artifact ID:", id);
      //   console.log("Artifact Existing Time:", finishTime - startTime, "ms");
      //   file_deleted = true;
      // }
      break;
    case "deployment_attempt_error":
      console.warn("Deploy attemp error, retrying");
      break;
    case "deployment_cancelled":
    case "deployment_failed":
    case "deployment_content_failed":
    case "deployment_lost":
      // console.error("Deployment Failed. Reason:", status.data.status)
      // failed = true;
      can_exit = true;
      break;
    default:
      // console.error("Unknown Status:", status.data.status)
      break;
  }
  if (can_exit) {
    break;
  }
}

console.log("Deployment finished. Check the status at:", status_url);

setOutput("page_url", page_url);
