import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const state = join(root, '.stellane-dev');
const name = 'stellane-phase1-postgres';
const volume = 'stellane-phase1-postgres-data';
const owner = 'stellane-phase1';
const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
function inspect(kind, target) {
  try { return JSON.parse(docker([kind, 'inspect', target]))[0]; }
  catch { return undefined; }
}
function owned(resource, labels) {
  if (resource && labels?.['com.stellane.owner'] !== owner) throw new Error('同名资源不属于 Stellane，已停止操作。');
}
mkdirSync(state, { recursive: true, mode: 0o700 });
const container = inspect('container', name);
owned(container, container?.Config.Labels);
const command = process.argv[2] ?? 'start';
if (command === 'stop') {
  if (container) docker(['stop', name]);
  console.log('Stellane 专用 PostgreSQL 已停止，数据卷保留。');
} else if (command === 'start') {
  const passwordFile = join(state, 'reader-password');
  if (!container) {
    const existingVolume = inspect('volume', volume);
    owned(existingVolume, existingVolume?.Labels);
    if (existingVolume) throw new Error('专用数据卷已存在但容器缺失，请人工核对，脚本不会覆盖旧数据。');
    const adminPassword = randomBytes(24).toString('hex');
    const readerPassword = randomBytes(24).toString('hex');
    const envFile = join(state, 'postgres.env');
    writeFileSync(envFile, `POSTGRES_PASSWORD=${adminPassword}\nPOSTGRES_DB=stellane\n`, { mode: 0o600 });
    writeFileSync(passwordFile, readerPassword, { mode: 0o600 });
    docker(['volume', 'create', '--label', `com.stellane.owner=${owner}`, volume]);
    docker(['run', '-d', '--name', name, '--label', `com.stellane.owner=${owner}`,
      '--env-file', envFile, '-p', '127.0.0.1::5432', '-v', `${volume}:/var/lib/postgresql/data`, 'postgres:17']);
  } else if (!container.State.Running) docker(['start', name]);
  if (!existsSync(passwordFile)) throw new Error('专用实例的本地密码引用缺失，请人工核对。');
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'stellane']); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!ready) throw new Error('专用 PostgreSQL 未在 20 秒内就绪。');
  const readerPassword = readFileSync(passwordFile, 'utf8');
  if (!/^[a-f0-9]{48}$/.test(readerPassword)) throw new Error('本地密码引用格式不正确。');
  const sql = `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stellane_reader') THEN
    CREATE ROLE stellane_reader LOGIN PASSWORD '${readerPassword}'; END IF; END $$;
    CREATE TABLE IF NOT EXISTS sample_data (id integer PRIMARY KEY, label text NOT NULL, value integer NOT NULL, group_name text NOT NULL);
    INSERT INTO sample_data VALUES (1,'alpha',120,'group_a'),(2,'beta',80,'group_b'),(3,'gamma',160,'group_a') ON CONFLICT DO NOTHING;
    GRANT CONNECT ON DATABASE stellane TO stellane_reader;
    GRANT USAGE ON SCHEMA public TO stellane_reader;
    GRANT SELECT ON sample_data TO stellane_reader;
    ALTER ROLE stellane_reader SET default_transaction_read_only = on;`;
  docker(['exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'stellane'], { input: sql });
  const info = inspect('container', name);
  const port = Number(info.NetworkSettings.Ports['5432/tcp'][0].HostPort);
  const connection = { name: 'Stellane 开发数据库', projectPath: root, host: '127.0.0.1', port,
    database: 'stellane', user: 'stellane_reader', passwordRef: `file:${passwordFile}`, tls: 'disable' };
  writeFileSync(join(state, 'connection.json'), `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ container: name, connection }, null, 2));
} else {
  throw new Error('用法：pnpm dev:db [start|stop]');
}
