# MongoDB Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MongoDB as a supported introspection engine to DBGraph

**Architecture:** A new `MongoDBIntrospector` class extends `BaseIntrospector`, manages its own MongoDB connection (bypassing the SQL-centric `createConnection()` factory), and extracts collections/indexes/views/schema-validation into the same Node/Edge graph format used by all other engines.

**Tech Stack:** TypeScript, `mongodb` npm package (lazy-imported optional dependency), Node >= 22.5

---

### Task 1: Export `parseAuth` from connection.ts

**Files:**
- Modify: `src/introspect/connection.ts:27`

`parseAuth` is a module-level helper that splits `user:password` strings. It's currently
not exported but is needed by `MongoDBIntrospector` for URI construction. Export it.

- [ ] **Step 1: Add `export` to parseAuth**

Replace `function parseAuth` with `export function parseAuth`:

```diff
- function parseAuth(auth?: string): { user?: string; password?: string } {
+ export function parseAuth(auth?: string): { user?: string; password?: string } {
```

- [ ] **Step 2: Build to verify no errors**

Run: `cd D:\code\dbgraph && npx tsc --noEmit`
Expected: No errors (existing code is unaffected because `parseAuth` is used within the same file only)

- [ ] **Step 3: Commit**

```bash
git add src/introspect/connection.ts
git commit -m "chore: export parseAuth for reuse by MongoDB introspector"
```

---

### Task 2: Add mongodb default port to base.ts

**Files:**
- Modify: `src/introspect/base.ts:72-77`

`BaseIntrospector.getDisplayUri()` has a `defaultPorts` map for constructing
display URIs. Add `mongodb: 27017`.

- [ ] **Step 1: Add mongodb to defaultPorts**

```diff
  const defaultPorts: Record<string, number> = {
    postgresql: 5432,
    mysql: 3306,
    mariadb: 3306,
    mssql: 1433,
+   mongodb: 27017,
  };
```

This produces display URIs like `mongodb://localhost:27017/mydb`.

- [ ] **Step 2: Build to verify**

Run: `cd D:\code\dbgraph && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/introspect/base.ts
git commit -m "chore: add mongodb default port to getDisplayUri"
```

---

### Task 3: Create MongoDBIntrospector

**Files:**
- Create: `src/introspect/mongodb.ts`

This is the core implementation. The file contains:

1. Lazy `require('mongodb')` with graceful error fallback
2. `MongoDBIntrospector` class extending `BaseIntrospector`
3. `extractAll()` — full introspection pipeline
4. `testConnection()` — overrides base to bypass SQL-centric factory
5. Private helpers: `importMongoDriver()`, `buildUri()`, `connectClient()`

- [ ] **Step 1: Create `src/introspect/mongodb.ts` with the full implementation**

