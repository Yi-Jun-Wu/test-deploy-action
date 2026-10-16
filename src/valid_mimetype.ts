import { readFile, writeFile } from "node:fs/promises";
import { upload } from './artifact-minify.ts'
import { setTimeout } from "node:timers/promises";

const auth = process.env['MY_ACTIONS_RUNTIME_TOKEN']!
const url = process.env['MY_ACTIONS_RESULTS_URL']!

async function read_csv(path: string): Promise<[string, string][]> {
  const lines = await readFile(path, "utf-8");
  return lines.split("\n").map(l => l.trim()).filter(l => l.length > 0)
    .map(l => l.split(",")).map(([name, mime]) => [mime.trim(), name.trim().replace(/[^0-9a-zA-Z]+/g, "_")]);
}

const files = [
  "src/mime_types/application.csv",
  "src/mime_types/audio.csv",
  "src/mime_types/font.csv",
  "src/mime_types/haptics.csv",
  "src/mime_types/image.csv",
  "src/mime_types/message.csv",
  "src/mime_types/model.csv",
  "src/mime_types/multipart.csv",
  "src/mime_types/text.csv",
  "src/mime_types/video.csv",
];

const types: [string, string][] = [["example/example", "example_type"]];
for (const f of files) {
  types.push(...await read_csv(f));
}
console.log(types.length)

const valid_list: string[] = [];
let idx = 0;
for (const [mime, name] of types) {
  idx++;
  try {
    await upload(
      auth,
      url,
      'src/main.ts',
      mime,
      idx + "_" + name,
      1
    )
    console.log("Success:", mime, "Progress:", idx / types.length);
    valid_list.push(mime);
  } catch (error) {
    console.error(`Failed to upload artifact for type ${mime}:`, String(error).slice(0, 100).replaceAll("\n", ""));
  }
  await setTimeout(100);
}

await writeFile("valid_mimetype.json", JSON.stringify(valid_list));
await upload(
  auth,
  url,
  'valid_mimetype.json',
  "application/json",
  'valid_mimetype.json',
  7
)


/*
Results:
Total types:  2377
Failed types: 2339
  Error: CreateArtifact failed (400): {"code":"invalid_argument","msg":"mime_type a valid mime_type is...
Success:      38

They are:
[
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
  "video/quicktime"
]
*/