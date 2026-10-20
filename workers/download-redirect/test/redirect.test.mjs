import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import worker, { DOWNLOAD_ALIASES, GITHUB_RELEASES_URL, LATEST_MANIFEST_URL, handleDownloadRequest, versionedDmgUrl } from '../src/index.mjs'

function manifestFetch(version, { ok = true, json = true } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (!ok) return new Response('missing', { status: 404 })
    if (!json) return new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } })
    return new Response(JSON.stringify({ version }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetchImpl }
}

async function redirectFor(pathname, fetchImpl) {
  return handleDownloadRequest(new Request(`https://releases.goalward.dev${pathname}`), fetchImpl)
}

test('redirects the stable download aliases to the versioned immutable DMG', async () => {
  assert.equal(versionedDmgUrl('0.6.0'), 'https://releases.goalward.dev/v0.6.0/Goalward_0.6.0_macos-universal.dmg')
  for (const pathname of DOWNLOAD_ALIASES) {
    const { calls, fetchImpl } = manifestFetch('0.6.0')
    const response = await redirectFor(`${pathname}?source=readme`, fetchImpl)
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('Location'), versionedDmgUrl('0.6.0'))
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=60')
    assert.equal(calls[0].url, LATEST_MANIFEST_URL)
    assert.deepEqual(calls[0].init.cf, { cacheTtl: 60, cacheEverything: true })
  }
  const head = await handleDownloadRequest(new Request('https://releases.goalward.dev/download/Goalward.dmg', { method: 'HEAD' }), manifestFetch('0.6.0').fetchImpl)
  assert.equal(head.status, 302)
  assert.equal(head.headers.get('Location'), versionedDmgUrl('0.6.0'))
})

test('falls back to GitHub Releases when the manifest cannot be used', async () => {
  const cases = [
    manifestFetch('0.6.0', { ok: false }).fetchImpl,
    manifestFetch('0.6.0', { json: false }).fetchImpl,
    manifestFetch('../0.6.0').fetchImpl,
    manifestFetch('0.6.0-beta.1').fetchImpl,
    manifestFetch(undefined).fetchImpl,
    async () => { throw new Error('network down') },
  ]
  for (const fetchImpl of cases) {
    const response = await redirectFor('/download/Goalward.dmg', fetchImpl)
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('Location'), GITHUB_RELEASES_URL)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  }
})

test('returns 404 for unknown download paths and 405 for other methods', async () => {
  const unused = async () => { throw new Error('manifest should not be fetched') }
  for (const pathname of ['/download/other', '/download/Goalward.dmg.sig', '/download/', '/latest.json']) {
    const response = await redirectFor(pathname, unused)
    assert.equal(response.status, 404)
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=60')
  }
  const posted = await handleDownloadRequest(new Request('https://releases.goalward.dev/download/Goalward.dmg', { method: 'POST' }), unused)
  assert.equal(posted.status, 405)
  const delegated = await worker.fetch(new Request('https://releases.goalward.dev/download/nope'))
  assert.equal(delegated.status, 404)
})

test('routes only download paths and deploys once from a manual workflow', async () => {
  const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8')
  assert.match(config, /pattern = "releases\.goalward\.dev\/download\/\*"/)
  assert.match(config, /zone_name = "goalward\.dev"/)
  assert.match(config, /account_id = "98775cbe093085ec17c5fab233cd571f"/)
  assert.match(config, /workers_dev = false/)
  assert.match(config, /preview_urls = false/)
  const workflow = await readFile(new URL('../../../.github/workflows/deploy-download-redirect.yml', import.meta.url), 'utf8')
  assert.match(workflow, /^name: Deploy download redirect Worker/m)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/)
  assert.match(workflow, /skipping the download redirect Worker deploy because CLOUDFLARE_API_TOKEN is not set/)
  assert.match(workflow, /wrangler@4\.151\.2/)
  assert.doesNotMatch(workflow, /echo\b.*\$\{?CLOUDFLARE_API_TOKEN/)
  const ci = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const jobs = ci.split(/^jobs:\n/m)[1]
  assert.deepEqual([...jobs.matchAll(/^ {2}([a-z0-9-]+):/gm)].map(match => match[1]), ['release-tooling', 'frontend-tests', 'rust-tests'])
  assert.match(jobs, /node --test workers\/download-redirect\/test\/redirect\.test\.mjs/)
})
