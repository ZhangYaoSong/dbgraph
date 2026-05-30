# MongoDB Support for DBGraph

Date: 2026-05-30
Status: Approved
Authors: AI Architect / User

## Overview

Add MongoDB as a supported database engine for DBGraph's schema introspection
system. MongoDB is fundamentally different from relational databases — it has
no tables, columns, foreign keys, or schemas in the SQL sense. The design
maps MongoDB's document model onto DBGraph's existing Node/Edge graph model
while respecting these differences.

## Concept Mapping

| MongoDB Concept | Graph Node Kind | Notes |
|---|---|---|
| Database | `database` | Container node |
| Collection | `table` | Includes capped, timeseries, clustered collections |
| View | `view` | Read-only aggregation view, pipeline def as `signature` |
| Index | `index` | All types: single, compound, text, geospatial, hashed, TTL |

No new `NodeKind` or `EdgeKind` values are needed — all map to existing types.

### Edges

| Relationship | Edge Kind | Source → Target |
|---|---|---|
| Database contains collection/view | `contains` | `database` → `table`/`view` |
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
| Database | `@alias.{database}` | `db://@alias/{database}` |
| Collection | `@alias.{database}.{collection}` | `db://@alias/{database}` |
| Index | `@alias.{database}.{collection}.{indexName}` | `db://@alias/{database}` |
| View | `@alias.{database}.{view}` | `db://@alias/{database}` |

Because MongoDB has no schema layer, the database name serves as the schema
parameter in all helper calls.

## Connection Management

### Driver: `mongodb` (official Node.js driver)

- **Install**: Optional (lazy import, like `pg`)
- **Error message**: `"mongodb package is not installed. Run: npm install mongodb"`
- **Auth mechanism**: SCRAM (default), via `auth: "user:password"` config

### Connection URI Construction

```typescript
const auth = parseAuth(config.auth);
const host = config.host || 'localhost';
const port = config.port || 27017;
const uri = auth.user
  ? `mongodb://${auth.user}:${auth.password}@${host}:${port}/${config.database}`
  : `mongodb://${host}:${port}/${config.database}`;
```

- SRV protocol (`mongodb+srv://`) is NOT supported in v1; plain `mongodb://` only
- TLS/SSL via `config.ssl` → `MongoClientOptions.tls`
- Auth source defaults to the target database (not `admin`)

### MongoDBConnection Class

```
MongoDBConnection implements DBConnection {
  - query(): throws Error("MongoDB does not support SQL queries")
  - getDb(): returns the native mongodb Db instance
  - close(): calls client.close()
}
```

`MongoDBConnection` is registered in `createConnection()` factory.
The `MongoDBIntrospector` casts the return value to access `getDb()`:

```typescript
const conn = (await createConnection(this.config)) as MongoDBConnection;
const db = conn.getDb();
```

This avoids changing the `DBConnection` interface for all engines.

### Default Port

Add `mongodb: 27017` to `defaultPorts` in `BaseIntrospector.getDisplayUri()`.

## Introspection Logic

### Pipeline (`extractAll()`)

```
1. Connect:   MongoClient.connect(uri, { tls: config.ssl, connectTimeoutMS: 10000 })
2. Get DB:    client.db(config.database)
3. List collections:
   db.listCollections({}, { nameOnly: false, authorizedCollections: true }).toArray()
4. Classify into regular collections vs views:
   - type: "collection" → collection
   - type: "view"      → view
5. For each collection (in parallel):
   a. indexes() → index definitions
   b. estimatedDocumentCount() → document count (fast, no full scan)
6. Build graph:
   a. Database node
   b. Collection nodes (with validation rules + stats in metadata)
   c. View nodes (pipeline as JSON string in signature)
   d. Index nodes (key definition + properties in metadata)
   e. Container edges (database→collection, collection→index)
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

`authorizedCollections: true` ensures only collections the user has
permissions for are returned.

### schemas Config

The `config.schemas` field (used for schema filtering in relational engines)
is silently ignored for MongoDB. A comment in code documents this.

## Node/Edge Schema

### Database Node (1 per source)

```typescript
{
  kind: "database",
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
    documentCount: number,  // from estimatedDocumentCount()
    validation: {           // $jsonSchema if collection has validator
      $jsonSchema: { ... }
    },
    collectionOptions: {    // from listCollections.options
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

BSON types in the pipeline are fine; `listCollections` returns plain JS
objects that serialize cleanly with `JSON.stringify`.

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
    automatic?: boolean,  // true for _id index
  },
}
```

The auto-created `_id` index on every collection IS included, with
`automatic: true`. This is accurate schema information and helps AI agents
understand document structure.

## Files to Change

| File | Change |
|---|---|
| `src/introspect/mongodb.ts` | **NEW** — `MongoDBIntrospector` |
| `src/introspect/connection.ts` | Add `MongoDBConnection` class + factory case |
| `src/introspect/index.ts` | Import + register `MongoDBIntrospector` in factory |
| `src/introspect/base.ts` | Add `mongodb: 27017` to `defaultPorts` |

No changes to `src/types.ts` (`mongodb` already in `DB_ENGINES`), no changes
to `package.json` (driver is lazy-imported as an optional dependency).

## Verified Edge Cases

| Case | Behavior |
|---|---|
| Empty database (no collections) | Return database node only, no errors |
| Database with only system collections | Return database node only |
| Collection with no indexes | Return collection node, no index nodes |
| Collection with many indexes (10+) | All included, no limit |
| View with empty pipeline | Return view node with `signature: "[]"` |
| TLS connection (`ssl: true`) | Pass `tls: true` to MongoClient options |
| Auth with special chars in password | Handled by URL-encoding in `parseAuth` |
| Collection with complex validator | Stored as raw JSON in `metadata.validation` |
| Capped collection | `collectionOptions.capped: true` in metadata |
| Time-series collection | `collectionOptions.timeseries` in metadata |

## Future Considerations (not in v1)

- **Document sampling** — Optional field inference by sampling N documents per collection
- **SRV protocol** — `mongodb+srv://` for Atlas/cloud deployments
- **`authSource` config** — Option to specify auth database separately
- **Multiple database support** — Introspect all databases on a MongoDB server
- **`$expr` validation** — Non-JSON-Schema validators
- **MongoDB 7+ features** — New index types, encrypted collections
