import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { updaterArtifactNames } from './updater-artifacts.mjs'

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const bucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const credentialNames = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']

export const AWSCLI_VERSION = '1.46.1'
export const RELEASES_ORIGIN = 'https://releases.goalward.dev'
export const R2_LATEST_JSON_URL = `${RELEASES_ORIGIN}/latest.json`
export const GITHUB_FALLBACK_MANIFEST_URL = 'https://github.com/Beace/goalward/releases/latest/download/latest.json'
export const DEFAULT_R2_BUCKET = 'goalward-releases'
export const VERSIONED_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const LATEST_CACHE_CONTROL = 'public, max-age=60'

export function updaterEndpointOrder(githubManifestUrl = GITHUB_FALLBACK_MANIFEST_URL) {
  if (typeof githubManifestUrl !== 'string' || !githubManifestUrl.startsWith('https://github.com/')) {
    throw new Error('The GitHub updater endpoint must be an https GitHub URL')
  }
  return [R2_LATEST_JSON_URL, githubManifestUrl]
}

export function r2ArchiveUrl(version) {
  const { archive } = updaterArtifactNames(version)
  return `${RELEASES_ORIGIN}/v${version}/${archive}`
}

export function dmgFileName(version) {
  if (!versionPattern.test(version)) throw new Error('Invalid updater version')
  return `Goalward_${version}_macos-universal.dmg`
}

export function r2ObjectPlan(version, { updateLatest = true } = {}) {
  if (typeof updateLatest !== 'boolean') throw new Error('updateLatest must be a boolean')
  const names = updaterArtifactNames(version)
  const dmg = dmgFileName(version)
  const versioned = (file, contentType, rewrite = false) => ({
    file,
    key: `v${version}/${file}`,
    cacheControl: VERSIONED_CACHE_CONTROL,
    contentType,
    rewrite,
  })
  const plan = [
    versioned(names.archive, 'application/gzip'),
    versioned(names.signature, 'text/plain; charset=utf-8'),
    versioned(dmg, 'application/x-apple-diskimage'),
    versioned(names.manifest, 'application/json; charset=utf-8', true),
  ]
  if (!updateLatest) return plan
  return [
    ...plan,
    {
      file: names.manifest,
      key: 'latest.json',
      cacheControl: LATEST_CACHE_CONTROL,
      contentType: 'application/json; charset=utf-8',
      rewrite: true,
    },
  ]
}

export function rewriteUpdaterManifestForR2(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid updater manifest')
  const keys = Object.keys(manifest)
  if (keys.some(key => !['version', 'notes', 'pub_date', 'platforms'].includes(key))) throw new Error('Updater manifest contains unexpected fields')
  const { version } = manifest
  if (!versionPattern.test(version)) throw new Error('Invalid updater version')
  const { archive } = updaterArtifactNames(version)
  const platforms = manifest.platforms
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) throw new Error('Updater manifest is missing platform entries')
  const platformNames = Object.keys(platforms)
  if (platformNames.length !== 2 || !platformNames.includes('darwin-aarch64') || !platformNames.includes('darwin-x86_64')) {
    throw new Error('Updater manifest must contain only the two macOS architectures')
  }
  const arm = platforms['darwin-aarch64']
  const intel = platforms['darwin-x86_64']
  if (!arm || !intel || typeof arm.url !== 'string' || arm.url !== intel.url || arm.signature !== intel.signature) {
    throw new Error('Updater manifest platforms do not match')
  }
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/releases\/download\/v([^/]+)\/([^/]+)$/.exec(arm.url)
  if (!match || match[2] !== version || match[3] !== archive || !repositoryPattern.test(match[1]) || match[1].includes('..')) {
    throw new Error('Updater manifest URL is not the GitHub Release for this version')
  }
  if (typeof arm.signature !== 'string' || !arm.signature.trim() || arm.signature !== arm.signature.trim()) {
    throw new Error('Updater manifest is missing its signature')
  }
  const url = r2ArchiveUrl(version)
  const platform = { url, signature: arm.signature }
  return {
    version: manifest.version,
    notes: manifest.notes,
    pub_date: manifest.pub_date,
    platforms: { 'darwin-aarch64': { ...platform }, 'darwin-x86_64': { ...platform } },
  }
}

