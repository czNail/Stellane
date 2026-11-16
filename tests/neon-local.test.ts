import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLocalNeonConfig } from '../src/core/neon-local-onboarding.ts';
import { localNeonEndpoint, type NeonSource } from '../src/shared/neon-models.ts';
import { NeonProvider } from '../src/providers/neon.ts';

const config = { name: 'Local test', projectPath: '/test-project', projectId: 'local-project', branchId: 'branch',
  database: 'postgres', user: 'cloud_admin', apiKeyRef: 'env:STELLANE_LOCAL_NEON_TEST_KEY', localEndpoint: 'http://127.0.0.1:12345' };
process.env.STELLANE_LOCAL_NEON_TEST_KEY = 'test-only-local-token';

test('local Neon configuration cannot select a cloud or non-loopback management endpoint', async () => {
  for (const value of ['https://console.neon.tech', 'http://localhost:1234', 'http://192.168.1.2:1234',
    'http://127.0.0.1:1234/path', 'http://user:secret@127.0.0.1:1234', 'http://127.0.0.1:1234?token=secret']) {
    assert.equal(localNeonEndpoint.safeParse(value).success, false, value);
  }
  assert.equal(localNeonEndpoint.parse('http://[::1]:1234/'), 'http://[::1]:1234');
  const directory = await mkdtemp(join(tmpdir(), 'stellane-local-config-'));
  const path = join(directory, 'provider.json');
  try {
    const { localEndpoint: _endpoint, ...cloud } = config;
    await writeFile(path, JSON.stringify(cloud));
    await assert.rejects(readLocalNeonConfig(path), /cloud configurations are not accepted/);
    await writeFile(path, JSON.stringify(config));
    assert.deepEqual(await readLocalNeonConfig(path), config);
    await assert.rejects(readLocalNeonConfig('provider.json'), /absolute/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('explicit local Neon validates SQL host and port and cannot weaken cloud transport', async () => {
  const source: NeonSource = { ...config, id: 'provider', createdAt: '2026-01-01' };
  let host = '127.0.0.1'; let uriPort = 23456;
  const provider = new NeonProvider(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, config.localEndpoint);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-only-local-token');
    const value = url.pathname.endsWith('/endpoints') ? { endpoints: [{ id: 'endpoint', project_id: config.projectId,
      branch_id: config.branchId, host, port: 23456, type: 'read_write' }] }
      : url.pathname.endsWith('/connection_uri') ? { uri: `postgresql://cloud_admin:test-password@${host}:${uriPort}/postgres?sslmode=disable` }
      : { branch: { id: config.branchId, project_id: config.projectId, name: 'source', created_at: '2026-01-01', current_state: 'ready' } };
    return new Response(JSON.stringify(value));
  });
  const signal = new AbortController().signal;
  const binding = await provider.sourceBinding(source, signal);
  assert.equal(binding.local, true);
  const connection = await provider.connect(source, binding, signal);
  assert.equal(connection.host, '127.0.0.1'); assert.equal(connection.port, 23456); assert.equal(connection.ssl, false);
  uriPort = 34567;
  await assert.rejects(provider.connect(source, binding, signal), /不匹配/);
  uriPort = 23456; host = 'public.example';
  await assert.rejects(provider.connect(source, binding, signal), /non-loopback/);
  await assert.rejects(provider.connect({ ...source, localEndpoint: undefined }, binding, signal));
});
