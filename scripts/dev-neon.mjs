#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, openSync, readFileSync, closeSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { docker, inspect, owns, loadState, newState, pinImage } from './neon-local-runtime.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const development = existsSync(join(root, 'src', 'core', 'index.ts'));
const cli = development ? 'pnpm dev:neon' : 'dsh plugin --profile web exec stellane-neon';
const { values, positionals } = parseArgs({ options: { instance: { type: 'string', default: 'local' }, help: { type: 'boolean' } }, allowPositionals: true });
const command = positionals[0] ?? 'start';
if (values.help || command === 'help') {
  console.log(`Local Neon development instance (real pageserver, safekeeper, broker and computes)
  ${cli} [start|status|stop|reconcile] [--instance local]
  ${cli} url [--instance local]

Uses only local Docker resources; no Neon cloud account or cloud API key.
Source checkouts use .stellane-dev/neon-<instance>; installed plugins use
~/.local/share/stellane-neon/<instance>. STELLANE_NEON_HOME overrides that parent
directory (an absolute path). Import the instance's provider.json in Stellane.
stop retains data. reconcile resumes only already recorded local control operations.
This single-node development setup is not a high-availability deployment.`);
  process.exit(0);
}
if (!['start', 'status', 'stop', 'url', 'reconcile'].includes(command) || positionals.length > 1
  || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(values.instance)) throw new Error('Invalid command or instance name. Use --help.');
if (process.env.STELLANE_NEON_HOME && !isAbsolute(process.env.STELLANE_NEON_HOME)) throw new Error('STELLANE_NEON_HOME must be an absolute path.');
const directory = process.env.STELLANE_NEON_HOME ? resolve(process.env.STELLANE_NEON_HOME, values.instance)
  : development ? resolve(root, '.stellane-dev', `neon-${values.instance}`)
  : join(homedir(), '.local', 'share', 'stellane-neon', values.instance);
const stateFile = join(directory, 'instance.json');
async function controller(state, path, method = 'GET') {
  const result = await fetch(`http://127.0.0.1:${state.apiPort}${path}`, { method, redirect: 'error',
    headers: { authorization: `Bearer ${readFileSync(join(directory, 'api-token'), 'utf8').trim()}` }, signal: AbortSignal.timeout(5000) });
  if (!result.ok) throw new Error(`Local controller returned ${result.status}.`);
  return result.json();
}
function show(state, health) {
  console.log(JSON.stringify({ instance: state.owner, ready: health?.ready ?? false, source: state.rootBranchId,
    project: state.projectPath, configuration: join(directory, 'provider.json'),
    liveBranches: Object.values(state.branches).filter(item => item.current_state !== 'deleted').length,
    guide: 'Import provider.json in Stellane. Source writes for fixture setup require an explicit database client.',
    ...(health?.failed ? { error: `Startup failed; inspect ${join(directory, 'controller.log')}` } : {}) }, null, 2));
}
async function main() {
  await docker(['info', '--format', '{{.ServerVersion}}']);
  let state = existsSync(stateFile) ? loadState(directory) : undefined;
  if (!state && command !== 'start') { console.log(`No local Neon instance exists. Run ${cli} start.`); return; }
  let health;
  if (state?.apiPort) {
    try { health = await controller(state, '/__local/health'); }
    catch { /* A stopped controller does not authorize killing another process. */ }
    if (health && (health.kind !== 'stellane-local-neon' || health.instanceId !== state.id)) throw new Error('Controller identity does not match the recorded instance.');
  }
  if (command === 'status') { show(state, health); return; }
  if (command === 'url') { console.log(readFileSync(join(directory, 'connection-url.txt'), 'utf8').trim()); return; }
  if (command === 'reconcile') {
    if (!health?.ready) throw new Error('Start this same local instance before reconciliation.');
    console.log(await controller(state, '/__local/reconcile', 'POST')); return;
  }
  if (command === 'stop') {
    if (health) await controller(state, '/__local/shutdown', 'POST');
    else if (existsSync(join(directory, 'controller.json'))) {
      const previous = JSON.parse(readFileSync(join(directory, 'controller.json'), 'utf8'));
      try { process.kill(previous.pid, 0); throw new Error('The recorded controller is alive but cannot be verified. No containers were stopped.'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const ids = (await docker(['ps', '-aq', '--filter', `label=com.stellane.instance=${state.id}`])).split('\n').filter(Boolean);
    for (const id of ids) { const info = await inspect('container', id); owns(info, state); }
    // Computes stop before storage, preserving their committed WAL.
    const all = await Promise.all(ids.map(id => inspect('container', id)));
    all.sort((a, b) => Number(!a.Config.Labels['com.stellane.timeline']) - Number(!b.Config.Labels['com.stellane.timeline']));
    for (const info of all) if (info.State.Running) await docker(['stop', '-t', '30', info.Id]);
    console.log('Local Neon stopped. Its source, timelines, credentials and volumes are retained.'); return;
  }
  if (health?.ready) { show(state, health); return; }
  if (health) throw new Error('A controller already owns this instance. Inspect its log; stop it before retrying startup.');
  if (!state) {
    const owner = `stellane-neon-${values.instance}`;
    if ((await docker(['ps', '-aq', '--filter', `label=com.stellane.owner=${owner}`])).trim()
      || await inspect('network', `${owner}-network`) || await inspect('volume', `${owner}-pageserver-data`)
      || await inspect('volume', `${owner}-safekeeper-data`)) throw new Error('Resources with this instance name already exist. Use their original checkout or a different --instance.');
    const storage = await pinImage('ghcr.io/neondatabase/neon:latest');
    const compute = await pinImage('ghcr.io/neondatabase/compute-node-v16:latest');
    state = newState(directory, values.instance, { storage, compute });
  }
  const recorded = join(directory, 'controller.json');
  if (existsSync(recorded)) {
    const previous = JSON.parse(readFileSync(recorded, 'utf8'));
    try { process.kill(previous.pid, 0); throw new Error('The previous controller process still exists but cannot be verified. Inspect it before restarting.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const log = openSync(join(directory, 'controller.log'), 'a', 0o600); chmodSync(join(directory, 'controller.log'), 0o600);
  const child = spawn(process.execPath, [join(root, 'scripts', 'neon-local-controller.mjs'), directory],
    { detached: true, stdio: ['ignore', log, log] }); child.unref(); closeSync(log);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await setTimeout(500); state = loadState(directory);
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Controller exited; inspect ${join(directory, 'controller.log')}.`);
    if (!state.apiPort) continue;
    try { health = await controller(state, '/__local/health'); } catch { continue; }
    if (health.instanceId !== state.id) throw new Error('Unexpected controller identity.');
    if (health.ready) { show(loadState(directory), health); return; }
    if (health.failed) throw new Error(`Local Neon startup failed. Inspect ${join(directory, 'controller.log')}; data was retained.`);
  }
  throw new Error(`Local Neon is still starting. Use ${cli} status and inspect ${join(directory, 'controller.log')}.`);
}
let commandLock;
try {
  if (['start', 'stop', 'reconcile'].includes(command) && (command === 'start' || existsSync(stateFile))) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    commandLock = new DatabaseSync(join(directory, 'command-owner.sqlite'));
    chmodSync(join(directory, 'command-owner.sqlite'), 0o600);
    try { commandLock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
    catch { throw new Error('Another local Neon command is managing this same instance. Wait for it to finish.'); }
  }
  await main();
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { commandLock?.close(); }
