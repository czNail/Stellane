import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** A separate SQLite transaction keeps the state writer exclusive without PID guesses.
 * The OS releases its file locks after a crash. The file itself must stay in place.
 */
export function acquireStateLock(directory: string): () => void {
  const filename = join(directory, 'owner.sqlite');
  const lock = new DatabaseSync(filename);
  try {
    chmodSync(filename, 0o600);
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch (error) {
    lock.close();
    const code = typeof error === 'object' && error !== null && 'errcode' in error ? error.errcode : undefined;
    if (code === 5 || code === 6) {
      throw new Error('此 Stellane 状态目录正在由另一个 Host 使用。请关闭原 Host，或为另一个 profile 设置独立的 stateDirectory。不要删除 owner.sqlite。');
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { lock.exec('ROLLBACK'); } finally { lock.close(); }
  };
}
