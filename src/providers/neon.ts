import { setTimeout } from 'node:timers/promises';
import type { ClientConfig } from 'pg';
import { z } from 'zod';
import type { BranchOperation } from '../shared/models.ts';
import type { NeonBinding, NeonRemoval, NeonSource } from '../shared/neon-models.ts';
import { PostgresProvider, secret } from './postgres.ts';

const id = z.string().regex(/^[a-z0-9-]{1,60}$/);
const branchSchema = z.object({
  id, project_id: id, name: z.string(), created_at: z.string().min(1), current_state: z.string(),
  parent_id: id.optional(), parent_lsn: z.string().optional(), last_reset_at: z.string().optional(),
  pending_state: z.string().optional(), default: z.boolean().optional(), protected: z.boolean().optional(),
});
const endpointSchema = z.object({
  id, project_id: id, branch_id: id, host: z.string().min(1),
  type: z.enum(['read_only', 'read_write']), disabled: z.boolean().optional(),
});
const operationSchema = z.object({ id: z.string().min(1), project_id: id, branch_id: id.optional(), status: z.string() });
type Branch = z.infer<typeof branchSchema>;
type Endpoint = z.infer<typeof endpointSchema>;
type Observed = { branch: Branch; annotation?: Record<string, string> };
const annotationSchema = z.object({ value: z.record(z.string(), z.string()) }).optional();
const operationOwner = 'stellane-operation-id';
function responseData<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('Neon 返回的响应不符合预期，请核对原操作。');
  return parsed.data;
}

