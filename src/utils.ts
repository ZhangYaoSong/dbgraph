/**
 * DBGraph Utilities
 */

import * as fs from 'fs';

/**
 * Safely parse JSON with a fallback value
 */
export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Cross-process file lock
 */
export class FileLock {
  private lockPath: string;
  private held = false;
  private static readonly STALE_TIMEOUT_MS = 2 * 60 * 1000;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  acquire(): void {
    if (fs.existsSync(this.lockPath)) {
      try {
        const content = fs.readFileSync(this.lockPath, 'utf-8').trim();
        const pid = parseInt(content, 10);
        const stat = fs.statSync(this.lockPath);
        const lockAge = Date.now() - stat.mtimeMs;

        if (lockAge < FileLock.STALE_TIMEOUT_MS && !isNaN(pid) && this.isProcessAlive(pid)) {
          throw new Error(
            `DBGraph database is locked by another process (PID ${pid}). ` +
            `If stale, run 'dbgraph unlock' or delete ${this.lockPath}`
          );
        }
        fs.unlinkSync(this.lockPath);
      } catch (err) {
        if (err instanceof Error && err.message.includes('locked by another')) {
          throw err;
        }
        try { fs.unlinkSync(this.lockPath); } catch { /* ignore */ }
      }
    }

    try {
      fs.writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
      this.held = true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        throw new Error(
          'DBGraph database is locked by another process. ' +
          `If stale, run 'dbgraph unlock' or delete ${this.lockPath}`
        );
      }
      throw err;
    }
  }

  release(): void {
    if (!this.held) return;
    try {
      const content = fs.readFileSync(this.lockPath, 'utf-8').trim();
      if (parseInt(content, 10) === process.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch { /* ignore */ }
    this.held = false;
  }

  withLock<T>(fn: () => T): T {
    this.acquire();
    try { return fn(); } finally { this.release(); }
  }

  async withLockAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.acquire();
    try { return await fn(); } finally { this.release(); }
  }

  private isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  }
}

/**
 * Simple mutex lock
 */
export class Mutex {
  private locked = false;
  private waitQueue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    while (this.locked) {
      await new Promise<void>((resolve) => { this.waitQueue.push(resolve); });
    }
    this.locked = true;
    return () => {
      this.locked = false;
      const next = this.waitQueue.shift();
      if (next) next();
    };
  }

  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try { return await fn(); } finally { release(); }
  }

  isLocked(): boolean { return this.locked; }
}

/**
 * Generate a stable hash string from input
 */
export function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Escape identifier for SQL display
 */
export function quoteIdentifier(name: string, engine: string): string {
  const quote = engine === 'mysql' || engine === 'mariadb' ? '`' : '"';
  return `${quote}${name.replace(new RegExp(quote, 'g'), `${quote}${quote}`)}${quote}`;
}
