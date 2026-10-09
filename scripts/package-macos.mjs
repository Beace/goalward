import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Build a self-contained, ad-hoc-signed macOS trial release. No UI scripting or
// Gatekeeper changes are needed to create these containers.
const root = fileURLToPath(new URL('../', import.meta.url))
const repackage = process.argv.includes('--repackage')
const repackageRelease = process.argv.includes('--repackage-release')
const universal = process.argv.includes('--universal')
if (process.argv.slice(2).some(argument => !['--repackage', '--repackage-release', '--universal'].includes(argument)) || (repackage && repackageRelease)) {
  throw new Error('Usage: npm run mac:dist [-- --universal] [-- --repackage | -- --repackage-release]')
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Run mac:dist on an Apple Silicon Mac using native arm64 Node.js.')
}
const architecture = universal ? 'universal' : 'arm64'
const expectedArchitectures = universal ? ['arm64', 'x86_64'] : ['arm64']
const target = universal ? 'universal-apple-darwin' : undefined
const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const version = config.version
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid release version')
const executableName = config.productName.toLowerCase().replace(/\s+/g, '-')
if (!/^[a-z0-9-]+$/.test(executableName)) throw new Error('Invalid product executable name')
const output = join(root, 'releases', version)
await mkdir(output, { recursive: true })
const releaseEnv = { ...process.env, CARGO_TARGET_DIR: join(root, 'src-tauri/target') }
for (const key of Object.keys(releaseEnv)) if (key.startsWith('APPLE_') || key === 'CARGO_BUILD_TARGET') delete releaseEnv[key]
releaseEnv.APPLE_SIGNING_IDENTITY = '-'
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, env: releaseEnv, stdio: 'inherit', ...options })
const read = (command, args) => run(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function files(directory) {
  const result = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}
async function sourceDigest() {
  const paths = ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'docs/install-macos-trial.txt']
  for (const dir of ['src', 'src-tauri/src', 'src-tauri/icons', 'src-tauri/capabilities', 'assets/branding']) {
    const sourceFiles = await files(join(root, dir))
    paths.push(...sourceFiles
      .filter(path => dir !== 'assets/branding' || ['README.md', 'icon-prompt.txt', 'goalward-icon.png'].includes(basename(path)) || basename(path).startsWith('runtime-source-'))
      .filter(path => dir !== 'src-tauri/icons' || basename(path) !== 'app.svg')
      .map(path => path.slice(root.length)))
  }
  return digestPaths(root, paths)
}
async function digestPaths(base, paths) {
  const digest = createHash('sha256')
  for (const path of paths.sort()) digest.update(path).update('\0').update(await readFile(join(base, path))).update('\0')
  return digest.digest('hex')
}
async function appDigest(app) {
  return digestPaths(app, (await files(app)).map(path => path.slice(app.length + 1)))
}
async function installerDigest() {
  return digestPaths(root, ['scripts/package-macos.mjs', 'scripts/dmg-settings.py', 'scripts/dmg-requirements.txt', ...(await files(join(root, 'assets/installer'))).map(path => path.slice(root.length))])
}
async function dmgPython() {
  const environment = join(root, 'node_modules/.cache/dmgbuild')
  const python = join(environment, 'bin/python')
  const requirements = join(root, 'scripts/dmg-requirements.txt')
  const verify = ['-c', 'import sys, importlib.metadata as m; from pathlib import Path; assert sys.version_info >= (3,10); requirements = Path(sys.argv[1]).read_text().splitlines(); assert all(m.version(name) == version for name, version in (line.split("==") for line in requirements if line.strip()))', requirements]
  try {
    read(python, verify)
    return python
  } catch { /* Provision only a project-local build environment. */ }
  const candidates = process.env.DMG_PYTHON ? [process.env.DMG_PYTHON] : ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3']
  const systemPython = candidates.find(candidate => {
    try { read(candidate, ['-c', 'import sys; assert sys.version_info >= (3,10)']); return true } catch { return false }
  })
  if (!systemPython) throw new Error('DMG packaging requires Python 3.10+. Set DMG_PYTHON to its executable path.')
  run(systemPython, ['-m', 'venv', environment])
  run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements])
  read(python, verify)
  return python
}
const python = await dmgPython()
let before = repackageRelease ? undefined : await sourceDigest()
const installerBefore = await installerDigest()
let sourceApp = join(root, 'src-tauri/target', ...(target ? [target] : []), 'release/bundle/macos', `${config.productName}.app`)
let product = config.productName
let minimumMacOS = config.bundle.macOS.minimumSystemVersion
let builtAt
let repackagedFromZipSha256
let expectedReleaseDigest
const workspace = await mkdtemp(join(tmpdir(), `${executableName}-distribution-`))
const stage = join(workspace, 'image')
try {
  await mkdir(stage)
  if (repackageRelease) {
    const previous = JSON.parse(await readFile(join(output, 'BUILD-INFO.json'), 'utf8'))
    const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    if (previous.version !== version || previous.product !== config.productName || previous.architecture !== architecture || previous.signing !== 'ad-hoc' || previous.notarized !== false
      || typeof previous.product !== 'string' || !previous.product || basename(previous.product) !== previous.product
      || typeof previous.minimumMacOS !== 'string' || typeof previous.builtAt !== 'string'
      || !validHash(previous.sourceDigest) || !validHash(previous.binarySha256) || !validHash(previous.appBundleDigest)) {
      throw new Error('Release metadata is incomplete or incompatible; cannot repackage the published app.')
    }
    const archives = Array.isArray(previous.artifacts) ? previous.artifacts.filter(item => typeof item.file === 'string' && item.file.endsWith('.zip')) : []
    const archive = archives[0]
    if (archives.length !== 1 || basename(archive.file) !== archive.file || !validHash(archive.sha256)
      || !Number.isSafeInteger(archive.bytes) || archive.bytes <= 0) throw new Error('Release metadata must identify one verified ZIP artifact.')
    const bytes = await readFile(join(output, archive.file))
    if (bytes.length !== archive.bytes || sha256(bytes) !== archive.sha256) throw new Error('Published ZIP size or SHA-256 differs from BUILD-INFO.json.')
    // Extract the exact bytes just verified, even if another process replaces the published ZIP.
    const verifiedZip = join(workspace, 'verified-release.zip')
    await writeFile(verifiedZip, bytes)
    const extracted = join(workspace, 'verified-release')
    run('/usr/bin/ditto', ['-x', '-k', verifiedZip, extracted])
    sourceApp = join(extracted, `${previous.product}.app`)
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', sourceApp])
    if (sha256(await readFile(join(sourceApp, 'Contents/MacOS', executableName))) !== previous.binarySha256
      || await appDigest(sourceApp) !== previous.appBundleDigest) throw new Error('Published ZIP app differs from the verified release metadata.')
    product = previous.product
    minimumMacOS = previous.minimumMacOS
    builtAt = previous.builtAt
    before = previous.sourceDigest
    expectedReleaseDigest = previous.appBundleDigest
    repackagedFromZipSha256 = archive.sha256
    console.log('Reusing the verified published ZIP app; current workspace application changes are excluded.')
  } else if (repackage) {
    const previous = JSON.parse(await readFile(join(output, 'BUILD-INFO.json'), 'utf8'))
    if (previous.product !== config.productName || previous.sourceDigest !== before || previous.binarySha256 !== sha256(await readFile(join(sourceApp, 'Contents/MacOS', executableName))) || previous.appBundleDigest !== await appDigest(sourceApp)) {
      throw new Error('App or source differs from the verified release. Run npm run mac:dist to rebuild.')
    }
    builtAt = previous.builtAt
    console.log('Reusing the unchanged, verified app; rebuilding installation media only.')
  } else {
    run('npm', ['test'])
    run('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml'])
    run('cargo', ['clippy', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets', '--', '-D', 'warnings'])
    run('npm', ['run', 'mac:build', '--', ...(target ? ['--target', target] : []), '--', '--locked'])
    builtAt = new Date().toISOString()
  }
  if (!repackageRelease && await sourceDigest() !== before) throw new Error('Source changed during the build; rerun to produce a consistent release.')

  const app = join(stage, basename(sourceApp))
  run('/usr/bin/ditto', [sourceApp, app])
  const binary = join(app, 'Contents/MacOS', executableName)
  const actualArchitectures = read('/usr/bin/lipo', ['-archs', binary]).split(/\s+/).sort()
  if (JSON.stringify(actualArchitectures) !== JSON.stringify([...expectedArchitectures].sort())) {
    throw new Error(`Unexpected executable architectures: ${actualArchitectures.join(', ')}`)
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  const verifiedAppDigest = await appDigest(app)
  if (repackageRelease && verifiedAppDigest !== expectedReleaseDigest) throw new Error('Staged app differs from the verified published ZIP app.')
  for (const arch of expectedArchitectures) {
    const linked = read('/usr/bin/otool', ['-arch', arch, '-L', binary]).split('\n').slice(1).map(line => line.trim().split(' (')[0])
    if (linked.some(path => !path.startsWith('/System/Library/') && !path.startsWith('/usr/lib/'))) {
      throw new Error(`The ${arch} app links to a non-system library; bundle it before distributing.`)
    }
  }
  const packaged = (await files(app)).map(path => path.slice(app.length + 1))
  if (packaged.some(path => /(?:^|\/)(?:state\.json|auth\.json|\.env|node_modules|traces|fixtures|test-results)(?:\/|$)/.test(path))) {
    throw new Error('Unexpected development or user-data file in app bundle')
  }
  const guide = await readFile(join(root, 'docs/install-macos-trial.txt'), 'utf8')
  const releaseGuide = `版本：${version}\n架构：${universal ? 'Apple Silicon + Intel / universal' : 'Apple Silicon / arm64'}\n\n${guide}`
  if (await readFile(join(app, 'Contents/Resources/installation/安装说明.txt'), 'utf8') !== guide) throw new Error('App is missing the current installation guide')
  const prefix = `${config.productName.replace(/\s+/g, '-')}_${version}_macos-${architecture}`
  const dmg = join(workspace, `${prefix}.dmg`)
  const zip = join(workspace, `${prefix}.zip`)
  run(python, ['-m', 'dmgbuild', '-s', join(root, 'scripts/dmg-settings.py'), '-D', `app=${app}`, '-D', `background=${join(root, 'assets/installer/background.png')}`, `${config.productName} ${version}`, dmg])
  run('/usr/bin/hdiutil', ['verify', dmg])
  const mounted = join(workspace, 'dmg-verification')
  await mkdir(mounted)
  run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mounted, dmg])
  try {
    const mountedApp = join(mounted, basename(app))
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', mountedApp])
    const mountedArchitectures = read('/usr/bin/lipo', ['-archs', join(mountedApp, 'Contents/MacOS', executableName)]).split(/\s+/).sort()
    if (JSON.stringify(mountedArchitectures) !== JSON.stringify([...expectedArchitectures].sort())) throw new Error('DMG app has unexpected architectures')
    if (await appDigest(mountedApp) !== verifiedAppDigest) throw new Error('The app inside the DMG differs from the verified app')
    if (await readlink(join(mounted, 'Applications')) !== '/Applications') throw new Error('Invalid Applications shortcut')
    await readFile(join(mounted, '.DS_Store'))
    await readFile(join(mounted, '.background.tiff'))
  } finally {
    run('/usr/bin/hdiutil', ['detach', mounted])
  }
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])
  const unpacked = join(workspace, 'zip-verification')
  run('/usr/bin/ditto', ['-x', '-k', zip, unpacked])
  const unpackedApp = join(unpacked, basename(app))
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', unpackedApp])
  const unpackedArchitectures = read('/usr/bin/lipo', ['-archs', join(unpackedApp, 'Contents/MacOS', executableName)]).split(/\s+/).sort()
  if (JSON.stringify(unpackedArchitectures) !== JSON.stringify([...expectedArchitectures].sort())) throw new Error('ZIP app has unexpected architectures')
  if (await appDigest(unpackedApp) !== verifiedAppDigest || await appDigest(app) !== verifiedAppDigest) throw new Error('Packaged app differs from the verified app.')
  if ((!repackageRelease && await sourceDigest() !== before) || await installerDigest() !== installerBefore) throw new Error('Source or installer changed while packaging; rerun.')
  const artifacts = []
  for (const path of [dmg, zip]) {
    const bytes = await readFile(path)
    const record = { file: basename(path), bytes: bytes.length, sha256: sha256(bytes) }
    await cp(path, join(output, record.file))
    artifacts.push(record)
  }
  await writeFile(join(output, 'SHA256SUMS.txt'), artifacts.map(item => `${item.sha256}  ${item.file}\n`).join(''))
  await writeFile(join(output, '安装说明.txt'), releaseGuide)
  await writeFile(join(output, 'BUILD-INFO.json'), JSON.stringify({ product, version, builtAt, packagedAt: new Date().toISOString(), architecture, architectures: expectedArchitectures, minimumMacOS, signing: 'ad-hoc', notarized: false, sourceDigest: before, appBundleDigest: verifiedAppDigest, installerDigest: installerBefore, binarySha256: sha256(await readFile(binary)), ...(repackagedFromZipSha256 ? { repackagedFromZipSha256 } : {}), artifacts }, null, 2) + '\n')
  console.log(`\nDistribution files: ${resolve(output)}`)
} finally {
  await rm(workspace, { recursive: true, force: true })
}
