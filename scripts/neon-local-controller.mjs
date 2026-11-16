import { createServer } from 'node:http';
import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LocalNeon, loadState, saveJson } from './neon-local-runtime.mjs';

const directory = resolve(process.argv[2] ?? '');
const lock = new DatabaseSync(join(directory, 'controller-owner.sqlite'));
chmodSync(join(directory, 'controller-owner.sqlite'), 0o600);
lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
const runtime = new LocalNeon(loadState(directory));
const state = runtime.state;
let ready = false;
let stopping = false;
let creating = 0;
let startupError;
const reply = (response, status, value = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
};
function authorized(request) {
  const actual = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${runtime.token()}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function branchData(branch) {
  const { id, project_id, name, created_at, current_state, parent_id, parent_lsn, protected: protectedBranch, default: defaultBranch } = branch;
  return { id, project_id, name, created_at, current_state, ...(parent_id ? { parent_id, parent_lsn } : {}), protected: protectedBranch, default: defaultBranch };
}
function operationData(operation) {
  return { id: operation.id, project_id: state.projectId, branch_id: operation.branch_id, status: operation.status };
}
async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 32768) throw new Error('Request too large.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function operation(kind, branch) {
  const item = { id: randomUUID(), branch_id: branch.id, project_id: state.projectId, kind, status: 'running', createdAt: new Date().toISOString() };
  state.operations[item.id] = item; return item;
}
const server = createServer(async (request, response) => {
  try {
    if (request.headers.host !== `127.0.0.1:${state.apiPort}` || !authorized(request)) return reply(response, 401);
    const url = new URL(request.url, `http://127.0.0.1:${state.apiPort}`);
    if (url.pathname === '/__local/health' && request.method === 'GET') {
      return reply(response, 200, { kind: 'stellane-local-neon', instanceId: state.id, ready, failed: !!startupError,
        runningOperations: runtime.pending.size + creating, sourceBranchId: state.rootBranchId });
    }
    if (url.pathname === '/__local/shutdown' && request.method === 'POST') {
      if (runtime.pending.size || creating || !ready && !startupError) return reply(response, 409, { error: 'Operations are still running.' });
      stopping = true; reply(response, 200, { stopped: true });
      server.close(() => { unlinkSync(join(directory, 'controller.json')); lock.exec('ROLLBACK'); lock.close(); process.exit(0); }); return;
    }
    if (url.pathname === '/__local/reconcile' && request.method === 'POST') {
      if (!ready || stopping) return reply(response, 503);
      const pending = Object.values(state.operations).filter(item => item.status === 'failed');
      for (const item of pending) { item.status = 'running'; delete item.error; runtime.save(); runtime.schedule(item); }
      return reply(response, 200, { operations: pending.map(operationData) });
    }
    if (!ready || stopping) return reply(response, 503, { error: 'Local storage is not ready. Inspect the private controller log.' });
    const prefix = `/api/v2/projects/${state.projectId}`;
    if (!url.pathname.startsWith(prefix + '/')) return reply(response, 404);
    const path = url.pathname.slice(prefix.length);
    if (path === '/branches' && request.method === 'GET') {
      const matching = Object.values(state.branches).filter(item => item.current_state !== 'deleted' && (!url.searchParams.get('search') || item.name === url.searchParams.get('search')));
      return reply(response, 200, { branches: matching.slice(0, 100).map(branchData), ...(matching.length > 100 ? { pagination: { next: 'more' } } : {}) });
    }
    if (path === '/branches' && request.method === 'POST') {
      creating++;
      try {
      const body = await readBody(request);
      const annotation = body.annotation_value?.['stellane-operation-id'];
      const parent = state.branches[body.branch?.parent_id];
      const type = body.endpoints?.[0]?.type;
      if (!parent || parent.current_state !== 'ready' || parent.endpoint.disabled || typeof body.branch?.name !== 'string'
        || body.branch.name.length > 120 || !/^[0-9a-f-]{36}$/.test(annotation ?? '')
        || body.endpoints.length !== 1 || !['read_only', 'read_write'].includes(type)) return reply(response, 400);
      const known = Object.values(state.branches).find(item => item.operationId === annotation);
      if (known) {
        if (known.name !== body.branch.name || known.parent_id !== parent.id || known.endpoint.type !== type || known.current_state === 'deleted') return reply(response, 409);
        return reply(response, 200, { branch: branchData(known), operations: [operationData(state.operations[known.creationOperationId])] });
      }
      if (Object.values(state.branches).filter(item => item.current_state !== 'deleted').length >= 16) return reply(response, 422);
      // Capture a committed LSN once. A fork and a retry share this recorded origin.
      const lsn = await runtime.parentLsn(parent);
      if (parent.current_state !== 'ready' || parent.endpoint.disabled) return reply(response, 409);
      // Admission can overlap while WAL is ingested. Recheck after the await;
      // everything through save() below is synchronous and uses the same ID.
      const admitted = Object.values(state.branches).find(item => item.operationId === annotation);
      if (admitted) {
        if (admitted.name !== body.branch.name || admitted.parent_id !== parent.id || admitted.endpoint.type !== type || admitted.current_state === 'deleted') return reply(response, 409);
        return reply(response, 200, { branch: branchData(admitted), operations: [operationData(state.operations[admitted.creationOperationId])] });
      }
      if (Object.values(state.branches).filter(item => item.current_state !== 'deleted').length >= 16) return reply(response, 422);
      const branch = runtime.newBranch(randomBytes(16).toString('hex'), body.branch.name, parent.id, lsn, type === 'read_only', annotation);
      const task = operation('create', branch); branch.creationOperationId = task.id;
      state.branches[branch.id] = branch; runtime.save();
      reply(response, 201, { branch: branchData(branch), operations: [operationData(task)] }); runtime.schedule(task); return;
      } finally { creating--; }
    }
    const branchMatch = path.match(/^\/branches\/([a-f0-9]{32})(\/endpoints)?$/);
    if (branchMatch) {
      const branch = state.branches[branchMatch[1]];
      if (!branch || branch.current_state === 'deleted') return reply(response, 404);
      if (request.method === 'GET' && branch.current_state === 'ready') await runtime.verifyBranch(branch);
      if (request.method === 'GET') return reply(response, 200, branchMatch[2]
        ? { endpoints: branch.endpoint.disabled ? [] : [branch.endpoint] }
        : { branch: branchData(branch), annotation: { value: branch.annotation } });
      if (request.method === 'DELETE' && !branchMatch[2]) {
        if (branch.source) return reply(response, 403);
        if (Object.values(state.branches).some(item => item.parent_id === branch.id && item.current_state !== 'deleted')) return reply(response, 409);
        let task = state.operations[branch.deletionOperationId];
        if (!task) { task = operation('branch', branch); branch.deletionOperationId = task.id; branch.current_state = 'deleting'; runtime.save(); }
        reply(response, 200, { operations: [operationData(task)] }); runtime.schedule(task); return;
      }
    }
    const endpointMatch = path.match(/^\/endpoints\/(ep-[a-f0-9]{32})$/);
    if (endpointMatch && request.method === 'DELETE') {
      const branch = Object.values(state.branches).find(item => item.endpoint.id === endpointMatch[1] && item.current_state !== 'deleted');
      if (!branch) return reply(response, 404);
      if (branch.source) return reply(response, 403);
      let task = state.operations[branch.computeRemovalId];
      if (!task) { task = operation('compute', branch); branch.computeRemovalId = task.id; runtime.save(); }
      reply(response, 200, { operations: [operationData(task)] }); runtime.schedule(task); return;
    }
    const operationMatch = path.match(/^\/operations\/([a-f0-9-]{36})$/);
    if (operationMatch && request.method === 'GET') {
      const item = state.operations[operationMatch[1]];
      return item ? reply(response, 200, { operation: operationData(item) }) : reply(response, 404);
    }
    if (path === '/connection_uri' && request.method === 'GET') {
      const branch = state.branches[url.searchParams.get('branch_id')];
      if (!branch || branch.current_state !== 'ready' || branch.endpoint.disabled) return reply(response, 404);
      if (url.searchParams.get('endpoint_id') !== branch.endpoint.id || url.searchParams.get('database_name') !== 'postgres'
        || url.searchParams.get('role_name') !== 'cloud_admin' || url.searchParams.get('pooled') !== 'false') return reply(response, 400);
      return reply(response, 200, { uri: `postgresql://cloud_admin:${runtime.password()}@127.0.0.1:${branch.endpoint.port}/postgres?sslmode=disable` });
    }
    reply(response, 404);
  } catch (error) {
    console.error(error.message);
    if (!response.headersSent) reply(response, 500, { error: 'Local Neon request failed. Inspect this instance’s private controller log.' });
  }
});
server.listen(state.apiPort ?? 0, '127.0.0.1', async () => {
  state.apiPort = server.address().port; runtime.save();
  saveJson(join(directory, 'controller.json'), { pid: process.pid, instanceId: state.id, endpoint: `http://127.0.0.1:${state.apiPort}` });
  try { await runtime.bootstrap(); runtime.publish(); ready = true; console.log('Local Neon storage and source are ready.'); }
  catch (error) { startupError = error; console.error(`Local Neon startup failed: ${error.message}`); }
});
server.on('error', error => { console.error(`Controller could not listen: ${error.code}`); lock.close(); process.exit(1); });
