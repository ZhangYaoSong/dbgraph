/**
 * SQLite Introspector
 *
 * Extracts tables, columns, primary keys, foreign keys, indexes,
 * and views from a SQLite database using `sqlite_master` and
 * `PRAGMA` queries (accessed via table-valued functions).
 *
 * Connection: uses `connection.ts` which wraps the built-in
 * `node:sqlite` module (Node >= 22.5). No external driver needed.
 *
 * Schema model:
 *  - SQLite has a flat namespace — the "schema" concept is modeled
 *    as a single node named "main".
 *  - Virtual tables (FTS, etc.) are included; they appear in
 *    sqlite_master alongside regular tables.
 */

import {
  IntrospectResult,
  DbConnectionConfig,
  Node,
  NodeKind,
  Edge,
  EdgeKind,
} from '../types';
import { BaseIntrospector } from './base';
import { createConnection, DBConnection } from './connection';

// =============================================================================
// Raw Row Types
// =============================================================================

interface MasterRow {
  type: 'table' | 'view' | 'index' | 'trigger';
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  pk: 0 | 1;
}

interface FkListRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexListRow {
  seq: number;
  name: string;
  unique: 0 | 1;
  origin: string;
  partial: 0 | 1;
}

interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string;
}

// =============================================================================
// Constants
// =============================================================================

/** The implicit schema name for the main SQLite database */
const MAIN_SCHEMA = 'main';

// =============================================================================
// SQLiteIntrospector
// =============================================================================

export class SQLiteIntrospector extends BaseIntrospector {
  constructor(config: DbConnectionConfig) {
    super(config);
  }

  /**
   * Full schema introspection pipeline for a SQLite database.
   *
   * 1. Open the SQLite file
   * 2. Query `sqlite_master` for tables/views
   * 3. For each table: columns (PRAGMA table_info), FKs, indexes
   * 4. For each index: index columns (PRAGMA index_info)
   * 5. Build Node[] + Edge[]
   * 6. Close and return result
   */
  async extractAll(): Promise<IntrospectResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    let conn: DBConnection;
    try {
      conn = await createConnection(this.config);
    } catch (err: any) {
      return {
        nodes: [],
        edges: [],
        durationMs: Date.now() - startTime,
        errors: [err.message],
      };
    }

