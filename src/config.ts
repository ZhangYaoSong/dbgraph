/**
 * DBGraph Configuration
 *
 * Loads and validates the dbgraph-db.json configuration file
 * which specifies which databases to introspect.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DbConnectionConfig, DbEngine } from './types';
import { ConfigError } from './errors';

export const CONFIG_FILENAME = 'dbgraph-db.json';

export interface DBGraphConfig {
  /** List of database connections to introspect */
  databases: DbConnectionConfig[];
}

/**
 * Find the config file by walking up from startPath
 */
export function findConfigFile(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    const candidate = path.join(current, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

/**
 * Load configuration from a file
 */
export function loadConfig(configPath: string): DBGraphConfig {
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`Configuration file not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');

  let parsed: any;
  // Try JSONC first (with comments), fallback to JSON
  try {
    const jsonc = require('jsonc-parser');
    const errors: any[] = [];
    parsed = jsonc.parse(raw, errors);
    if (errors.length > 0) {
      // jsonc-parser is lenient; fall back to JSON for strict validation
      parsed = JSON.parse(raw);
    }
  } catch {
    parsed = JSON.parse(raw);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ConfigError('Configuration must be a JSON object');
  }

  const databases = parsed.databases;
  if (!Array.isArray(databases)) {
    throw new ConfigError('Configuration must contain a "databases" array');
  }

  if (databases.length === 0) {
    throw new ConfigError('At least one database must be configured');
  }

  const validEngines: DbEngine[] = ['postgresql', 'mysql', 'mariadb', 'mssql', 'sqlite', 'oracle', 'mongodb'];

  const validated: DbConnectionConfig[] = [];
  for (let i = 0; i < databases.length; i++) {
    const db = databases[i];
    if (!db.alias) throw new ConfigError(`Database at index ${i} is missing "alias"`);
    if (!db.engine) throw new ConfigError(`Database "${db.alias}" is missing "engine"`);
    if (!validEngines.includes(db.engine)) {
      throw new ConfigError(`Database "${db.alias}" has unsupported engine "${db.engine}"`);
    }
    if (db.engine === 'sqlite' && !db.path) {
      throw new ConfigError(`SQLite database "${db.alias}" must specify "path"`);
    }
    if (db.engine !== 'sqlite' && !db.database) {
      throw new ConfigError(`Database "${db.alias}" is missing "database"`);
    }

    validated.push({
      alias: db.alias,
      engine: db.engine,
      host: db.host,
      port: db.port,
      database: db.database ?? path.basename(db.path ?? ''),
      schemas: db.schemas,
      path: db.path,
      auth: db.auth,
      authType: db.authType,
      ssl: db.ssl,
      tlsInsecure: db.tlsInsecure,
    });
  }

  return { databases: validated };
}

/**
 * Generate a default config file content
 */
export function generateDefaultConfig(): string {
  return JSON.stringify(
    {
      $schema: 'https://raw.githubusercontent.com/colbymchenry/dbgraph/main/dbgraph-db.schema.json',
      databases: [
        {
          alias: 'local',
          engine: 'postgresql',
          host: 'localhost',
          port: 5432,
          database: 'mydb',
          schemas: ['public'],
          auth: 'user:password',
        },
        {
          alias: 'analytics',
          engine: 'mysql',
          host: 'localhost',
          port: 3306,
          database: 'analytics',
          auth: 'user:password',
        },
      ],
    },
    null,
    2,
  );
}
