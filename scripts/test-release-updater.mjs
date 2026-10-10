import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createUpdaterManifest, updaterArtifactNames, updaterPublicKeyHash, verifyUpdaterRelease, verifyUpdaterSignature } from './updater-artifacts.mjs'

const wrap = text => Buffer.from(text).toString('base64')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const version = '0.3.0'
const repo = 'Beace/goalward'
const publishedAt = '2026-10-10T06:00:00.000Z'

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyId = randomBytes(8)
  const keyPacket = Buffer.concat([Buffer.from('Ed'), keyId, publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)])
  const key = wrap(`untrusted comment: test public key\n${keyPacket.toString('base64')}\n`)
  return {
    key,
    signature(bytes, trustedComment = `timestamp:1791612000\tfile:Goalward.app.tar.gz\tversion:${version}`) {
      const artifactSignature = sign(null, createHash('blake2b512').update(bytes).digest(), privateKey)
      const packet = Buffer.concat([Buffer.from('ED'), keyId, artifactSignature])
      const commentSignature = sign(null, Buffer.concat([artifactSignature, Buffer.from(trustedComment)]), privateKey)
      return wrap(`untrusted comment: signature from tauri secret key\n${packet.toString('base64')}\ntrusted comment: ${trustedComment}\n${commentSignature.toString('base64')}\n`)
    },
  }
}

test('verifies an independent minisign-verify reference vector', () => {
  // Published in minisign-verify 0.2.3's Rust documentation, rather than signed
  // by our test helper. This checks compatibility with the upstream format.
  const key = wrap('untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n')
  const signature = wrap('untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==\n')
  assert.match(verifyUpdaterSignature(Buffer.from('test'), signature, key), /file:test/)
})

test('verifies a signature bound to the expected release version', () => {
  const fixture = signer()
  const bytes = Buffer.from('universal updater archive')
  assert.match(verifyUpdaterSignature(bytes, fixture.signature(bytes), fixture.key, version), /version:0\.3\.0$/)
})

test('rejects tampered archive bytes, mismatched keys, and tampered trusted comments', () => {
  const fixture = signer()
  const bytes = Buffer.from('universal updater archive')
  const signature = fixture.signature(bytes)
  assert.throws(() => verifyUpdaterSignature(Buffer.from('modified'), signature, fixture.key, version), /signature verification/)
  assert.throws(() => verifyUpdaterSignature(bytes, signature, signer().key, version), /public key/)
  const tampered = wrap(Buffer.from(signature, 'base64').toString().replace('version:0.3.0', 'version:0.4.0'))
  assert.throws(() => verifyUpdaterSignature(bytes, tampered, fixture.key, '0.4.0'), /signature verification/)
})

test('rejects wrong, missing, or duplicate signed versions even with valid cryptographic signatures', () => {
  const fixture = signer()
  const bytes = Buffer.from('updater')
  for (const comment of ['timestamp:1\tversion:0.2.0', 'timestamp:1', 'timestamp:1\tversion:0.3.0\tversion:0.3.0']) {
    assert.throws(() => verifyUpdaterSignature(bytes, fixture.signature(bytes, comment), fixture.key, version), /expected release version/)
  }
})

test('rejects malformed and legacy signature formats', () => {
  const fixture = signer()
  const bytes = Buffer.from('updater')
  assert.throws(() => verifyUpdaterSignature(bytes, 'not a signature', fixture.key, version), /encoding/)
  assert.throws(() => updaterPublicKeyHash('not a public key'), /encoding/)
  const lines = Buffer.from(fixture.signature(bytes), 'base64').toString().trimEnd().split('\n')
  const packet = Buffer.from(lines[1], 'base64')
  packet.write('Ed', 0)
  lines[1] = packet.toString('base64')
  assert.throws(() => verifyUpdaterSignature(bytes, wrap(lines.join('\n')), fixture.key, version), /Unsupported/)
})

