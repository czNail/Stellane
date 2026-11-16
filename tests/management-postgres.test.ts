import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StellaneCore } from '../src/core/index.ts';
import { PostgresProvider, secret } from '../src/providers/postgres.ts';
import type { ConnectionInput } from '../src/shared/models.ts';

test('real PostgreSQL credential rotation, disable and local purge preserve the source database', async () => {
  const connection = JSON.parse(await readFile(new URL('../.stellane-dev/connection.json', import.meta.url), 'utf8')) as ConnectionInput;
  const directory = await mkdtemp(join(tmpdir(), 'stellane-management-pg-'));
  const core = new StellaneCore(directory);
  try {
    const source = await core.connectPostgres(connection);
    const owner = { kind: 'user' as const, id: 'owner' };
    const before = await core.query({ environmentId: source.id, sql: 'SELECT id, value FROM sample_data ORDER BY id' }, owner);
    assert.equal(before.status, 'succeeded');
    const url = new URL(`postgresql://${connection.host}:${connection.port}/${encodeURIComponent(connection.database)}`);
    url.username = connection.user; url.password = await secret(connection.passwordRef);
    url.searchParams.set('sslmode', connection.tls === 'disable' ? 'disable' : 'verify-full');
    await core.manage({ action: 'rotate-postgres', environmentId: source.id, connectionString: url.href });
    const replacement = core.snapshot().connections[0]!.passwordRef;
    assert.notEqual(replacement, connection.passwordRef);
    assert.equal((await stat(replacement.slice(5))).mode & 0o077, 0);
    const afterRotation = await core.query({ environmentId: source.id, sql: before.sql }, owner);
    assert.deepEqual(afterRotation.preview?.rows, before.preview?.rows);
    await core.manage({ action: 'set-source-enabled', environmentId: source.id, enabled: false });
    await assert.rejects(core.query({ environmentId: source.id, sql: before.sql }, owner), /停用/);
    await core.manage({ action: 'remove-source', environmentId: source.id });
    assert.deepEqual(core.evidence(before.id).preview, before.preview);
    await assert.rejects(stat(replacement.slice(5)), { code: 'ENOENT' });
    assert(await secret(connection.passwordRef), 'the external development credential remains available');
    await core.manage({ action: 'purge-source', environmentId: source.id, confirmation: source.name });
    assert.equal(core.management().sources.length, 0);
    assert.throws(() => core.evidence(before.id), /不存在/);
    const direct = await new PostgresProvider().query(connection, { environmentId: source.id, sql: before.sql, values: [] }, new AbortController().signal);
    assert.deepEqual(direct.rows, before.preview?.rows);
  } finally { await core.close(); await rm(directory, { recursive: true, force: true }); }
});
