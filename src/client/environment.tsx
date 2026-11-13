import { useState, type FormEvent } from 'react';
import type { Environment, Run, Snapshot } from '../shared/models.ts';
import { ActionDialog, message, type Api } from './workspace-ui.tsx';

export type EnvironmentAction = 'create' | 'checkpoint' | 'fork' | 'deliver';
const titles: Record<EnvironmentAction, string> = { create: '创建环境', checkpoint: '固定当前状态', fork: '派生可写分支', deliver: '交付方案' };

export function EnvironmentDialog({ action, api, data, environment, initialConnection, onDone, onPending, onClose }: {
  action: EnvironmentAction;
  api: Api;
  data: Snapshot;
  environment?: Environment;
  initialConnection?: string;
  onDone: (environment: Environment, run?: Run) => Promise<void>;
  onPending: (requestId: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [connectionId, setConnectionId] = useState(initialConnection ?? data.connections[0]?.id ?? '');
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [sql, setSql] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const ancestors: Environment[] = [];
  let parentId = environment?.parentEnvironmentId;
  while (parentId && ancestors.length < 16) {
    const parent = data.environments.find(item => item.id === parentId);
    if (!parent) break;
    ancestors.push(parent);
    parentId = parent.parentEnvironmentId;
  }
  const recipient = recipientId || ancestors[0]?.id || '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (action === 'create') {
        await api('probe', { connectionId });
        await onDone(await api('createEnvironment', { connectionId, name: name.trim() }));
      } else if (environment && action === 'deliver') {
        const result = await api('deliver', { environmentId: environment.id, recipientEnvironmentId: recipient, summary: summary.trim(), sql: sql.trim(), requestId });
        await onDone(result.environment, result.run);
      } else if (environment && (action === 'checkpoint' || action === 'fork')) {
        await onDone(await api(action, { environmentId: environment.id, name: name.trim(), requestId }));
      }
    } catch (error) {
      if (action !== 'create' && await onPending(requestId).catch(() => false)) return;
      setError(message(error));
    }
    finally { setBusy(false); }
  }

  return <ActionDialog title={titles[action]} busy={busy} onClose={onClose}>
    <form onSubmit={event => void submit(event)}>
      <fieldset className="st-stack" disabled={busy}>
        {action === 'create' && <label className="st-field"><span>PostgreSQL 连接</span>
          <select value={connectionId} required onChange={event => setConnectionId(event.target.value)}>
            {data.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
          </select></label>}
        {action === 'checkpoint' && <p className="st-muted">将「{environment?.name}」的当前数据固定为只读切面。</p>}
        {action === 'fork' && <p className="st-muted">从「{environment?.name}」派生一个独立的可写分支。</p>}
        {action === 'deliver' ? <>
          <label className="st-field"><span>接收环境</span><select value={recipient} onChange={event => setRecipientId(event.target.value)} required>
            {ancestors.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <label className="st-field"><span>方案摘要</span><textarea className="st-prose-input" required maxLength={4000} rows={3} value={summary} onChange={event => setSummary(event.target.value)} /></label>
          <label className="st-field"><span>证据 SQL</span><textarea required maxLength={16384} rows={4} value={sql} onChange={event => setSql(event.target.value)} /></label>
          <p className="st-muted">证据查询会在当前状态的固定切面上执行。</p>
        </> : <label className="st-field"><span>{action === 'checkpoint' ? '切面名称' : action === 'fork' ? '分支名称' : '环境名称'}</span>
          <input required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder={action === 'create' ? '例如：分析环境' : environment?.name} /></label>}
        {error && <p role="alert" className="st-error">{error}</p>}
        <div className="st-actions st-form-actions"><button className="st-button" type="button" onClick={onClose}>取消</button>
          <button className="st-button st-primary" type="submit" disabled={action === 'deliver' ? !recipient || !summary.trim() || !sql.trim() : !name.trim()}>
            {busy ? '处理中…' : action === 'deliver' ? '固定并交付' : titles[action]}</button></div>
      </fieldset>
    </form>
  </ActionDialog>;
}