test('publishes both macOS architectures at the same versioned universal archive URL', () => {
  const fixture = signer()
  const signature = fixture.signature(Buffer.from('updater'))
  const manifest = createUpdaterManifest({ version, repo, signature, publishedAt })
  assert.deepEqual(Object.keys(manifest.platforms), ['darwin-aarch64', 'darwin-x86_64'])
  assert.deepEqual(manifest.platforms['darwin-aarch64'], manifest.platforms['darwin-x86_64'])
  assert.equal(manifest.platforms['darwin-aarch64'].url, 'https://github.com/Beace/goalward/releases/download/v0.3.0/Goalward_0.3.0_macos-universal.app.tar.gz')
  assert.equal(manifest.platforms['darwin-aarch64'].signature, signature)
  assert.equal(manifest.version, version)
})

test('rejects unsafe versions, repositories, publication dates, or missing signatures', () => {
  const signature = signer().signature(Buffer.from('updater'))
  assert.throws(() => updaterArtifactNames('../0.3.0'), /version/)
  assert.throws(() => updaterArtifactNames('01.3.0'), /version/)
  for (const invalid of [
    { repo: 'owner/../repo' }, { repo: 'https://github.com/owner/repo' },
    { publishedAt: 'today' }, { signature: '' },
  ]) assert.throws(() => createUpdaterManifest({ version, repo, signature, publishedAt, ...invalid }))
})

async function releaseFixture(context) {
  const fixture = signer()
  const directory = await mkdtemp(join(tmpdir(), 'goalward-updater-test-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const names = updaterArtifactNames(version)
  const archive = Buffer.from('a signed archive fixture')
  const signature = fixture.signature(archive)
  const manifest = createUpdaterManifest({ version, repo, signature, publishedAt })
  const contents = { [names.archive]: archive, [names.signature]: Buffer.from(`${signature}\n`), [names.manifest]: Buffer.from(JSON.stringify(manifest)) }
  const info = {
    version, architecture: 'universal', builtAt: publishedAt,
    updater: { ...names, publicKeySha256: updaterPublicKeyHash(fixture.key), signatureVersion: version },
    artifacts: Object.entries(contents).map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: hash(bytes) })),
  }
  for (const [file, bytes] of Object.entries(contents)) await writeFile(join(directory, file), bytes)
  await writeFile(join(directory, 'BUILD-INFO.json'), JSON.stringify(info))
  return { directory, options: { version, repo, publicKey: fixture.key }, manifest, info, names }
}

test('verifies complete updater artifacts and their recorded hashes', async context => {
  const fixture = await releaseFixture(context)
  assert.deepEqual(await verifyUpdaterRelease(fixture.directory, fixture.options), fixture.info.updater)
})

test('rejects manifests with wrong URL, missing platform, wrong version, or different signature', async context => {
  const fixture = await releaseFixture(context)
  const mutations = [
    manifest => { manifest.platforms['darwin-aarch64'].url = 'https://example.com/other.app.tar.gz' },
    manifest => { delete manifest.platforms['darwin-x86_64'] },
    manifest => { manifest.version = '0.4.0' },
    manifest => { manifest.platforms['darwin-x86_64'].signature = signer().signature(Buffer.from('other')) },
  ]
  for (const mutate of mutations) {
    const manifest = structuredClone(fixture.manifest)
    mutate(manifest)
    await writeFile(join(fixture.directory, fixture.names.manifest), JSON.stringify(manifest))
    await assert.rejects(verifyUpdaterRelease(fixture.directory, fixture.options), /Updater manifest differs/)
  }
})

test('rejects missing or duplicate artifact metadata and changed public-key fingerprint', async context => {
  const fixture = await releaseFixture(context)
  for (const mutate of [
    info => { info.artifacts.pop() },
    info => { info.artifacts.push(info.artifacts[0]) },
    info => { info.updater.publicKeySha256 = '0'.repeat(64) },
    info => { info.version = '0.4.0' },
    info => { info.artifacts[0].bytes += 1 },
  ]) {
    const info = structuredClone(fixture.info)
    mutate(info)
    await writeFile(join(fixture.directory, 'BUILD-INFO.json'), JSON.stringify(info))
    await assert.rejects(verifyUpdaterRelease(fixture.directory, fixture.options))
  }
})

test('rejects post-build artifact replacement', async context => {
  const fixture = await releaseFixture(context)
  const path = join(fixture.directory, fixture.names.archive)
  const bytes = await readFile(path)
  bytes[0] ^= 1
  await writeFile(path, bytes)
  await assert.rejects(verifyUpdaterRelease(fixture.directory, fixture.options), /signature verification/)
})