export function r2Settings(env, { required = false } = {}) {
  const values = Object.fromEntries(credentialNames.map(name => [name, typeof env[name] === 'string' ? env[name].trim() : '']))
  const missing = credentialNames.filter(name => !values[name])
  if (missing.length === credentialNames.length && !required) return { skip: true, missing }
  if (missing.length) throw new Error(`Cloudflare R2 credentials are incomplete. Missing: ${missing.join(', ')}`)
  if (!/^[0-9a-f]{32}$/.test(values.R2_ACCOUNT_ID)) throw new Error('R2_ACCOUNT_ID must be the 32-character Cloudflare account id')
  const bucket = typeof env.R2_BUCKET === 'string' && env.R2_BUCKET.trim() ? env.R2_BUCKET.trim() : DEFAULT_R2_BUCKET
  if (!bucketPattern.test(bucket)) throw new Error('R2_BUCKET is not a valid bucket name')
  return {
    skip: false,
    accountId: values.R2_ACCOUNT_ID,
    accessKeyId: values.R2_ACCESS_KEY_ID,
    secretAccessKey: values.R2_SECRET_ACCESS_KEY,
    bucket,
    endpoint: `https://${values.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  }
}

export function awsPutObjectArgs(settings, item, bodyPath) {
  return [
    's3api', 'put-object',
    '--endpoint-url', settings.endpoint,
    '--bucket', settings.bucket,
    '--key', item.key,
    '--body', bodyPath,
    '--cache-control', item.cacheControl,
    '--content-type', item.contentType,
  ]
}

export function requireGitHubToken(env = process.env) {
  if (typeof env.GH_TOKEN !== 'string' || env.GH_TOKEN.trim() === '') {
    throw new Error('GH_TOKEN is required to call the GitHub CLI. Set GH_TOKEN for this step; the token is not printed.')
  }
}

function githubCommandEnv(options = {}) {
  return options.env ? { ...process.env, ...options.env } : process.env
}

function run(command, args, options = {}) {
  if (command === 'gh') requireGitHubToken(githubCommandEnv(options))
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}

function capture(command, args) {
  if (command === 'gh') requireGitHubToken()
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
  return result.stdout
}

export function latestGitHubReleaseTag(repo, runCapture = capture) {
  // Newest published release, including prereleases. GitHub's /releases/latest omits them.
  if (!repositoryPattern.test(repo) || repo.includes('..')) throw new Error('Invalid updater repository')
  let releases
  try {
    releases = JSON.parse(runCapture('gh', [
      'release', 'list', '-R', repo, '--exclude-drafts', '--limit', '1', '--json', 'tagName,isDraft',
    ]))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Could not determine the newest GitHub Release')
    throw error
  }
  const tag = releases?.[0]?.tagName
  const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : ''
  if (!Array.isArray(releases) || releases.length !== 1 || releases[0].isDraft || tag !== `v${version}` || !versionPattern.test(version)) {
    throw new Error('Could not determine the newest GitHub Release')
  }
  return tag
}

export function parseUpdateLatest(args) {
  const index = args.indexOf('--update-latest')
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) return true
  if (value === 'true' || value === 'false') return value === 'true'
  throw new Error('Invalid --update-latest value')
}

export async function resolveUpdateLatest({ version, repository, updateLatest, latestTag = latestGitHubReleaseTag }) {
  if (!versionPattern.test(version)) throw new Error('Invalid updater version')
  if (updateLatest !== undefined && typeof updateLatest !== 'boolean') throw new Error('Invalid --update-latest value')
  if (updateLatest !== undefined) return updateLatest
  if (typeof repository !== 'string' || !repositoryPattern.test(repository) || repository.includes('..')) throw new Error('Invalid updater repository')
  return await Promise.resolve(latestTag(repository)) === `v${version}`
}

export function recordPublishedLatest(published, env = process.env) {
  const value = published ? 'true' : 'false'
  console.log(`R2_PUBLISHED_LATEST=${value}`)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `published_latest=${value}\n`)
  return value
}

async function awsCommand() {
  const root = await mkdtemp(join(tmpdir(), 'goalward-awscli-'))
  const python = process.env.PYTHON || 'python3'
  try {
    run(python, ['-m', 'venv', root])
    run(join(root, 'bin', 'pip'), ['install', '--disable-pip-version-check', `awscli==${AWSCLI_VERSION}`])
    return { bin: join(root, 'bin', 'aws'), cleanup: () => rm(root, { recursive: true, force: true }) }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export async function uploadDirectoryToR2(directory, version, env = process.env, { updateLatest = true } = {}) {
  if (!versionPattern.test(version)) throw new Error('Invalid updater version')
  if (typeof updateLatest !== 'boolean') throw new Error('updateLatest must be a boolean')
  const settings = r2Settings(env)
  if (settings.skip) {
    console.warn('Warning: skipping Cloudflare R2 upload because R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are not set. The GitHub Release remains available as the updater fallback.')
    return { uploaded: false, keys: [] }
  }
  const plan = r2ObjectPlan(version, { updateLatest })
  for (const item of plan) await readFile(join(directory, item.file))
  const manifest = JSON.parse(await readFile(join(directory, 'latest.json'), 'utf8'))
  const rewritten = rewriteUpdaterManifestForR2(manifest)
  if (rewritten.version !== version) throw new Error('Updater manifest version does not match the release')
  const temp = await mkdtemp(join(tmpdir(), 'goalward-r2-manifest-'))
  const rewrittenPath = join(temp, 'latest.json')
  await writeFile(rewrittenPath, `${JSON.stringify(rewritten, null, 2)}\n`)
  const aws = await awsCommand()
  try {
    for (const item of plan) {
      const body = item.rewrite ? rewrittenPath : join(directory, item.file)
      run(aws.bin, awsPutObjectArgs(settings, item, body), {
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: settings.accessKeyId,
          AWS_SECRET_ACCESS_KEY: settings.secretAccessKey,
          AWS_DEFAULT_REGION: 'auto',
          AWS_EC2_METADATA_DISABLED: 'true',
        },
      })
      console.log(`Uploaded s3://${settings.bucket}/${item.key}`)
    }
  } finally {
    await aws.cleanup()
    await rm(temp, { recursive: true, force: true })
  }
  if (updateLatest) console.log(`Published ${R2_LATEST_JSON_URL} for Goalward ${version}`)
  else console.log(`Uploaded versioned R2 objects for Goalward ${version} without changing latest.json`)
  return { uploaded: true, keys: plan.map(item => item.key), updateLatest }
}