```typescript
/**
 * MongoDB Introspector
 *
 * Extracts collections, views, indexes, and schema validation rules
 * from a MongoDB database. No document sampling — field-level schema
 * is inferred from $jsonSchema validation rules only.
 *
 * Connection: manages its own MongoClient lifecycle (does NOT use the
 * SQL-centric createConnection() factory in connection.ts).
 * The driver import is guarded so a missing `mongodb` is reported at
 * connect() time, not at module load time.
 */

import {
  IntrospectResult,
  DbConnectionConfig,
  Node,
  Edge,
  NodeKind,
  EdgeKind,
} from '../types';
import { BaseIntrospector } from './base';
import { parseAuth } from './connection';

// =============================================================================
// Lazy MongoDB Driver Import
// =============================================================================

let mongoModule: any;
try {
  mongoModule = require('mongodb');
} catch {
  /* handled at connect() time — see private importMongoDriver() */ 
}

// =============================================================================
// MongoDBIntrospector
// =============================================================================

export class MongoDBIntrospector extends BaseIntrospector {
  constructor(config: DbConnectionConfig) {
    super(config);
  }

  /**
   * Override testConnection() — MongoDB does not use the
   * SQL-centric createConnection() factory from connection.ts.
   */
  async testConnection(): Promise<boolean> {
    try {
      const client = await this.connectClient();
      await client.close();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Full schema introspection.
   *
   * 1. Connect to MongoDB
   * 2. List collections (collecting regular collections and views)
   * 3. For each collection: indexes + estimatedDocumentCount
   * 4. Build Node[] + Edge[] with schema→collection→index hierarchy
   * 5. Close connection and return IntrospectResult
   */
  async extractAll(): Promise<IntrospectResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    let client: any;
    try {
      client = await this.connectClient();
    } catch (err: any) {
      return {
        nodes: [],
        edges: [],
        durationMs: Date.now() - startTime,
        errors: [err.message],
      };
    }

    try {
      const db = client.db(this.config.database);
      const dbName = this.config.database;

      // -----------------------------------------------------------------------
      // 1. List all collections (non-system, user-accessible)
      // -----------------------------------------------------------------------
      const collectionsRaw = await db
        .listCollections(
          {},
          { nameOnly: false, authorizedCollections: true },
        )
        .toArray();

      // Separate regular collections from views
      const collections = collectionsRaw.filter(
        (c: any) => !c.type || c.type === 'collection',
      );
      const views = collectionsRaw.filter((c: any) => c.type === 'view');

      if (collections.length === 0 && views.length === 0) {
        errors.push('No collections or views found in database');
        return { nodes, edges, durationMs: Date.now() - startTime, errors };
      }

      // -----------------------------------------------------------------------
      // 2. Create schema (database) node
      // -----------------------------------------------------------------------
      const schemaNode = this.makeNode(
        'schema',
        dbName,
        this.qn(dbName),
        this.schemaFilePath(dbName),
      );
      nodes.push(schemaNode);

      // -----------------------------------------------------------------------
      // 3. Process each collection
      // -----------------------------------------------------------------------
      for (const coll of collections) {
        const collName: string = coll.name;
        const collQual = this.qn(dbName, collName);
        const collFp = this.schemaFilePath(dbName);

        // Gather indexes and document count for this collection
        let indexes: any[] = [];
        let docCount: number | undefined;
        try {
          const mongoColl = db.collection(collName);
          indexes = await mongoColl.indexes();
          // estimatedDocumentCount() — fast metadata read.
          // NOTE: on sharded clusters this may be approximate.
          docCount = await mongoColl.estimatedDocumentCount();
        } catch (err: any) {
          errors.push(
            `Skipping indexes/stats for ${collName}: ${err.message}`,
          );
        }

        // Build metadata from collection options and validator
        const collOptions = coll.options || {};
        const validator = collOptions.validator;
        const validationSchema =
          validator && validator.$jsonSchema
            ? { $jsonSchema: validator.$jsonSchema }
            : undefined;

        const collNode = this.makeNode(
          'table',
          collName,
          collQual,
          collFp,
          {
            metadata: {
              documentCount: docCount,
              ...(validationSchema ? { validation: validationSchema } : {}),
              collectionOptions: {
                capped: collOptions.capped || undefined,
                size: collOptions.size || undefined,
                max: collOptions.max || undefined,
                collation: collOptions.collation || undefined,
                timeseries: collOptions.timeseries || undefined,
              },
            },
          },
        );
        nodes.push(collNode);
        edges.push(this.containEdge(schemaNode.id, collNode.id));

        // Create index nodes
        for (const idx of indexes) {
          const idxName: string = idx.name;
          const idxQual = this.qn(dbName, collName, idxName);

          // Determine index type from key values
          const keyValues = Object.values(idx.key || {}) as any[];
          const idxType =
            keyValues.some((v) => v === 'text')
              ? 'text'
              : keyValues.some((v) => v === '2dsphere')
                ? '2dsphere'
                : keyValues.some((v) => v === 'hashed')
                  ? 'hashed'
                  : 'regular';

          const idxNode = this.makeNode(
            'index',
            idxName,
            idxQual,
            collFp,
            {
              metadata: {
                key: idx.key,
                unique: idx.unique || false,
                sparse: idx.sparse || undefined,
                indexType: idxType,
                partialFilterExpression:
                  idx.partialFilterExpression || undefined,
                ttl: idx.expireAfterSeconds || undefined,
                automatic: idxName === '_id_' ? true : undefined,
              },
            },
          );
          nodes.push(idxNode);
          edges.push(this.containEdge(collNode.id, idxNode.id));
          edges.push(
            this.makeEdge(collNode.id, idxNode.id, 'indexed_by'),
          );
        }
      }

      // -----------------------------------------------------------------------
      // 4. Process views
      // -----------------------------------------------------------------------
      for (const view of views) {
        const viewName: string = view.name;
        const viewQual = this.qn(dbName, viewName);
        const viewFp = this.schemaFilePath(dbName);
        const viewOptions = view.options || {};

        const viewNode = this.makeNode(
          'view',
          viewName,
          viewQual,
          viewFp,
          {
            signature: JSON.stringify(viewOptions.pipeline || [], null, 2),
            metadata: {
              viewOn: viewOptions.viewOn,
            },
          },
        );
        nodes.push(viewNode);
        edges.push(this.containEdge(schemaNode.id, viewNode.id));
      }
    } catch (err: any) {
      errors.push(`Introspection error: ${err.message}`);
    } finally {
      if (client) await client.close();
    }

    return {
      nodes,
      edges,
      durationMs: Date.now() - startTime,
      errors,
    };
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Lazy-import the mongodb driver and throw a helpful error if absent.
   */
  private importMongoDriver(): any {
    if (!mongoModule) {
      throw new Error(
        `mongodb package is not installed.\n` +
        `Connect to ${this.config.alias} (mongodb) by running: npm install mongodb`,
      );
    }
    return mongoModule;
  }

  /**
   * Build a MongoDB connection URI from the config.
   * NOTE: encodeURIComponent() is required for passwords containing
   * special characters (@, :, /, ?, #, %). parseAuth() does raw split only.
   */
  private buildUri(): string {
    const auth = parseAuth(this.config.auth);
    const host = this.config.host || 'localhost';
    const port = this.config.port || 27017;

    if (auth.user && auth.password) {
      return `mongodb://${encodeURIComponent(auth.user)}:${encodeURIComponent(auth.password)}@${host}:${port}/${this.config.database}`;
    }
    if (auth.user) {
      return `mongodb://${encodeURIComponent(auth.user)}@${host}:${port}/${this.config.database}`;
    }
    return `mongodb://${host}:${port}/${this.config.database}`;
  }

  /**
   * Connect to MongoDB and return the MongoClient.
   */
  private async connectClient(): Promise<any> {
    const mongodb = this.importMongoDriver();
    const uri = this.buildUri();
    return mongodb.MongoClient.connect(uri, {
      tls: this.config.ssl ?? false,
      connectTimeoutMS: 10_000,
      serverSelectionTimeoutMS: 10_000,
    });
  }
}
```

- [ ] **Step 2: Build to verify**

Run: `cd D:\code\dbgraph && npx tsc --noEmit`
Expected: No errors (note: `mongodb` package is not installed, but the lazy require handles it — TypeScript will use `any` type for the module variable)

- [ ] **Step 3: Commit**

```bash
git add src/introspect/mongodb.ts
git commit -m "feat: add MongoDBIntrospector"
```

---

### Task 4: Register in introspect factory

**Files:**
- Modify: `src/introspect/index.ts:1-52`

Add the import, factory case, and update the error message to include `mongodb`.

- [ ] **Step 1: Update header comment + import**

```diff
  /**
   * Concrete implementations:
   *  - PostgresIntrospector  (postgres.ts)
   *  - MySQLIntrospector     (mysql.ts)
   *  - SQLiteIntrospector    (sqlite.ts)
   *  - MSSQLIntrospector     (mssql.ts)
+  *  - MongoDBIntrospector   (mongodb.ts)
   */

  import { PostgresIntrospector } from './postgres';
  import { MySQLIntrospector } from './mysql';
  import { SQLiteIntrospector } from './sqlite';
  import { MSSQLIntrospector } from './mssql';
