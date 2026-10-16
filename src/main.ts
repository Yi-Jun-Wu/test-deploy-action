import {
  uploadArtifact,
  type UploadConfig,
  VALID_MIME_TYPE,
} from "./artifact-minify.ts";

const auth = process.env["MY_ACTIONS_RUNTIME_TOKEN"]!;
const url = process.env["MY_ACTIONS_RESULTS_URL"]!;

const config: Partial<UploadConfig> = {
  // result_url_origin: '',
  // twirp_service: '',
  // artifact_version: 0,
  // block_size: 0,
  mime_type: "application/gzip",
  retention_seconds: 3600,
};

for (const type of VALID_MIME_TYPE) {
  config.mime_type = type;
  const result = await uploadArtifact(
    auth,
    "src/main.ts",
    type.replace(/[^A-Za-z0-9]+/g, "_"),
    config,
  );
  console.log(result);
}
