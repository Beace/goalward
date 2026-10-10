import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const encodeHash = bytes => createHash('sha256').update(bytes).digest('hex')

function base64(value, label) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`Invalid ${label} encoding`)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error(`Invalid ${label} encoding`)
  return bytes
}

function publicKeyBytes(encodedKey) {
  const lines = base64(encodedKey?.trim(), 'updater public key').toString('utf8').trimEnd().split('\n')
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment: ')) throw new Error('Invalid updater public key')
  const bytes = base64(lines[1], 'minisign public key')
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString() !== 'Ed') throw new Error('Unsupported updater public key')
  return bytes
}

export function updaterPublicKeyHash(encodedKey) {
  return encodeHash(publicKeyBytes(encodedKey))
}

// Tauri uses a base64-wrapped minisign signature. Verify the prehashed artifact
// and the trusted comment independently, as minisign-verify does in the plugin.
// Node's Ed25519 and BLAKE2b implementations avoid another signing dependency.
export function verifyUpdaterSignature(artifact, encodedSignature, encodedKey, expectedVersion) {
  const key = publicKeyBytes(encodedKey)
  const lines = base64(encodedSignature?.trim(), 'updater signature').toString('utf8').trimEnd().split('\n')
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || !lines[2].startsWith('trusted comment: ')) throw new Error('Invalid updater signature')
  const signature = base64(lines[1], 'minisign signature')
  const globalSignature = base64(lines[3], 'minisign comment signature')
  if (signature.length !== 74 || globalSignature.length !== 64 || signature.subarray(0, 2).toString() !== 'ED') throw new Error('Unsupported updater signature')
  if (!signature.subarray(2, 10).equals(key.subarray(2, 10))) throw new Error('Updater signature does not match the configured public key')
  const ed25519Key = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
    format: 'der', type: 'spki',
  })
  const rawSignature = signature.subarray(10)
  const trustedComment = lines[2].slice('trusted comment: '.length)
  const digest = createHash('blake2b512').update(artifact).digest()
  if (!verify(null, digest, ed25519Key, rawSignature)
    || !verify(null, Buffer.concat([rawSignature, Buffer.from(trustedComment)]), ed25519Key, globalSignature)) {
    throw new Error('Updater artifact or trusted comment failed signature verification')
  }
  if (expectedVersion !== undefined) {
    if (!versionPattern.test(expectedVersion)) throw new Error('Invalid updater version')
    const signedVersions = trustedComment.split('\t').filter(field => field.startsWith('version:'))
    if (signedVersions.length !== 1 || signedVersions[0] !== `version:${expectedVersion}`) throw new Error('Updater signature does not bind the expected release version')
  }
  return trustedComment
}

export function updaterArtifactNames(version) {
  if (!versionPattern.test(version)) throw new Error('Invalid updater version')
  const archive = `Goalward_${version}_macos-universal.app.tar.gz`
  return { archive, signature: `${archive}.sig`, manifest: 'latest.json' }
}

export function createUpdaterManifest({ version, repo, signature, publishedAt }) {
  const { archive } = updaterArtifactNames(version)
  if (!repositoryPattern.test(repo) || repo.includes('..')) throw new Error('Invalid updater repository')
  if (typeof publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(publishedAt) || Number.isNaN(Date.parse(publishedAt))) throw new Error('Invalid updater publication date')
  base64(signature?.trim(), 'updater signature')
  const platform = {
    url: `https://github.com/${repo}/releases/download/v${version}/${archive}`,
    signature: signature.trim(),
  }
  return {
    version,
    notes: `Goalward ${version}. See https://github.com/${repo}/releases/tag/v${version} for changes. This macOS trial build is ad-hoc signed and not notarized by Apple.`,
    pub_date: publishedAt,
    platforms: { 'darwin-aarch64': { ...platform }, 'darwin-x86_64': { ...platform } },
  }
}

export async function verifyUpdaterRelease(directory, { version, repo, publicKey }) {
  const names = updaterArtifactNames(version)
  const [archive, signature, manifestText, infoText] = await Promise.all([
    readFile(join(directory, names.archive)), readFile(join(directory, names.signature), 'utf8'),
    readFile(join(directory, names.manifest), 'utf8'), readFile(join(directory, 'BUILD-INFO.json'), 'utf8'),
  ])
  const info = JSON.parse(infoText)
  const manifest = JSON.parse(manifestText)
  if (info.version !== version || info.architecture !== 'universal' || !Array.isArray(info.artifacts)) throw new Error('Updater build metadata has an unexpected version or architecture')
  verifyUpdaterSignature(archive, signature, publicKey, version)
  const expectedManifest = createUpdaterManifest({ version, repo, signature, publishedAt: info.builtAt })
  if (!isDeepStrictEqual(manifest, expectedManifest)) throw new Error('Updater manifest differs from the verified release version, platforms, URL, or signature')
  const expectedUpdater = { ...names, publicKeySha256: updaterPublicKeyHash(publicKey), signatureVersion: version }
  if (!isDeepStrictEqual(info.updater, expectedUpdater)) throw new Error('Build metadata does not describe the verified updater artifacts and public key')
  for (const name of Object.values(names)) {
    const entries = info.artifacts.filter(item => item.file === name)
    if (entries.length !== 1 || basename(name) !== name) throw new Error('Build metadata must identify every updater artifact exactly once')
    const bytes = await readFile(join(directory, name))
    if (entries[0].bytes !== bytes.length || entries[0].sha256 !== encodeHash(bytes)) throw new Error(`Updater artifact checksum differs from build metadata: ${name}`)
  }
  return expectedUpdater
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, version, repo, ...extra] = process.argv.slice(2)
  if (command !== 'verify' || !directory || !version || !repo || extra.length) throw new Error('Usage: node scripts/updater-artifacts.mjs verify OUTPUT VERSION OWNER/REPO')
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
  await verifyUpdaterRelease(directory, { version, repo, publicKey: config.plugins?.updater?.pubkey })
  console.log(`Verified signed updater artifacts for Goalward ${version}`)
}
