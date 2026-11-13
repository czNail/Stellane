import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { Operation, Requests, Responses } from '../shared/remote.ts';
import type { Environment } from '../shared/models.ts';

export type Api = <K extends Operation>(name: K, input: Requests[K]) => Promise<Responses[K]>;

export function message(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

export function environmentLabel(environment: Environment): string {
  if (environment.mode === 'fixed') return '固定切面';
  if (environment.access === 'read-write') return '可写分支';
  return environment.stello ? '只读来源' : '实时只读';
}

export function environmentTree(environments: Environment[]): { environment: Environment; depth: number }[] {
  const result: { environment: Environment; depth: number }[] = [];
  const ids = new Set(environments.map(environment => environment.id));
  const visited = new Set<string>();
  function append(environment: Environment, depth: number) {
    if (visited.has(environment.id)) return;
    visited.add(environment.id);
    result.push({ environment, depth });
    for (const child of environments) if (child.parentEnvironmentId === environment.id) append(child, depth + 1);
  }
  for (const environment of environments) {
    if (!environment.parentEnvironmentId || !ids.has(environment.parentEnvironmentId)) append(environment, 0);
  }
  for (const environment of environments) append(environment, 0);
  return result;
}

export function ActionDialog({ title, children, busy, onClose }: {
  title: string;
  children: ReactNode;
  busy?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="st-dialog" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault();
    if (!busy) onClose();
  }}>
    <header className="st-dialog-header">
      <h2 id={titleId}>{title}</h2>
      <button className="st-button st-quiet" type="button" aria-label="关闭" disabled={busy} onClick={onClose}>×</button>
    </header>
    {children}
  </dialog>;
}
