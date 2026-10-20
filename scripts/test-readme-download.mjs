import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ciChecksCoverHead,
  openReadmeDownloadPullRequest,
  parseCheckRuns,
  REQUIRED_CI_CHECKS,
} from './open-readme-download-pr.mjs'
import {
  readmeDownloadDecision,
  readmeFilesIn,
  updateReadmeDownload,
  updateReadmeDownloadFiles,
  versionedDmgUrl,
} from './update-readme-download.mjs'

const OLD_URL = 'https://releases.goalward.dev/v0.5.1/Goalward_0.5.1_macos-universal.dmg'
const NEW_URL = versionedDmgUrl('0.6.0')
const DECOY_URL = 'https://releases.goalward.dev/v0.1.0/Goalward_0.1.0_macos-universal.dmg'
const GITHUB_RELEASES = 'https://github.com/Beace/goalward/releases'

function readme(url, label) {
  return [
    '# Goalward',
    '',
    '<!-- download-link:start -->',
    `**[${label}](${url})**`,
    '',
    `Every version remains on [GitHub Releases](${GITHUB_RELEASES}).`,
    '<!-- download-link:end -->',
    '',
    `Historical note: ${DECOY_URL}`,
    '',
  ].join('\n')
}

test('rewrites only the versioned DMG URL inside the download markers', () => {
  const english = readme(OLD_URL, 'Download for macOS →')
  const chinese = readme(OLD_URL, '下载 macOS 安装包 →').replace(
    'Every version remains on [GitHub Releases]',
    '全部版本见 [GitHub Releases]',
  )
  const updated = updateReadmeDownload(english, '0.6.0')
  assert.equal(updated.changed, true)
  assert.match(updated.text, new RegExp(`<!-- download-link:start -->[\\s\\S]*${NEW_URL.replaceAll('.', '\\.')}[\\s\\S]*<!-- download-link:end -->`))
  assert.equal(updated.text.includes(OLD_URL), false)
  assert.match(updated.text, new RegExp(DECOY_URL.replaceAll('.', '\\.')))
  assert.match(updated.text, /Download for macOS/)
  assert.match(updated.text, new RegExp(GITHUB_RELEASES.replaceAll('.', '\\.')))
  const translated = updateReadmeDownload(chinese, '0.6.0')
  assert.match(translated.text, /下载 macOS 安装包/)
  assert.match(translated.text, /全部版本见/)
  assert.equal(updateReadmeDownload(updated.text, '0.6.0').changed, false)
  assert.throws(() => updateReadmeDownload('no markers', '0.6.0'), /download-link markers/)
  assert.throws(() => updateReadmeDownload(english.replace(GITHUB_RELEASES, 'https://example.invalid'), '0.6.0'), /GitHub Releases/)
  assert.throws(() => updateReadmeDownload(`${english}\n${english}`, '0.6.0'), /more than one/)
  assert.throws(() => updateReadmeDownload(english, '0.6'), /Invalid updater version/)
  const doubled = english.replace(OLD_URL, `${OLD_URL} and ${OLD_URL}`)
  assert.throws(() => updateReadmeDownload(doubled, '0.6.0'), /one versioned DMG URL/)
})

test('chooses skip, reuse, or push for the README download branch', () => {
  const current = readme(NEW_URL, 'Download for macOS →')
  const previous = readme(OLD_URL, 'Download for macOS →')
  assert.deepEqual(readmeDownloadDecision('0.6.0', [current], null).action, 'skip')
  assert.deepEqual(readmeDownloadDecision('0.6.0', [previous], [current]).action, 'reuse')
  assert.deepEqual(readmeDownloadDecision('0.6.0', [previous], [previous]).action, 'push')
  assert.deepEqual(readmeDownloadDecision('0.6.0', [previous], null).action, 'push')
  assert.deepEqual(readmeDownloadDecision('0.6.0', [previous], ['not a readme']).action, 'push')
  const pushed = readmeDownloadDecision('0.6.0', [previous, previous], [current])
  assert.equal(pushed.action, 'push')
  assert.equal(pushed.files.every(file => file.text.includes(NEW_URL)), true)
})

