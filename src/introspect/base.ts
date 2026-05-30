/**
 * Base Introspector — shared helpers for all database engines
 *
 * Provides:
 *  - URI / naming helpers
 *  - testConnection() implementation
 *  - Generic Node/Edge factories with deterministic IDs
 */

import {
  IntrospectResult,
  DbEngine,
  DbConnectionConfig,
  Node,
  NodeKind,
  Edge,
  EdgeKind,
} from '../types';
import { createConnection } from './connection';
import { hashString } from '../utils';

/**
 * Introspector Interface
 */
export interface Introspector {
  /** Extract all schema objects into nodes/edges */
  extractAll(): Promise<IntrospectResult>;

  /** Test connectivity (open + close) */
  testConnection(): Promise<boolean>;

  /** Human-readable connection URI (no credentials) */
  getDisplayUri(): string;

  /** Database name from config */
  getDatabase(): string;

  /** Engine type (e.g. 'postgresql') */
  getEngine(): DbEngine;
}

/**
 * Abstract base class providing:
 *  - URI / naming helpers
 *  - testConnection() implementation
 *  - Generic Node/Edge factories
 *
 * Subclass responsibilities:
 *  - implement extractAll() with engine-specific information_schema queries
 *  - call the protected factories to produce Node[] + Edge[]
 */
export abstract class BaseIntrospector implements Introspector {
  constructor(protected config: DbConnectionConfig) {}

  // ---- interface methods ----

  abstract extractAll(): Promise<IntrospectResult>;

  getEngine(): DbEngine {
    return this.config.engine;
  }

  getDatabase(): string {
    return this.config.database;
  }

  getDisplayUri(): string {
    if (this.config.path) {
      return `${this.config.engine}:${this.config.path}`;
    }
    const h = this.config.host || 'localhost';
    const defaultPorts: Record<string, number> = {
      postgresql: 5432,
      mysql: 3306,
      mariadb: 3306,
      mssql: 1433,
      mongodb: 27017,
    };
    const defaultPort = defaultPorts[this.config.engine] ?? 3306;
    const p = this.config.port || defaultPort;
    return `${this.config.engine}://${h}:${p}/${this.config.database}`;
  }

  async testConnection(): Promise<boolean> {
    try {
      const conn = await createConnection(this.config);
      await conn.close();
      return true;
    } catch {
      return false;
    }
  }

  // ---- URI / naming helpers ----

  /** Build a filePath URI for objects in a given schema: `db://@alias/schema` */
  protected schemaFilePath(schema: string): string {
    return `db://@${this.config.alias}/${schema}`;
  }

  /** Dot-separated qualified name: `@alias.schema.table.column` */
  protected qn(...parts: string[]): string {
    return `${this.config.alias}.${parts.join('.')}`;
  }

  /** Map from (schema, table) to a stable lookup key */
  protected tableKey(schema: string, table: string): string {
    return `${schema}.${table}`;
  }

  /** Map from (schema, table, column) to a stable lookup key */
  protected columnKey(schema: string, table: string, column: string): string {
    return `${schema}.${table}.${column}`;
  }

  // ---- Generic Node / Edge factories ----

  /**
   * Create a Node with a deterministic ID derived from its qualified name.
   */
  protected makeNode(
    kind: NodeKind,
    name: string,
    qualifiedName: string,
    filePath: string,
    extra?: Partial<Node>,
  ): Node {
    return {
      id: hashString(qualifiedName),
      kind,
      name,
      qualifiedName,
      filePath,
      language: this.config.engine,
      startLine: 0,
      endLine: 0,
      updatedAt: Date.now(),
      ...extra,
    };
  }

  /**
   * Create an Edge with deterministic provenance = 'introspect'.
   */
  protected makeEdge(
    source: string,
    target: string,
    kind: EdgeKind,
    metadata?: Record<string, unknown>,
  ): Edge {
    return {
      source,
      target,
      kind,
      metadata,
      provenance: 'introspect',
    };
  }

  /** Shorthand: contains edge (parent → child) */
  protected containEdge(parentId: string, childId: string): Edge {
    return this.makeEdge(parentId, childId, 'contains');
  }
}
