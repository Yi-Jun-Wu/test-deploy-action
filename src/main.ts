// Reverse engineered from the GitHub Actions toolkit (@actions/artifact v6):
// the artifact upload protocol implemented in ./artifact.ts, without any
// toolkit dependency. Only a single file upload is supported.

// import {uploadArtifact} from './artifact.ts'

// process.env['ACTIONS_RUNTIME_TOKEN'] = process.env['MY_ACTIONS_RUNTIME_TOKEN']
// process.env['ACTIONS_RESULTS_URL'] = process.env['MY_ACTIONS_RESULTS_URL']

// // test uploading artifacts
// const result = await uploadArtifact(
//   'test_artifact',
//   ['src/main.ts'],
//   'src/',
//   {retentionDays: 1}
// )

// console.log(result)


import { upload } from './artifact-minify.ts'

const auth = process.env['MY_ACTIONS_RUNTIME_TOKEN']!
const url = process.env['MY_ACTIONS_RESULTS_URL']!

const types = {
  'application/zip': "zip", // valid .zip
  'application/x-tar': "tar", // valid .tar
  'application/x-7z-compressed': "7z", // valid .7z
  'application/octet-stream': "bin", // valid (no extension)
  'application/x-gzip': "gzip",
  'application/x-bzip2': "bzip2",
  'application/x-xz': "xz",
  'application/x-rar-compressed': "rar",
  'application/x-lzip': "lzip",
  'application/x-lzma': "lzma",
  'application/x-lzop': "lzop",
  'application/x-compress': "Z",
  'application/x-apple-diskimage': "dmg",
  'application/x-deb': "deb",
  'application/x-rpm': "rpm",
  'application/x-msdownload': "exe",
  'application/x-shockwave-flash': "swf",
  'application/x-java-archive': "jar",
  'application/x-python-code': "pyc",
  'application/x-perl': "pl",
};

for (const [type, name] of Object.entries(types)) {
  try {
    const result = await upload(
      auth,
      url,
      'src/main.ts',
      type,
      name + '_artifact',
      1
    )
    console.log(result)
  }catch (error) {
    console.error(`Failed to upload artifact for type ${type}:`, error)
  }
}
