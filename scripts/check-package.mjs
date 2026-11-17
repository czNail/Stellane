import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const destination = join(root, '.stellane-dev', 'release');
await mkdir(destination, { recursive: true, mode: 0o700 });
function run(program, args, cwd = root) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${program} ${args[0]} failed: ${result.stderr || result.error?.message || result.stdout}`);
  return result.stdout;
}
console.log('Building the release archive…');
run('pnpm', ['pack', '--pack-destination', destination]);
const filename = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`;
assert((await readdir(destination)).includes(filename));
const archive = join(destination, filename);
const entries = run('tar', ['-tzf', archive]).trim().split('\n');
for (const path of ['dist/host.js', 'dist/client.js', 'dist/demo-branches.js', 'stellane.patch.yml', 'scripts/demo.mjs',
  'scripts/dev-neon.mjs', 'scripts/neon-local-controller.mjs', 'scripts/neon-local-runtime.mjs',
  'CHANGELOG.md', 'SECURITY.md', 'docs/install-and-maintain.md', 'docs/local-neon.md',
  'docs/data-and-privacy.md', 'examples/datasets/telemetry/manifest.json', 'examples/datasets/support/manifest.json']) {
  assert(entries.includes(`package/${path}`), `Release asset missing: ${path}`);
}
assert(entries.every(path => path.startsWith('package/') && !path.split('/').includes('..')));
assert(!entries.some(path => /\/(?:\.stellane-dev|node_modules|\.git|src|tests)\//.test(path)
  || /(?:reader-password|credentials\.yaml|postgres\.env)$/.test(path)), 'Private/development files entered the archive.');
const sandbox = await mkdtemp(join(tmpdir(), 'stellane-package-'));
try {
  await writeFile(join(sandbox, 'package.json'), JSON.stringify({ name: 'stellane-release-smoke', private: true,
    type: 'module', packageManager: manifest.packageManager }));
  console.log('Installing only the archive in a fresh directory…');
  run('pnpm', ['add', archive, '--ignore-scripts'], sandbox);
  const installed = join(sandbox, 'node_modules', '@stellane', 'harness-plugin');
  assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, manifest.version);
  for (const command of Object.keys(manifest.bin)) {
    assert(run('pnpm', ['exec', command, '--help'], sandbox).length > 50, `Published command failed: ${command}`);
  }
  assert(run(process.execPath, [join(installed, 'dist/demo-branches.js'), '--help'], sandbox).length > 50);
  const installedFiles = await readdir(installed);
  assert(!installedFiles.includes('src'));
  const bytes = await readFile(archive);
  const report = { version: manifest.version, archive: filename, sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length, files: entries.length, checkedAt: new Date().toISOString(),
    checks: ['required assets', 'private file exclusion', 'fresh archive dependency install', 'published demo commands without source'] };
  await writeFile(join(destination, 'package-check.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`Package checks passed: ${archive}`);
} finally { await rm(sandbox, { recursive: true, force: true }); }
