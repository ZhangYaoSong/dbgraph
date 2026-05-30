/**
 * Introspector Interface & Factory
 *
 * An Introspector connects to a live database and extracts its schema as
 * a knowledge graph of Node[] + Edge[] (the same format used by DBGraph's
 * query engine and MCP tools).
 *
 * Concrete implementations:
 *  - PostgresIntrospector  (postgres.ts)
 *  - MySQLIntrospector     (mysql.ts)
 *  - SQLiteIntrospector    (sqlite.ts)
 *  - MSSQLIntrospector     (mssql.ts)
 *  - MongoDBIntrospector   (mongodb.ts)
 */

import { DbConnectionConfig } from '../types';
import { PostgresIntrospector } from './postgres';
import { MySQLIntrospector } from './mysql';
import { SQLiteIntrospector } from './sqlite';
import { MSSQLIntrospector } from './mssql';
import { MongoDBIntrospector } from './mongodb';
import { Introspector, BaseIntrospector } from './base';

// Re-export base types
export { Introspector, BaseIntrospector } from './base';

// =============================================================================
// Factory
// =============================================================================

/**
 * Create the appropriate Introspector for the given config.
 *
 * Throws if the engine is not supported.
 * Does _not_ open a connection — call .extractAll() or .testConnection().
 */
export function createIntrospector(config: DbConnectionConfig): Introspector {
  switch (config.engine) {
    case 'postgresql':
      return new PostgresIntrospector(config);
    case 'mysql':
    case 'mariadb':
      return new MySQLIntrospector(config);
    case 'sqlite':
      return new SQLiteIntrospector(config);
    case 'mssql':
      return new MSSQLIntrospector(config);
    case 'mongodb':
      return new MongoDBIntrospector(config);
    default:
      throw new Error(
        `Unsupported database engine: "${config.engine}". ` +
        `Supported engines: postgresql, mysql, mariadb, sqlite, mssql, mongodb`,
      );
  }
}