export class NeonRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Neon API 请求失败（${status}）。请核对 API key、项目权限、分支额度和网络。`);
    this.status = status;
  }
}
export class NeonCreationRejectedError extends NeonRequestError {}

/** Management API contract: https://neon.com/docs/reference/api/branches/create-project-branch */
export class NeonProvider {
  readonly sql = new PostgresProvider();
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = globalThis.fetch) { this.fetcher = fetcher; }

  private async request(source: NeonSource, method: string, path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const apiKey = await secret(source.apiKeyRef);
    let response: Response;
    try {
      response = await this.fetcher(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(source.projectId)}${path}`, {
        method, signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), redirect: 'error',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error('Neon 请求未确认。请核对原操作；创建和写入不会自动重放。');
    }
    if (!response.ok) { await response.body?.cancel(); throw new NeonRequestError(response.status); }
    if (response.status === 204) return {};
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Neon 返回了空响应。');
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 512 * 1024) { await reader.cancel(); throw new Error('Neon 响应超过 512 KiB。'); }
        chunks.push(chunk.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch { throw new Error('Neon 响应中断或格式不正确，请核对原操作。'); }
  }

  async inspect(source: NeonSource, branchId: string, signal: AbortSignal): Promise<Observed> {
    const response = responseData(z.object({ branch: branchSchema, annotation: annotationSchema }),
      await this.request(source, 'GET', `/branches/${id.parse(branchId)}`, signal));
    if (response.branch.project_id !== source.projectId || response.branch.id !== branchId) {
      throw new Error('Neon 返回的项目或分支身份不匹配。');
    }
    return { branch: response.branch, annotation: response.annotation?.value };
  }

  private assertReady(branch: Branch): void {
    if (branch.current_state === 'archived' || branch.pending_state === 'archived') {
      throw new Error('当前不支持已归档的 Neon 分支，请先在 Neon Console 恢复为可用分支。');
    }
    if (branch.current_state !== 'ready' || (branch.pending_state && branch.pending_state !== 'ready')) {
      throw new Error('Neon 分支尚未就绪或正在恢复，请稍后核对。');
    }
  }
  private assertIdentity(source: NeonSource, binding: NeonBinding, observed: Observed): void {
    const branch = observed.branch;
    if (binding.providerId !== source.id || binding.projectId !== source.projectId || branch.id !== binding.branchId
      || branch.created_at !== binding.createdAt || branch.parent_id !== binding.parentId
      || branch.parent_lsn !== binding.parentLsn || branch.last_reset_at !== binding.lastResetAt
      || (binding.managed && observed.annotation?.[operationOwner] !== binding.operationId)) {
      throw new Error('Neon 分支身份或恢复位置已变化，旧环境不会连接被替换或重置的数据。');
    }
    this.assertReady(branch);
  }
  private async endpoints(source: NeonSource, branchId: string, signal: AbortSignal): Promise<Endpoint[]> {
    const response = responseData(z.object({ endpoints: z.array(endpointSchema).max(100) }),
      await this.request(source, 'GET', `/branches/${id.parse(branchId)}/endpoints`, signal));
    if (response.endpoints.some(endpoint => endpoint.project_id !== source.projectId || endpoint.branch_id !== branchId)) {
      throw new Error('Neon compute 所属分支不匹配。');
    }
    return response.endpoints;
  }
  private binding(source: NeonSource, observed: Observed, endpoint: Endpoint, managed: boolean, checkpoint: boolean): NeonBinding {
    const branch = observed.branch;
    return { providerId: source.id, projectId: source.projectId, branchId: branch.id, endpointId: endpoint.id,
      createdAt: branch.created_at, parentId: branch.parent_id, parentLsn: branch.parent_lsn,
      lastResetAt: branch.last_reset_at, managed, checkpoint,
      ...(managed ? { operationId: observed.annotation?.[operationOwner] } : {}) };
  }
  async sourceBinding(source: NeonSource, signal: AbortSignal, expectedHost?: string): Promise<NeonBinding> {
    const observed = await this.inspect(source, source.branchId, signal);
    this.assertReady(observed.branch);
    const endpoints = await this.endpoints(source, source.branchId, signal);
    const endpoint = expectedHost ? endpoints.find(item => item.host === expectedHost && !item.disabled)
      : endpoints.find(item => item.type === 'read_write' && !item.disabled) ?? endpoints.find(item => !item.disabled);
    if (expectedHost && !endpoint) throw new Error('连接地址与 Neon 项目或分支不一致，请从同一个分支复制连接信息。');
    if (!endpoint) throw new Error('此 Neon 来源没有可用 compute，请先在 Neon Console 启用连接。');
    return this.binding(source, observed, endpoint, false, false);
  }
  private async usableEndpoint(source: NeonSource, binding: NeonBinding, signal: AbortSignal): Promise<Endpoint> {
    this.assertIdentity(source, binding, await this.inspect(source, binding.branchId, signal));
    const endpoints = await this.endpoints(source, binding.branchId, signal);
    const endpoint = endpoints.find(item => item.id === binding.endpointId);
    if (!endpoint || endpoint.disabled) throw new Error('Neon compute 已移除或停用，请核对原环境。');
    if (binding.checkpoint && (endpoint.type !== 'read_only' || endpoints.some(item => item.type === 'read_write'))) {
      throw new Error('保留的 Neon 只读分支出现了可写 compute，请重新验证结果。');
    }
    if (binding.managed && !binding.checkpoint && endpoint.type !== 'read_write') throw new Error('实验分支的 compute 已变更。');
    return endpoint;
  }
  async connect(source: NeonSource, binding: NeonBinding, signal: AbortSignal): Promise<ClientConfig> {
    const endpoint = await this.usableEndpoint(source, binding, signal);
    const params = new URLSearchParams({ branch_id: binding.branchId, endpoint_id: binding.endpointId,
      database_name: source.database, role_name: source.user, pooled: 'false' });
    const { uri } = responseData(z.object({ uri: z.string().max(16384) }),
      await this.request(source, 'GET', `/connection_uri?${params}`, signal));
    let url: URL;
    let database: string, user: string, password: string;
    try { url = new URL(uri); database = decodeURIComponent(url.pathname.slice(1));
      user = decodeURIComponent(url.username); password = decodeURIComponent(url.password);
    } catch { throw new Error('Neon 返回了无效连接。'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== endpoint.host
      || database !== source.database || user !== source.user
      || !password || (url.port && url.port !== '5432')) throw new Error('Neon SQL 连接与已验证的分支不匹配。');
    // Construct options explicitly. A URI sslmode must never override certificate verification.
    return { host: url.hostname, port: 5432, database: source.database, user: source.user,
      password, ssl: { rejectUnauthorized: true }, enableChannelBinding: true,
      connectionTimeoutMillis: 15000 };
  }
  private async waitOperations(source: NeonSource, operationIds: string[], signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 120000;
    for (const operationId of operationIds) {
      while (true) {
        const { operation } = responseData(z.object({ operation: operationSchema }),
          await this.request(source, 'GET', `/operations/${encodeURIComponent(operationId)}`, signal));
        if (operation.id !== operationId || operation.project_id !== source.projectId) throw new Error('Neon operation 身份不匹配。');
        if (operation.status === 'finished' || operation.status === 'skipped') break;
        if (['failed', 'error', 'cancelled'].includes(operation.status)) throw new Error('Neon 后台操作失败，请核对原操作。');
        if (Date.now() > deadline) throw new Error('Neon 后台操作尚未完成，请保留原操作并稍后核对。');
        await setTimeout(400, undefined, { signal });
      }
    }
  }
  private operationIds(value: unknown): string[] {
    return responseData(z.object({ operations: z.array(operationSchema).max(100).default([]) }), value).operations.map(item => item.id);
  }
  async create(source: NeonSource, parent: NeonBinding, operation: BranchOperation,
    prepared: (request: Record<string, unknown>) => void, signal: AbortSignal): Promise<NeonBinding> {
    await this.usableEndpoint(source, parent, signal);
    const checkpoint = operation.kind === 'checkpoint';
    const body = { branch: { parent_id: parent.branchId, name: operation.resource },
      endpoints: [{ type: checkpoint ? 'read_only' : 'read_write' }],
      annotation_value: { [operationOwner]: operation.id } };
    const request: Record<string, unknown> = { body, parent: { ...parent } };
    // Persist intent before POST. A lost response is reconciled, never replayed.
    prepared(request);
    let response: unknown;
    try { response = await this.request(source, 'POST', '/branches', signal, body); }
    catch (error) {
      // Authentication, authorization and input rejection did not admit a branch.
      // Network errors and server/locking/conflict responses remain uncertain.
      if (error instanceof NeonRequestError && [400, 401, 403, 404, 422].includes(error.status)) {
        throw new NeonCreationRejectedError(error.status);
      }
      throw error;
    }
    const { branch } = responseData(z.object({ branch: branchSchema }), response);
    if (branch.project_id !== source.projectId || branch.name !== operation.resource || branch.parent_id !== parent.branchId) {
      throw new Error('Neon 新分支与原请求不匹配，请核对操作。');
    }
    request.branchId = branch.id;
    request.createdAt = branch.created_at;
    if (branch.parent_lsn) request.parentLsn = branch.parent_lsn;
    request.operationIds = this.operationIds(response);
    prepared(request);
    await this.waitOperations(source, request.operationIds as string[], signal);
    const binding = await this.reconcile(source, { ...operation, request }, signal);
    if (!binding) throw new Error('Neon 分支尚未就绪，请核对原操作。');
    return binding;
  }
  async reconcile(source: NeonSource, operation: BranchOperation, signal: AbortSignal): Promise<NeonBinding | undefined> {
    const request = operation.request;
    if (!request) throw new Error('没有可核对的 Neon 创建请求。');
    const body = z.object({ branch: z.object({ parent_id: id, name: z.string() }) }).parse(request.body);
    const parent = request.parent as NeonBinding;
    if (!parent || parent.branchId !== body.branch.parent_id) throw new Error('Neon 原请求的父分支信息不完整。');
    await this.usableEndpoint(source, parent, signal);
    if (Array.isArray(request.operationIds)) await this.waitOperations(source, z.array(z.string()).parse(request.operationIds), signal);
    let branchId = typeof request.branchId === 'string' ? request.branchId : undefined;
    if (!branchId) {
      // Search is only discovery. Exact name, parent and persisted ownership annotation are all required below.
      const listed = responseData(z.object({ branches: z.array(branchSchema).max(100), pagination: z.object({ next: z.string().optional() }).optional() }),
        await this.request(source, 'GET', `/branches?${new URLSearchParams({ search: operation.resource, limit: '100' })}`, signal));
      if (listed.pagination?.next) throw new Error('Neon 分支列表不完整，无法安全确认原创建结果。');
      const matching = listed.branches.filter(branch => branch.name === operation.resource);
      if (!matching.length) return undefined;
      if (matching.length !== 1) throw new Error('发现多个同名 Neon 分支，无法确认原创建结果。');
      branchId = matching[0]!.id;
    }
    const observed = await this.inspect(source, branchId, signal);
    if (observed.branch.name !== operation.resource || observed.branch.parent_id !== body.branch.parent_id
      || observed.annotation?.[operationOwner] !== operation.id || observed.branch.last_reset_at
      || (request.createdAt && observed.branch.created_at !== request.createdAt)
      || (request.parentLsn && observed.branch.parent_lsn !== request.parentLsn)) {
      throw new Error('Neon 分支不属于原创建操作或已被重置，已停止绑定。');
    }
    if (observed.branch.current_state === 'archived' || observed.branch.pending_state === 'archived') this.assertReady(observed.branch);
    if (observed.branch.current_state !== 'ready'
      || (observed.branch.pending_state && observed.branch.pending_state !== 'ready')) return undefined;
    if (!observed.branch.parent_lsn || observed.branch.parent_lsn === '0/0') throw new Error('Neon 未返回分支的来源位置。');
    const checkpoint = operation.kind === 'checkpoint';
    const endpoints = await this.endpoints(source, branchId, signal);
    if (endpoints.length !== 1 || endpoints[0]!.type !== (checkpoint ? 'read_only' : 'read_write') || endpoints[0]!.disabled) {
      throw new Error('Neon 新分支的 compute 配置不符合原请求。');
    }
    return this.binding(source, observed, endpoints[0]!, true, checkpoint);
  }
  async resumeCreation(source: NeonSource, operation: BranchOperation, signal: AbortSignal): Promise<NeonBinding> {
    const binding = await this.reconcile(source, operation, signal);
    if (!binding) throw new Error('尚不能确认原 Neon 创建结果，请保留原操作；未再次创建分支。');
    return binding;
  }
  async remove(source: NeonSource, binding: NeonBinding, removalId: string, saved: NeonRemoval | undefined,
    persist: (removal: NeonRemoval) => void, signal: AbortSignal, kind: NeonRemoval['kind'] = 'branch'): Promise<void> {
    if (!binding.managed || !binding.operationId) throw new Error('只能清理 Stellane 创建的 Neon 分支。');
    if (saved && (saved.branchId !== binding.branchId || saved.projectId !== binding.projectId
      || saved.endpointId !== binding.endpointId || saved.kind !== kind)) throw new Error('Neon 原清理请求与环境不匹配。');
    // Absence can precede the completion of Neon's background deletion chain.
    // If its operation IDs are known, their completion remains part of the proof.
    if (saved?.operationIds?.length) await this.waitOperations(source, saved.operationIds, signal);
    let observed: Observed;
    try { observed = await this.inspect(source, binding.branchId, signal); }
    catch (error) { if (saved && error instanceof NeonRequestError && error.status === 404) return; throw error; }
    this.assertIdentity(source, binding, observed);
    if (observed.branch.default || observed.branch.protected) throw new Error('此 Neon 分支已被设为默认或受保护，停止自动清理。');
    const endpoints = await this.endpoints(source, binding.branchId, signal);
    if (kind === 'compute' && endpoints.some(endpoint => endpoint.id !== binding.endpointId)) {
      throw new Error('Neon 分支新增了其他 compute，请核对后再结束实验。');
    }
    const endpointPresent = endpoints.some(endpoint => endpoint.id === binding.endpointId);
    if (kind === 'compute' && !endpointPresent) {
      if (saved) return;
      throw new Error('Neon 原 compute 已被移除，请核对环境。');
    }
    const removal: NeonRemoval = saved ?? { id: removalId, kind, projectId: source.projectId, branchId: binding.branchId, endpointId: binding.endpointId };
    if (!saved) persist(removal);
    if (!removal.operationIds?.length) {
      const path = kind === 'branch' ? `/branches/${binding.branchId}` : `/endpoints/${binding.endpointId}`;
      // DELETE addresses an immutable Neon ID. Reconciliation observes disappearance;
      // no name-based resource replacement or branch creation occurs on retry.
      try {
        const response = await this.request(source, 'DELETE', path, signal);
        removal.operationIds = this.operationIds(response); persist(removal);
        await this.waitOperations(source, removal.operationIds, signal);
      } catch (error) {
        if (!(error instanceof NeonRequestError && error.status === 404)) throw error;
      }
    }
    if (kind === 'compute') {
      if ((await this.endpoints(source, binding.branchId, signal)).some(endpoint => endpoint.id === binding.endpointId)) {
        throw new Error('Neon compute 删除尚未完成，请继续核对原操作。');
      }
    } else {
      try { await this.inspect(source, binding.branchId, signal); }
      catch (error) { if (error instanceof NeonRequestError && error.status === 404) return; throw error; }
      throw new Error('Neon 分支删除尚未完成，请继续核对原操作。');
    }
  }
}