export async function backfillReleaseToR2({
  tag,
  repo,
  env = process.env,
  updateLatest,
  latestTag = latestGitHubReleaseTag,
  runCommand = run,
  upload = uploadDirectoryToR2,
}) {
  const version = tag?.startsWith('v') ? tag.slice(1) : ''
  if (tag !== `v${version}` || !versionPattern.test(version)) throw new Error('Invalid release tag')
  if (!repositoryPattern.test(repo) || repo.includes('..')) throw new Error('Invalid updater repository')
  r2Settings(env, { required: true })
  const publishLatest = await resolveUpdateLatest({ version, repository: repo, updateLatest, latestTag })
  const directory = await mkdtemp(join(tmpdir(), 'goalward-r2-backfill-'))
  try {
    const names = updaterArtifactNames(version)
    const files = [names.archive, names.signature, dmgFileName(version), names.manifest]
    runCommand('gh', ['release', 'download', tag, '-R', repo, '-D', directory, ...files.flatMap(file => ['-p', file])])
    const manifest = JSON.parse(await readFile(join(directory, names.manifest), 'utf8'))
    const expected = `https://github.com/${repo}/releases/download/v${version}/${names.archive}`
    if (manifest?.platforms?.['darwin-aarch64']?.url !== expected) throw new Error('Downloaded manifest does not point at this GitHub Release')
    const rewritten = rewriteUpdaterManifestForR2(manifest)
    const signatureFile = (await readFile(join(directory, names.signature), 'utf8')).trim()
    if (signatureFile !== rewritten.platforms['darwin-aarch64'].signature) throw new Error('Downloaded signature file does not match latest.json')
    // Await the upload before finally removes the staging directory. Returning the
    // promise alone lets that cleanup race the upload's file reads.
    return await upload(directory, version, env, { updateLatest: publishLatest })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function option(args, name) {
  const index = args.indexOf(name)
  if (index === -1 || index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`)
  return args[index + 1]
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'upload') {
    const version = option(args, '--version')
    const directory = option(args, '--directory')
    if (r2Settings(process.env).skip) {
      await uploadDirectoryToR2(directory, version)
      recordPublishedLatest(false)
      return
    }
    const updateLatest = await resolveUpdateLatest({ version, repository: process.env.GITHUB_REPOSITORY, updateLatest: parseUpdateLatest(args) })
    const result = await uploadDirectoryToR2(directory, version, process.env, { updateLatest })
    recordPublishedLatest(Boolean(result.uploaded && result.updateLatest))
    return
  }
  if (command === 'backfill') {
    const result = await backfillReleaseToR2({ tag: option(args, '--tag'), repo: option(args, '--repo'), updateLatest: parseUpdateLatest(args) })
    recordPublishedLatest(Boolean(result.uploaded && result.updateLatest))
    return
  }
  throw new Error('Usage: node scripts/r2-release.mjs upload --directory DIR --version VERSION [--update-latest true|false] | backfill --tag vX.Y.Z --repo OWNER/REPO [--update-latest true|false]')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
