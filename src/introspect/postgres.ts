/**
 * PostgreSQL Introspector
 *
 * Extracts schemas, tables, columns, primary keys, foreign keys,
 * indexes, and views from a PostgreSQL database using
 * `information_schema` + `pg_catalog` queries.
 *
 * Connection: uses `connection.ts` which wraps the `pg` package.
 * The driver import is guarded so a missing `pg` is reported at
 * connect() time, not at module load time.
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

interface SchemaRow {
  schema_name: string;
}

interface TableRow {
  schema_name: string;
  table_name: string;
  table_type: string;
  comment: string | null;
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
  datetime_precision: number | null;
  ordinal_position: number;
  udt_name: string | null;
  collation_name: string | null;
  description: string | null;
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
  indexname: string;
  indexdef: string;
}

interface ViewRow {
  schema_name: string;
  table_name: string;
  view_definition: string | null;
}

// =============================================================================
// PostgresIntrospector
// =============================================================================

export class PostgresIntrospector extends BaseIntrospector {
  constructor(config: DbConnectionConfig) {
    super(config);
  }

  /**
   * Full schema introspection pipeline.
   *
   * 1. Connect to DB
   * 2. Query schemas, tables, columns, PKs, FKs, indexes, views in batch
   * 3. Build Node[] and Edge[] from the raw data
   * 4. Close connection and return IntrospectResult
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

        const node = this.makeNode(kind, t.table_name, qual, fp, {
          docstring: t.comment ?? undefined,
        });
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
            udtName: c.udt_name ?? null,
            collation: c.collation_name ?? null,
          },
          docstring: c.description ?? undefined,
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
        }
      }

      // ----- 8. Index nodes + indexed_by edges (table → index, column → index) -----
      // Group index rows by index name to get column lists
      const indexGroups = new Map<
        string,
        { schema: string; table: string; indexdef: string; columns: string[] }
      >();
      for (const idx of indexes) {
        const indexKey = `${idx.schema_name}.${idx.table_name}.${idx.indexname}`;
        if (!indexGroups.has(indexKey)) {
          indexGroups.set(indexKey, {
            schema: idx.schema_name,
            table: idx.table_name,
            indexdef: idx.indexdef,
            columns: [],
          });
        }
      }
      // Parse column list from indexdef (simplified — extracts first parenthesized group)
      for (const [key, grp] of indexGroups) {
        const match = grp.indexdef.match(/\(([^)]+)\)/);
        if (match && match[1]) {
          grp.columns = match[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
        }
      }

      for (const [_key, grp] of indexGroups) {
        const tableKey = this.tableKey(grp.schema, grp.table);
        const tableNode = tableNodeByKey.get(tableKey);
        if (!tableNode) continue;

        // Extract a short index name from the DEFINE for the node name
        const idxName = _key.split('.').pop()!;
        const qual = this.qn(grp.schema, grp.table, idxName);
        const fp = this.schemaFilePath(grp.schema);

        const unique = grp.indexdef.toUpperCase().includes('UNIQUE');

        const node = this.makeNode('index', idxName, qual, fp, {
          signature: grp.indexdef,
          metadata: { unique, columns: grp.columns },
        });
        nodes.push(node);
        edges.push(this.containEdge(tableNode.id, node.id));
        edges.push(this.makeEdge(tableNode.id, node.id, 'indexed_by'));
      }

      // ----- 9. View nodes — attach their definitions as signatures -----
      // viewDefMap keys match the tableKey(schema, viewName) we used
      // during table/view node creation in step 4.
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
  // Each method includes the schema_name in its result set so callers can
  // group by schema at build time.
  // ===========================================================================

  /**
   * Query: non-system schemas.
   */
  private async querySchemas(conn: DBConnection): Promise<SchemaRow[]> {
    return (await conn.query(
      `-- Schemas
       SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND schema_name NOT LIKE 'pg_%'
       ORDER BY schema_name`,
    )) as SchemaRow[];
  }

  /**
   * Query: tables and views (BASE TABLE or VIEW) with optional pg_catalog
   * comment.
   */
  private async queryTables(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<TableRow[]> {
    if (schemaNames.length === 0) return [];
    return (await conn.query(
      `SELECT t.table_schema AS schema_name,
              t.table_name,
              t.table_type,
              pg_catalog.obj_description(
                (quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::regclass,
                'pg_class'
              ) AS comment
       FROM information_schema.tables t
       WHERE t.table_schema = ANY($1)
         AND t.table_type IN ('BASE TABLE', 'VIEW')
       ORDER BY t.table_name`,
      [schemaNames],
    )) as TableRow[];
  }

  /**
   * Query: column metadata + pg_catalog column description.
   */
  private async queryColumns(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<ColumnRow[]> {
    if (schemaNames.length === 0) return [];
    return (await conn.query(
      `SELECT c.table_schema AS schema_name,
              c.table_name,
              c.column_name,
              c.data_type,
              c.is_nullable,
              c.column_default,
              c.character_maximum_length,
              c.numeric_precision,
              c.numeric_scale,
              c.datetime_precision,
              c.ordinal_position,
              c.udt_name,
              c.collation_name,
              pg_catalog.col_description(
                (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass,
                c.ordinal_position::integer
              ) AS description
       FROM information_schema.columns c
       WHERE c.table_schema = ANY($1)
       ORDER BY c.table_name, c.ordinal_position`,
      [schemaNames],
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
    return (await conn.query(
      `SELECT tc.table_schema AS schema_name,
              tc.table_name,
              tc.constraint_name,
              kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_catalog = kcu.constraint_catalog
        AND tc.constraint_schema  = kcu.constraint_schema
        AND tc.constraint_name    = kcu.constraint_name
       WHERE tc.table_schema = ANY($1)
         AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY tc.table_name, kcu.ordinal_position`,
      [schemaNames],
    )) as PkRow[];
  }

  /**
   * Query: foreign key columns + referenced table/column + referential actions.
   */
  private async queryForeignKeys(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<FkRow[]> {
    if (schemaNames.length === 0) return [];
    return (await conn.query(
      `SELECT tc.table_schema AS schema_name,
              tc.table_name,
              tc.constraint_name,
              kcu.column_name,
              ccu.table_schema  AS ref_table_schema,
              ccu.table_name    AS ref_table_name,
              ccu.column_name   AS ref_column_name,
              rc.update_rule,
              rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_catalog = kcu.constraint_catalog
        AND tc.constraint_schema  = kcu.constraint_schema
        AND tc.constraint_name    = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_catalog = tc.constraint_catalog
        AND ccu.constraint_schema  = tc.constraint_schema
        AND ccu.constraint_name    = tc.constraint_name
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_catalog = tc.constraint_catalog
        AND rc.constraint_schema  = tc.constraint_schema
        AND rc.constraint_name    = tc.constraint_name
       WHERE tc.table_schema = ANY($1)
         AND tc.constraint_type = 'FOREIGN KEY'
       ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position`,
      [schemaNames],
    )) as FkRow[];
  }

  /**
   * Query: index definitions from pg_indexes.
   */
  private async queryIndexes(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<IndexRow[]> {
    if (schemaNames.length === 0) return [];
    return (await conn.query(
      `SELECT pi.schemaname AS schema_name,
              pi.tablename AS table_name,
              pi.indexname,
              pi.indexdef
       FROM pg_indexes pi
       WHERE pi.schemaname = ANY($1)
       ORDER BY pi.tablename, pi.indexname`,
      [schemaNames],
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
    return (await conn.query(
      `SELECT v.table_schema AS schema_name,
              v.table_name,
              v.view_definition
       FROM information_schema.views v
       WHERE v.table_schema = ANY($1)
       ORDER BY v.table_name`,
      [schemaNames],
    )) as ViewRow[];
  }
}
