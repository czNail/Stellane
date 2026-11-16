import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StellaneCore } from '../src/core/index.ts';
import { parseConnectionUrl } from '../src/core/onboarding.ts';
import { secret, type QueryProvider } from '../src/providers/postgres.ts';

test('connection URLs preserve encoded credentials and enforce explicit transport settings', () => {
  const parsed = parseConnectionUrl('postgresql://reader:p%40ss%20@ep-test-pooler.eu.aws.neon.tech/data?sslmode=require&channel_binding=require');
  assert.equal(parsed.password, 'p@ss ');
  assert.equal(parsed.host, 'ep-test-pooler.eu.aws.neon.tech');
  assert.equal(parsed.tls, 'verify-full');
  assert.equal(parsed.channelBinding, 'require');
  assert.equal(parseConnectionUrl('postgres://r:p@[::1]:5544/db').host, '::1');
  assert.equal(parseConnectionUrl('postgres://r:p@localhost/db').tls, 'disable');
  assert.equal(parseConnectionUrl('postgres://r:p@remote.example/db').tls, 'verify-full');
  for (const url of [
    'https://reader:secret@example.test/db', 'postgres://r:p@localhost/db#fragment',
    'postgres://r:p@localhost/db?sslmode=disable&sslmode=require',
    'postgres://r:p@localhost/db?channel_binding=require&sslmode=disable',
    'postgres://r:p@localhost/db?options=-c%20search_path%3Dhidden',
    'postgres://r:p@localhost/db?sslrootcert=/private/file',
    'postgres://r:p%0A@localhost/db', 'postgres://r@localhost/db',
  ]) {
    assert.throws(() => parseConnectionUrl(url), error => error instanceof Error && !error.message.includes(url));
  }
});

test('one-step onboarding tests before publishing, stores only a credential reference and rolls back failed setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stellane-onboarding-'));
  const directory = join(root, 'state');
  let fail = true;
  const target = { database: 'app', user: 'reader', address: '127.0.0.1', port: 5432 };
  const provider: QueryProvider = {
    async probe(connection) {
      assert.equal(await secret(connection.passwordRef), 'test-password ');
      if (fail) throw new Error('connection unavailable');
      return target;
    },
    async query() { return { columns: ['n'], rows: [{ n: 1 }], rowCount: 1, truncated: false, target }; },
  };
  let core = new StellaneCore(directory, provider);
  const input = { name: 'app', projectPath: root, connectionString: 'postgresql://reader:test-password%20@localhost/app' };
  try {
    await assert.rejects(core.connectPostgres(input), /unavailable/);
    assert.equal(core.snapshot().connections.length, 0);
    assert.equal(core.snapshot().environments.length, 0);
    assert.deepEqual(await readdir(join(directory, 'credentials')), []);
    fail = false;
    const environment = await core.connectPostgres(input);
    assert.equal(environment.access, 'read-only');
    assert.equal(environment.mode, 'live');
    assert.equal(core.snapshot().environments.length, 1);
    const connection = core.snapshot().connections[0]!;
    assert(!JSON.stringify(core.snapshot()).includes('test-password'));
    assert.equal((await stat(connection.passwordRef.slice(5))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'credentials'))).mode & 0o777, 0o700);
    await core.close();
    core = new StellaneCore(directory, provider);
    assert.equal((await core.environments({ kind: 'agent', id: 'new-chat', projectPath: root }))[0]!.id, environment.id);
    assert.equal(await secret(connection.passwordRef), 'test-password ');
    assert(!(await readFile(join(directory, 'state.sqlite'))).includes(Buffer.from('test-password')));
    await assert.rejects(core.write({ environmentId: environment.id, sql: 'DELETE FROM readings' }, { kind: 'user', id: 'owner' }), /只能写入/);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});
