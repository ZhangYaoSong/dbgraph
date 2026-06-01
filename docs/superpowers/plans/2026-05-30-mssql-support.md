# MSSQL Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Microsoft SQL Server database introspection support to DBGraph.

**Architecture:** Follow the existing introspector pattern — new `MSSQLConnection` adapter in `connection.ts`, new `MSSQLIntrospector` class in `mssql.ts`, registered in both factory functions. MSSQL schema model is like PostgreSQL (database → schemas → tables), so the introspector follows the PostgreSQL multi-schema pattern. Indexes use `sys` catalog views (not in INFORMATION_SCHEMA). The `mssql` npm package is lazily loaded like `pg` and `mysql2`.

**Tech Stack:** Node.js 22.5+, `mssql` npm package (lazy-loaded, not in package.json), MSSQL 2017+ (supports STRING_AGG). INFORMATION_SCHEMA for structural metadata, `sys.indexes`+`sys.index_columns` for indexes.

---

### Task 1: Update base.ts port mapping for MSSQL

**Files:**
- Modify: `src/introspect/base.ts:71-73`

- [x] **Step 1: Replace hardcoded port ternary with engine-to-port map**

Current code in `getDisplayUri()`:
```typescript
const defaultPort = this.config.engine === 'postgresql' ? 5432 : 3306;
const p = this.config.port || defaultPort;
```

Replace with a port map that includes MSSQL:
```typescript
const defaultPorts: Record<string, number> = {
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  mssql: 1433,
};
const defaultPort = defaultPorts[this.config.engine] ?? 3306;
const p = this.config.port || defaultPort;
```

- [x] **Step 2: Verify the edit**

Run: `npx tsc --noEmit` — should produce no errors.

---

### Task 2: Add MSSQLConnection adapter to connection.ts

**Files:**
- Modify: `src/introspect/connection.ts`

- [x] **Step 1: Add lazy import for `mssql` package (after the sqlite import block, before the factory comment)**

```typescript
// =============================================================================
// MSSQL Connection (mssql — wraps tedious)
// =============================================================================

let mssqlModule: any;
try {
  mssqlModule = require('mssql');
} catch {
  /* handled at connect() time */
}
```

- [x] **Step 2: Add MSSQLConnection class (after the lazy import)**

```typescript
class MSSQLConnection implements DBConnection {
  private pool: any;

  private constructor(pool: any) {
    this.pool = pool;
  }

  static async create(config: DbConnectionConfig): Promise<MSSQLConnection> {
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
```

- [x] **Step 3: Add `case 'mssql'` to the `createConnection()` factory**

Insert before the default case:
```typescript
    case 'mssql':
      return await MSSQLConnection.create(config);
```

- [x] **Step 4: Update the factory's JSDoc comment**

Replace:
```
 *  - `sqlite` — via built-in `node:sqlite` (Node >= 22.5)
```
with:
```
 *  - `sqlite` — via built-in `node:sqlite` (Node >= 22.5)
 *  - `mssql` — via the `mssql` package
```

- [x] **Step 5: Verify compilation**

Run: `npx tsc --noEmit` — should produce no errors.

---

### Task 3: Create MSSQLIntrospector (new file)

**Files:**
- Create: `src/introspect/mssql.ts`

- [x] **Step 1: Create the raw row type interfaces and class skeleton**

```typescript
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
 * MSSQL-specific considerations:
 *  - Schemas are namespaces within a database (like PostgreSQL).
 *  - Indexes are not exposed in INFORMATION_SCHEMA; uses sys.indexes + sys.index_columns.
 *  - Descriptions/comments via sys.extended_properties (not yet implemented).
 *  - Default port: 1433.
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
```

- [x] **Step 2: Create class with constructor and extractAll() skeleton (following PostgreSQL multi-schema pattern)**

