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
  // 'application/json': 'json', // valid .xml
  // 'application/xml': 'xml', // valid .json
  // 'text/plain': 'txt',  // valid .txt
  'application/pdf':'pdf',
  'application/msword':'msword',
  'application/json':'json',
  'application/mp4':'mp4',
  'application/ogg':'ogg',
  'application/rtf':'rtf',
  'application/vnd.adobe.xdp+xml':'xml',
  'application/vnd.ms-excel':'excel',
  'application/vnd.rar':'rar',
  'application/wasm':'wasm',
  'application/winhlp':'winhlp',
  'application/yaml':'yaml',

  // 'application/zip': "zip", // valid .zip
  // 'application/x-tar': "tar", // valid .tar
  // 'application/x-7z-compressed': "7z", // valid .7z
  // 'application/octet-stream': "bin", // valid (no extension)
  // 'application/x-gzip': "gzip", // invalid!
  // 'application/x-bzip2': "bzip2", // invalid!
  // 'application/x-xz': "xz", // invalid!
  // 'application/x-rar-compressed': "rar",  // invalid!
  // 'application/x-lzip': "lzip", // invalid!
  // 'application/x-lzma': "lzma", // invalid!
  // 'application/x-lzop': "lzop", // invalid!
  // 'application/x-compress': "Z",  // invalid!
  // 'application/x-apple-diskimage': "dmg", // invalid!
  // 'application/x-deb': "deb", // invalid!
  // 'application/x-rpm': "rpm", // invalid!
  // 'application/x-msdownload': "exe",  // invalid!
  // 'application/x-shockwave-flash': "swf", // invalid!
  // 'application/x-java-archive': "jar",  // invalid!
  // 'application/x-python-code': "pyc", // invalid!
  // 'application/x-perl': "pl", // invalid!
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