test('updates every marked README and leaves unmarked files alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goalward-readme-files-'))
  try {
    await writeFile(join(root, 'README.md'), readme(OLD_URL, 'Download for macOS →'))
    await writeFile(join(root, 'README.zh-CN.md'), readme(OLD_URL, '下载 macOS 安装包 →'))
    await writeFile(join(root, 'README-notes.md'), 'no download marker\n')
    assert.deepEqual(readmeFilesIn(root), ['README.md', 'README.zh-CN.md'])
    const results = updateReadmeDownloadFiles(root, '0.6.0')
    assert.deepEqual(results, [
      { name: 'README.md', changed: true },
      { name: 'README.zh-CN.md', changed: true },
    ])
    assert.match(await readFile(join(root, 'README.zh-CN.md'), 'utf8'), /下载 macOS 安装包/)
    assert.equal(await readFile(join(root, 'README-notes.md'), 'utf8'), 'no download marker\n')
    assert.equal(updateReadmeDownloadFiles(root, '0.6.0').every(file => !file.changed), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recognizes the required CI checks on the pull request head', () => {
  assert.deepEqual(REQUIRED_CI_CHECKS, ['frontend-tests', 'rust-tests', 'release-tooling'])
  const success = parseCheckRuns([
    'frontend-tests\tcompleted\tsuccess',
    'rust-tests\tcompleted\tsuccess',
    'release-tooling\tcompleted\tsuccess',
    'other\tcompleted\tfailure',
  ].join('\n'))
  assert.equal(ciChecksCoverHead(success), true)
  assert.equal(ciChecksCoverHead([
    { name: 'frontend-tests', status: 'queued', conclusion: null },
    { name: 'rust-tests', status: 'in_progress', conclusion: null },
    { name: 'release-tooling', status: 'completed', conclusion: 'success' },
  ]), true)
  assert.equal(ciChecksCoverHead(success.filter(run => run.name !== 'rust-tests')), false)
  assert.equal(ciChecksCoverHead(success.map(run => run.name === 'frontend-tests' ? { ...run, conclusion: 'failure' } : run)), false)
  assert.deepEqual(parseCheckRuns('\nfrontend-tests\tqueued\t\n'), [{ name: 'frontend-tests', status: 'queued', conclusion: null }])
})

