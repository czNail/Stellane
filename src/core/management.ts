import { isDeepStrictEqual } from 'node:util';
import type { Store } from './store.ts';
import { managedSecret, preparePostgresConnection, removeManagedSecret } from './onboarding.ts';
import { managementInput, type ManagedResource, type ManagementView } from '../shared/management-models.ts';
import type { Actor, Environment } from '../shared/models.ts';
import type { QueryProvider } from '../providers/postgres.ts';
import type { StelloProvider } from '../providers/stello.ts';
import type { NeonProvider } from '../providers/neon.ts';

export const sourceKey = (environment: Environment): string => environment.connectionId ?? environment.stello?.providerId ?? environment.neon!.providerId;
const isResource = (environment: Environment) => !!(environment.stello?.managed || environment.neon?.managed);
const retained = (environment: Environment) => isResource(environment) && !environment.resourceDeletedAt && (!environment.removedAt || !!environment.retainedReason);
const requireOwner = (actor: Actor) => { if (actor.kind !== 'user') throw new Error('仅 Host 所有者可管理连接、资料和资源。'); };

export class DataManagement {
  private readonly store: Store;
  private readonly directory: string;
  private readonly postgres: QueryProvider;
  private readonly stello: StelloProvider;
  private readonly neon: NeonProvider;
  private readonly busy: (environment: Environment) => boolean;
  private readonly lock: (sourceId: string) => () => void;
  constructor(store: Store, directory: string, postgres: QueryProvider, stello: StelloProvider, neon: NeonProvider,
    busy: (environment: Environment) => boolean, lock: (sourceId: string) => () => void) {
    this.store = store; this.directory = directory; this.postgres = postgres; this.stello = stello; this.neon = neon;
    this.busy = busy; this.lock = lock;
  }

