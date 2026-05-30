/**
 * MySQL / MariaDB Introspector
 *
 * Extracts schemas (databases), tables, columns, primary keys,
 * foreign keys, indexes, and views from a MySQL or MariaDB
 * database using `information_schema` queries.
 *
 * Connection: uses `connection.ts` which wraps the `mysql2` package.
 * The driver import is guarded so a missing `mysql2` is reported at
 * connect() time, not at module load time.
 *
 * MySQL-specific metadata extracted:
 *  - ENGINE (InnoDB, MyISAM, …)
 *  - AUTO_INCREMENT value
 *  - CHARACTER_SET_NAME / COLLATION_NAME
 *  - COLUMN_TYPE (full type string, e.g. "varchar(255)")
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
import { hashString } from '../utils';

// =============================================================================
// Raw Row Types
// =============================================================================

interface TableRow {
  table_name: string;
  table_type: string;
  table_comment: string;
  engine: string | null;
  auto_increment: number | null;
  table_collation: string | null;
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  column_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  ordinal_position: number;
  extra: string;
  column_comment: string;
  character_set_name: string | null;
  collation_name: string | null;
}

interface PkRow {
  table_name: string;
  constraint_name: string;
  column_name: string;
}

interface FkRow {
  table_name: string;
  constraint_name: string;
  column_name: string;
  ref_table_schema: string;
  ref_table_name: string;
  ref_column_name: string;
  update_rule: string;
  delete_rule: string;
}

interface IndexRow {
  table_name: string;
  index_name: string;
  column_name: string;
  non_unique: number;
  index_type: string;
  seq_in_index: number;
}

interface ViewRow {
  table_name: string;
  view_definition: string | null;
}

// =============================================================================
// MySQLIntrospector
// =============================================================================

export class MySQLIntrospector extends BaseIntrospector {
  /** The database/schema name to introspect */
  private dbName: string;

  constructor(config: DbConnectionConfig) {
    super(config);
    this.dbName = config.database;
  }

  /**
   * Full schema introspection pipeline.
   *
   * 1. Connect to the MySQL database
   * 2. Query all structural metadata
   * 3. Build Node[] + Edge[]
   * 4. Close connection and return the result
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
      // MySQL's "schema" == "database". We always introspect the connected
      // database. The `schemas` config filter is applied as a TABLE_SCHEMA
      // filter if the user specified one; otherwise we use `DATABASE()`.

      // ----- 1. Fetch all raw metadata in parallel -----
      const [tables, columns, pks, fks, indexes, views] = await Promise.all([
        this.queryTables(conn),
        this.queryColumns(conn),
        this.queryPrimaryKeys(conn),
        this.queryForeignKeys(conn),
        this.queryIndexes(conn),
        this.queryViews(conn),
      ]);

      // ----- 2. Build a single "schema" node for this database -----
      const schemaName = this.dbName;
      const schemaQual = this.qn(schemaName);
      const schemaFp = this.schemaFilePath(schemaName);
      const schemaNode = this.makeNode('schema', schemaName, schemaQual, schemaFp);
      nodes.push(schemaNode);

      // ----- 3. Build table nodes + contains edges (schema → table) -----
      const tableNodeByKey = new Map<string, Node>(); // key = table_name

      for (const t of tables) {
        const kind: NodeKind = t.table_type === 'VIEW' ? 'view' : 'table';
        const qual = this.qn(schemaName, t.table_name);
        const fp = this.schemaFilePath(schemaName);

        const node = this.makeNode(kind, t.table_name, qual, fp, {
          docstring: t.table_comment || undefined,
          metadata: {
            engine: t.engine,
            autoIncrement: t.auto_increment ?? null,
            collation: t.table_collation ?? null,
          },
        });
        nodes.push(node);
        tableNodeByKey.set(t.table_name, node);
        edges.push(this.containEdge(schemaNode.id, node.id));
      }

      // ----- 4. Build column nodes + contains edges (table → column) -----
      const columnNodeByKey = new Map<string, Node>(); // key = table.column

      for (const c of columns) {
        const tableNode = tableNodeByKey.get(c.table_name);
        if (!tableNode) continue;

        const colKey = `${c.table_name}.${c.column_name}`;
        const qual = this.qn(schemaName, c.table_name, c.column_name);
        const fp = this.schemaFilePath(schemaName);
        const autoIncrement = c.extra?.toLowerCase().includes('auto_increment');

        const node = this.makeNode('column', c.column_name, qual, fp, {
          startLine: c.ordinal_position ?? 0,
          metadata: {
            dataType: c.data_type,
            columnType: c.column_type,
            isNullable: c.is_nullable === 'YES',
            defaultValue: c.column_default ?? null,
            maxLength: c.character_maximum_length ?? null,
            numericPrecision: c.numeric_precision ?? null,
            numericScale: c.numeric_scale ?? null,
            charSet: c.character_set_name ?? null,
            collation: c.collation_name ?? null,
            autoIncrement: autoIncrement ?? false,
          },
          docstring: c.column_comment || undefined,
        });
        nodes.push(node);
        columnNodeByKey.set(colKey, node);
        edges.push(this.containEdge(tableNode.id, node.id));
      }

      // ----- 5. Primary key edges (table → column) -----
      for (const pk of pks) {
        const colKey = `${pk.table_name}.${pk.column_name}`;
        const colNode = columnNodeByKey.get(colKey);
        const tableNode = tableNodeByKey.get(pk.table_name);
        if (colNode && tableNode) {
          edges.push(
            this.makeEdge(tableNode.id, colNode.id, 'primary_key', {
              constraintName: pk.constraint_name,
            }),
          );
        }
      }

      // ----- 6. Foreign key references edges (column → referenced column) -----
      // Note: for cross-database FKs, the ref_table_schema may differ.
      // We still create the edge if we have both nodes; cross-DB refs
      // where the target isn't introspected will have a dangling target
      // (the edge's target still exists as a node id, but the node may
      // not be present in this result).
      for (const fk of fks) {
        // MySQL KEY_COLUMN_USAGE has REFERENCED_TABLE_SCHEMA
        const fromKey = `${fk.table_name}.${fk.column_name}`;
        const toKey =
          fk.ref_table_schema === this.dbName
            ? `${fk.ref_table_name}.${fk.ref_column_name}`
            : null;

        const fromNode = columnNodeByKey.get(fromKey);
        const toNode = toKey ? columnNodeByKey.get(toKey) : undefined;

        if (fromNode && toNode) {
          edges.push(
            this.makeEdge(fromNode.id, toNode.id, 'references', {
              constraintName: fk.constraint_name,
              onUpdate: fk.update_rule,
              onDelete: fk.delete_rule,
            }),
          );
        } else if (fromNode) {
          // Cross-database FK reference — still emit the edge but note in metadata
          edges.push(
            this.makeEdge(fromNode.id, hashString(`${fk.ref_table_schema}.${fk.ref_table_name}.${fk.ref_column_name}`), 'references', {
              constraintName: fk.constraint_name,
              onUpdate: fk.update_rule,
              onDelete: fk.delete_rule,
              refDatabase: fk.ref_table_schema,
              refTable: fk.ref_table_name,
              refColumn: fk.ref_column_name,
              unresolved: true,
            }),
          );
        }
      }

      // ----- 7. Index nodes + indexed_by edges -----
      // Group index rows to collect column lists
      const indexGroups = new Map<
        string,
        { table: string; indexName: string; unique: boolean; indexType: string; columns: string[] }
      >();

      for (const idx of indexes) {
        const indexKey = `${idx.table_name}.${idx.index_name}`;
        if (!indexGroups.has(indexKey)) {
          indexGroups.set(indexKey, {
            table: idx.table_name,
            indexName: idx.index_name,
            unique: idx.non_unique === 0,
            indexType: idx.index_type,
            columns: [],
          });
        }
        indexGroups.get(indexKey)!.columns.push(idx.column_name);
      }

      for (const [, grp] of indexGroups) {
        const tableNode = tableNodeByKey.get(grp.table);
        if (!tableNode) continue;
        if (grp.indexName === 'PRIMARY') continue; // PK already handled

        const qual = this.qn(schemaName, grp.table, grp.indexName);
        const fp = this.schemaFilePath(schemaName);

        const node = this.makeNode('index', grp.indexName, qual, fp, {
          metadata: {
            unique: grp.unique,
            indexType: grp.indexType,
            columns: grp.columns,
          },
        });
        nodes.push(node);
        edges.push(this.containEdge(tableNode.id, node.id));
        edges.push(this.makeEdge(tableNode.id, node.id, 'indexed_by'));
      }

      // ----- 8. Attach view definitions -----
      const viewDefs = new Map<string, string>();
      for (const v of views) {
        if (v.view_definition) viewDefs.set(v.table_name, v.view_definition);
      }
      for (const node of nodes) {
        if (node.kind === 'view') {
          const def = viewDefs.get(node.name);
          if (def) node.signature = def;
        }
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

  // ===========================================================================
  // Query Methods
  //
  // MySQL information_schema uses uppercase column names by convention.
  // All queries filter by TABLE_SCHEMA = the connected database name.
  // ===========================================================================

  /**
   * Query: tables and views in the current database.
   */
  private async queryTables(conn: DBConnection): Promise<TableRow[]> {
    return (await conn.query(
      `-- Tables & views with MySQL-specific metadata
       SELECT t.TABLE_NAME                                            AS table_name,
              t.TABLE_TYPE                                             AS table_type,
              t.TABLE_COMMENT                                          AS table_comment,
              t.ENGINE                                                 AS engine,
              t.AUTO_INCREMENT                                         AS auto_increment,
              t.TABLE_COLLATION                                        AS table_collation
       FROM information_schema.TABLES t
       WHERE t.TABLE_SCHEMA = ?
         AND t.TABLE_TYPE IN ('BASE TABLE', 'VIEW')
       ORDER BY t.TABLE_NAME`,
      [this.dbName],
    )) as TableRow[];
  }

  /**
   * Query: columns with MySQL-specific type info.
   */
  private async queryColumns(conn: DBConnection): Promise<ColumnRow[]> {
    return (await conn.query(
      `-- Columns with MySQL-specific metadata
       SELECT c.TABLE_NAME                AS table_name,
              c.COLUMN_NAME               AS column_name,
              c.DATA_TYPE                 AS data_type,
              c.COLUMN_TYPE               AS column_type,
              c.IS_NULLABLE               AS is_nullable,
              c.COLUMN_DEFAULT            AS column_default,
              c.CHARACTER_MAXIMUM_LENGTH  AS character_maximum_length,
              c.NUMERIC_PRECISION         AS numeric_precision,
              c.NUMERIC_SCALE             AS numeric_scale,
              c.ORDINAL_POSITION          AS ordinal_position,
              c.EXTRA                     AS extra,
              c.COLUMN_COMMENT            AS column_comment,
              c.CHARACTER_SET_NAME        AS character_set_name,
              c.COLLATION_NAME            AS collation_name
       FROM information_schema.COLUMNS c
       WHERE c.TABLE_SCHEMA = ?
       ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
      [this.dbName],
    )) as ColumnRow[];
  }

  /**
   * Query: primary key columns.
   */
  private async queryPrimaryKeys(conn: DBConnection): Promise<PkRow[]> {
    return (await conn.query(
      `-- Primary key columns
       SELECT tc.TABLE_NAME        AS table_name,
              tc.CONSTRAINT_NAME   AS constraint_name,
              kcu.COLUMN_NAME      AS column_name
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_CATALOG = kcu.CONSTRAINT_CATALOG
        AND tc.CONSTRAINT_SCHEMA  = kcu.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME    = kcu.CONSTRAINT_NAME
        AND tc.TABLE_SCHEMA       = kcu.TABLE_SCHEMA
        AND tc.TABLE_NAME         = kcu.TABLE_NAME
       WHERE tc.TABLE_SCHEMA = ?
         AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
       ORDER BY tc.TABLE_NAME, kcu.ORDINAL_POSITION`,
      [this.dbName],
    )) as PkRow[];
  }

  /**
   * Query: foreign key columns with referential actions.
   *
   * MySQL's KEY_COLUMN_USAGE table directly exposes the referenced
   * schema/table/column columns, making it simpler than Postgres.
   */
  private async queryForeignKeys(conn: DBConnection): Promise<FkRow[]> {
    return (await conn.query(
      `-- Foreign keys (MySQL's KEY_COLUMN_USAGE has REFERENCED_* columns directly)
       SELECT tc.TABLE_NAME                       AS table_name,
              tc.CONSTRAINT_NAME                  AS constraint_name,
              kcu.COLUMN_NAME                     AS column_name,
              kcu.REFERENCED_TABLE_SCHEMA         AS ref_table_schema,
              kcu.REFERENCED_TABLE_NAME           AS ref_table_name,
              kcu.REFERENCED_COLUMN_NAME          AS ref_column_name,
              rc.UPDATE_RULE                      AS update_rule,
              rc.DELETE_RULE                      AS delete_rule
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_CATALOG = kcu.CONSTRAINT_CATALOG
        AND tc.CONSTRAINT_SCHEMA  = kcu.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME    = kcu.CONSTRAINT_NAME
        AND tc.TABLE_SCHEMA       = kcu.TABLE_SCHEMA
        AND tc.TABLE_NAME         = kcu.TABLE_NAME
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_CATALOG = tc.CONSTRAINT_CATALOG
        AND rc.CONSTRAINT_SCHEMA  = tc.CONSTRAINT_SCHEMA
        AND rc.CONSTRAINT_NAME    = tc.CONSTRAINT_NAME
       WHERE tc.TABLE_SCHEMA = ?
         AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
       ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
      [this.dbName],
    )) as FkRow[];
  }

  /**
   * Query: index columns from STATISTICS table.
   *
   * STATISTICS has one row per (index, column), so we group by
   * index_name + seq_in_index to build the column list later.
   */
  private async queryIndexes(conn: DBConnection): Promise<IndexRow[]> {
    return (await conn.query(
      `-- Index columns (one row per index × column)
       SELECT s.TABLE_NAME    AS table_name,
              s.INDEX_NAME    AS index_name,
              s.COLUMN_NAME   AS column_name,
              s.NON_UNIQUE    AS non_unique,
              s.INDEX_TYPE    AS index_type,
              s.SEQ_IN_INDEX  AS seq_in_index
       FROM information_schema.STATISTICS s
       WHERE s.TABLE_SCHEMA = ?
       ORDER BY s.TABLE_NAME, s.INDEX_NAME, s.SEQ_IN_INDEX`,
      [this.dbName],
    )) as IndexRow[];
  }

  /**
   * Query: view definitions.
   */
  private async queryViews(conn: DBConnection): Promise<ViewRow[]> {
    return (await conn.query(
      `-- View definitions
       SELECT v.TABLE_NAME       AS table_name,
              v.VIEW_DEFINITION  AS view_definition
       FROM information_schema.VIEWS v
       WHERE v.TABLE_SCHEMA = ?
       ORDER BY v.TABLE_NAME`,
      [this.dbName],
    )) as ViewRow[];
  }
}

// =============================================================================