    try {
      // ----- 1. Fetch all objects from sqlite_master -----
      const masterRows = (await conn.query(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_master
         WHERE type IN ('table', 'view')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )) as MasterRow[];

      if (masterRows.length === 0) {
        errors.push('No user tables or views found in the database');
        return { nodes, edges, durationMs: Date.now() - startTime, errors };
      }

      // Separate tables and views
      const tables = masterRows.filter((r) => r.type === 'table');
      const views = masterRows.filter((r) => r.type === 'view');

      // ----- 2. Build a single "schema" node for this database -----
      const schemaQual = this.qn(MAIN_SCHEMA);
      const schemaFp = this.schemaFilePath(MAIN_SCHEMA);
      const schemaNode = this.makeNode('schema', MAIN_SCHEMA, schemaQual, schemaFp);
      nodes.push(schemaNode);

      // ----- 3. Build table nodes + contains edges (schema → table) -----
      const tableNodeByKey = new Map<string, Node>(); // key = table_name

      for (const t of tables) {
        const qual = this.qn(MAIN_SCHEMA, t.name);
        const fp = this.schemaFilePath(MAIN_SCHEMA);

        const node = this.makeNode('table', t.name, qual, fp, {
          signature: t.sql ?? undefined,
        });
        nodes.push(node);
        tableNodeByKey.set(t.name, node);
        edges.push(this.containEdge(schemaNode.id, node.id));
      }

      // ----- 4. For each table: columns, PKs, FKs, indexes -----
      const columnNodeByKey = new Map<string, Node>(); // key = table.column
      const pkEdges: Edge[] = [];
      const fkEdges: Edge[] = [];
      const indexNodes: Node[] = [];

      for (const t of tables) {
        const tableNode = tableNodeByKey.get(t.name);
        if (!tableNode) continue;

        // ----- 4a. Columns via pragma_table_info -----
        const colRows = (await conn.query(
          `SELECT cid, name, type, notnull, dflt_value, pk
           FROM pragma_table_info(?)`,
          [t.name],
        )) as TableInfoRow[];

        for (const col of colRows) {
          const colKey = `${t.name}.${col.name}`;
          const qual = this.qn(MAIN_SCHEMA, t.name, col.name);
          const fp = this.schemaFilePath(MAIN_SCHEMA);

          const node = this.makeNode('column', col.name, qual, fp, {
            startLine: col.cid + 1,
            metadata: {
              dataType: col.type || 'TEXT',
              isNullable: col.notnull === 0,
              defaultValue: col.dflt_value ?? null,
              isPrimaryKey: col.pk === 1,
              // SQLite types don't have precision/scale/length in the
              // traditional sense, but we report what's in the DDL type
              collation: null,
            },
          });
          nodes.push(node);
          columnNodeByKey.set(colKey, node);
          edges.push(this.containEdge(tableNode.id, node.id));

          // Primary key flag from pragma result
          if (col.pk === 1) {
            pkEdges.push(
              this.makeEdge(tableNode.id, node.id, 'primary_key', {
                constraintName: `pk_${t.name}`,
                pkOrdinal: col.pk,
              }),
            );
          }
        }

        // ----- 4b. Foreign keys via pragma_foreign_key_list -----
        const fkRows = (await conn.query(
          `SELECT id, seq, "table", "from", "to", on_update, on_delete, match
           FROM pragma_foreign_key_list(?)`,
          [t.name],
        )) as FkListRow[];

        for (const fk of fkRows) {
          const fromKey = `${t.name}.${fk.from}`;
          const toKey = `${fk.table}.${fk.to}`;

          const fromNode = columnNodeByKey.get(fromKey);
          const toNode = columnNodeByKey.get(toKey);

          if (fromNode && toNode) {
            fkEdges.push(
              this.makeEdge(fromNode.id, toNode.id, 'references', {
                constraintName: `fk_${t.name}_${fk.from}`,
                onUpdate: fk.on_update,
                onDelete: fk.on_delete,
              }),
            );
          }
        }

        // ----- 4c. Index list via pragma_index_list -----
        const idxListRows = (await conn.query(
          `SELECT seq, name, unique, origin, partial
           FROM pragma_index_list(?)`,
          [t.name],
        )) as IndexListRow[];

        for (const idx of idxListRows) {
          // Skip auto-generated indexes for UNIQUE / PK constraints
          if (idx.origin === 'pk') continue;
          if (idx.origin === 'u' && idx.name.startsWith('sqlite_autoindex_')) continue;

          // Get index columns
          const idxColRows = (await conn.query(
            `SELECT seqno, cid, name
             FROM pragma_index_info(?)`,
            [idx.name],
          )) as IndexInfoRow[];

          const colNames = idxColRows
            .sort((a, b) => a.seqno - b.seqno)
            .map((r) => r.name);

          const qual = this.qn(MAIN_SCHEMA, t.name, idx.name);
          const fp = this.schemaFilePath(MAIN_SCHEMA);

          const node = this.makeNode('index', idx.name, qual, fp, {
            metadata: {
              unique: idx.unique === 1,
              columns: colNames,
              origin: idx.origin,
              partial: idx.partial === 1,
            },
          });
          indexNodes.push(node);
          edges.push(this.containEdge(tableNode.id, node.id));
          edges.push(this.makeEdge(tableNode.id, node.id, 'indexed_by'));
        }
      }

      // Add all deferred edges and index nodes
      edges.push(...pkEdges);
      edges.push(...fkEdges);
      nodes.push(...indexNodes);

      // ----- 5. Build view nodes + contains edges -----
      for (const v of views) {
        const qual = this.qn(MAIN_SCHEMA, v.name);
        const fp = this.schemaFilePath(MAIN_SCHEMA);

        const node = this.makeNode('view', v.name, qual, fp, {
          signature: v.sql ?? undefined,
        });
        nodes.push(node);
        edges.push(this.containEdge(schemaNode.id, node.id));
      }
    } catch (err: any) {
      errors.push(`Introspection error: ${err.message}`);
    } finally {
      await conn!.close();
    }

    return {
      nodes,
      edges,
      durationMs: Date.now() - startTime,
      errors,
    };
  }
}
