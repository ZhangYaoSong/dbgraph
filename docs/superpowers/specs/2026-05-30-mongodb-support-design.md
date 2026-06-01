# MongoDB Support for DBGraph

Date: 2026-05-30
Status: Approved (post-review)
Authors: AI Architect / User
Reviewer: @oracle

## Overview

Add MongoDB as a supported database engine for DBGraph's schema introspection
system. MongoDB is fundamentally different from relational databases — it has
no tables, columns, foreign keys, or schemas in the SQL sense. The design
maps MongoDB's document model onto DBGraph's existing Node/Edge graph model
while respecting these differences.

## Concept Mapping

| MongoDB Concept | Graph Node Kind | Notes |
|---|---|---|
| Database | `schema` | Consistent with all other engines (Postgres/MySQL/MSSQL all use `schema`) |
| Collection | `table` | Includes capped, timeseries, clustered collections |
| View | `view` | Read-only aggregation view, pipeline def as `signature` |
| Index | `index` | All types: single, compound, text, geospatial, hashed, TTL |

No new `NodeKind` or `EdgeKind` values are needed — all map to existing types.

### Edges

| Relationship | Edge Kind | Source → Target |
|---|---|---|
| Database contains collection/view | `contains` | `schema` → `table`/`view` |
| Collection contains index | `contains` | `table` → `index` |

### Concepts NOT mapped

- **Columns/Fields** — Not introspected (no document sampling by design)
- **Foreign Keys** — MongoDB has no relational FK constraints
- **Triggers** — Change Streams are event-driven, not schema objects
- **Stored Procedures** — MongoDB 6+ has stored procedures but they're rare
- **Schemas** — No SQL-style schema layer; the database IS the schema

## Naming Conventions

Using existing helpers from `BaseIntrospector`:

| Object | Qualified Name (`qn()`) | File Path (`schemaFilePath()`) |
|---|---|---|
| Database (as schema) | `@alias.{database}` | `db://@alias/{database}` |
| Collection | `@alias.{database}.{collection}` | `db://@alias/{database}` |
| Index | `@alias.{database}.{collection}.{indexName}` | `db://@alias/{database}` |
| View | `@alias.{database}.{view}` | `db://@alias/{database}` |

Because MongoDB has no schema layer, the database name serves as the schema
parameter in all helper calls — exactly the same pattern as MySQL.

## Connection Management

### Driver: `mongodb` (official Node.js driver)

- **Install**: Optional (lazy import, like `pg`)
- **Error message**: `"mongodb package is not installed. Run: npm install mongodb"`
- **Auth mechanism**: SCRAM (default), via `auth: "user:password"` config

### Connection: NOT via `createConnection()` factory

**Key architectural decision**: MongoDB does NOT use the `createConnection()`
factory or `DBConnection` interface. The `DBConnection` interface is SQL-centric
(with `query(sql, params)`), so shoehorning MongoDB into it would require:

- A `MongoDBConnection` class whose `query()` throws at runtime
- An unsafe type cast (`as MongoDBConnection`) in the introspector
- Dead code that could break future generic callers

**Instead**: `MongoDBIntrospector.extractAll()` manages its own connection:

```typescript
import { DbConnectionConfig } from '../types';
import { BaseIntrospector } from './base';
import { parseAuth } from './connection';  // reuse auth parser

export class MongoDBIntrospector extends BaseIntrospector {
  async extractAll(): Promise<IntrospectResult> {
    // 1. Lazy-import mongodb driver (with graceful error if missing)
    // 2. Build MongoDB URI from config
    // 3. MongoClient.connect() → get Db
    // 4. Introspect
    // 5. client.close()
  }

  // Override testConnection for direct MongoDB testing
  async testConnection(): Promise<boolean> {
    try { /* MongoClient.connect + close */ return true; }
    catch { return false; }
  }
}
```

### Connection URI Construction

```typescript
import { parseAuth } from './connection';  // reused helper

const auth = parseAuth(config.auth);
const host = config.host || 'localhost';
const port = config.port || 27017;

// IMPORTANT: encodeURIComponent() is REQUIRED for passwords with
// special chars (@, :, /, ?, #, %). parseAuth() does raw split only.
const user = auth.user ? encodeURIComponent(auth.user) : undefined;
const pass = auth.password ? encodeURIComponent(auth.password) : undefined;

const uri = user && pass
  ? `mongodb://${user}:${pass}@${host}:${port}/${config.database}`
  : `mongodb://${host}:${port}/${config.database}`;
```

- SRV protocol (`mongodb+srv://`) is NOT supported in v1; plain `mongodb://` only
- TLS/SSL via `config.ssl` → `MongoClientOptions.tls`
- Auth source defaults to the target database (not `admin`)

### testConnection() Override

`BaseIntrospector.testConnection()` delegates to `createConnection()` which
we're not using. So `MongoDBIntrospector` overrides it:

```typescript
async testConnection(): Promise<boolean> {
  try {
    const client = await this.connectClient();
    await client.close();
    return true;
  } catch {
    return false;
  }
}

private async connectClient(): Promise<MongoClient> {
  const { MongoClient } = await importMongoDriver();  // lazy require
  const uri = this.buildUri();
  return MongoClient.connect(uri, {
    tls: this.config.ssl ?? false,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  });
}
```

### Default Port

Add `mongodb: 27017` to `defaultPorts` in `BaseIntrospector.getDisplayUri()`.

## Introspection Logic

### Pipeline (`extractAll()`)

