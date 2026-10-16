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


import {upload} from './artifact-minify.ts'

const auth = process.env['MY_ACTIONS_RUNTIME_TOKEN']!
const url = process.env['MY_ACTIONS_RESULTS_URL']!

const result = await upload(
  auth,
  url,
  'src/main.ts',
  'test_artifact',
  1
)

console.log(result)