import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';

const exec = promisify(execFile);
export async function docker(args) {
  try { return (await exec('docker', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })).stdout.trim(); }
  catch (error) { throw new Error(`Docker ${args[0]} failed. Inspect this instance's private log.`, { cause: error }); }
}
export function saveJson(filename, value) {
  writeFileSync(`${filename}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const file = openSync(`${filename}.tmp`, 'r');
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(`${filename}.tmp`, filename);
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(filename), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
export async function inspect(kind, name) {
  try { return JSON.parse(await docker([kind, 'inspect', name]))[0]; }
  catch (error) {
    if (String(error.cause?.stderr ?? '').match(/No such (object|container|volume|network|image)/i)) return undefined;
    throw error;
  }
}
export function owns(value, state, branchId) {
  if (!value) return;
  const labels = value.Config?.Labels ?? value.Labels;
  if (labels?.['com.stellane.owner'] !== state.owner || labels?.['com.stellane.instance'] !== state.id
    || labels?.['com.stellane.state'] !== state.directory || (branchId && labels?.['com.stellane.timeline'] !== branchId)) {
    throw new Error('A resource with this name has a different owner or identity. Nothing was replaced.');
  }
}
export function labels(state, extra = {}) {
  return Object.entries({ 'com.stellane.owner': state.owner, 'com.stellane.instance': state.id,
    'com.stellane.state': state.directory, ...extra }).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}
export async function pinImage(reference) {
  let value = await inspect('image', reference);
  if (!value) { console.log(`Fetching ${reference}…`); await docker(['pull', reference]); value = await inspect('image', reference); }
  const digest = value?.RepoDigests?.find(item => item.startsWith(reference.split(':')[0] + '@'));
  if (!digest) throw new Error('The image has no registry digest; a reproducible official image is required.');
  return { reference: digest, imageId: value.Id };
}
export function newState(directory, instance, images) {
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  mkdirSync(join(directory, 'project'), { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, 'compute'), { recursive: true, mode: 0o700 });
  for (const [file, bytes] of [['api-token', 32], ['sql-password', 24]]) {
    writeFileSync(join(directory, file), randomBytes(bytes).toString('hex'), { mode: 0o600 });
    const descriptor = openSync(join(directory, file), 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  const tenant = randomBytes(16).toString('hex');
  const state = { version: 1, directory, id: randomUUID(), owner: `stellane-neon-${instance}`,
    tenant, projectId: `local-${tenant}`, rootBranchId: randomBytes(16).toString('hex'),
    projectPath: join(directory, 'project'), images, nodes: {}, branches: {}, operations: {}, createdAt: new Date().toISOString() };
  saveJson(join(directory, 'instance.json'), state);
  return state;
}
export function loadState(directory) {
  const state = JSON.parse(readFileSync(join(directory, 'instance.json'), 'utf8'));
  if (state.version !== 1 || state.directory !== directory || !/^stellane-neon-[a-z0-9-]+$/.test(state.owner)
    || !/^[a-f0-9]{32}$/.test(state.tenant)) throw new Error('Local Neon state does not match this directory.');
  return state;
}
export class LocalNeon {
  constructor(state) { this.state = state; this.pending = new Map(); }
  save() { saveJson(join(this.state.directory, 'instance.json'), this.state); }
  token() { return readFileSync(join(this.state.directory, 'api-token'), 'utf8').trim(); }
  password() { return readFileSync(join(this.state.directory, 'sql-password'), 'utf8').trim(); }
  async api(service, path, method = 'GET', body) {
    const port = this.state.nodes[service].port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const error = new Error(`${service} API returned ${response.status}.`); error.status = response.status;
      await response.body?.cancel(); throw error;
    }
    const text = await response.text(); return text ? JSON.parse(text) : null;
  }
  async wait(check, description, milliseconds = 90000) {
    const deadline = Date.now() + milliseconds; let last;
    do {
      try { const value = await check(); if (value) return value; } catch (error) { last = error; }
      await setTimeout(500);
    } while (Date.now() < deadline);
    throw new Error(`${description} did not become ready.`, { cause: last });
  }
  async ensureNode(key, args, internalPort) {
    const state = this.state, name = `${state.owner}-${key}`;
    let info = await inspect('container', name); owns(info, state);
    if (info && state.nodes[key]?.id && state.nodes[key].id !== info.Id) throw new Error('A local Neon container identity changed.');
    if (!info) {
      await docker(['create', '--name', name, ...labels(state), '--network', `${state.owner}-network`,
        '--network-alias', key, ...args]);
      info = await inspect('container', name); owns(info, state);
      state.nodes[key] = { id: info.Id, name }; this.save();
    }
    if (!info.State.Running) { await docker(['start', name]); info = await inspect('container', name); }
    state.nodes[key] = { id: info.Id, name,
      ...(internalPort ? { port: Number(info.NetworkSettings.Ports[`${internalPort}/tcp`][0].HostPort) } : {}) };
    this.save();
  }
  async startStorage() {
    const state = this.state, network = `${state.owner}-network`;
    const currentNetwork = await inspect('network', network); owns(currentNetwork, state);
    if (!currentNetwork) await docker(['network', 'create', ...labels(state), network]);
    for (const name of ['pageserver', 'safekeeper']) {
      const volume = `${state.owner}-${name}-data`; const current = await inspect('volume', volume); owns(current, state);
      if (!current) await docker(['volume', 'create', ...labels(state), volume]);
    }
    const image = state.images.storage.reference;
    await this.ensureNode('broker', ['--memory', '128m', '--cpus', '0.5', '--entrypoint', 'storage_broker', image,
      '--listen-addr=0.0.0.0:50051']);
    await this.ensureNode('safekeeper', ['--memory', '512m', '--cpus', '1', '-p', '127.0.0.1::7676',
      '-v', `${state.owner}-safekeeper-data:/data`, '--entrypoint', 'safekeeper', image,
      '--listen-pg=safekeeper:5454', '--listen-http=0.0.0.0:7676', '--id=1',
      '--broker-endpoint=http://broker:50051', '--disable-wal-backup', '--dev', '-D', '/data']);
    // Current upstream reads both files from its working directory; its CLI
    // intentionally does not accept ad-hoc config overrides.
    const configDirectory = join(state.directory, 'storage-config');
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(configDirectory, 'identity.toml'), 'id=1\n', { mode: 0o644 });
    writeFileSync(join(configDirectory, 'pageserver.toml'), [
      "broker_endpoint='http://broker:50051'", "pg_distrib_dir='/usr/local/'",
      "listen_pg_addr='0.0.0.0:6400'", "listen_http_addr='0.0.0.0:9898'",
      "remote_storage={local_path='/data/remote'}", "control_plane_api='http://127.0.0.1:1'",
      'control_plane_emergency_mode=true', 'dev_mode=true', 'virtual_file_io_mode="buffered"',
      'page_cache_size=32768', '',
    ].join('\n'), { mode: 0o644 });
    await this.ensureNode('pageserver', ['--memory', '2g', '--cpus', '2', '-p', '127.0.0.1::9898',
      '-v', `${state.owner}-pageserver-data:/data`,
      '--mount', `type=bind,src=${join(configDirectory, 'identity.toml')},dst=/data/identity.toml,readonly`,
      '--mount', `type=bind,src=${join(configDirectory, 'pageserver.toml')},dst=/data/pageserver.toml,readonly`,
      '--entrypoint', 'pageserver', image, '-D', '/data'], 9898);
    // Safekeeper has its own endpoint, used to remove the WAL for an owned timeline.
    const safe = await inspect('container', `${state.owner}-safekeeper`);
    state.nodes.safekeeper.port = Number(safe.NetworkSettings.Ports['7676/tcp'][0].HostPort); this.save();
    await this.wait(() => this.api('pageserver', '/v1/status'), 'Neon pageserver');
    await this.api('pageserver', `/v1/tenant/${state.tenant}/location_config`, 'PUT', { mode: 'AttachedSingle', generation: 1, tenant_conf: {} });
  }
  async timeline(branchId) { return this.api('pageserver', `/v1/tenant/${this.state.tenant}/timeline/${branchId}`); }
  async verifyBranch(branch) {
    const observed = await this.timeline(branch.id);
    if (branch.parent_id && (observed.ancestor_timeline_id !== branch.parent_id || observed.ancestor_lsn !== branch.parent_lsn)) {
      throw new Error('The live timeline no longer matches its recorded ancestry.');
    }
    if (!branch.endpoint.disabled) {
      const info = await inspect('container', `${this.state.owner}-c-${branch.id.slice(0, 12)}`);
      owns(info, this.state, branch.id);
      if (!info || info.Id !== branch.containerId) throw new Error('The recorded compute identity is no longer present.');
    }
  }
  async sql(branch, statement) {
    if (!branch.endpoint?.port || branch.endpoint.disabled) throw new Error('The branch has no active compute.');
    const client = new pg.Client({ host: '127.0.0.1', port: branch.endpoint.port, user: 'cloud_admin',
      password: this.password(), database: 'postgres', ssl: false, connectionTimeoutMillis: 15000,
      query_timeout: 15000, application_name: 'stellane-local-neon' });
    client.on('error', () => {});
    try { await client.connect(); return await client.query(statement); }
    finally { await client.end().catch(() => {}); }
  }
  async parentLsn(parent) {
    const lsn = parent.checkpoint ? parent.parent_lsn : (await this.sql(parent, 'SELECT pg_current_wal_flush_lsn()::text AS lsn')).rows[0].lsn;
    const number = value => { const [high, low] = value.split('/'); return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`); };
    await this.wait(async () => number((await this.timeline(parent.id)).last_record_lsn) >= number(lsn), 'Committed WAL ingestion');
    return lsn;
  }
  config(branch) {
    const state = this.state;
    const password = createHash('md5').update(this.password() + 'cloud_admin').digest('hex');
    const settings = { port: ['55433', 'integer'], listen_addresses: ['0.0.0.0', 'string'], shared_buffers: ['32MB', 'string'],
      max_connections: ['30', 'integer'], max_wal_senders: ['10', 'integer'], max_replication_slots: ['10', 'integer'],
      wal_level: ['logical', 'enum'], wal_log_hints: ['on', 'bool'], fsync: ['on', 'bool'],
      shared_preload_libraries: ['neon', 'string'], synchronous_standby_names: ['walproposer', 'string'],
      password_encryption: ['md5', 'enum'] };
    return { spec: { format_version: 1, operation_uuid: branch.operationId, suspend_timeout_seconds: -1,
      tenant_id: state.tenant, timeline_id: branch.id, pageserver_connstring: 'host=pageserver port=6400',
      safekeeper_connstrings: ['safekeeper:5454'], mode: branch.checkpoint ? { Static: branch.parent_lsn } : 'Primary',
      skip_pg_catalog_updates: branch.checkpoint,
      cluster: { cluster_id: branch.id, name: branch.name, state: 'restarted',
        roles: [{ name: 'cloud_admin', encrypted_password: password, options: null }], databases: [],
        settings: Object.entries(settings).map(([name, [value, vartype]]) => ({ name, value, vartype })) }, delta_operations: [] },
      compute_ctl_config: { jwks: { keys: [] } } };
  }
  async compute(branch) {
    const state = this.state, name = `${state.owner}-c-${branch.id.slice(0, 12)}`;
    let info = await inspect('container', name); owns(info, state, branch.id);
    if (info && branch.containerId && info.Id !== branch.containerId) throw new Error('Compute container identity changed.');
    if (!info) {
      const configPath = join(state.directory, 'compute', `${branch.id}.json`);
      saveJson(configPath, this.config(branch)); chmodSync(configPath, 0o644); // Parent directory is private; container postgres reads this single mounted file.
      await docker(['create', '--name', name, ...labels(state, { 'com.stellane.timeline': branch.id }),
        '--network', `${state.owner}-network`, '--memory', '512m', '--cpus', '1', '-p', '127.0.0.1::55433',
        '--mount', `type=bind,src=${configPath},dst=/run/stellane-compute.json,readonly`,
        '--entrypoint', '/usr/local/bin/compute_ctl', state.images.compute.reference,
        '--pgdata', '/var/db/postgres/compute', '-C', 'postgresql://cloud_admin@localhost:55433/postgres',
        '-b', '/usr/local/bin/postgres', '--compute-id', branch.endpoint.id, '--config', '/run/stellane-compute.json', '--dev']);
      info = await inspect('container', name); owns(info, state, branch.id);
      branch.containerId = info.Id; this.save();
    }
    if (!info.State.Running) { await docker(['start', name]); info = await inspect('container', name); }
    branch.endpoint.port = Number(info.NetworkSettings.Ports['55433/tcp'][0].HostPort);
    branch.endpoint.host = '127.0.0.1'; this.save();
    await this.wait(async () => (await this.sql(branch, 'SELECT 1')).rows.length === 1, 'Neon SQL compute');
    const readOnly = (await this.sql(branch, 'SHOW transaction_read_only')).rows[0].transaction_read_only;
    if ((readOnly === 'on') !== branch.checkpoint) throw new Error('Compute access mode does not match the recorded branch.');
  }
  async createTimeline(branch) {
    let existing;
    try { existing = await this.timeline(branch.id); }
    catch (error) { if (error.status !== 404) throw error; }
    if (!existing) {
      if (branch.current_state !== 'creating') throw new Error('A previously recorded timeline is missing. Its data will not be silently recreated.');
      await this.api('pageserver', `/v1/tenant/${this.state.tenant}/timeline`, 'POST', { new_timeline_id: branch.id, pg_version: 16,
        ...(branch.parent_id ? { ancestor_timeline_id: branch.parent_id, ancestor_start_lsn: branch.parent_lsn } : {}) });
      existing = await this.timeline(branch.id);
    }
    if (branch.parent_id && (existing.ancestor_timeline_id !== branch.parent_id || existing.ancestor_lsn !== branch.parent_lsn)) {
      throw new Error('The timeline ancestry differs from the durable creation request.');
    }
    await this.compute(branch);
    branch.current_state = 'ready'; this.save();
  }
  newBranch(id, name, parent, lsn, checkpoint, operationId, source = false) {
    return { id, project_id: this.state.projectId, name, created_at: new Date().toISOString(), current_state: 'creating',
      ...(parent ? { parent_id: parent, parent_lsn: lsn } : {}), checkpoint, operationId, source,
      default: source, protected: source, annotation: source ? {} : { 'stellane-operation-id': operationId },
      endpoint: { id: `ep-${id}`, branch_id: id, project_id: this.state.projectId, host: '127.0.0.1', type: checkpoint ? 'read_only' : 'read_write' } };
  }
  async bootstrap() {
    await this.startStorage();
    let source = this.state.branches[this.state.rootBranchId];
    if (!source) { source = this.newBranch(this.state.rootBranchId, 'Local Neon source', undefined, undefined, false, randomUUID(), true);
      this.state.branches[source.id] = source; this.save(); }
    await this.createTimeline(source);
    for (const branch of Object.values(this.state.branches)) {
      if (branch.source || branch.current_state === 'deleted' || branch.current_state === 'deleting' || branch.endpoint.disabled) continue;
      if (branch.current_state === 'ready') { await this.timeline(branch.id); await this.compute(branch); }
    }
    // Reconcile only already persisted work. IDs, ancestry and operation ownership
    // stay identical across a controller restart; no new trial is invented.
    for (const operation of Object.values(this.state.operations).filter(item => item.status === 'running')) this.schedule(operation);
  }
  schedule(operation) {
    if (this.pending.has(operation.id)) return;
    const job = (async () => {
      try {
        const branch = this.state.branches[operation.branch_id];
        if (operation.kind === 'create') await this.createTimeline(branch);
        else await this.remove(branch, operation.kind);
        operation.status = 'finished'; delete operation.error;
      } catch (error) {
        operation.status = 'failed'; operation.error = error.message;
        console.error(`Local operation ${operation.id}: ${error.message}`);
      } finally { this.save(); this.pending.delete(operation.id); }
    })();
    this.pending.set(operation.id, job);
  }
  async remove(branch, kind) {
    if (branch.source) throw new Error('The source timeline cannot be removed.');
    const name = `${this.state.owner}-c-${branch.id.slice(0, 12)}`;
    const info = await inspect('container', name); owns(info, this.state, branch.id);
    if (info) {
      if (branch.containerId && info.Id !== branch.containerId) throw new Error('Compute identity changed before removal.');
      await docker(['rm', '-f', info.Id]);
    }
    branch.endpoint.disabled = true; this.save();
    if (kind === 'compute') return;
    for (const service of ['pageserver', 'safekeeper']) {
      try { await this.api(service, `/v1/tenant/${this.state.tenant}/timeline/${branch.id}`, 'DELETE'); }
      catch (error) { if (error.status !== 404) throw error; }
      await this.wait(async () => {
        try { await this.api(service, `/v1/tenant/${this.state.tenant}/timeline/${branch.id}`); return false; }
        catch (error) { if (error.status === 404) return true; throw error; }
      }, `${service} timeline removal`);
    }
    branch.current_state = 'deleted'; this.save();
  }
  provider() {
    return { name: 'Local Neon', projectPath: this.state.projectPath, projectId: this.state.projectId,
      branchId: this.state.rootBranchId, database: 'postgres', user: 'cloud_admin',
      apiKeyRef: `file:${join(this.state.directory, 'api-token')}`, localEndpoint: `http://127.0.0.1:${this.state.apiPort}` };
  }
  publish() {
    saveJson(join(this.state.directory, 'provider.json'), this.provider());
    const branch = this.state.branches[this.state.rootBranchId];
    if (branch?.endpoint.port) writeFileSync(join(this.state.directory, 'connection-url.txt'),
      `postgresql://cloud_admin:${this.password()}@127.0.0.1:${branch.endpoint.port}/postgres?sslmode=disable\n`, { mode: 0o600 });
  }
}