+ import { MongoDBIntrospector } from './mongodb';
  import { Introspector, BaseIntrospector } from './base';
```

- [ ] **Step 2: Add factory case + update error message**

```diff
    case 'mssql':
      return new MSSQLIntrospector(config);
+   case 'mongodb':
+     return new MongoDBIntrospector(config);
    default:
      throw new Error(
        `Unsupported database engine: "${config.engine}". ` +
-       `Supported engines: postgresql, mysql, mariadb, sqlite, mssql`,
+       `Supported engines: postgresql, mysql, mariadb, sqlite, mssql, mongodb`,
      );
```

- [ ] **Step 3: Build to verify**

Run: `cd D:\code\dbgraph && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/introspect/index.ts
git commit -m "feat: register MongoDBIntrospector in factory"
```

---

### Task 5: Full build and integration verification

**Files:** (no changes — pure verification)

- [ ] **Step 1: Full build**

```bash
cd D:\code\dbgraph && npm run build
```

Expected: Build succeeds, `dist/introspect/mongodb.js` exists

- [ ] **Step 2: Quick smoke test — verify engine is recognized**

```bash
node -e "
const { createIntrospector } = require('./dist/introspect');
try {
  createIntrospector({ engine: 'mongodb', alias: 'test', database: 'test' });
  console.log('PASS: MongoDBIntrospector created successfully');
} catch (e) {
  console.log('FAIL:', e.message);
}
"
```

Expected: `PASS: MongoDBIntrospector created successfully`

- [ ] **Step 3: Verify unknown engine still throws**

```bash
node -e "
const { createIntrospector } = require('./dist/introspect');
try {
  createIntrospector({ engine: 'fake', alias: 'test', database: 'test' });
  console.log('FAIL: should have thrown');
} catch (e) {
  console.log('PASS:', e.message);
}
"
```

Expected: Error message includes `mongodb` in the supported engines list

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "build: verify MongoDB introspector integration"
```
