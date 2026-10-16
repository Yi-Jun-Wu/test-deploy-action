
// TODO: reverse engineer the artifact upload code from the GitHub Actions toolkit,
// and implement it in a way that works with the current version of TypeScript and Node.js without relying on the GitHub Actions toolkit.
// Only need to upload a single file, and don't need to worry about the other features of the toolkit.
import { DefaultArtifactClient } from '@actions/artifact';

// test uploading artifacts
const artifact = new DefaultArtifactClient();
const { id: artifactId } = await artifact.uploadArtifact(
  "test_artifact",
  ["src/main.ts"],
  "src/",
  { retentionDays: 1 }
);
