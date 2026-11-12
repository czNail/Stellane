import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { request } from 'node:https';
import { setTimeout } from 'node:timers/promises';
import type { ClientConfig } from 'pg';
import { z } from 'zod';
import type { BranchBinding, BranchIdentity, BranchOperation, StelloSource } from '../shared/models.ts';
import { PostgresProvider, secret } from './postgres.ts';

const identitySchema = z.object({ service: z.string().min(1), slot: z.number().int().nonnegative(), incarnation: z.number().int().positive() });
const branchSchema = z.object({
  identity: identitySchema, name: z.string(), resource_id: z.string().min(1),
  mode: z.enum(['writable', 'fixed', 'following']), fork_lsn: z.string().regex(/^[0-9A-F]+\/[0-9A-F]+$/i),
  complete: z.boolean(), state: z.string(), creation_id: z.string().nullable().optional(),
  parent_identity: identitySchema.nullable().optional(),
});
const configSchema = z.object({ endpoint: z.url().refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password;
}), ca: z.string().min(1), token_file: z.string().min(1) });
const connectionSchema = z.object({ host: z.string().min(1), port: z.number().int().positive().max(65535),
  database: z.string().min(1), user: z.string().min(1), ca: z.string().max(65536),
  password: z.string().optional(), certificate: z.string().optional(), key: z.string().optional() });

export function encodeResource(resource: string): string {
  if (!/^[a-z0-9-]{1,24}\/[a-z0-9-]{1,24}$/.test(resource)) throw new Error('Stello 资源须为 database/branch，每段最多 24 个小写字母、数字或短横线。');
  const [database, branch] = resource.split('/');
  return `db${database!.length}-${database}-${branch}`;
}
export function sameIdentity(left: BranchIdentity, right: BranchIdentity): boolean {
  return left.service === right.service && left.slot === right.slot && left.incarnation === right.incarnation;
}
export class StelloRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, detail?: string) {
    super(`Stello 操作失败（${status}/${code}），请核对权限与资源状态。`, { cause: detail });
    this.status = status; this.code = code;
  }
}