test('wires the release and backfill workflows to the README pull request', async () => {
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const publish = release.slice(release.indexOf('\n  publish:\n'))
  assert.match(publish, /contents: write\n\s+pull-requests: write\n\s+actions: write/)
  assert.match(publish, /if: steps\.r2\.outputs\.published_latest == 'true'/)
  assert.match(publish, /node scripts\/open-readme-download-pr\.mjs --version "\$VERSION"/)
  const upload = publish.match(/run: node scripts\/r2-release\.mjs upload[^\n]*/)?.[0] ?? ''
  assert.equal(upload, 'run: node scripts/r2-release.mjs upload --directory "releases/$VERSION" --version "$VERSION"')
  assert.match(publish, /Omitting --update-latest publishes latest\.json only when this tag is the newest GitHub Release\./)
  const backfill = await readFile(new URL('../.github/workflows/backfill-r2.yml', import.meta.url), 'utf8')
  assert.match(backfill, /contents: write\n\s+pull-requests: write\n\s+actions: write/)
  assert.match(backfill, /if: steps\.r2\.outputs\.published_latest == 'true'/)
  assert.match(backfill, /node scripts\/open-readme-download-pr\.mjs --version "\$\{RELEASE_TAG#v\}"/)
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(ci, /workflow_dispatch:/)
  assert.match(ci, /release-tooling:/)
  assert.match(ci, /frontend-tests:/)
  assert.match(ci, /rust-tests:/)
  assert.match(ci, /node --test scripts\/test-readme-download\.mjs/)
  assert.equal(ci.includes('workers/download-redirect'), false)
  await assert.rejects(readFile(new URL('../.github/workflows/deploy-download-redirect.yml', import.meta.url)))
  await assert.rejects(readFile(new URL('../workers/download-redirect/wrangler.toml', import.meta.url)))
})

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`)
  return (result.stdout || '').trim()
}

function ghCalls(log) {
  return log.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

test('opens one ready README pull request and dispatches CI on its head', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goalward-readme-pr-'))
  const repo = join(root, 'repo')
  const origin = join(root, 'origin.git')
  const bin = join(root, 'bin')
  const log = join(root, 'gh.log')
  const prFile = join(root, 'pr.json')
  const previousPath = process.env.PATH
  const previousChecks = process.env.GH_CHECKS
  try {
    mkdirSync(repo)
    mkdirSync(bin)
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n')
const [command, subcommand] = args
if (command === 'auth' && subcommand === 'setup-git') process.exit(0)
if (command === 'pr' && subcommand === 'list') {
  process.stdout.write(existsSync(process.env.GH_PR) ? '[' + readFileSync(process.env.GH_PR, 'utf8') + ']' : '[]')
  process.exit(0)
}
if (command === 'pr' && subcommand === 'create') {
  if (args.includes('--draft')) process.exit(2)
  writeFileSync(process.env.GH_PR, JSON.stringify({ number: 41, url: 'https://github.com/Beace/goalward/pull/41' }))
  process.exit(0)
}
if (command === 'pr' && subcommand === 'view') {
  process.stdout.write(readFileSync(process.env.GH_PR, 'utf8'))
  process.exit(0)
}
if (command === 'pr' && subcommand === 'merge') {
  for (const flag of ['--auto', '--squash', '--delete-branch']) {
    if (!args.includes(flag)) process.exit(3)
  }
  process.exit(0)
}
if (command === 'api') {
  if (process.env.GH_CHECKS === 'success') {
    process.stdout.write(['frontend-tests', 'rust-tests', 'release-tooling'].map(name => name + '\\tcompleted\\tsuccess').join('\\n') + '\\n')
  }
  process.exit(0)
}
if (command === 'workflow' && subcommand === 'run' && args[2] === 'ci.yml') process.exit(0)
process.exit(4)
`)
    chmodSync(join(bin, 'gh'), 0o755)
    git(repo, ['init', '-b', 'main'])
    git(repo, ['config', 'user.email', 'dev@example.com'])
    git(repo, ['config', 'user.name', 'Dev'])
    writeFileSync(join(repo, 'README.md'), readme(OLD_URL, 'Download for macOS →'))
    writeFileSync(join(repo, 'README.zh-CN.md'), readme(OLD_URL, '下载 macOS 安装包 →'))
    git(repo, ['add', 'README.md', 'README.zh-CN.md'])
    git(repo, ['commit', '-m', 'initial'])
    git(root, ['init', '--bare', '-b', 'main', origin])
    git(repo, ['remote', 'add', 'origin', origin])
    git(repo, ['push', '-u', 'origin', 'main'])
    process.env.PATH = `${bin}:${previousPath}`
    process.env.GH_LOG = log
    process.env.GH_PR = prFile
    delete process.env.GH_CHECKS
    const first = openReadmeDownloadPullRequest({ version: '0.6.0', repository: 'Beace/goalward', repoRoot: repo })
    assert.equal(first.action, 'push')
    assert.equal(first.url, 'https://github.com/Beace/goalward/pull/41')
    const branch = 'chore/readme-download-v0.6.0'
    git(repo, ['fetch', 'origin', branch])
    assert.equal(git(repo, ['log', '-1', '--format=%an <%ae>', `origin/${branch}`]), 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>')
    assert.equal(git(repo, ['log', '-1', '--format=%s', `origin/${branch}`]), 'docs: point the macOS download at Goalward 0.6.0')
    const pushed = git(repo, ['show', `origin/${branch}:README.zh-CN.md`])
    assert.match(pushed, new RegExp(NEW_URL.replaceAll('.', '\\.')))
    assert.match(pushed, /下载 macOS 安装包/)
    assert.match(pushed, new RegExp(DECOY_URL.replaceAll('.', '\\.')))
    let calls = ghCalls(await readFile(log, 'utf8'))
    assert.equal(calls.filter(args => args[0] === 'pr' && args[1] === 'create').length, 1)
    assert.equal(calls.some(args => args[0] === 'pr' && args[1] === 'create' && args.includes('--draft')), false)
    assert.deepEqual(calls.find(args => args[0] === 'pr' && args[1] === 'merge').slice(3), ['--repo', 'Beace/goalward', '--auto', '--squash', '--delete-branch'])
    assert.equal(calls.filter(args => args[0] === 'workflow').length, 1)
    assert.deepEqual(calls.find(args => args[0] === 'workflow'), ['workflow', 'run', 'ci.yml', '--repo', 'Beace/goalward', '--ref', branch])

    git(repo, ['checkout', '-B', branch, `origin/${branch}`])
    writeFileSync(join(repo, 'README.md'), readme(OLD_URL, 'Download for macOS →'))
    writeFileSync(join(repo, 'README.zh-CN.md'), readme(OLD_URL, '下载 macOS 安装包 →'))
    git(repo, ['add', 'README.md', 'README.zh-CN.md'])
    git(repo, ['commit', '-m', 'revert download link'])
    const reverted = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['push', 'origin', branch])
    git(repo, ['checkout', 'main'])
    const replaced = openReadmeDownloadPullRequest({ version: '0.6.0', repository: 'Beace/goalward', repoRoot: repo })
    assert.equal(replaced.action, 'push')
    assert.notEqual(replaced.sha, reverted)
    assert.match(git(repo, ['show', `origin/${branch}:README.md`]), new RegExp(NEW_URL.replaceAll('.', '\\.')))
    calls = ghCalls(await readFile(log, 'utf8'))
    assert.equal(calls.filter(args => args[0] === 'pr' && args[1] === 'create').length, 1)
    assert.equal(calls.filter(args => args[0] === 'workflow').length, 2)
    assert.equal(calls.some(args => args[0] === 'pr' && args[1] === 'list' && args.includes(`Beace:${branch}`)), true)

    process.env.GH_CHECKS = 'success'
    const reused = openReadmeDownloadPullRequest({ version: '0.6.0', repository: 'Beace/goalward', repoRoot: repo })
    assert.equal(reused.action, 'reuse')
    assert.equal(reused.sha, replaced.sha)
    calls = ghCalls(await readFile(log, 'utf8'))
    assert.equal(calls.filter(args => args[0] === 'workflow').length, 2)
    assert.equal(calls.filter(args => args[0] === 'pr' && args[1] === 'merge').length, 3)

    writeFileSync(join(repo, 'README.md'), readme(NEW_URL, 'Download for macOS →'))
    writeFileSync(join(repo, 'README.zh-CN.md'), readme(NEW_URL, '下载 macOS 安装包 →'))
    git(repo, ['add', 'README.md', 'README.zh-CN.md'])
    git(repo, ['commit', '-m', 'update main'])
    git(repo, ['push', 'origin', 'main'])
    const skipped = openReadmeDownloadPullRequest({ version: '0.6.0', repository: 'Beace/goalward', repoRoot: repo })
    assert.deepEqual(skipped, { action: 'skip', url: NEW_URL })
    calls = ghCalls(await readFile(log, 'utf8'))
    assert.equal(calls.filter(args => args[0] === 'pr' && args[1] === 'create').length, 1)
  } finally {
    process.env.PATH = previousPath
    if (previousChecks === undefined) delete process.env.GH_CHECKS
    else process.env.GH_CHECKS = previousChecks
    delete process.env.GH_LOG
    delete process.env.GH_PR
    await rm(root, { recursive: true, force: true })
  }
})
