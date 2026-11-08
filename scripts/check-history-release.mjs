// Local-only release checks. Never contacts Supabase or a deployment service.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = 'data/runpod-docs-index.json';
const manifestName = 'release-manifest.json';
const allowedPages = new Set([
  'https://docs.runpod.io/pods/storage/types',
  'https://docs.runpod.io/pods/troubleshooting/zero-gpus',
  'https://docs.runpod.io/serverless/endpoints/endpoint-configurations',
  'https://docs.runpod.io/serverless/endpoints/send-requests',
  'https://docs.runpod.io/storage/network-volumes',
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
const assert = (ok, message) => { if (!ok) throw new Error(message); };

function safePath(path) {
  assert(typeof path === 'string' && path && !path.includes('\\') && !path.includes(':') &&
    path.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe package path: ${path}`);
}

function forbiddenPath(path) {
  return path.split('/').some(part =>
    /^(?:\.git|node_modules|\.next(?:-.*)?|\.local|\.vercel|\.aws|coverage)$/i.test(part) ||
    (/^\.env(?:\.|$)/i.test(part) && part !== '.env.example') ||
    /(?:\.pem|\.key|\.p12|\.pfx|\.log|\.tsbuildinfo)$/i.test(part) ||
    /^(?:credentials(?:\.\w+)?|id_rsa|id_ed25519|service[-_]?account.*\.json)$/i.test(part));
}

function checkBytes(path, bytes) {
  safePath(path);
  assert(!forbiddenPath(path), `Refusing credential/local artifact path: ${path}`);
  const content = bytes.toString('utf8');
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content), `Private key detected in ${path}`);
  assert(!/\bsb_secret_[A-Za-z0-9_-]{12,}\b/.test(content), `Supabase secret detected in ${path}`);
  for (const jwt of content.matchAll(/\beyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    try {
      assert(JSON.parse(Buffer.from(jwt[1], 'base64url').toString()).role !== 'service_role',
        `Service-role token detected in ${path}`);
    } catch (error) {
      if (error.message.startsWith('Service-role')) throw error;
    }
  }
}

function checkIndex(bytes) {
  const index = JSON.parse(bytes.toString('utf8'));
  const terms = value => Array.isArray(value) && value.every(term => typeof term === 'string' && /^[a-z0-9]+$/.test(term)) && new Set(value).size === value.length;
  assert(index.version === 1 && Array.isArray(index.chunks) && index.chunks.length > 0, 'Invalid Docs index version/chunks');
  assert(index.chunks.every(chunk => chunk && typeof chunk.heading === 'string' && chunk.heading.trim() && chunk.heading.length <= 160 &&
    typeof chunk.passage === 'string' && chunk.passage.trim() && chunk.passage.length <= 1800 && allowedPages.has(chunk.url) &&
    terms(chunk.headingTerms) && terms(chunk.bodyTerms)), 'Docs index contains invalid chunks');
  return { bytes: bytes.length, chunks: index.chunks.length, sha256: sha256(bytes) };
}

function checkTraces(buildDir) {
  for (const route of ['chat', 'status']) {
    const tracePath = join(buildDir, 'server', 'app', 'api', route, 'route.js.nft.json');
    assert(existsSync(tracePath), `Build trace missing: ${tracePath}; run npm run build first`);
    const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
    const included = trace.files.map(path => resolve(dirname(tracePath), path)).find(path => path === join(root, indexPath));
    assert(included, `/api/${route} trace omits ${indexPath}`);
  }
  console.log('PASS both API build traces include the Docs index');
}

function verifyPackage(directory) {
  assert(!lstatSync(directory).isSymbolicLink(), 'Package directory cannot be a symlink');
  assert(lstatSync(join(directory, manifestName)).isFile() && !lstatSync(join(directory, manifestName)).isSymbolicLink(), 'Manifest must be a regular file');
  const manifest = JSON.parse(readFileSync(join(directory, manifestName), 'utf8'));
  assert(manifest.version === 1 && /^[a-f0-9]{40}$/.test(manifest.commit) && Array.isArray(manifest.files), 'Invalid release manifest');
  function rejectLinks(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), `Package symlink: ${entry.name}`);
      if (entry.isDirectory()) rejectLinks(join(folder, entry.name));
    }
  }
  rejectLinks(directory);
  const expected = new Set([manifestName]);
  for (const file of manifest.files) {
    safePath(file.path);
    assert(!expected.has(file.path), `Duplicate package path: ${file.path}`);
    expected.add(file.path);
    const fullPath = join(directory, file.path);
    assert(lstatSync(fullPath).isFile() && !lstatSync(fullPath).isSymbolicLink(), `Non-file package entry: ${file.path}`);
    const bytes = readFileSync(fullPath);
    checkBytes(file.path, bytes);
    assert(bytes.length === file.bytes && sha256(bytes) === file.sha256, `Integrity mismatch: ${file.path}`);
  }
  function walk(folder, prefix = '') {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = prefix + entry.name;
      assert(!entry.isSymbolicLink(), `Package symlink: ${path}`);
      if (entry.isDirectory()) walk(join(folder, entry.name), `${path}/`);
      else assert(expected.delete(path), `Unexpected package entry: ${path}`);
    }
  }
  walk(directory);
  assert(expected.size === 0, 'Package entries missing');
  assert(manifest.files.some(file => file.path === indexPath), 'Package omits Docs index');
  const actualIndex = checkIndex(readFileSync(join(directory, indexPath)));
  assert(JSON.stringify(actualIndex) === JSON.stringify(manifest.docsIndex), 'Manifest Docs summary mismatch');
  console.log(`PASS package ${manifest.commit}: ${manifest.files.length} files, Docs ${actualIndex.bytes} bytes / ${actualIndex.chunks} chunks`);
}

function preparePackage(destination, indexBytes, docsIndex) {
  // Use committed blobs rather than arbitrary local files. Packaging dirty code is ambiguous.
  assert(!git('status', '--porcelain', '--untracked-files=normal').toString().trim(), 'Commit/review tracked and untracked changes before preparing a release package');
  const stagingRoot = resolve(root, '.local');
  const output = resolve(root, destination);
  assert(output.startsWith(stagingRoot + sep) && output !== stagingRoot, 'Package destination must be a new directory under .local/');
  assert(!existsSync(output), 'Package destination already exists; choose a new name');
  let ancestor = dirname(output);
  while (ancestor !== root) {
    if (existsSync(ancestor)) assert(!lstatSync(ancestor).isSymbolicLink(), 'Package ancestor cannot be a symlink');
    ancestor = dirname(ancestor);
  }
  const commit = git('rev-parse', 'HEAD').toString().trim();
  const files = [];
  const entries = git('ls-tree', '-rz', '--full-tree', 'HEAD').toString('utf8').split('\0').filter(Boolean);
  for (const entry of entries) {
    const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(entry);
    assert(match && ['100644', '100755'].includes(match[1]), 'Package supports regular tracked files only');
    const [, mode, blob, path] = match;
    assert(path !== manifestName && path !== indexPath, `Generated file must remain untracked: ${path}`);
    if (forbiddenPath(path)) continue;
    const bytes = git('cat-file', 'blob', blob);
    checkBytes(path, bytes);
    files.push({ path, bytes: bytes.length, sha256: sha256(bytes), mode, content: bytes });
  }
  checkBytes(indexPath, indexBytes);
  files.push({ path: indexPath, bytes: indexBytes.length, sha256: docsIndex.sha256, mode: '100644', content: indexBytes });
  files.sort((a, b) => a.path.localeCompare(b.path));
  mkdirSync(output, { recursive: true });
  for (const file of files) {
    const target = join(output, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 });
  }
  writeFileSync(join(output, manifestName), JSON.stringify({ version: 1, commit, docsIndex,
    files: files.map(({ content, ...metadata }) => metadata) }, null, 2) + '\n', { flag: 'wx' });
  verifyPackage(output);
  console.log(`Prepared local source only: ${relative(root, output)} (no upload/build/deploy)`);
}

try {
  const args = process.argv.slice(2);
  if (args[0] === '--verify-package') {
    assert(args.length === 2, 'Usage: --verify-package <directory>');
    verifyPackage(resolve(root, args[1]));
  } else {
    assert(args.length === 0 || (['--prepare', '--build-dir'].includes(args[0]) && args.length === 2),
      'Usage: node scripts/check-history-release.mjs [--prepare .local/<new-directory> | --build-dir <build-directory> | --verify-package <directory>]');
    assert(git('ls-files', '--', indexPath).length === 0, 'Docs index must remain ignored, not committed');
    git('check-ignore', '--quiet', indexPath);
    const indexBytes = readFileSync(join(root, indexPath));
    const docsIndex = checkIndex(indexBytes);
    console.log(`PASS ignored Docs index: ${docsIndex.bytes} bytes / ${docsIndex.chunks} chunks / SHA256 ${docsIndex.sha256}`);
    if (args[0] === '--prepare') preparePackage(args[1], indexBytes, docsIndex);
    else if (args[0] === '--build-dir') checkTraces(resolve(root, args[1]));
    else console.log('Next: build and check --build-dir .next; after review/commit use --prepare .local/<release-name>');
  }
} catch (error) {
  console.error(`RELEASE CHECK FAILED: ${error.message}`);
  process.exitCode = 1;
}
