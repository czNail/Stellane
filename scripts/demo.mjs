#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const development = existsSync(join(root, 'src', 'core', 'index.ts'));
const entry = development ? 'pnpm demo' : 'dsh plugin --profile web exec stellane-demo';
const guide = join(root, 'examples', 'README.md');
if (process.env.STELLANE_DEMO_HOME && !isAbsolute(process.env.STELLANE_DEMO_HOME)) throw new Error('STELLANE_DEMO_HOME must be an absolute path.');
const state = resolve(process.env.STELLANE_DEMO_HOME ?? (development ? join(root, '.stellane-dev', 'demo') : join(homedir(), '.local', 'share', 'stellane-demo')));
const provisionFile = join(state, 'provision.json');
const project = join(state, 'project');
// Retain existing source-checkout demos. Fresh installations use a stable,
// state-specific identity, so a second checkout cannot manage the first one.
const owner = existsSync(join(state, 'connection.json')) && !existsSync(join(state, 'instance-name'))
  ? 'stellane-community-demo' : `stellane-demo-${createHash('sha256').update(state).digest('hex').slice(0, 10)}`;
const containerName = owner;
const volumeName = `${owner}-data`;
const database = 'stellane_demo';
const role = 'stellane_demo_reader';
const datasetName = 'telemetry';
const command = process.argv[2] ?? 'help';
const selected = process.argv[3];
const help = `Stellane telemetry demo (Docker + PostgreSQL 17)

  ${entry} start                 Create or resume the private demo database
  ${entry} status                Show the project, connection file and data stage
  ${entry} url                   Print the local demo connection URL for pasting
  ${entry} verify                Compare live data with the independent expectations
  ${entry} drift                 Break one known relationship
  ${entry} reset                 Restore the synthetic data; old memories become stale
  ${entry} stop                  Stop this demo container; retain its data

Only this helper's labeled container and demo schemas are changed.
Guide: ${guide} (Chinese: README.zh-CN.md alongside it).`;

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
}
function inspect(kind, name) {
  try { return JSON.parse(docker([kind, 'inspect', name]))[0]; }
  catch { return undefined; }
}
function owned(value, labels) {
  if (value && labels?.['com.stellane.owner'] !== owner) throw new Error('A resource with this name belongs to someone else. Nothing was changed.');
  if (!value) return;
  const recordedState = labels?.['com.stellane.state'];
  if (recordedState === state) return;
  // Earlier local demos did not carry a state-directory label. Accept them only
  // with this checkout's existing credential reference and project registration.
  const connectionFile = join(state, 'connection.json');
  if (!recordedState && existsSync(connectionFile) && existsSync(join(state, 'reader-password'))) {
    const connection = JSON.parse(readFileSync(connectionFile, 'utf8'));
    if (connection.projectPath === project && connection.passwordRef === `file:${join(state, 'reader-password')}`) return;
  }
  throw new Error('This demo belongs to another checkout. Use its original directory; nothing was changed.');
}
function provision() {
  if (!existsSync(provisionFile)) return undefined;
  const value = JSON.parse(readFileSync(provisionFile, 'utf8'));
  if (value.version !== 1 || value.owner !== owner || value.container !== containerName || value.volume !== volumeName
    || !['pending', 'ready'].includes(value.status)) throw new Error('Demo setup record does not match this helper. Existing data was retained.');
  return value;
}
function saveProvision(status) {
  writeFileSync(`${provisionFile}.tmp`, JSON.stringify({ version: 1, owner, container: containerName, volume: volumeName, status }) + '\n', { mode: 0o600 });
  renameSync(`${provisionFile}.tmp`, provisionFile);
}
function sql(statement) {
  return docker(['exec', '-i', containerName, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], { input: statement });
}
function dataset() {
  const directory = join(root, 'examples', 'datasets', datasetName);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (!/^stellane_demo_[a-z]+$/.test(manifest.schema)) throw new Error('Invalid demo schema.');
  return { manifest, read: file => readFileSync(join(directory, file), 'utf8') };
}
const literal = text => `'${text.replaceAll("'", "''")}'`;
function version() {
  const hash = createHash('sha256');
  const data = dataset();
  for (const file of ['manifest.json', 'setup.sql', 'drift.sql', 'variant-a.sql', 'variant-b.sql']) hash.update(data.read(file));
  return hash.digest('hex');
}
function metadata() {
  if (sql("SELECT to_regclass('public.stellane_demo_metadata') IS NOT NULL") !== 't') return undefined;
  const result = sql('SELECT row_to_json(m) FROM public.stellane_demo_metadata m WHERE singleton');
  if (!result) throw new Error('Demo metadata is incomplete; no data was reset.');
  const value = JSON.parse(result);
  if (value.owner !== owner) throw new Error('This database is not the expected demo.');
  return value;
}
function current() {
  const meta = metadata();
  if (!meta || meta.version !== version()) throw new Error(`Demo files and database differ. Run ${entry} reset to restore the demo data, then ${entry} start.`);
  return meta;
}
function seed(reset) {
  const previous = metadata();
  if (reset && !previous) throw new Error('No owned demo metadata exists; reset was refused.');
  const statements = ['BEGIN;'];
  if (!previous) statements.push(`CREATE TABLE public.stellane_demo_metadata (
    singleton boolean PRIMARY KEY CHECK (singleton), owner text NOT NULL, version text NOT NULL, phases jsonb NOT NULL);`);
  const data = dataset();
  if (reset) {
    statements.push(`DROP SCHEMA IF EXISTS ${data.manifest.schema} CASCADE;`);
    // Older owned demo instances also seeded the support fixture. Retire it on explicit reset.
    if (Object.hasOwn(previous.phases, 'support')) statements.push('DROP SCHEMA IF EXISTS stellane_demo_support CASCADE;');
  }
  statements.push(data.read('setup.sql'));
  statements.push(`GRANT USAGE ON SCHEMA ${data.manifest.schema} TO ${role};
    GRANT SELECT ON ALL TABLES IN SCHEMA ${data.manifest.schema} TO ${role};`);
  statements.push(`INSERT INTO public.stellane_demo_metadata VALUES (true, ${literal(owner)}, ${literal(version())},
    '{"telemetry":"baseline"}') ON CONFLICT (singleton) DO UPDATE SET version=EXCLUDED.version, phases=EXCLUDED.phases; COMMIT;`);
  sql(statements.join('\n'));
}
function check(meta = current()) {
  const data = dataset();
  const stage = meta.phases[datasetName];
  const query = data.manifest.metricSql.trim().replace(/;\s*$/, '');
  const rows = JSON.parse(sql(`SELECT COALESCE(json_agg(r),'[]') FROM (${query}) r`));
  assert.deepEqual(rows, data.manifest.expected[stage], `${datasetName}: data does not match the last managed stage ${stage}`);
  console.log(JSON.stringify({ dataset: datasetName, stage, verified: true, rows }, null, 2));
}
function show(info) {
  console.log(`Demo ${info?.State.Running ? 'running' : 'stopped'}.\nProject: ${project}\nConnection URL file: ${join(state, 'connection-url.txt')}\nCopy with: ${entry} url\nGuide: ${guide}`);
  if (info?.State.Running) {
    const meta = current();
    console.log(`Last managed stages: ${JSON.stringify(meta.phases)}`);
  }
}
async function main() {
  if (['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (!['start', 'status', 'url', 'verify', 'drift', 'reset', 'stop'].includes(command)
    || process.argv.length > 4 || selected && !['verify', 'drift'].includes(command)) throw new Error(help);
  if (selected && selected !== datasetName) throw new Error('The demo dataset is telemetry.');
  try { docker(['info', '--format', '{{.ServerVersion}}']); }
  catch { throw new Error('Docker is unavailable. Start Docker and make sure this user can access it, then retry.'); }
  let info = inspect('container', containerName);
  owned(info, info?.Config.Labels);
  const volume = inspect('volume', volumeName);
  owned(volume, volume?.Labels);
  if (command === 'stop') {
    if (info?.State.Running) docker(['stop', containerName]);
    console.log('Demo stopped. Its data and credentials are retained.');
    return;
  }
  if (command === 'status') {
    if (info) show(info);
    else if (provision()?.status === 'pending') console.log(`Demo setup is incomplete. Run ${entry} start to resume the recorded setup.`);
    else if (volume) console.log('The owned demo volume has no container. Inspect the retained data before recreating the container.');
    else console.log(`No demo exists yet. Run ${entry} start.`);
    return;
  }
  mkdirSync(project, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  if (owner !== 'stellane-community-demo') writeFileSync(join(state, 'instance-name'), owner + '\n', { mode: 0o600 });
  const passwordFile = join(state, 'reader-password');
  if (command === 'start') {
    if (!info) {
      const envFile = join(state, 'postgres.env');
      const pending = provision()?.status === 'pending';
      if (!pending && (volume || existsSync(passwordFile))) throw new Error('Previous demo data exists without its container. Inspect it before recreating; nothing was overwritten.');
      // Fetch the image before creating any database state. An interrupted setup
      // can reuse only its recorded volume and credentials, never a completed demo.
      if (!inspect('image', 'postgres:17')) docker(['pull', 'postgres:17']);
      if (!pending) {
        writeFileSync(envFile, `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}\nPOSTGRES_DB=${database}\n`, { mode: 0o600 });
        writeFileSync(passwordFile, randomBytes(24).toString('hex'), { mode: 0o600 });
        saveProvision('pending');
      } else if (!existsSync(envFile) || !existsSync(passwordFile)) {
        throw new Error('Recorded setup credentials are missing. Existing data was retained.');
      }
      if (!volume) docker(['volume', 'create', '--label', `com.stellane.owner=${owner}`, '--label', `com.stellane.state=${state}`, volumeName]);
      docker(['run', '-d', '--name', containerName, '--label', `com.stellane.owner=${owner}`,
        '--label', `com.stellane.state=${state}`,
        '--env-file', envFile, '-p', '127.0.0.1::5432', '-v', `${volumeName}:/var/lib/postgresql/data`, 'postgres:17']);
    } else if (!info.State.Running) docker(['start', containerName]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { sql('SELECT 1'); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!ready) throw new Error(`The demo PostgreSQL did not become ready within 30 seconds. Check docker logs ${containerName}.`);
    if (!existsSync(passwordFile)) throw new Error('The local demo password file is missing. Existing data was retained.');
    const password = readFileSync(passwordFile, 'utf8').trim();
    if (!/^[a-f0-9]{48}$/.test(password)) throw new Error('The local demo password has an unexpected format.');
    sql(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN
      CREATE ROLE ${role} LOGIN PASSWORD '${password}'; END IF; END $$;
      GRANT CONNECT ON DATABASE ${database} TO ${role};
      ALTER ROLE ${role} SET default_transaction_read_only=on;`);
    if (!metadata()) seed(false);
    const meta = current();
    info = inspect('container', containerName);
    const port = Number(info.NetworkSettings.Ports['5432/tcp'][0].HostPort);
    const connection = { name: 'Stellane demo', projectPath: project, host: '127.0.0.1', port,
      database, user: role, passwordRef: `file:${passwordFile}`, tls: 'disable' };
    writeFileSync(join(state, 'connection.json'), JSON.stringify(connection, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(state, 'connection-url.txt'), `postgresql://${role}:${password}@127.0.0.1:${port}/${database}?sslmode=disable\n`, { mode: 0o600 });
    check(meta);
    saveProvision('ready');
    show(info);
    return;
  }
  if (!info?.State.Running) throw new Error(`Start the private demo with ${entry} start first.`);
  if (command === 'url') { console.log(readFileSync(join(state, 'connection-url.txt'), 'utf8').trim()); return; }
  if (command === 'reset') {
    seed(true);
    check();
    console.log('Synthetic data restored. Previously saved observations must be checked again.');
    return;
  }
  const meta = current();
  if (command === 'drift') {
    sql(`BEGIN;\n${dataset().read('drift.sql')}\nUPDATE public.stellane_demo_metadata
      SET phases=jsonb_set(phases, '{telemetry}', '"drift"'); COMMIT;`);
    check();
    console.log('One telemetry relationship changed. Open a new ordinary chat and ask the same metric again.');
  } else check(meta);
}

try { await main(); }
catch (error) {
  // Process errors can carry SQL/credentials on stderr. Only expose controlled diagnostics.
  console.error(error && typeof error === 'object' && 'status' in error
    ? 'A demo database command failed. The data was retained; check Docker status and the demo guide.'
    : error instanceof Error ? error.message : 'Demo failed.');
  process.exitCode = 1;
}
