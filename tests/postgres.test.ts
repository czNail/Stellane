import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StellaneCore } from '../src/core/index.ts';

const connection = JSON.parse(await readFile(new URL('../.stellane-dev/connection.json', import.meta.url), 'utf8'));
const actor = { kind: 'user' as const, id: 'owner' };

test('real PostgreSQL query, parameters, row limit and read-only boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-pg-'));
  const core = new StellaneCore(root);
  try {
    const saved = await core.saveConnection(connection);
    const target = await core.probe(saved.id, new AbortController().signal);
    assert.equal(target.database, 'stellane');
    assert.equal(target.user, 'stellane_reader');
    const environment = core.createEnvironment({ connectionId: saved.id, name: 'integration' });
    const query = (sql: string, values: (string | number | boolean | null)[] = []) => core.query({ environmentId: environment.id, sql, values }, actor);
    const result = await query('SELECT customer, quantity FROM demo_orders WHERE quantity > $1 ORDER BY id', [100]);
    assert.equal(result.status, 'succeeded', result.error);
    assert.deepEqual(result.preview?.rows.map(row => row.quantity), [120, 160]);
    const large = await query('SELECT generate_series(1, 1000) AS n');
    assert.equal(large.preview?.rows.length, 200);
    assert.equal(large.preview?.truncated, true);
    const duplicate = await query('SELECT 1 AS value, 2 AS value');
    assert.deepEqual(duplicate.preview?.rows, [{ value: 1, 'value (2)': 2 }]);
    const oversized = await query("SELECT repeat('x', 140000) AS value");
    assert.equal(oversized.status, 'failed');
    assert.match(oversized.error ?? '', /128 KiB/);
    for (const sql of [
      'DELETE FROM demo_orders',
      'SELECT 1; COMMIT; DELETE FROM demo_orders',
      'WITH removed AS (DELETE FROM demo_orders RETURNING *) SELECT * FROM removed',
      'SELECT 1) AS escape; COMMIT; DELETE FROM demo_orders; --',
      "SELECT set_config('transaction_read_only', 'off', true)",
    ]) assert.equal((await query(sql)).status, 'failed', sql);
    const remaining = await query('SELECT count(*)::int AS count FROM demo_orders');
    assert.deepEqual(remaining.preview?.rows, [{ count: 3 }]);
    const password = await readFile(connection.passwordRef.slice(5), 'utf8');
    assert(!JSON.stringify(core.snapshot()).includes(password));
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('query cancellation settles the connection and persists interrupted status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-cancel-'));
  const core = new StellaneCore(root);
  try {
    const saved = await core.saveConnection(connection);
    const environment = core.createEnvironment({ connectionId: saved.id, name: 'cancel' });
    const controller = new AbortController();
    const started = Date.now();
    const pending = core.query({ environmentId: environment.id, sql: 'SELECT pg_sleep(4)' }, actor, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.equal(result.status, 'interrupted');
    assert(Date.now() - started < 3000);
    assert.equal(core.snapshot().runs[0]?.status, 'interrupted');
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});
