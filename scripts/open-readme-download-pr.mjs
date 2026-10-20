import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireGitHubToken } from './r2-release.mjs'
import {
  readmeDownloadDecision,
  readmeFilesIn,
  versionedDmgUrl,
} from './update-readme-download.mjs'

export const REQUIRED_CI_CHECKS = ['frontend-tests', 'rust-tests', 'release-tooling']
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function execute(command, args, options = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env }
  if (command === 'gh') requireGitHubToken(env)
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    cwd: options.cwd,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}${result.stdout || ''}`.replace(/https:\/\/x-access-token:[^@\s]+@/g, 'https://x-access-token:***@').trim()
    throw new Error(detail ? `${command} ${args[0] || ''} failed: ${detail}` : `${command} exited with status ${result.status}`)
  }
  return result.stdout ?? ''
}

function executeAllowingFailure(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
    cwd: options.cwd,
  })
  if (result.error || result.status !== 0) return null
  return result.stdout ?? ''
}

export function parseCheckRuns(stdout) {
  return String(stdout || '').split('\n').filter(Boolean).map(line => {
    const [name, status, conclusion] = line.split('\t')
    return { name, status, conclusion: conclusion || null }
  })
}

export function ciChecksCoverHead(checkRuns) {
  return REQUIRED_CI_CHECKS.every(name => (checkRuns || []).some(run => run.name === name && (
    run.status === 'queued'
    || run.status === 'in_progress'
    || (run.status === 'completed' && run.conclusion === 'success')
  )))
}

function pullRequestBody(version) {
  const url = versionedDmgUrl(version)
  return `## Summary

Point the README download link at the immutable R2 installer for Goalward ${version}: ${url}

GitHub Releases remains the link for every version.

## Validation

The release upload published top-level latest.json for this version. CI is dispatched with workflow_dispatch so the required frontend-tests, rust-tests, and release-tooling checks run on this pull request's head SHA.

## Language check

