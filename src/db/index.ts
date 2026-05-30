/**
 * Database Layer
 */

import { SqliteDatabase, SqliteBackend, createDatabase } from './sqlite-adapter';
import * as fs from 'fs';
import * as path from 'path';
import { runMigrations, getCurrentVersion, CURRENT_SCHEMA_VERSION } from './migrations';

export { SqliteDatabase, SqliteBackend } from './sqlite-adapter';

function configureConnection(db: SqliteDatabase): void {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');
}

export class DatabaseConnection {
  private db: SqliteDatabase;
  private dbPath: string;
  private backend: SqliteBackend;

  private constructor(db: SqliteDatabase, dbPath: string, backend: SqliteBackend) {
    this.db = db;
    this.dbPath = dbPath;
    this.backend = backend;
  }

  static initialize(dbPath: string): DatabaseConnection {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const { db, backend } = createDatabase(dbPath);
    configureConnection(db);

    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);

    const currentVersion = getCurrentVersion(db);
    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      db.prepare(
        'INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)'
      ).run(CURRENT_SCHEMA_VERSION, Date.now(), 'Initial schema includes all migrations');
    }

    return new DatabaseConnection(db, dbPath, backend);
  }

  static open(dbPath: string): DatabaseConnection {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Database not found: ${dbPath}`);
    }

    const { db, backend } = createDatabase(dbPath);
    configureConnection(db);

    const conn = new DatabaseConnection(db, dbPath, backend);
    const currentVersion = getCurrentVersion(db);
    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      runMigrations(db, currentVersion);
    }

    return conn;
  }

  getDb(): SqliteDatabase { return this.db; }
  getBackend(): SqliteBackend { return this.backend; }
  getPath(): string { return this.dbPath; }

  getJournalMode(): string {
    const raw = this.db.pragma('journal_mode');
    const row = Array.isArray(raw) ? raw[0] : raw;
    const mode = row && typeof row === 'object'
      ? (row as Record<string, unknown>).journal_mode
      : row;
    return String(mode ?? '').toLowerCase();
  }

  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  getSize(): number { return fs.statSync(this.dbPath).size; }

  optimize(): void {
    this.db.exec('VACUUM');
    this.db.exec('ANALYZE');
  }

  runMaintenance(): void {
    try { this.db.exec('PRAGMA optimize'); } catch { /* ignore */ }
    try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* ignore */ }
  }

  close(): void { this.db.close(); }
  isOpen(): boolean { return this.db.open; }
}

export const DATABASE_FILENAME = 'dbgraph.db';

export function getDatabasePath(projectRoot: string): string {
  return path.join(projectRoot, '.dbgraph', DATABASE_FILENAME);
}
