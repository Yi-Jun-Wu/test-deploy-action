# Deploy GitHub Pages site

A dependency-free GitHub Action that deploys a directory to GitHub Pages. It
packages the directory, uploads it as a workflow artifact using the Actions
artifact protocol implemented in this repository, and asks the Pages REST API
to publish it. Once the deployment no longer needs the artifact it is deleted
(to free up storage) unless `expire` is set to `0`.

Unlike `actions/deploy-pages`, this action pulls nothing from the network at
runtime beyond GitHub itself: the artifact upload is implemented directly in
[`src/artifact-minify.ts`](../../../src/artifact-minify.ts) and the workflow
commands in [`src/core.ts`](../../../src/core.ts).

## Usage

```yaml
permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - name: Build site
        run: |
          mkdir -p dist
          cp -r public/. dist/

      - name: Deploy
        id: deployment
        uses: ./.github/actions/deploy
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          path: dist/
          expire: '30'
```

## Inputs

| Input    | Required | Default          | Description |
| -------- | -------- | ---------------- | ----------- |
| `token`  | yes      | `${{ github.token }}` | GitHub token used to call the Pages deployment API. |
| `path`   | yes      | `dist/`          | Directory whose contents are deployed. |
| `expire` | yes      | `30`             | Seconds to poll the deployment before giving up. When positive the artifact is deleted once it is no longer needed; when `0` the artifact is left in place until its retention period ends. |

## Outputs

| Output     | Description |
| ---------- | ----------- |
| `page_url` | URL the deployed site is served from. |

## How it works

1. The `path` directory is archived with `tar` (platform-specific flags) and
   wrapped in a zip, because GitHub Pages only accepts zip artifacts.
2. The zip is uploaded via the Actions artifact service and its id is retrieved.
3. `POST /repos/{owner}/{repo}/pages/deployments` is called with the artifact
   id, the `GITHUB_SHA` build version and the OIDC token from `getIDToken()`.
4. The deployment status is polled until it reaches a terminal state. The
   artifact is deleted as soon as the deployment stops needing it (or when the
   `expire` deadline is reached).

## Building

The action's bundled runtime lives next to this file as `index.mjs`. Regenerate
it from [`scripts/deploy.ts`](../../../scripts/deploy.ts) with:

```sh
pnpm run build
```

## Library usage

The same deployment logic is exported as a plain function from
[`src/deploy.ts`](../../../src/deploy.ts). That entrypoint does not read action
inputs or the runner environment, so it can be embedded in other tooling by
passing the runtime token explicitly:

```ts
import { deploy } from './src/deploy.ts'

const result = await deploy({
  actionsRuntimeToken: process.env.ACTIONS_RUNTIME_TOKEN!,
  githubToken,
  oidcToken,
  filePath: 'dist/',
  owner: 'my-org',
  repo: 'my-site',
  buildVersion: process.env.GITHUB_SHA,
  expireTime: 30, // omit or set to 0 to keep the artifact
})

console.log(result.pageUrl)
```
