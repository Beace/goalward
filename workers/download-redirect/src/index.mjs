export const LATEST_MANIFEST_URL = 'https://releases.goalward.dev/latest.json'
export const GITHUB_RELEASES_URL = 'https://github.com/Beace/goalward/releases'
export const DOWNLOAD_ALIASES = ['/download/Goalward.dmg', '/download/latest', '/download/macos']
export const MANIFEST_CACHE_TTL = 60

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function versionedDmgUrl(version) {
  if (!versionPattern.test(version)) throw new Error('Invalid updater version')
  return `https://releases.goalward.dev/v${version}/Goalward_${version}_macos-universal.dmg`
}

function redirect(location, cacheControl) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': cacheControl },
  })
}

export async function handleDownloadRequest(request, fetchImpl = globalThis.fetch) {
  const url = new URL(request.url)
  if (!DOWNLOAD_ALIASES.includes(url.pathname)) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  try {
    // JSON is not cached unless cacheEverything is set. cacheTtl overrides the origin max-age.
    const response = await fetchImpl(LATEST_MANIFEST_URL, {
      cf: { cacheTtl: MANIFEST_CACHE_TTL, cacheEverything: true },
    })
    if (!response?.ok) throw new Error('Updater manifest request failed')
    const manifest = await response.json()
    return redirect(versionedDmgUrl(manifest?.version), 'public, max-age=60')
  } catch {
    return redirect(GITHUB_RELEASES_URL, 'no-store')
  }
}

export default {
  fetch(request) {
    return handleDownloadRequest(request)
  },
}
