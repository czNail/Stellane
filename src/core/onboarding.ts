import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { connectionInput, type ConnectionInput } from '../shared/models.ts';
import { connectNeonInput, connectPostgresInput } from '../shared/onboarding-models.ts';
import type { NeonInput } from '../shared/neon-models.ts';

export interface ParsedConnection {
  host: string; port: number; database: string; user: string; password: string;
  tls: ConnectionInput['tls']; channelBinding?: ConnectionInput['channelBinding'];
}

/** Parse without passing a credential-bearing URL to a logger or error message. */
export function parseConnectionUrl(value: string): ParsedConnection {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('请粘贴完整的 PostgreSQL 连接地址，以 postgresql:// 或 postgres:// 开头。'); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.hostname || url.hash) {
    throw new Error('连接地址须包含 PostgreSQL 主机、用户名、密码和数据库名称。');
  }
  const allowed = new Set(['sslmode', 'channel_binding']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new Error('连接地址包含暂不支持的参数。请仅保留 sslmode、channel_binding，或使用分项配置。');
    if (url.searchParams.getAll(key).length !== 1) throw new Error('连接地址中有重复参数，请每个参数只填写一次。');
  }
  let user: string, password: string, database: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch { throw new Error('连接地址中的转义格式不正确，请重新复制完整地址。'); }
  if (!user || !password || !database || /[\x00-\x1f\x7f]/.test(user + password + database)
    || url.pathname.slice(1).includes('/')) {
    throw new Error('连接地址须包含用户名、密码和一个数据库名称；特殊字符请使用 URL 转义。');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode && !['disable', 'require', 'verify-full', 'verify-ca'].includes(sslmode)) {
    throw new Error('请使用 sslmode=verify-full（验证证书）或 sslmode=disable（不启用 TLS）。');
  }
  const tls = sslmode === 'disable' || !sslmode && local ? 'disable' : 'verify-full';
  const channelBinding = url.searchParams.get('channel_binding') ?? 'prefer';
  if (!['disable', 'prefer', 'require'].includes(channelBinding) || channelBinding === 'require' && tls === 'disable') {
    throw new Error('channel_binding 仅支持 disable、prefer、require；require 需要启用 TLS。');
  }
  return { host, port: url.port ? Number(url.port) : 5432, user, password, database, tls,
    channelBinding: channelBinding as ConnectionInput['channelBinding'] };
}

export async function managedSecret(directory: string, value: string): Promise<{ reference: string; discard: () => Promise<void> }> {
  if (Buffer.byteLength(value + '\n') > 8192) throw new Error('凭据过长，私有凭据文件最多支持 8 KiB。');
  const folder = join(directory, 'credentials');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const filename = join(folder, randomUUID());
  await writeFile(filename, value + '\n', { mode: 0o600, flag: 'wx' });
  return { reference: `file:${filename}`, discard: () => unlink(filename) };
}

// Only explicit ownership recorded at creation authorizes deletion. User-supplied
// file/env references, including legacy references without ownership, are retained.
export async function removeManagedSecret(directory: string, reference: string): Promise<void> {
  if (!reference.startsWith('file:')) throw new Error('仅能清理插件自己创建的凭据文件。');
  const filename = reference.slice(5);
  const folder = resolve(directory, 'credentials');
  if (dirname(filename) !== folder || !/^[a-f0-9-]{36}$/.test(basename(filename))) throw new Error('凭据不在插件私有目录内，未删除文件。');
  const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || await realpath(dirname(filename)) !== folder) throw new Error('凭据文件身份已变化，未删除文件。');
  await unlink(filename);
}

export async function preparePostgresConnection(directory: string, value: unknown): Promise<{
  connection: ConnectionInput; discard: () => Promise<void>; managedCredentialRef?: string;
}> {
  const input = connectPostgresInput.parse(value);
  if (!('connectionString' in input)) return { connection: input, discard: async () => {} };
  const { password, ...parsed } = parseConnectionUrl(input.connectionString);
  // Validate all public fields before creating a credential file.
  const connection = connectionInput.parse({ name: input.name, projectPath: input.projectPath, ...parsed, passwordRef: 'env:STELLANE_PENDING' });
  const credential = await managedSecret(directory, password);
  return { connection: { ...connection, passwordRef: credential.reference }, discard: credential.discard, managedCredentialRef: credential.reference };
}

export async function prepareNeonConnection(directory: string, value: unknown): Promise<{
  source: NeonInput; expectedHost: string; discard: () => Promise<void>; managedCredentialRef: string;
}> {
  const input = connectNeonInput.parse(value);
  const parsed = parseConnectionUrl(input.connectionString);
  if (!parsed.host.endsWith('.neon.tech') || parsed.tls !== 'verify-full') {
    throw new Error('Neon 试验需要 Neon 控制台的连接地址，并启用 TLS 证书验证。');
  }
  const credential = await managedSecret(directory, input.apiKey);
  return {
    source: { name: input.name, projectPath: input.projectPath, projectId: input.projectId, branchId: input.branchId,
      database: parsed.database, user: parsed.user, apiKeyRef: credential.reference },
    expectedHost: parsed.host.replace(/-pooler(?=\.)/, ''), discard: credential.discard, managedCredentialRef: credential.reference,
  };
}