```
1. Connect:   MongoClient.connect(uri, { tls, connectTimeoutMS, serverSelectionTimeoutMS })
2. Get DB:    client.db(config.database)
3. List collections:
   db.listCollections({}, { nameOnly: false, authorizedCollections: true }).toArray()
4. Classify into regular collections vs views:
   - type: "collection" → collection
   - type: "view"      → view
5. For each collection (in parallel):
   a. indexes() → index definitions
   b. estimatedDocumentCount() → document count
      NOTE: accurate for standalone/replica sets, approximate on sharded clusters
6. Build graph:
   a. Schema (database) node
   b. Collection nodes (with validation rules + stats in metadata)
   c. View nodes (pipeline as JSON string in signature)
   d. Index nodes (key definition + properties in metadata)
   e. Container edges (schema→collection, collection→index)
7. Close:   client.close()
8. Return:  IntrospectResult { nodes, edges, durationMs, errors }
```

### Error Handling

| Failure | Behavior |
|---|---|
| Connection failure | Return empty result with error message |
| `listCollections` permission denied | Return error, no results |
| Single collection access failure | Skip that collection, log error, continue |
| `estimatedDocumentCount` timeout | Skip count, still include collection |
| Index query failure | Skip indexes for that collection |

`authorizedCollections: true` (explicit but default in driver 4.x+) ensures
only collections the user has permissions for are returned.

### schemas Config

The `config.schemas` field (used for schema filtering in relational engines)
is silently ignored for MongoDB. A comment in code documents this.

## Node/Edge Schema

### Schema (Database) Node (1 per source)

```typescript
{
  kind: "schema",               // consistent with all other engines
  name: config.database,
  qualifiedName: `@${alias}.${database}`,
  filePath: `db://@${alias}/${database}`,
  language: "mongodb",
}
```

### Collection Node (kind: "table")

```typescript
{
  kind: "table",
  name: collectionName,
  qualifiedName: `@${alias}.${database}.${collectionName}`,
  filePath: `db://@${alias}/${database}`,
  language: "mongodb",
  metadata: {
    documentCount: number,    // estimatedDocumentCount()
                              // CAVEAT: approximate on sharded clusters
    validation: {             // $jsonSchema if collection has validator
      $jsonSchema: { ... }
    },
    collectionOptions: {      // from listCollections.options
      capped?: boolean,
      size?: number,
      max?: number,
      collation?: object,
      timeseries?: object,
    }
  },
}
```

The `validation` field is only present if the collection has a `$validator`
with `$jsonSchema`. Other validation operators (like `$expr`) are not stored.

### View Node (kind: "view")

```typescript
{
  kind: "view",
  name: viewName,
  qualifiedName: `@${alias}.${database}.${viewName}`,
  filePath: `db://@${alias}/${database}`,
  language: "mongodb",
  signature: JSON.stringify(pipeline, null, 2),  // aggregation pipeline
  metadata: {
    viewOn: sourceCollection,
  },
}
```

BSON types in the pipeline (ObjectId, Long, Decimal128) serialize to extended
JSON format (`{"$oid": "..."}`). This is fine for AI agent consumption.

### Index Node (kind: "index")

```typescript
{
  kind: "index",
  name: indexName,
  qualifiedName: `@${alias}.${database}.${collectionName}.${indexName}`,
  filePath: `db://@${alias}/${database}`,
  language: "mongodb",
  metadata: {
    key: { fieldName: 1 | -1 | "text" | "2dsphere" | "hashed" },
    unique: boolean,
    sparse?: boolean,
    indexType: "regular" | "text" | "2dsphere" | "hashed",
    partialFilterExpression?: object,
    ttl?: number,
    automatic?: boolean,   // true for the auto-created _id index
  },
}
```

The auto-created `_id` index on every collection IS included, with
`automatic: true`. This is accurate schema information and helps AI agents
understand document structure.

## Files to Change

| File | Change |
|---|---|
| `src/introspect/mongodb.ts` | **NEW** — `MongoDBIntrospector` (manages own connection, overrides testConnection) |
| `src/introspect/index.ts` | Import + register `MongoDBIntrospector` in factory |
| `src/introspect/base.ts` | Add `mongodb: 27017` to `defaultPorts` |

No changes to:
- `src/types.ts` — `mongodb` already in `DB_ENGINES`
- `src/introspect/connection.ts` — MongoDB does NOT use `createConnection()`
- `package.json` — driver is lazy-imported as an optional dependency

## Verified Edge Cases

| Case | Behavior |
|---|---|
| Empty database (no collections) | Return schema node only, no errors |
| Database with only system collections | Return schema node only |
| Collection with no indexes | Return collection node, no index nodes |
| Collection with many indexes (10+) | All included, no limit |
| View with empty pipeline | Return view node with `signature: "[]"` |
| TLS connection (`ssl: true`) | Pass `tls: true` and `tlsAllowInvalid: false` to MongoClient |
| Auth with special chars in password | `encodeURIComponent()` applied before URI construction |
| Collection with complex validator | Stored as raw JSON in `metadata.validation` |
| Capped collection | `collectionOptions.capped: true` in metadata |
| Time-series collection | `collectionOptions.timeseries` in metadata |
| `max` not set on capped collection | Handled gracefully (field absent from metadata) |

## Future Considerations (not in v1)

- ~~**Document sampling** — Optional field inference by sampling N documents per collection~~ *(deferred indefinitely — see risk assessment)*
- ~~**SRV protocol** — `mongodb+srv://` for Atlas/cloud deployments~~ *(已实现 — config.srv: true)*
- ~~**`authSource` config** — Option to specify auth database separately~~ *(已实现 — config.authSource)*
- **Multiple database support** — Introspect all databases on a MongoDB server *(可通过配置多个 sources 实现，见 README)*
- **`$expr` validation** — Non-JSON-Schema validators *(已实现 — metadata.rawValidator)*
- **MongoDB 7+ features** — New index types, encrypted collections *(部分已实现 — clusteredIndex/encryptedFields 元数据 + wildcard 索引类型检测)*
