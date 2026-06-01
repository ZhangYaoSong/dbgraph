/**
 * MSSQL Introspector
 *
 * Extracts schemas, tables, columns, primary keys, foreign keys,
 * indexes, and views from a Microsoft SQL Server database using
 * INFORMATION_SCHEMA and sys catalog views.
 *
 * Connection: uses `connection.ts` which wraps the `mssql` package.
 * The driver import is guarded so a missing `mssql` is reported at
 * connect() time, not at module load time.
 *
 * MSSQL-specific metadata extracted:
 *  - Identity columns (via COLUMNPROPERTY)
 *  - Index metadata from sys.indexes / sys.index_columns / sys.columns
 *  - Schema-based organization (like PostgreSQL, unlike MySQL)
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

interface SchemaRow {
  schema_name: string;
}

interface TableRow {
  schema_name: string;
  table_name: string;
  table_type: string;
}

interface ColumnRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  ordinal_position: number;
  is_identity: number;
}

interface PkRow {
  schema_name: string;
  table_name: string;
  constraint_name: string;
  column_name: string;
}

interface FkRow {
  schema_name: string;
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
  schema_name: string;
  table_name: string;
  index_name: string;
  is_unique: boolean;
  is_primary_key: boolean;
  column_name: string;
  ordinal_position: number;
}

interface ViewRow {
  schema_name: string;
  table_name: string;
  view_definition: string | null;
}

// =============================================================================
// MSSQLIntrospector
// =============================================================================

export class MSSQLIntrospector extends BaseIntrospector {
  constructor(config: DbConnectionConfig) {
    super(config);
  }

  /**
   * Full schema introspection pipeline.
   *
   * 1. Connect to the MSSQL database
   * 2. Query schemas and filter by config.schemas if provided
   * 3. Query all structural metadata in parallel
   * 4. Build Node[] + Edge[]
   * 5. Close connection and return the result
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
      // ----- 1. Determine which schemas to introspect -----
      // schemas: undefined   → no filter (all schemas)
      // schemas: ["*"]       → explicit "all schemas" (no filter)
      // schemas: ["public"]  → filter specific schemas
      // schemas: []          → introspect nothing
      const hasFilter =
        this.config.schemas !== undefined && !this.config.schemas.includes('*');
      const schemaFilter = new Set(this.config.schemas ?? []);

      const schemas = await this.querySchemas(conn);

      // Apply user-configured schema filter
      const targetSchemas = hasFilter
        ? schemas.filter((r) => schemaFilter.has(r.schema_name))
        : schemas;

      if (targetSchemas.length === 0) {
        errors.push(
          hasFilter
            ? (this.config.schemas!.length > 0
                ? `No matching schemas found. Filter: ${this.config.schemas!.join(', ')}`
                : 'No schemas to introspect (schemas: [])')
            : 'No non-system schemas found',
        );
        return { nodes, edges, durationMs: Date.now() - startTime, errors };
      }

      const schemaNames = targetSchemas.map((r) => r.schema_name);

      // ----- 2. Fetch all raw metadata in parallel -----
      const [tables, columns, pks, fks, indexes, views] = await Promise.all([
        this.queryTables(conn, schemaNames),
        this.queryColumns(conn, schemaNames),
        this.queryPrimaryKeys(conn, schemaNames),
        this.queryForeignKeys(conn, schemaNames),
        this.queryIndexes(conn, schemaNames),
        this.queryViews(conn, schemaNames),
      ]);

      // ----- 3. Build schema nodes -----
      const schemaNodeById = new Map<string, Node>(); // key = schema name
      for (const s of targetSchemas) {
        const qual = this.qn(s.schema_name);
        const fp = this.schemaFilePath(s.schema_name);
        const node = this.makeNode('schema', s.schema_name, qual, fp);
        nodes.push(node);
        schemaNodeById.set(s.schema_name, node);
      }

      // ----- 4. Build table nodes + contains edges (schema → table) -----
      const tableNodeByKey = new Map<string, Node>(); // key = schema.table

      for (const t of tables) {
        const schemaNode = schemaNodeById.get(t.schema_name);
        if (!schemaNode) continue;

        const key = this.tableKey(t.schema_name, t.table_name);
        const kind: NodeKind = t.table_type === 'VIEW' ? 'view' : 'table';
        const qual = this.qn(t.schema_name, t.table_name);
        const fp = this.schemaFilePath(t.schema_name);

        const node = this.makeNode(kind, t.table_name, qual, fp);
        nodes.push(node);
        tableNodeByKey.set(key, node);
        edges.push(this.containEdge(schemaNode.id, node.id));
      }

      // ----- 5. Build column nodes + contains edges (table → column) -----
      const columnNodeByKey = new Map<string, Node>(); // key = schema.table.column

      for (const c of columns) {
        const tableKey = this.tableKey(c.schema_name, c.table_name);
        const tableNode = tableNodeByKey.get(tableKey);
        if (!tableNode) continue;

        const colKey = this.columnKey(c.schema_name, c.table_name, c.column_name);
        const qual = this.qn(c.schema_name, c.table_name, c.column_name);
        const fp = this.schemaFilePath(c.schema_name);

        const node = this.makeNode('column', c.column_name, qual, fp, {
          startLine: c.ordinal_position ?? 0,
          metadata: {
            dataType: c.data_type,
            isNullable: c.is_nullable === 'YES',
            defaultValue: c.column_default ?? null,
            maxLength: c.character_maximum_length ?? null,
            numericPrecision: c.numeric_precision ?? null,
            numericScale: c.numeric_scale ?? null,
            isIdentity: c.is_identity === 1,
          },
        });
        nodes.push(node);
        columnNodeByKey.set(colKey, node);
        edges.push(this.containEdge(tableNode.id, node.id));
      }

      // ----- 6. Primary key edges (table → column) -----
      for (const pk of pks) {
        const colKey = this.columnKey(pk.schema_name, pk.table_name, pk.column_name);
        const colNode = columnNodeByKey.get(colKey);
        const tableKey = this.tableKey(pk.schema_name, pk.table_name);
        const tableNode = tableNodeByKey.get(tableKey);
        if (colNode && tableNode) {
          edges.push(
            this.makeEdge(tableNode.id, colNode.id, 'primary_key', {
              constraintName: pk.constraint_name,
            }),
          );
        }
      }

      // ----- 7. Foreign key references edges (column → referenced column) -----
      for (const fk of fks) {
        const fromKey = this.columnKey(fk.schema_name, fk.table_name, fk.column_name);
        const toKey = this.columnKey(fk.ref_table_schema, fk.ref_table_name, fk.ref_column_name);

        const fromNode = columnNodeByKey.get(fromKey);
        const toNode = columnNodeByKey.get(toKey);

        if (fromNode && toNode) {
          edges.push(
            this.makeEdge(fromNode.id, toNode.id, 'references', {
              constraintName: fk.constraint_name,
              onUpdate: fk.update_rule,
              onDelete: fk.delete_rule,
            }),
          );
        } else if (fromNode) {
          // Cross-schema FK reference — emit unresolved edge
          edges.push(
            this.makeEdge(fromNode.id, hashString(`${fk.ref_table_schema}.${fk.ref_table_name}.${fk.ref_column_name}`), 'references', {
              constraintName: fk.constraint_name,
              onUpdate: fk.update_rule,
              onDelete: fk.delete_rule,
              refTableSchema: fk.ref_table_schema,
              refTableName: fk.ref_table_name,
              refColumn: fk.ref_column_name,
              unresolved: true,
            }),
          );
        }
      }

      // ----- 8. Index nodes + indexed_by edges -----
      // Group index rows to collect column lists (one row per index × column)
      const indexGroups = new Map<
        string,
        {
          schema: string;
          table: string;
          indexName: string;
          isUnique: boolean;
          isPrimaryKey: boolean;
          columns: string[];
        }
      >();

      for (const idx of indexes) {
        const indexKey = `${idx.schema_name}.${idx.table_name}.${idx.index_name}`;
        if (!indexGroups.has(indexKey)) {
          indexGroups.set(indexKey, {
            schema: idx.schema_name,
            table: idx.table_name,
            indexName: idx.index_name,
            isUnique: idx.is_unique,
            isPrimaryKey: idx.is_primary_key,
            columns: [],
          });
        }
        indexGroups.get(indexKey)!.columns.push(idx.column_name);
      }

      for (const [, grp] of indexGroups) {
        const tableKey = this.tableKey(grp.schema, grp.table);
        const tableNode = tableNodeByKey.get(tableKey);
        if (!tableNode) continue;
        if (grp.isPrimaryKey) continue; // PK already handled via primary_key edges

        const qual = this.qn(grp.schema, grp.table, grp.indexName);
        const fp = this.schemaFilePath(grp.schema);

        const node = this.makeNode('index', grp.indexName, qual, fp, {
          metadata: {
            unique: grp.isUnique,
            columns: grp.columns,
          },
        });
        nodes.push(node);
        edges.push(this.containEdge(tableNode.id, node.id));
        edges.push(this.makeEdge(tableNode.id, node.id, 'indexed_by'));
      }

      // ----- 9. Attach view definitions as signatures -----
      const viewDefMap = new Map<string, string>();
      for (const v of views) {
        const key = this.tableKey(v.schema_name, v.table_name);
        if (v.view_definition) viewDefMap.set(key, v.view_definition);
      }
      for (const node of nodes) {
        if (node.kind !== 'view') continue;
        // qualifiedName = alias.schema.viewname → extract last two parts
        const parts = node.qualifiedName.split('.');
        if (parts.length < 3) continue;
        const schema = parts[parts.length - 2]!;
        const viewName = parts[parts.length - 1]!;
        const def = viewDefMap.get(this.tableKey(schema, viewName));
        if (def) node.signature = def;
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
  // MSSQL INFORMATION_SCHEMA uses UPPERCASE column names.
  // Each query fetches ALL data and then JS-filters by schemaNames to avoid
  // parameter-binding complexities with the mssql driver.
  // ===========================================================================

  /**
   * Query: non-system schemas.
   */
  private async querySchemas(conn: DBConnection): Promise<SchemaRow[]> {
    return (await conn.query(
      `SELECT SCHEMA_NAME AS schema_name
       FROM INFORMATION_SCHEMA.SCHEMATA
       WHERE SCHEMA_NAME NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
         AND SCHEMA_NAME NOT LIKE 'db_%'
       ORDER BY SCHEMA_NAME`,
    )) as SchemaRow[];
  }

  /**
   * Query: tables and views (BASE TABLE or VIEW).
   */
  private async queryTables(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<TableRow[]> {
    if (schemaNames.length === 0) return [];
    const placeholders = schemaNames.map(() => '?').join(',');
    return (await conn.query(
      `SELECT TABLE_SCHEMA AS schema_name,
              TABLE_NAME AS table_name,
              TABLE_TYPE AS table_type
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
         AND TABLE_SCHEMA IN (${placeholders})
       ORDER BY TABLE_NAME`,
      schemaNames,
    )) as TableRow[];
  }

  /**
   * Query: columns with identity detection via COLUMNPROPERTY.
   */
  private async queryColumns(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<ColumnRow[]> {
    if (schemaNames.length === 0) return [];
    const placeholders = schemaNames.map(() => '?').join(',');
    return (await conn.query(
      `SELECT c.TABLE_SCHEMA AS schema_name,
              c.TABLE_NAME AS table_name,
              c.COLUMN_NAME AS column_name,
              c.DATA_TYPE AS data_type,
              c.IS_NULLABLE AS is_nullable,
              c.COLUMN_DEFAULT AS column_default,
              c.CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
              c.NUMERIC_PRECISION AS numeric_precision,
              c.NUMERIC_SCALE AS numeric_scale,
              c.ORDINAL_POSITION AS ordinal_position,
              COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') AS is_identity
       FROM INFORMATION_SCHEMA.COLUMNS c
       WHERE c.TABLE_SCHEMA IN (${placeholders})
       ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
      schemaNames,
    )) as ColumnRow[];
  }

  /**
   * Query: columns that are part of a PRIMARY KEY constraint.
   */
  private async queryPrimaryKeys(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<PkRow[]> {
    if (schemaNames.length === 0) return [];
    const placeholders = schemaNames.map(() => '?').join(',');
    return (await conn.query(
      `SELECT tc.TABLE_SCHEMA AS schema_name,
              tc.TABLE_NAME AS table_name,
              tc.CONSTRAINT_NAME AS constraint_name,
              kcu.COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_CATALOG = kcu.CONSTRAINT_CATALOG
        AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
        AND tc.TABLE_NAME = kcu.TABLE_NAME
       WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
         AND tc.TABLE_SCHEMA IN (${placeholders})
       ORDER BY tc.TABLE_NAME, kcu.ORDINAL_POSITION`,
      schemaNames,
    )) as PkRow[];
  }

  /**
   * Query: foreign key columns + referential actions.
   *
   * Uses sys.foreign_keys / sys.foreign_key_columns catalog views
   * (faster than the INFORMATION_SCHEMA 4-table join).
   * Referential action codes are mapped via CASE:
   *   0 = NO ACTION, 1 = CASCADE, 2 = SET_NULL, 3 = SET_DEFAULT
   */
  private async queryForeignKeys(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<FkRow[]> {
    if (schemaNames.length === 0) return [];
    const placeholders = schemaNames.map(() => '?').join(',');
    return (await conn.query(
      `SELECT s.name AS schema_name,
              OBJECT_NAME(fk.parent_object_id) AS table_name,
              fk.name AS constraint_name,
              COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name,
              ref_s.name AS ref_table_schema,
              OBJECT_NAME(fk.referenced_object_id) AS ref_table_name,
              COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS ref_column_name,
              CASE fk.update_referential_action
                WHEN 0 THEN 'NO ACTION'
                WHEN 1 THEN 'CASCADE'
                WHEN 2 THEN 'SET_NULL'
                WHEN 3 THEN 'SET_DEFAULT'
              END AS update_rule,
              CASE fk.delete_referential_action
                WHEN 0 THEN 'NO ACTION'
                WHEN 1 THEN 'CASCADE'
                WHEN 2 THEN 'SET_NULL'
                WHEN 3 THEN 'SET_DEFAULT'
              END AS delete_rule
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc
         ON fk.object_id = fkc.constraint_object_id
       JOIN sys.tables pt
         ON fk.parent_object_id = pt.object_id
       JOIN sys.schemas s
         ON pt.schema_id = s.schema_id
       JOIN sys.tables rt
         ON fk.referenced_object_id = rt.object_id
       JOIN sys.schemas ref_s
         ON rt.schema_id = ref_s.schema_id
       WHERE s.name IN (${placeholders})
       ORDER BY pt.name, fk.name, fkc.constraint_column_id`,
      schemaNames,
    )) as FkRow[];
  }

  /**
   * Query: index columns from sys.indexes / sys.index_columns / sys.columns.
   *
   * MSSQL does NOT expose index metadata in INFORMATION_SCHEMA, so we query
   * the sys catalog views instead. Returns one row per (index × column),
   * grouped later in the build step.
   */
  private async queryIndexes(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<IndexRow[]> {
    if (schemaNames.length === 0) return [];
    const placeholders = schemaNames.map(() => '?').join(',');
    return (await conn.query(
      `SELECT s.name AS schema_name,
              o.name AS table_name,
              i.name AS index_name,
              i.is_unique AS is_unique,
              i.is_primary_key AS is_primary_key,
              c.name AS column_name,
              ic.key_ordinal AS ordinal_position
       FROM sys.indexes i
       JOIN sys.objects o ON i.object_id = o.object_id
       JOIN sys.schemas s ON o.schema_id = s.schema_id
       JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
       JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = ic.column_id
       WHERE o.type IN ('U', 'V')
         AND s.name IN (${placeholders})
       ORDER BY o.name, i.name, ic.key_ordinal`,
      schemaNames,
    )) as IndexRow[];
  }

  /**
   * Query: view definitions.
   */
  private async queryViews(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<ViewRow[]> {
    if (schemaNames.length === 0) return [];
    const placeholders = schemaNames.map(() => '?').join(',');
    return (await conn.query(
      `SELECT v.TABLE_SCHEMA AS schema_name,
              v.TABLE_NAME AS table_name,
              v.VIEW_DEFINITION AS view_definition
       FROM INFORMATION_SCHEMA.VIEWS v
       WHERE v.TABLE_SCHEMA IN (${placeholders})
       ORDER BY v.TABLE_NAME`,
      schemaNames,
    )) as ViewRow[];
  }
}
