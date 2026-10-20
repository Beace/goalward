import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createUpdaterManifest, resolveUpdaterPrivateKey, updaterArtifactNames, updaterPublicKeyHash, verifyUpdaterRelease, verifyUpdaterSignature } from './updater-artifacts.mjs'
import { GITHUB_FALLBACK_MANIFEST_URL, LATEST_CACHE_CONTROL, R2_LATEST_JSON_URL, RELEASES_ORIGIN, VERSIONED_CACHE_CONTROL, awsPutObjectArgs, backfillReleaseToR2, r2ArchiveUrl, r2ObjectPlan, r2Settings, rewriteUpdaterManifestForR2, updaterEndpointOrder } from './r2-release.mjs'

const wrap = text => Buffer.from(text).toString('base64')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const version = '0.3.0'
const repo = 'Beace/goalward'
const publishedAt = '2026-10-10T06:00:00.000Z'

test('resolves an existing no-extension private-key path even when every path character is valid base64', async context => {
  // /tmp/key has the same ambiguity; use a unique portable fixture path.
  const directory = await mkdtemp(join(tmpdir(), 'GoalwardUpdaterKey'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'key')
  assert.match(path, /^[A-Za-z0-9+/]+$/)
  const content = wrap('untrusted comment: test private key\nRWQBAgME\n')
  await writeFile(path, `${content}\n`, { mode: 0o600 })
  assert.equal(await resolveUpdaterPrivateKey(path), content)
  assert.equal(await resolveUpdaterPrivateKey(content), content)
})

test('rejects a missing key path or malformed inline key without exposing supplied values', async () => {
  const input = '/path/with/key/that/does/not/exist'
  await assert.rejects(resolveUpdaterPrivateKey(input), error => !error.message.includes(input))
  await assert.rejects(resolveUpdaterPrivateKey(''), /TAURI_SIGNING_PRIVATE_KEY is required/)
  await assert.rejects(resolveUpdaterPrivateKey(wrap('private secret fixture')), error => !error.message.includes('private secret fixture'))
})

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

test('rewrites latest.json package URLs to the versioned R2 host and leaves the signature', () => {
  const fixture = signer()
  const signature = fixture.signature(Buffer.from('updater'))
  const manifest = createUpdaterManifest({ version, repo, signature, publishedAt })
  const original = structuredClone(manifest)
  const rewritten = rewriteUpdaterManifestForR2(manifest)
  assert.deepEqual(manifest, original)
  assert.equal(rewritten.platforms['darwin-aarch64'].url, r2ArchiveUrl(version))
  assert.equal(rewritten.platforms['darwin-aarch64'].url, `${RELEASES_ORIGIN}/v0.3.0/Goalward_0.3.0_macos-universal.app.tar.gz`)
  assert.equal(rewritten.platforms['darwin-x86_64'].url, rewritten.platforms['darwin-aarch64'].url)
  assert.equal(rewritten.platforms['darwin-aarch64'].signature, signature)
  assert.equal(rewritten.notes, original.notes)
  assert.equal(rewritten.pub_date, original.pub_date)
  assert.equal(original.platforms['darwin-aarch64'].url, 'https://github.com/Beace/goalward/releases/download/v0.3.0/Goalward_0.3.0_macos-universal.app.tar.gz')
})

test('rejects manifests that are already rewritten or point outside the GitHub release', () => {
  const signature = signer().signature(Buffer.from('updater'))
  const manifest = createUpdaterManifest({ version, repo, signature, publishedAt })
  assert.throws(() => rewriteUpdaterManifestForR2(rewriteUpdaterManifestForR2(manifest)), /GitHub Release/)
  for (const url of [
    'https://example.com/Goalward_0.3.0_macos-universal.app.tar.gz',
    'https://github.com/Beace/goalward/releases/download/v0.3.1/Goalward_0.3.0_macos-universal.app.tar.gz',
    'https://github.com/Beace/goalward/releases/download/v0.3.0/other.app.tar.gz',
    'http://github.com/Beace/goalward/releases/download/v0.3.0/Goalward_0.3.0_macos-universal.app.tar.gz',
  ]) {
    const copy = structuredClone(manifest)
    copy.platforms['darwin-aarch64'].url = url
    copy.platforms['darwin-x86_64'].url = url
    assert.throws(() => rewriteUpdaterManifestForR2(copy), /GitHub Release|platforms/)
  }
})

test('uploads versioned R2 objects before latest.json and keeps a short cache on the pointer', () => {
  const plan = r2ObjectPlan(version)
  assert.deepEqual(plan.map(item => item.key), [
    'v0.3.0/Goalward_0.3.0_macos-universal.app.tar.gz',
    'v0.3.0/Goalward_0.3.0_macos-universal.app.tar.gz.sig',
    'v0.3.0/Goalward_0.3.0_macos-universal.dmg',
    'v0.3.0/latest.json',
    'latest.json',
  ])
  assert.equal(plan.at(-1).key, 'latest.json')
  assert.equal(plan.at(-1).cacheControl, LATEST_CACHE_CONTROL)
  assert.equal(plan.at(-1).rewrite, true)
  for (const item of plan.slice(0, -1)) {
    assert.equal(item.cacheControl, VERSIONED_CACHE_CONTROL)
    assert.match(item.key, /^v0\.3\.0\//)
  }
  const settings = r2Settings({
    R2_ACCOUNT_ID: '98775cbe093085ec17c5fab233cd571f',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
  })
  const args = plan.map(item => awsPutObjectArgs(settings, item, item.rewrite ? '/tmp/latest.json' : `/dist/${item.file}`))
  assert.equal(args.at(-1)[args.at(-1).indexOf('--key') + 1], 'latest.json')
  assert.equal(args.at(-1)[args.at(-1).indexOf('--cache-control') + 1], 'public, max-age=60')
  assert.equal(args[0][args[0].indexOf('--cache-control') + 1], VERSIONED_CACHE_CONTROL)
  assert.equal(args[0][args[0].indexOf('--endpoint-url') + 1], 'https://98775cbe093085ec17c5fab233cd571f.r2.cloudflarestorage.com')
  assert.equal(settings.bucket, 'goalward-releases')
})

test('skips R2 when every credential is absent and fails when only some are set', () => {
  assert.equal(r2Settings({}).skip, true)
  assert.equal(r2Settings({ R2_BUCKET: 'custom-bucket' }).skip, true)
  assert.throws(() => r2Settings({ R2_ACCOUNT_ID: '98775cbe093085ec17c5fab233cd571f' }), /incomplete/)
  assert.throws(() => r2Settings({}, { required: true }), /incomplete/)
  const custom = r2Settings({
    R2_ACCOUNT_ID: '98775cbe093085ec17c5fab233cd571f',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET: 'goalward-releases',
  })
  assert.equal(custom.skip, false)
  assert.equal(custom.bucket, 'goalward-releases')
})

test('workflows read the R2 account id from a variable and the keys from secrets', async () => {
  for (const file of ['.github/workflows/release.yml', '.github/workflows/backfill-r2.yml']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.match(text, /R2_ACCOUNT_ID:\s*\$\{\{\s*vars\.R2_ACCOUNT_ID\s*\|\|\s*secrets\.R2_ACCOUNT_ID\s*\}\}/)
    assert.match(text, /R2_ACCESS_KEY_ID:\s*\$\{\{\s*secrets\.R2_ACCESS_KEY_ID\s*\}\}/)
    assert.match(text, /R2_SECRET_ACCESS_KEY:\s*\$\{\{\s*secrets\.R2_SECRET_ACCESS_KEY\s*\}\}/)
    assert.doesNotMatch(text, /echo\b.*R2_(ACCOUNT_ID|ACCESS_KEY_ID|SECRET_ACCESS_KEY)/)
    assert.doesNotMatch(text, /vars\.R2_ACCESS_KEY_ID|vars\.R2_SECRET_ACCESS_KEY/)
  }
})

test('lists the R2 manifest before the GitHub manifest in app config and endpoint order', async () => {
  const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  assert.deepEqual(config.plugins.updater.endpoints, updaterEndpointOrder())
  assert.equal(config.plugins.updater.endpoints[0], R2_LATEST_JSON_URL)
  assert.equal(config.plugins.updater.endpoints[1], GITHUB_FALLBACK_MANIFEST_URL)
  assert.deepEqual(updaterEndpointOrder('https://github.com/Beace/goalward/releases/download/v0.5.1/latest.json'), [
    R2_LATEST_JSON_URL,
    'https://github.com/Beace/goalward/releases/download/v0.5.1/latest.json',
  ])
  assert.match(config.app.security.csp, /connect-src[^;]*https:\/\/releases\.goalward\.dev/)
  assert.match(config.app.security.devCsp, /connect-src[^;]*https:\/\/releases\.goalward\.dev/)
  assert.doesNotMatch(config.app.security.csp, /https:\/\/github\.com/)
})

test('backfill keeps staged release files until the upload has read them', async () => {
  const releaseVersion = '0.5.1'
  const names = updaterArtifactNames(releaseVersion)
  const signature = signer().signature(Buffer.from('updater'))
  const manifest = createUpdaterManifest({ version: releaseVersion, repo, signature, publishedAt })
  const dmg = `Goalward_${releaseVersion}_macos-universal.dmg`
  let staged
  const result = await backfillReleaseToR2({
    tag: `v${releaseVersion}`,
    repo,
    env: {
      R2_ACCOUNT_ID: '98775cbe093085ec17c5fab233cd571f',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
    },
    runCommand(command, args) {
      assert.equal(command, 'gh')
      assert.deepEqual(args.slice(0, 5), ['release', 'download', `v${releaseVersion}`, '-R', repo])
      const directory = args[args.indexOf('-D') + 1]
      const patterns = args.flatMap((arg, index) => arg === '-p' ? [args[index + 1]] : [])
      assert.deepEqual(patterns, [names.archive, names.signature, dmg, names.manifest])
      writeFileSync(join(directory, names.archive), 'archive')
      writeFileSync(join(directory, names.signature), `${signature}\n`)
      writeFileSync(join(directory, dmg), 'dmg')
      writeFileSync(join(directory, names.manifest), `${JSON.stringify(manifest)}\n`)
    },
    async upload(directory) {
      staged = directory
      await new Promise(resolve => setTimeout(resolve, 40))
      assert.equal((await readFile(join(directory, names.signature), 'utf8')).trim(), signature)
      assert.equal(JSON.parse(await readFile(join(directory, names.manifest), 'utf8')).version, releaseVersion)
      return { uploaded: true, keys: ['latest.json'] }
    },
  })
  assert.equal(result.uploaded, true)
  await assert.rejects(readFile(join(staged, names.signature)), { code: 'ENOENT' })
})