```typescript
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
      const hasFilter =
        this.config.schemas !== undefined && this.config.schemas.length > 0;
      const schemaFilter = new Set(this.config.schemas ?? []);

      const schemas = await this.querySchemas(conn);

      // Apply user-configured schema filter
      const targetSchemas = hasFilter
        ? schemas.filter((r) => schemaFilter.has(r.schema_name))
        : schemas;

      if (targetSchemas.length === 0) {
        errors.push(
          hasFilter
            ? `No matching schemas found. Filter: ${this.config.schemas!.join(', ')}`
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
      const schemaNodeById = new Map<string, Node>();
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
        const toKey = this.columnKey(
          fk.ref_table_schema,
          fk.ref_table_name,
          fk.ref_column_name,
        );

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

      // ----- 8. Index nodes + indexed_by edges -----
      // Group index rows to collect column lists
      const indexGroups = new Map<
        string,
        {
          schema: string;
          table: string;
          indexName: string;
          unique: boolean;
          columns: string[];
        }
      >();

      for (const idx of indexes) {
        if (idx.is_primary_key) continue; // PK already handled
        const indexKey = `${idx.schema_name}.${idx.table_name}.${idx.index_name}`;
        if (!indexGroups.has(indexKey)) {
          indexGroups.set(indexKey, {
            schema: idx.schema_name,
            table: idx.table_name,
            indexName: idx.index_name,
            unique: idx.is_unique,
            columns: [],
          });
        }
        indexGroups.get(indexKey)!.columns.push(idx.column_name);
      }

      for (const [, grp] of indexGroups) {
        const tableKey = this.tableKey(grp.schema, grp.table);
        const tableNode = tableNodeByKey.get(tableKey);
        if (!tableNode) continue;

        const qual = this.qn(grp.schema, grp.table, grp.indexName);
        const fp = this.schemaFilePath(grp.schema);

        const node = this.makeNode('index', grp.indexName, qual, fp, {
          metadata: {
            unique: grp.unique,
            columns: grp.columns,
          },
        });
        nodes.push(node);
        edges.push(this.containEdge(tableNode.id, node.id));
        edges.push(this.makeEdge(tableNode.id, node.id, 'indexed_by'));
      }

      // ----- 9. Attach view definitions -----
      const viewDefMap = new Map<string, string>();
      for (const v of views) {
        const key = this.tableKey(v.schema_name, v.table_name);
        if (v.view_definition) viewDefMap.set(key, v.view_definition);
      }
      for (const node of nodes) {
        if (node.kind !== 'view') continue;
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
```

- [x] **Step 3: Add query methods (after the class body)**

