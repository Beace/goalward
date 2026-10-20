import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dmgFileName, RELEASES_ORIGIN } from './r2-release.mjs'

export const DOWNLOAD_LINK_START = '<!-- download-link:start -->'
export const DOWNLOAD_LINK_END = '<!-- download-link:end -->'
export const GITHUB_RELEASES_URL = 'https://github.com/Beace/goalward/releases'

function versionedDmgPattern() {
  return /https:\/\/releases\.goalward\.dev\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\/Goalward_\1\.\2\.\3_macos-universal\.dmg/g
}

export function versionedDmgUrl(version) {
  return `${RELEASES_ORIGIN}/v${version}/${dmgFileName(version)}`
}

export function updateReadmeDownload(text, version) {
  const url = versionedDmgUrl(version)
  const start = text.indexOf(DOWNLOAD_LINK_START)
  const end = text.indexOf(DOWNLOAD_LINK_END)
  if (start === -1 || end === -1 || end < start) throw new Error('README is missing download-link markers')
  if (text.indexOf(DOWNLOAD_LINK_START, start + 1) !== -1 || text.indexOf(DOWNLOAD_LINK_END, end + 1) !== -1) {
    throw new Error('README contains more than one download-link block')
  }
  const blockStart = start + DOWNLOAD_LINK_START.length
  const block = text.slice(blockStart, end)
  if (!block.includes(GITHUB_RELEASES_URL)) throw new Error('README download block is missing the GitHub Releases link')
  const matches = block.match(versionedDmgPattern())
  if (!matches || matches.length !== 1) throw new Error('README download block must contain one versioned DMG URL')
  if (matches[0] === url) return { text, changed: false }
  return { text: `${text.slice(0, blockStart)}${block.replace(versionedDmgPattern(), url)}${text.slice(end)}`, changed: true }
}

function isCurrentReadme(text, version) {
  try {
    return typeof text === 'string' && !updateReadmeDownload(text, version).changed
  } catch {
    return false
  }
}

export function readmeDownloadDecision(version, mainTexts, branchTexts) {
  const url = versionedDmgUrl(version)
  const files = mainTexts.map(text => updateReadmeDownload(text, version))
  if (files.every(file => !file.changed)) return { action: 'skip', reason: 'up-to-date', url }
  const branchReady = Array.isArray(branchTexts)
    && branchTexts.length === mainTexts.length
    && branchTexts.every(text => isCurrentReadme(text, version))
  if (branchReady) return { action: 'reuse', reason: 'branch-current', url }
  return { action: 'push', reason: 'update', url, files }
}

export function readmeFilesIn(root) {
  return readdirSync(root)
    .filter(name => /^README.*\.md$/.test(name) && readFileSync(join(root, name), 'utf8').includes(DOWNLOAD_LINK_START))
    .sort()
}

export function updateReadmeDownloadFiles(root, version) {
  const names = readmeFilesIn(root)
  if (!names.length) throw new Error('No README contains download-link markers')
  const results = []
  for (const name of names) {
    const path = join(root, name)
    const result = updateReadmeDownload(readFileSync(path, 'utf8'), version)
    if (result.changed) writeFileSync(path, result.text)
    results.push({ name, changed: result.changed })
  }
  return results
}

function main() {
  const version = process.argv[2]
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/update-readme-download.mjs X.Y.Z')
  const root = fileURLToPath(new URL('..', import.meta.url))
  for (const result of updateReadmeDownloadFiles(root, version)) {
    console.log(result.changed ? `Updated ${result.name}` : `${result.name} already points at ${versionedDmgUrl(version)}`)
  }
}

if (process.argv[1] && process.argv[1].endsWith('update-readme-download.mjs')) {
  main()
}
