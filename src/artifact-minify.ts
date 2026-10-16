import {createHash, randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'

const TWIRP_SERVICE = 'github.actions.results.api.v1.ArtifactService'
const ARTIFACT_VERSION = 7
// const ARTIFACT_CONTENT_TYPE = 'application/zip'
const ARTIFACT_CONTENT_TYPE = 'text/javascript'
const BLOCK_SIZE = 8 * 1024 * 1024

export async function upload(
  auth: string,
  url: string,
  zipFilePath: string,
  name: string,
  retention: number
): Promise<number> {
  const archive = await readFile(zipFilePath)
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`
  const origin = new URL(url).origin
  const [workflowRunBackendId, workflowJobRunBackendId] = getBackendIdsFromToken(auth)

  const created = await twirp(origin, auth, 'CreateArtifact', {
    workflow_run_backend_id: workflowRunBackendId,
    workflow_job_run_backend_id: workflowJobRunBackendId,
    name,
    version: ARTIFACT_VERSION,
    mime_type: ARTIFACT_CONTENT_TYPE,
    expires_at: getExpiration(retention)
  })

  await uploadToBlob(created.signed_upload_url, archive)

  const finalized = await twirp(origin, auth, 'FinalizeArtifact', {
    workflow_run_backend_id: workflowRunBackendId,
    workflow_job_run_backend_id: workflowJobRunBackendId,
    name,
    size: String(archive.length),
    hash: digest
  })

  return Number(finalized.artifact_id)
}

function getBackendIdsFromToken(token: string): [string, string] {
  const payload = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
  )
  for (const scope of String(payload['scp']).split(' ')) {
    const parts = scope.split(':')
    if (parts[0] === 'Actions.Results') {
      return [parts[1], parts[2]]
    }
  }
  throw new Error('Invalid token: missing Actions.Results scope')
}

async function twirp(
  origin: string,
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<any> {
  const response = await fetch(`${origin}/twirp/${TWIRP_SERVICE}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    throw new Error(`${method} failed (${response.status}): ${await response.text()}`)
  }
  return response.json()
}

async function uploadToBlob(signedUrl: string, body: Buffer): Promise<void> {
  const version = new URL(signedUrl).searchParams.get('sv') ?? '2021-08-06'
  const prefix = randomUUID()
  const blockIds: string[] = []

  for (let i = 0, offset = 0; offset < body.length; i++, offset += BLOCK_SIZE) {
    const chunk = body.subarray(offset, Math.min(offset + BLOCK_SIZE, body.length))
    const blockId = Buffer.from(`${prefix}-${String(i).padStart(6, '0')}`).toString('base64')
    const response = await fetch(
      appendQuery(signedUrl, ['comp=block', `blockid=${encodeURIComponent(blockId)}`]),
      {
        method: 'PUT',
        headers: {
          'x-ms-version': version,
          'x-ms-date': new Date().toUTCString(),
          'Content-Type': 'application/octet-stream'
        },
        body: chunk
      }
    )
    if (response.status !== 201) {
      throw new Error(`Put Block failed (${response.status}): ${await response.text()}`)
    }
    blockIds.push(blockId)
  }

  const xml = `<BlockList>${blockIds.map(id => `<Latest>${id}</Latest>`).join('')}</BlockList>`
  const response = await fetch(appendQuery(signedUrl, ['comp=blocklist']), {
    method: 'PUT',
    headers: {
      'x-ms-version': version,
      'x-ms-date': new Date().toUTCString(),
      'Content-Type': 'application/xml; charset=utf-8',
      'x-ms-blob-content-type': ARTIFACT_CONTENT_TYPE
    },
    body: Buffer.from(xml, 'utf8')
  })
  if (response.status !== 201) {
    throw new Error(`Put Block List failed (${response.status}): ${await response.text()}`)
  }
}

function appendQuery(url: string, parameters: string[]): string {
  const parsed = new URL(url)
  parsed.search = [parsed.search.replace(/^\?/, ''), ...parameters]
    .filter(part => part.length > 0)
    .join('&')
  return parsed.toString()
}

function getExpiration(retention: number): string | undefined {
  if (!retention) {
    return undefined
  }
  const date = new Date()
  date.setDate(date.getDate() + retention)
  return date.toISOString()
}