```typescript
  // ===========================================================================
  // Query Methods
  //
  // MSSQL INFORMATION_SCHEMA uses uppercase column names.
  // Index metadata queried from sys catalog views (not in INFORMATION_SCHEMA).
  // Schema filtering is done in JS memory (no array param support in mssql).
  // ===========================================================================

  /**
   * Query: non-system schemas.
   * Excludes built-in schemas: sys, INFORMATION_SCHEMA, guest, and fixed db roles.
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
    const rows = (await conn.query(
      `SELECT TABLE_SCHEMA AS schema_name,
              TABLE_NAME AS table_name,
              TABLE_TYPE AS table_type
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
       ORDER BY TABLE_NAME`,
    )) as TableRow[];
    return rows.filter((r) => schemaNames.includes(r.schema_name));
  }

  /**
   * Query: column metadata.
   * Uses COLUMNPROPERTY to detect IDENTITY columns.
   */
  private async queryColumns(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<ColumnRow[]> {
    const rows = (await conn.query(
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
              COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME),
                c.COLUMN_NAME, 'IsIdentity') AS is_identity
       FROM INFORMATION_SCHEMA.COLUMNS c
       ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
    )) as ColumnRow[];
    return rows.filter((r) => schemaNames.includes(r.schema_name));
  }

  /**
   * Query: primary key columns.
   */
  private async queryPrimaryKeys(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<PkRow[]> {
    const rows = (await conn.query(
      `SELECT tc.TABLE_SCHEMA AS schema_name,
              tc.TABLE_NAME AS table_name,
              tc.CONSTRAINT_NAME AS constraint_name,
              kcu.COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_CATALOG = kcu.CONSTRAINT_CATALOG
        AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
       ORDER BY tc.TABLE_NAME, kcu.ORDINAL_POSITION`,
    )) as PkRow[];
    return rows.filter((r) => schemaNames.includes(r.schema_name));
  }

  /**
   * Query: foreign key columns with referential actions.
   */
  private async queryForeignKeys(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<FkRow[]> {
    const rows = (await conn.query(
      `SELECT tc.TABLE_SCHEMA AS schema_name,
              tc.TABLE_NAME AS table_name,
              tc.CONSTRAINT_NAME AS constraint_name,
              kcu.COLUMN_NAME AS column_name,
              ccu.TABLE_SCHEMA AS ref_table_schema,
              ccu.TABLE_NAME AS ref_table_name,
              ccu.COLUMN_NAME AS ref_column_name,
              rc.UPDATE_RULE AS update_rule,
              rc.DELETE_RULE AS delete_rule
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_CATALOG = kcu.CONSTRAINT_CATALOG
        AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
         ON ccu.CONSTRAINT_CATALOG = tc.CONSTRAINT_CATALOG
        AND ccu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND ccu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
       JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_CATALOG = tc.CONSTRAINT_CATALOG
        AND rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
       WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
       ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
    )) as FkRow[];
    return rows.filter((r) => schemaNames.includes(r.schema_name));
  }

  /**
   * Query: index columns from sys catalog views.
   * One row per (index × column), grouped in JS later.
   */
  private async queryIndexes(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<IndexRow[]> {
    const rows = (await conn.query(
      `SELECT s.name AS schema_name,
              t.name AS table_name,
              i.name AS index_name,
              i.is_unique AS is_unique,
              i.is_primary_key AS is_primary_key,
              c.name AS column_name,
              ic.key_ordinal AS ordinal_position
       FROM sys.indexes i
       JOIN sys.tables t ON i.object_id = t.object_id
       JOIN sys.schemas s ON t.schema_id = s.schema_id
       JOIN sys.index_columns ic
         ON i.object_id = ic.object_id AND i.index_id = ic.index_id
       JOIN sys.columns c
         ON ic.object_id = c.object_id AND ic.column_id = ic.column_id
       ORDER BY t.name, i.name, ic.key_ordinal`,
    )) as IndexRow[];
    return rows.filter((r) => schemaNames.includes(r.schema_name));
  }

  /**
   * Query: view definitions.
   */
  private async queryViews(
    conn: DBConnection,
    schemaNames: string[],
  ): Promise<ViewRow[]> {
    const rows = (await conn.query(
      `SELECT v.TABLE_SCHEMA AS schema_name,
              v.TABLE_NAME AS table_name,
              v.VIEW_DEFINITION AS view_definition
       FROM INFORMATION_SCHEMA.VIEWS v
       ORDER BY v.TABLE_NAME`,
    )) as ViewRow[];
    return rows.filter((r) => schemaNames.includes(r.schema_name));
  }
}
```

- [x] **Step 4: Verify compilation**

Run: `npx tsc --noEmit` — should produce no errors.

---

### Task 4: Register MSSQLIntrospector in index.ts

**Files:**
- Modify: `src/introspect/index.ts`

- [x] **Step 1: Add import**

After the existing imports:
```typescript
import { MSSQLIntrospector } from './mssql';
```

- [x] **Step 2: Add factory case**

After `case 'sqlite':` in `createIntrospector()`:
```typescript
    case 'mssql':
      return new MSSQLIntrospector(config);
```

- [x] **Step 3: Update JSDoc comment comment**

Replace `//  - SQLiteIntrospector    (sqlite.ts)` with:
```
 *  - SQLiteIntrospector    (sqlite.ts)
 *  - MSSQLIntrospector     (mssql.ts)
```

- [x] **Step 4: Verify compilation**

Run: `npx tsc --noEmit` — should produce no errors.

---

### Task 5: Build and verify

**Files:** N/A (build step)

- [x] **Step 1: Build the project**

Run: `npm run build` — should complete with no errors.

- [x] **Step 2: Quick smoke test — verify CLI doesn't crash**

Run: `node dist/bin/dbgraph.js --help` — should show help text with all commands.

- [x] **Step 3: Verify MSSQL appears in supported engines**

Run: `node dist/bin/dbgraph.js config --help` — look for mssql in engine list (if config command shows supported engines).

- [x] **Step 4: Commit**

```bash
git add src/introspect/mssql.ts src/introspect/connection.ts src/introspect/index.ts src/introspect/base.ts docs/superpowers/plans/2026-05-30-mssql-support.md
git commit -m "feat: add MSSQL database engine support"
```