  private family(environment: Environment): Environment[] {
    return this.store.listAll('environments').filter(item => sourceKey(item) === sourceKey(environment));
  }
  private source(environment: Environment): Environment {
    const source = this.family(environment).find(item => !item.parentEnvironmentId);
    if (!source) throw new Error('原数据源登记不存在，请保留证据并核对状态。');
    return source;
  }
  private unresolved(family: Environment[]): string[] {
    const ids = new Set(family.map(item => item.id));
    const reasons: string[] = [];
    if (family.some(item => this.busy(item))) reasons.push('当前有操作正在执行，请等待完成或取消后继续。');
    if (this.store.listAll('operations').some(item => ids.has(item.parentEnvironmentId) && ['pending', 'unknown'].includes(item.status))) {
      reasons.push('还有分支派生结果未核实，请先核对原请求。');
    }
    if (this.store.listAll('runs').some(item => ids.has(item.environmentId) && ['running', 'unknown'].includes(item.status))) {
      reasons.push('还有执行结果未核实，请先核对原执行记录。');
    }
    return reasons;
  }
  private activeExperiments(family: Environment[]) {
    const ids = new Set(family.map(item => item.id));
    return this.store.listAll('experiments').filter(item => item.status !== 'closed'
      && [item.sourceId, item.baselineId, item.workId, item.resultId].some(id => id && ids.has(id)));
  }
  private sourceReasons(source: Environment): string[] {
    const family = this.family(source);
    return [...(!source.disabledAt ? ['请先停用数据源。'] : []), ...this.unresolved(family),
      ...(this.activeExperiments(family).length ? ['请先结束此来源的活动实验。'] : []),
      ...(family.some(retained) ? ['请先回收仍保留的派生资源，不能遗失其管理凭据。'] : [])];
  }
  private purgeReasons(source: Environment): string[] {
    const references = new Set(this.family(source).flatMap(item => item.managedCredentialRefs ?? []));
    const otherRegistration = this.store.listAll('connections').some(item => item.id !== sourceKey(source) && references.has(item.passwordRef))
      || this.store.listAll('neonSources').some(item => item.id !== sourceKey(source) && references.has(item.apiKeyRef));
    return [...this.sourceReasons(source), ...(otherRegistration ? ['其他连接仍引用此来源拥有的凭据，请先轮换或移除那些连接，避免遗失凭据的归属记录。'] : [])];
  }
  private resourceView(environment: Environment): ManagedResource {
    const family = this.family(environment);
    const dependentEnvironmentIds = family.filter(item => retained(item) && item.parentEnvironmentId === environment.id).map(item => item.id);
    const blockedReasons = [...this.unresolved(family),
      ...(dependentEnvironmentIds.length ? ['此资源仍有保留的子分支，请先回收子分支。'] : []),
      ...(this.activeExperiments(family).some(item => [item.sourceId, item.baselineId, item.workId, item.resultId].includes(environment.id))
        ? ['此资源仍被活动实验使用，请先结束实验。'] : [])];
    return { environment, sourceEnvironmentId: this.source(environment).id, parentEnvironmentId: environment.parentEnvironmentId,
      dependentEnvironmentIds, canRemove: !blockedReasons.length, blockedReasons,
      retentionReason: environment.resourceRemovalPendingAt ? '回收结果尚未确认，请继续核对原清理请求；此资源暂停新访问。'
        : environment.retainedReason ?? (dependentEnvironmentIds.length ? '其他保留结果依赖这个共同起点。'
        : environment.neon?.local ? '保留的本地 Neon 时间线仍占用磁盘，回收会删除本地派生时间线。'
          : environment.neon ? '保留的 Neon 分支存储可能继续计费，回收会删除远端分支。' : '保留的试验状态；回收后仍能查看已有本地证据。') };
  }
  view(actor: Actor): ManagementView {
    requireOwner(actor);
    const environments = this.store.listAll('environments');
    const sources = environments.filter(item => !item.parentEnvironmentId);
    const canonical = new Map<string, Environment>();
    for (const source of sources) if (!canonical.has(sourceKey(source))) canonical.set(sourceKey(source), source);
    return {
      sources: [...canonical.values()].map(source => {
        const blockedReasons = this.sourceReasons(source);
        return { environmentId: source.id, name: source.name, projectPath: source.projectPath,
          provider: source.neon ? 'neon' as const : source.stello ? 'stello' as const : 'postgres' as const,
          ...(source.neon?.local ? { local: true } : {}),
          enabled: !source.disabledAt && !source.removedAt, removed: !!source.removedAt,
          canRemove: !source.removedAt && !blockedReasons.length, canPurge: !this.purgeReasons(source).length,
          blockedReasons, purgeBlockedReasons: this.purgeReasons(source),
          managedCredentialCount: new Set(this.family(source).flatMap(item => item.managedCredentialRefs ?? [])).size,
          retainedResources: this.family(source).filter(retained).length };
      }),
      resources: environments.filter(retained).map(environment => this.resourceView(environment)),
      knowledge: this.store.listAll('knowledge').map(item => {
        const environment = this.store.get('environments', item.environmentId);
        const fact = item.fact;
        const label = fact.kind === 'row-key' ? `${fact.target.schema}.${fact.target.table} (${fact.target.columns.join(', ')})`
          : `${fact.from.schema}.${fact.from.table} → ${fact.to.schema}.${fact.to.table}`;
        return { id: item.id, environmentId: item.environmentId, sourceEnvironmentId: this.source(environment).id,
          label, version: item.version, archivedAt: item.archivedAt };
      }),
      definitions: this.store.listAll('definitions').flatMap(item => {
        const source = canonical.get(item.dataSourceId);
        return source ? [{ id: item.id, sourceEnvironmentId: source.id, key: item.key, title: item.title,
          version: item.version, archivedAt: item.archivedAt }] : [];
      }),
      notes: ['归档使资料退出后续检索并释放未归档版本额度，历史证据保留。',
        '移除连接只删除本地登记与有创建记录的插件凭据，不删除来源数据库。旧版本或用户提供的凭据文件不自动删除。',
        '清除此来源的本地资料会删除本 Host 保存的 SQL、结果预览、记忆与定义；DSH 对话、模型服务端记录和备份需要分别管理。'],
    };
  }
  async execute(value: unknown, actor: Actor, signal: AbortSignal): Promise<ManagementView> {
    requireOwner(actor);
    const input = managementInput.parse(value);
    if (input.action === 'archive-knowledge' || input.action === 'archive-definition') {
      const table = input.action === 'archive-knowledge' ? 'knowledge' : 'definitions';
      const key = table === 'knowledge' ? sourceKey(this.store.get('environments', this.store.get('knowledge', input.id).environmentId))
        : this.store.get('definitions', input.id).dataSourceId;
      const family = this.store.listAll('environments').filter(item => sourceKey(item) === key);
      if (family.some(item => this.busy(item))) throw new Error('当前有操作正在执行，请等待后归档资料。');
      const release = this.lock(key);
      try {
        if (table === 'knowledge') {
          const item = this.store.get('knowledge', input.id);
          this.store.put('knowledge', { ...item, archivedAt: item.archivedAt ?? new Date().toISOString() });
        } else {
          const item = this.store.get('definitions', input.id);
          this.store.put('definitions', { ...item, archivedAt: item.archivedAt ?? new Date().toISOString() });
        }
        return this.view(actor);
      } finally { release(); }
    }
    const environment = this.store.get('environments', input.environmentId);
    const source = this.source(environment);
    if (input.action !== 'remove-resource' && environment.parentEnvironmentId) throw new Error('请在数据源上管理连接。');
    const family = this.family(source);
    if (family.some(item => this.busy(item))) throw new Error('当前有操作正在执行，请等待完成后管理来源。');
    const release = this.lock(sourceKey(source));
    try {
      signal.throwIfAborted();
      if (input.action === 'set-source-enabled') {
        if (source.removedAt) throw new Error('连接已移除，请重新接入。');
        this.store.transaction(() => {
          for (const item of family) this.store.put('environments', { ...item, disabledAt: input.enabled ? undefined : new Date().toISOString() });
        });
      } else if (input.action === 'rotate-postgres') {
        if (!source.connectionId || source.removedAt) throw new Error('请选择未移除的 PostgreSQL 连接。');
        const previous = this.store.get('connections', source.connectionId);
        const prepared = await preparePostgresConnection(this.directory, { name: previous.name, projectPath: previous.projectPath, connectionString: input.connectionString });
        try {
          if (['host', 'port', 'database', 'user'].some(key => previous[key as keyof typeof previous] !== prepared.connection[key as keyof typeof prepared.connection])) {
            throw new Error('凭据轮换不能改变数据库主机、端口、数据库或用户；请为其他目标新建连接。');
          }
          if (previous.tls !== prepared.connection.tls
            || (previous.channelBinding ?? 'prefer') !== (prepared.connection.channelBinding ?? 'prefer')) {
            throw new Error('凭据轮换必须保留原 TLS 和通道绑定设置；请使用相同的 sslmode 与 channel_binding。');
          }
          await this.postgres.probe(prepared.connection, signal);
          signal.throwIfAborted();
          this.store.transaction(() => {
            this.store.put('connections', { ...previous, ...prepared.connection });
            this.addOwnedCredential(source, prepared.managedCredentialRef!);
          });
        } catch (error) { await prepared.discard(); throw error; }
        await this.cleanUnusedCredentials(source);
      } else if (input.action === 'rotate-neon') {
        if (!source.neon || source.removedAt) throw new Error('请选择未移除的 Neon 连接。');
        const previous = this.store.get('neonSources', source.neon.providerId);
        const secret = await managedSecret(this.directory, input.apiKey);
        try {
          const updated = { ...previous, apiKeyRef: secret.reference };
          // connect verifies the exact recorded branch and reset identity.
          const connection = await this.neon.connect(updated, source.neon, signal);
          await this.neon.sql.query(connection, { environmentId: source.id, sql: 'SELECT 1', values: [] }, signal);
          signal.throwIfAborted();
          this.store.transaction(() => { this.store.put('neonSources', updated); this.addOwnedCredential(source, secret.reference); });
        } catch (error) { await secret.discard(); throw error; }
        await this.cleanUnusedCredentials(source);
      } else if (input.action === 'replace-stello-config') {
        if (!source.stello || source.removedAt) throw new Error('请选择未移除的 Stello 连接。');
        const previous = this.store.get('providers', source.stello.providerId);
        const updated = { ...previous, configPath: input.configPath };
        await this.stello.connect(updated, source.stello, signal);
        signal.throwIfAborted(); this.store.put('providers', updated);
      } else if (input.action === 'remove-resource') {
        await this.removeResource(environment, signal);
      } else {
        const reasons = input.action === 'purge-source' ? this.purgeReasons(source) : this.sourceReasons(source);
        if (reasons.length) throw new Error(reasons.join(' '));
        if (input.action === 'purge-source' && input.confirmation !== source.name) throw new Error('请准确输入数据源名称以确认清除本地资料和证据。');
        // Disable first; every new query is fenced while credential removal settles.
        this.store.transaction(() => {
          for (const item of family) this.store.put('environments', { ...item, disabledAt: item.disabledAt ?? new Date().toISOString(), removedAt: item.removedAt ?? new Date().toISOString() });
          if (source.connectionId) this.store.delete('connections', source.connectionId);
          if (source.stello) this.store.delete('providers', source.stello.providerId);
          if (source.neon) this.store.delete('neonSources', source.neon.providerId);
        });
        await this.cleanUnusedCredentials(source);
        if (input.action === 'purge-source') this.purge(source);
      }
      return this.view(actor);
    } finally { release(); }
  }
  private addOwnedCredential(source: Environment, reference: string) {
    const current = this.store.get('environments', source.id);
    this.store.put('environments', { ...current, managedCredentialRefs: [...new Set([...(current.managedCredentialRefs ?? []), reference])] });
  }
  private async cleanUnusedCredentials(source: Environment) {
    const used = new Set([...this.store.listAll('connections').map(item => item.passwordRef), ...this.store.listAll('neonSources').map(item => item.apiKeyRef)]);
    for (const environment of this.family(source)) {
      let owned = environment.managedCredentialRefs ?? [];
      for (const reference of owned) {
        if (used.has(reference)) continue;
        await removeManagedSecret(this.directory, reference);
        owned = owned.filter(item => item !== reference);
        this.store.put('environments', { ...this.store.get('environments', environment.id), managedCredentialRefs: owned });
      }
    }
  }
  private async removeResource(environment: Environment, signal: AbortSignal) {
    if (!isResource(environment) || !environment.parentEnvironmentId) throw new Error('只能回收 Stellane 创建的派生资源，不能删除来源数据库。');
    if (!retained(environment)) return;
    const view = this.resourceView(environment);
    if (view.blockedReasons.length) throw new Error(view.blockedReasons.join(' '));
    this.store.put('environments', { ...environment, resourceRemovalPendingAt: environment.resourceRemovalPendingAt ?? new Date().toISOString() });
    if (environment.neon) {
      const original = this.store.find('neonRemovals', environment.id);
      // A compute deletion is not the branch deletion. Keep its receipt and use
      // a separate persistent key for the full retained-storage removal.
      const key = `${environment.id}:branch`;
      const saved = this.store.find('neonRemovals', key) ?? (original?.kind === 'branch' ? original : undefined);
      await this.neon.remove(this.store.get('neonSources', environment.neon.providerId), environment.neon, key, saved,
        removal => this.store.put('neonRemovals', removal), signal, 'branch');
    } else if (environment.stello) {
      const saved = this.store.find('removals', environment.id);
      if (saved && !isDeepStrictEqual(saved.identity, environment.stello.identity)) throw new Error('原清理请求与分支身份不一致。');
      await this.stello.remove(this.store.get('providers', environment.stello.providerId), environment.stello, environment.id, saved,
        removal => this.store.put('removals', removal), signal);
    }
    this.store.put('environments', { ...environment, removedAt: environment.removedAt ?? new Date().toISOString(),
      resourceDeletedAt: new Date().toISOString(), resourceRemovalPendingAt: undefined, retainedReason: undefined });
  }
  private purge(source: Environment) {
    const family = this.family(source); const ids = new Set(family.map(item => item.id));
    const dataSourceId = sourceKey(source);
    this.store.transaction(() => {
      for (const item of this.store.listAll('runs')) if (ids.has(item.environmentId)) this.store.delete('runs', item.id);
      for (const item of this.store.listAll('operations')) if (ids.has(item.parentEnvironmentId)) this.store.delete('operations', item.id);
      for (const item of this.store.listAll('deliveries')) if ([item.sourceEnvironmentId, item.recipientEnvironmentId, item.snapshotEnvironmentId].some(id => ids.has(id))) this.store.delete('deliveries', item.id);
      for (const item of this.store.listAll('contexts')) if (ids.has(item.environmentId)) this.store.delete('contexts', item.id);
      for (const item of this.store.listAll('definitions')) if (item.dataSourceId === dataSourceId) this.store.delete('definitions', item.id);
      for (const item of this.store.listAll('catalogImports')) if (item.dataSourceId === dataSourceId) this.store.delete('catalogImports', item.id);
      for (const item of this.store.listAll('knowledge')) if (ids.has(item.environmentId)) this.store.delete('knowledge', item.id);
      for (const item of this.store.listAll('experiments')) if (ids.has(item.sourceId)) this.store.delete('experiments', item.id);
      for (const item of this.store.listAll('scopes')) if (ids.has(item.environmentId)) this.store.delete('scopes', item.id);
      for (const item of family) {
        this.store.delete('removals', item.id); this.store.delete('neonRemovals', item.id); this.store.delete('neonRemovals', `${item.id}:branch`);
        this.store.delete('environments', item.id);
      }
    });
  }
}