- [x] The PR title and description, code comments, unit test descriptions and synthetic data, and development process documents are in English. Product i18n text and exact localization or localized-data compatibility fixtures retain their required language.
`
}

export function openReadmeDownloadPullRequest({
  version,
  repository,
  repoRoot = process.cwd(),
  runCommand = execute,
  tryCommand = executeAllowingFailure,
} = {}) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid updater version')
  if (!repositoryPattern.test(repository) || repository.includes('..')) throw new Error('Invalid updater repository')
  const branch = `chore/readme-download-v${version}`
  const title = `docs: point the macOS download at Goalward ${version}`
  runCommand('git', ['fetch', '--no-tags', 'origin', 'main'], { cwd: repoRoot })
  const fetchedBranch = tryCommand('git', ['fetch', '--no-tags', 'origin', `${branch}:refs/remotes/origin/${branch}`], { cwd: repoRoot })
  const temp = mkdtempSync(join(tmpdir(), 'goalward-readme-pr-'))
  let bodyFile
  try {
    runCommand('git', ['worktree', 'add', '--detach', temp, 'origin/main'], { cwd: repoRoot })
    const names = readmeFilesIn(temp)
    if (!names.length) throw new Error('No README contains download-link markers')
    const mainTexts = names.map(name => readFileSync(join(temp, name), 'utf8'))
    const branchTexts = fetchedBranch === null ? null : names.map(name => tryCommand('git', ['show', `origin/${branch}:${name}`], { cwd: repoRoot }))
    const decision = readmeDownloadDecision(version, mainTexts, branchTexts)
    if (decision.action === 'skip') {
      console.log(`README download link already points at ${decision.url}`)
      return { action: 'skip', url: decision.url }
    }
    let sha
    if (decision.action === 'reuse') {
      sha = runCommand('git', ['rev-parse', `origin/${branch}`], { cwd: repoRoot }).trim()
      console.log(`Reusing ${branch} at ${sha}`)
    } else {
      for (const [index, name] of names.entries()) writeFileSync(join(temp, name), decision.files[index].text)
      runCommand('git', ['add', '--', ...names], { cwd: temp })
      runCommand('git', [
        '-c', 'user.name=github-actions[bot]',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        '-c', 'commit.gpgsign=false',
        'commit', '-m', title, '-m', 'Use the immutable R2 installer for this version.',
      ], { cwd: temp })
      runCommand('gh', ['auth', 'setup-git'], { cwd: repoRoot })
      // A missing remote branch has no lease to compare. An existing branch is replaced
      // only when it still points at the commit this run just fetched.
      const refspec = `HEAD:refs/heads/${branch}`
      if (fetchedBranch === null) {
        runCommand('git', ['push', 'origin', refspec], { cwd: temp })
      } else {
        const expected = runCommand('git', ['rev-parse', `origin/${branch}`], { cwd: repoRoot }).trim()
        runCommand('git', ['push', `--force-with-lease=refs/heads/${branch}:${expected}`, 'origin', refspec], { cwd: temp })
      }
      sha = runCommand('git', ['rev-parse', 'HEAD'], { cwd: temp }).trim()
      console.log(`Pushed ${branch} at ${sha}`)
    }
    bodyFile = join(tmpdir(), `goalward-readme-pr-body-${version}.md`)
    writeFileSync(bodyFile, pullRequestBody(version))
    const owner = repository.slice(0, repository.indexOf('/'))
    const listed = JSON.parse(runCommand('gh', ['pr', 'list', '--repo', repository, '--head', `${owner}:${branch}`, '--base', 'main', '--state', 'open', '--json', 'number,url'], { cwd: repoRoot }) || '[]')
    let number
    let prUrl
    if (listed.length) {
      number = listed[0].number
      prUrl = listed[0].url
      console.log(`Using pull request ${prUrl}`)
    } else {
      runCommand('gh', ['pr', 'create', '--repo', repository, '--base', 'main', '--head', branch, '--title', title, '--body-file', bodyFile], { cwd: repoRoot })
      const created = JSON.parse(runCommand('gh', ['pr', 'view', branch, '--repo', repository, '--json', 'number,url'], { cwd: repoRoot }))
      number = created.number
      prUrl = created.url
      console.log(`Opened pull request ${prUrl}`)
    }
    runCommand('gh', ['pr', 'merge', String(number), '--repo', repository, '--auto', '--squash', '--delete-branch'], { cwd: repoRoot })
    const checks = parseCheckRuns(runCommand('gh', ['api', '--paginate', `repos/${repository}/commits/${sha}/check-runs`, '--jq', '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv'], { cwd: repoRoot }))
    if (!ciChecksCoverHead(checks)) {
      // workflow_dispatch records frontend-tests, rust-tests, and release-tooling on this head SHA.
      // A pull request opened with GITHUB_TOKEN does not start the pull_request workflows.
      runCommand('gh', ['workflow', 'run', 'ci.yml', '--repo', repository, '--ref', branch], { cwd: repoRoot })
      console.log(`Dispatched CI for ${branch} at ${sha}`)
    } else {
      console.log(`CI checks already cover ${sha}`)
    }
    return { action: decision.action, sha, url: prUrl }
  } finally {
    if (bodyFile) rmSync(bodyFile, { force: true })
    tryCommand('git', ['worktree', 'remove', '--force', temp], { cwd: repoRoot })
    rmSync(temp, { recursive: true, force: true })
  }
}

function option(args, name) {
  const index = args.indexOf(name)
  if (index === -1 || index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`)
  return args[index + 1]
}

function main() {
  const version = option(process.argv.slice(2), '--version')
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error('GITHUB_REPOSITORY is required')
  openReadmeDownloadPullRequest({ version, repository, repoRoot: fileURLToPath(new URL('..', import.meta.url)) })
}

if (process.argv[1] && process.argv[1].endsWith('open-readme-download-pr.mjs')) {
  main()
}
