/**
 * DB Connection Management
 *
 * Adapter pattern over pg, mysql2, and node:sqlite drivers.
 * Driver packages are lazy-imported with try/catch so missing
 * deps fail at connect() time, not at module load time.
 */

import { DbConnectionConfig } from '../types';
import { ConnectionError } from '../errors';

// =============================================================================
// DBConnection Interface
// =============================================================================

export interface DBConnection {
  /** Execute a SQL query and return all result rows */
  query(sql: string, params?: any[]): Promise<any[]>;
  /** Close the connection / release pool resources */
  close(): Promise<void>;
}

// =============================================================================
// Helpers
// =============================================================================

export function parseAuth(auth?: string): { user?: string; password?: string } {
  if (!auth || auth.length === 0) return {};
  const idx = auth.indexOf(':');
  if (idx === -1) return { user: auth };
  return { user: auth.substring(0, idx), password: auth.substring(idx + 1) };
}

// =============================================================================
// PostgreSQL Connection (pg)
// =============================================================================

let pgModule: any;
try {
  pgModule = require('pg');
} catch {
  /* handled at connect() time */
}

class PgConnection implements DBConnection {
  private client: any;

  private constructor(client: any) {
    this.client = client;
  }

  static async create(config: DbConnectionConfig): Promise<PgConnection> {
    if (!pgModule) {
      throw new ConnectionError(
        `pg package is not installed.\n` +
        `Connect to ${config.alias} (${config.engine}) by running: npm install pg`,
        config.alias,
      );
    }

    const auth = parseAuth(config.auth);
    const client = new pgModule.Client({
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database,
      user: auth.user,
      password: auth.password,
      ssl: config.ssl || false,
      connectionTimeoutMillis: 10_000,
    });

    try {
      await client.connect();
    } catch (err: any) {
      throw new ConnectionError(
        `Failed to connect to PostgreSQL at ${config.host || 'localhost'}:${config.port || 5432}/${config.database}: ${err.message}`,
        config.alias,
        err,
      );
    }

    return new PgConnection(client);
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    try {
      const result = await this.client.query(sql, params);
      return result.rows;
    } catch (err: any) {
      throw new ConnectionError(
        `Query failed: ${err.message}\nSQL: ${sql.substring(0, 200)}`,
        'query',
        err,
      );
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.end();
    } catch {
      /* closing a closed connection is harmless */
    }
  }
}

// =============================================================================
// MySQL / MariaDB Connection (mysql2)
// =============================================================================

let mysqlModule: any;
try {
  mysqlModule = require('mysql2/promise');
} catch {
  /* handled at connect() time */
}

class MySQLConnection implements DBConnection {
  private pool: any;

  private constructor(pool: any) {
    this.pool = pool;
  }

  static async create(config: DbConnectionConfig): Promise<MySQLConnection> {
    if (!mysqlModule) {
      throw new ConnectionError(
        `mysql2 package is not installed.\n` +
        `Connect to ${config.alias} (${config.engine}) by running: npm install mysql2`,
        config.alias,
      );
    }

    const auth = parseAuth(config.auth);
    const pool = mysqlModule.createPool({
      host: config.host || 'localhost',
      port: config.port || 3306,
      database: config.database,
      user: auth.user,
      password: auth.password,
      ssl: config.ssl || undefined,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
    });

    // Verify the connection works before returning
    try {
      const conn = await pool.getConnection();
      conn.release();
    } catch (err: any) {
      await pool.end().catch(() => {});
      throw new ConnectionError(
        `Failed to connect to MySQL at ${config.host || 'localhost'}:${config.port || 3306}/${config.database}: ${err.message}`,
        config.alias,
        err,
      );
    }

    return new MySQLConnection(pool);
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    try {
      const [rows] = await this.pool.query(sql, params);
      return rows as any[];
    } catch (err: any) {
      throw new ConnectionError(
        `Query failed: ${err.message}\nSQL: ${sql.substring(0, 200)}`,
        'query',
        err,
      );
    }
  }

  async close(): Promise<void> {
    try {
      await this.pool.end();
    } catch {
      /* harmless */
    }
  }
}

// =============================================================================
// SQLite Connection (node:sqlite — built-in Node 22.5+)
// =============================================================================

let sqliteModule: any;
try {
  sqliteModule = require('node:sqlite');
} catch {
  /* handled at connect() time */
}

class SQLiteConnection implements DBConnection {
  private db: any;

  private constructor(db: any) {
    this.db = db;
  }

  static create(config: DbConnectionConfig): SQLiteConnection {
    if (!sqliteModule) {
      throw new ConnectionError(
        `node:sqlite is not available. DBGraph requires Node.js 22.5+`,
        config.alias,
      );
    }

    if (!config.path) {
      throw new ConnectionError(
        `SQLite connection requires a path to the database file in config.\n` +
        `Example: { engine: 'sqlite', alias: 'myapp', path: '/data/mydb.sqlite' }`,
        config.alias,
      );
    }

    try {
      const db = new sqliteModule.DatabaseSync(config.path);
      // Use WAL mode for read performance during introspection
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA foreign_keys = ON');
      return new SQLiteConnection(db);
    } catch (err: any) {
      throw new ConnectionError(
        `Failed to open SQLite database at ${config.path}: ${err.message}`,
        config.alias,
        err,
      );
    }
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    try {
      const stmt = this.db.prepare(sql);
      return params ? stmt.all(...params) : stmt.all();
    } catch (err: any) {
      throw new ConnectionError(
        `Query failed: ${err.message}\nSQL: ${sql.substring(0, 200)}`,
        'query',
        err,
      );
    }
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      /* harmless */
    }
  }
}