export class StelloProvider {
  readonly sql = new PostgresProvider();
  private readonly creating = new Map<string, Promise<void>>();
  async operation(source: StelloSource, operation: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const file = source.configPath;
    if (!isAbsolute(file) || (await stat(file)).size > 65536) throw new Error('Stello 客户端配置须为不超过 64 KiB 的绝对路径文件。');
    const config = configSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    const ca = await readFile(resolve(dirname(file), config.ca));
    if (ca.byteLength > 65536) throw new Error('Stello CA 文件过大。');
    const token = await secret(`file:${resolve(dirname(file), config.token_file)}`);
    const body = JSON.stringify(operation);
    return new Promise((accept, reject) => {
      const req = request(new URL('/v1/operations', config.endpoint), {
        method: 'POST', ca, rejectUnauthorized: true,
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(body) },
      }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > 512 * 1024) { req.destroy(new Error('Stello 响应超过限制。')); return; }
          chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('Stello 响应中断，请核对原资源状态。')));
        response.on('end', () => {
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!response.statusCode || response.statusCode >= 300) {
              const failure = z.object({ error: z.object({ code: z.string(), message: z.string().max(2000).optional() }) }).safeParse(value);
              const code = failure.success && /^[a-z0-9_]+$/.test(failure.data.error.code) ? failure.data.error.code : 'request_failed';
              reject(new StelloRequestError(response.statusCode ?? 0, code, failure.success ? failure.data.error.message : undefined));
            } else accept(value);
          } catch { reject(new Error('Stello 返回了无法识别的响应。')); }
        });
      });
      req.on('error', () => reject(new Error('Stello 请求未确认，请核对原资源状态；不要另建同名操作。')));
      req.end(body);
    });
  }
  async inspect(source: StelloSource, resource: string, signal: AbortSignal) {
    return branchSchema.parse(await this.operation(source, { action: 'branch_get', name: encodeResource(resource) }, signal));
  }
  binding(source: StelloSource, resource: string, observed: z.infer<typeof branchSchema>, managed: boolean): BranchBinding {
    return { providerId: source.id, resource, identity: observed.identity, resourceId: observed.resource_id,
      forkLsn: observed.fork_lsn, managed, ...(observed.creation_id ? { creationId: observed.creation_id } : {}) };
  }
  async connect(source: StelloSource, binding: BranchBinding, signal: AbortSignal): Promise<ClientConfig> {
    const value = await this.operation(source, { action: 'branch_connect', name: encodeResource(binding.resource) }, signal);
    const observed = branchSchema.parse(value);
    if (!sameIdentity(observed.identity, binding.identity) || observed.resource_id !== binding.resourceId) {
      throw new Error('Stello 资源身份已变化，旧环境不会连接同名新分支。');
    }
    const connection = connectionSchema.parse(z.object({ connection: z.unknown() }).parse(value).connection);
    if (!connection.password && (!connection.certificate || !connection.key)) throw new Error('Stello 未返回完整 SQL 凭据。');
    return { host: connection.host, port: connection.port, database: connection.database, user: connection.user,
      password: connection.password,
      ssl: { ca: connection.ca, cert: connection.certificate, key: connection.key, rejectUnauthorized: true } };
  }
  async create(source: StelloSource, parent: BranchBinding, operation: BranchOperation,
    prepared: (request: Record<string, unknown>) => void, signal: AbortSignal): Promise<BranchBinding> {
    // Admission selects a fresh catalog identity. Serialize this short lifecycle
    // path per database; SQL on existing sibling branches remains concurrent.
    const key = `${source.configPath}:${parent.resource.split('/')[0]}`;
    const previous = this.creating.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.creating.set(key, current);
    await previous;
    try {
      signal.throwIfAborted();
      return await this.createBranch(source, parent, operation, prepared, signal);
    } finally {
      release(); if (this.creating.get(key) === current) this.creating.delete(key);
    }
  }
  private async createBranch(source: StelloSource, parent: BranchBinding, operation: BranchOperation,
    prepared: (request: Record<string, unknown>) => void, signal: AbortSignal): Promise<BranchBinding> {
    const observed = await this.inspect(source, parent.resource, signal);
    if (!sameIdentity(observed.identity, parent.identity) || observed.resource_id !== parent.resourceId) throw new Error('父环境身份已变化。');
    const resource = operation.resource;
    const admission = z.object({ identity: identitySchema, database: identitySchema,
      parent_identity: identitySchema, source_history: z.string().min(1) }).parse(await this.operation(source, {
      action: 'prepare_resource', request: { kind: 'branch', name: encodeResource(resource), empty: false, source: null, parent: encodeResource(parent.resource) },
    }, signal));
    if (!sameIdentity(admission.parent_identity, parent.identity)) throw new Error('派生准入期间父环境身份已变化。');
    const body = { action: 'branch_create', name: encodeResource(resource), creation_id: operation.id.replaceAll('-', ''), empty: false,
      ...admission, source: '', parent_branch: encodeResource(parent.resource),
      mode: operation.kind === 'checkpoint' ? 'fixed' : 'writable', no_compute: false,
      lsn: 'latest', at: null, node: null, spec: null, extensions: [] };
    prepared(body);
    await this.operation(source, body, signal);
    const deadline = Date.now() + 120000;
    while (true) {
      const binding = await this.reconcile(source, operation, signal);
      if (binding) return binding;
      if (Date.now() > deadline) throw new Error('Stello 派生仍未完成，请保留原操作并核对状态。');
      await setTimeout(400, undefined, { signal });
    }
  }
  async reconcile(source: StelloSource, operation: BranchOperation, signal: AbortSignal): Promise<BranchBinding | undefined> {
    const request = operation.request;
    if (!request) throw new Error('派生尚未取得持久准入，无法确认远端资源。');
    const resource = operation.resource;
    const observed = await this.inspect(source, resource, signal);
    const expected = identitySchema.parse(request.identity);
    const parent = identitySchema.parse(request.parent_identity);
    if (!sameIdentity(observed.identity, expected) || observed.creation_id !== operation.id.replaceAll('-', '')
      || !observed.parent_identity || !sameIdentity(observed.parent_identity, parent)
      || observed.mode !== (operation.kind === 'checkpoint' ? 'fixed' : 'writable')) {
      throw new Error('远端资源与原派生票据不匹配，已停止绑定。');
    }
    if (!observed.complete || !['ready', 'stored', 'sleeping'].includes(observed.state)) return undefined;
    if (observed.fork_lsn === '0/0') throw new Error('Stello 未返回固定来源位置。');
    return this.binding(source, resource, observed, true);
  }
}