// =============================================================================
// MSSQL Connection (mssql — wraps tedious)
// =============================================================================

let mssqlModule: any;
try {
  mssqlModule = require('mssql');
} catch {
  /* handled at connect() time */
}

let msnodesqlModule: any;
try {
  msnodesqlModule = require('mssql/msnodesqlv8');
} catch {
  /* handled at connect() time */
}

class MSSQLConnection implements DBConnection {
  private pool: any;

  private constructor(pool: any) {
    this.pool = pool;
  }

  static async create(config: DbConnectionConfig): Promise<MSSQLConnection> {
    if (config.authType === 'integrated') {
      // Windows Integrated Authentication — uses current Windows user
      if (!msnodesqlModule) {
        throw new ConnectionError(
          `msnodesqlv8 package is not installed.\n` +
          `Windows Integrated Auth requires: npm install msnodesqlv8`,
          config.alias,
        );
      }

      const mssqlConfig: any = {
        server: config.host || 'localhost',
        port: config.port || 1433,
        database: config.database,
        options: {
          trustedConnection: true,
          encrypt: config.ssl || false,
          trustServerCertificate: config.ssl || false,
        },
        connectionTimeout: 10_000,
        pool: {
          max: 2,
          min: 0,
          idleTimeoutMillis: 30_000,
        },
      };

      try {
        const pool = new msnodesqlModule.ConnectionPool(mssqlConfig);
        await pool.connect();
        return new MSSQLConnection(pool);
      } catch (err: any) {
        throw new ConnectionError(
          `Failed to connect to MSSQL at ${config.host || 'localhost'}:${config.port || 1433}/${config.database}: ${err.message}`,
          config.alias,
          err,
        );
      }
    }

    // Default: SQL Server authentication (user/password)
    if (!mssqlModule) {
      throw new ConnectionError(
        `mssql package is not installed.\n` +
        `Connect to ${config.alias} (${config.engine}) by running: npm install mssql`,
        config.alias,
      );
    }

    const auth = parseAuth(config.auth);
    const mssqlConfig: any = {
      server: config.host || 'localhost',
      port: config.port || 1433,
      database: config.database,
      user: auth.user,
      password: auth.password,
      options: {
        encrypt: config.ssl || false,
        trustServerCertificate: config.ssl || false,
      },
      connectionTimeout: 10_000,
      pool: {
        max: 2,
        min: 0,
        idleTimeoutMillis: 30_000,
      },
    };

    try {
      const pool = new mssqlModule.ConnectionPool(mssqlConfig);
      await pool.connect();
      return new MSSQLConnection(pool);
    } catch (err: any) {
      throw new ConnectionError(
        `Failed to connect to MSSQL at ${config.host || 'localhost'}:${config.port || 1433}/${config.database}: ${err.message}`,
        config.alias,
        err,
      );
    }
  }

  async query(sql: string, params?: any[]): Promise<any[]> {
    try {
      const request = this.pool.request();
      if (params) {
        let idx = 0;
        // Convert ? placeholders to @p0, @p1, ... named params
        sql = sql.replace(/\?/g, () => `@p${idx++}`);
        for (let i = 0; i < params.length; i++) {
          request.input(`p${i}`, params[i]);
        }
      }
      const result = await request.query(sql);
      return result.recordset;
    } catch (err: any) {
      throw new ConnectionError(
        `Query failed: ${err.message}\nSQL: ${sql.substring(0, 200)}`,
        'query',
        err,
      );
    }
  }

  async close(): Promise<void> {
    try {
      await this.pool.close();
    } catch {
      /* harmless */
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a DBConnection for the given config.
 *
 * Supported engines:
 *  - `postgresql` — via the `pg` package
 *  - `mysql` / `mariadb` — via the `mysql2` package
 *  - `sqlite` — via built-in `node:sqlite` (Node >= 22.5)
 *  - `mssql` — via the `mssql` package
 *
 * @throws ConnectionError if the driver is unavailable or the connection fails.
 */
export async function createConnection(config: DbConnectionConfig): Promise<DBConnection> {
  switch (config.engine) {
    case 'postgresql':
      return await PgConnection.create(config);
    case 'mysql':
    case 'mariadb':
      return await MySQLConnection.create(config);
    case 'sqlite':
      return SQLiteConnection.create(config);
    case 'mssql':
      return await MSSQLConnection.create(config);
    default:
      throw new ConnectionError(
        `Unsupported engine: "${config.engine}". Supported engines: postgresql, mysql, mariadb, sqlite, mssql`,
        config.alias,
      );
  }
}

/**
 * Quick connectivity check — returns true if a full connection cycle succeeds.
 */
export async function tryConnect(config: DbConnectionConfig): Promise<boolean> {
  try {
    const conn = await createConnection(config);
    await conn.close();
    return true;
  } catch {
    return false;
  }
}
