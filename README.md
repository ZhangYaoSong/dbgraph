# DBGraph

[![npm version](https://img.shields.io/npm/v/dbgraph)](https://www.npmjs.com/package/dbgraph)
[![License](https://img.shields.io/npm/l/dbgraph)](LICENSE)
[![Node](https://img.shields.io/node/v/dbgraph)](https://nodejs.org)

Database knowledge graph — Introspect database schemas into a local-first knowledge graph, exposed over MCP for LLM-powered SQL generation.

## The Problem

LLMs make SQL mistakes because they **don't know your schema** — guessing table names, column names, and JOIN conditions. DBGraph extracts your complete database schema (tables, columns, types, foreign keys, constraints, indexes) into a **searchable knowledge graph** stored in `.dbgraph/`. LLMs query it via MCP tools directly — no live database connection needed.

```
Without DBGraph:
  LLM → guess names → write SQL → run → error → guess again → loop

With DBGraph:
  LLM → dbgraph_context("orders") → get exact schema
       → write SQL → dbgraph_execute → success
```

## Quick Install

```bash
# Global install
npm install -g dbgraph

# Or use directly with npx
npx dbgraph --help
```

## Requirements

- **Node.js >= 22.5.0** (requires built-in `node:sqlite` for FTS5 + WAL)

## Quick Start

### 1. Initialize a project

```bash
dbgraph init ./demo-project
```

This creates:
- `demo-project/.dbgraph/` — knowledge graph data directory
- `demo-project/dbgraph-db.json` — database connection config (default template)

### 2. Configure database connections

Edit `demo-project/dbgraph-db.json` with your database info:

```json
{
  "databases": [
    {
      "alias": "prod",
      "engine": "postgresql",
      "host": "localhost",
      "port": 5432,
      "database": "ecommerce",
      "schemas": ["public"],
      "auth": "env:DB_PASSWORD"
    },
    {
      "alias": "local",
      "engine": "sqlite",
      "path": "./dev.db"
    }
  ]
}
```

### 3. Extract schema

```bash
dbgraph index ./demo-project
```

Introspects all configured databases and stores tables, columns, foreign keys, indexes, and views into the knowledge graph.

### 4. Query the knowledge graph

```bash
# Search tables/columns
dbgraph query orders ./demo-project
dbgraph query users --kind table ./demo-project

# View full table structure
dbgraph context public.orders ./demo-project

# Check status
dbgraph status ./demo-project

# List data sources
dbgraph sources ./demo-project
```

## Configuration

### `dbgraph-db.json`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `alias` | string | yes | Database alias, identified as `db://@alias` in the graph |
| `engine` | string | yes | Database engine: `postgresql` / `mysql` / `mariadb` / `sqlite` |
| `host` | string | no | Host address (not needed for SQLite) |
| `port` | number | no | Port (default depends on engine) |
| `database` | string | yes (non-SQLite) | Database name |
| `schemas` | string[] | no | Schemas to introspect (default: all) |
| `path` | string | yes (SQLite) | SQLite file path |
| `auth` | string | no | Authentication, e.g. `env:DB_PASSWORD` or `~/.pgpass` |
| `ssl` | boolean | no | Enable SSL connection |

## CLI Reference

All commands follow: `dbgraph <command> [options] [directory]`

| Command | Description |
|---------|-------------|
| `init` | Initialize .dbgraph project + config |
| `index` | Run database introspection |
| `serve` | Start MCP server (for AI agents) |
| `query` | Search tables/columns/views |
| `context` | View full table structure |
| `status` | Knowledge graph statistics |
| `sources` | List data sources |
| `test` | Test database connections |
| `config` | View/create configuration |

### `init`

```bash
# Initialize a project
dbgraph init ./my-project

# Init and index immediately
dbgraph init ./my-project --index

# Specify config file path
dbgraph init ./my-project -c ./my-project/custom-config.json
```

### `index`

```bash
# Index configured databases
dbgraph index ./my-project

# Use a specific config file
dbgraph index ./my-project -c ./my-project/custom-config.json
```

### `serve` (MCP mode)

```bash
# Start MCP stdio server
dbgraph serve ./my-project
```

AI agents automatically discover `dbgraph_*` tools upon connecting to MCP.

### `query`

```bash
# Search
dbgraph query orders ./my-project

# Filter by kind
dbgraph query orders --kind table ./my-project
dbgraph query amount --kind column ./my-project

# JSON output
dbgraph query orders --json ./my-project
```

### `context`

```bash
# View table structure
dbgraph context orders ./my-project
dbgraph context public.orders ./my-project
```

Example output:
```
## Table: public.orders

Database: prod (postgresql)

| Column       | Type         | Nullable | Default  | PK | FK        |
|-------------|-------------|----------|----------|----|-----------|
| id          | bigint       | NO       |          | PK |           |
| user_id     | integer      | NO       |          |    | users.id  |
| status      | varchar(20)  | NO       | pending  |    |           |
| total_amount| numeric(10,2)| YES      | 0.00     |    |           |
| created_at  | timestamp    | NO       | now()    |    |           |

Indexes:
  - idx_orders_status on (status)
  - pk_orders PRIMARY KEY using btree (id)

Foreign Keys:
  - fk_orders_user → users(id) ON DELETE CASCADE
```

## MCP Tools

After starting `dbgraph serve`, AI agents can call these tools:

| Tool | Purpose | When to use |
|------|---------|-------------|
| `dbgraph_search` | Search tables/columns/views/indexes | When unsure about names |
| `dbgraph_context` | **Primary entry** — full table schema + columns + FKs + indexes | Before writing SQL |
| `dbgraph_trace` | Trace FK join paths (orders→users) | Before writing JOINs |
| `dbgraph_explore` | Explore multiple related tables at once | Complex multi-table queries |
| `dbgraph_sources` | List all configured database sources | Learn what databases are available |
| `dbgraph_status` | Knowledge graph statistics | Verify the graph is healthy |

### Recommended workflow

```
Standard pre-SQL flow:
1. dbgraph_search("order")        → find relevant tables
2. dbgraph_context("public.orders") → get full schema
3. dbgraph_context("public.users")   → get related table schema
4. dbgraph_trace("orders", "users")  → verify FK paths
5. LLM writes precise SQL
```

## Supported Engines

| Engine | Status | Details |
|--------|--------|---------|
| PostgreSQL | ✅ Full | `information_schema` + `pg_catalog` |
| MySQL / MariaDB | ✅ Full | `information_schema` |
| SQLite | ✅ Full | `pragma table_info` / `foreign_key_list` |
| SQL Server | 🔜 Planned | |
| Oracle | 🔜 Planned | |
| MongoDB | 🔜 Planned | |

## Project Structure

```
dbgraph/
├── src/
│   ├── index.ts                        # DBGraph main class
│   ├── types.ts                        # All types (Node, Edge, TableSchema...)
│   ├── config.ts                       # dbgraph-db.json config management
│   ├── directory.ts                    # .dbgraph directory management
│   ├── errors.ts                       # Error types
│   ├── utils.ts                        # Utility functions
│   │
│   ├── db/                             # SQLite storage layer
│   │   ├── schema.sql                  # Table schema (nodes/edges FTS5)
│   │   ├── sqlite-adapter.ts           # node:sqlite adapter
│   │   ├── migrations.ts               # Version migrations
│   │   ├── queries.ts                  # CRUD + FTS5 search + scoring (LRU cache)
│   │   └── index.ts                    # Connection management
│   │
│   ├── graph/
│   │   └── traversal.ts                # BFS/DFS/pathfinding/impact radius
│   │
│   ├── context/
│   │   ├── index.ts                    # Table context assembly
│   │   └── formatter.ts                # Markdown output
│   │
│   ├── introspect/                     # Database introspection
│   │   ├── base.ts                     # Base class + Node/Edge factory
│   │   ├── index.ts                    # Factory method
│   │   ├── connection.ts               # Connection management
│   │   ├── postgres.ts                 # PostgreSQL
│   │   ├── mysql.ts                    # MySQL
│   │   └── sqlite.ts                   # SQLite
│   │
│   ├── mcp/                            # MCP server
│   │   ├── transport.ts                # JSON-RPC transport
│   │   ├── session.ts                  # Session management
│   │   ├── engine.ts                   # Engine + lifecycle
│   │   ├── tools.ts                    # 6 dbgraph_* tools
│   │   ├── server-instructions.ts      # LLM instructions
│   │   └── index.ts                    # MCPServer
│   │
│   └── bin/
│       └── dbgraph.ts                  # CLI
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Development mode (watch)
npm run dev

# Quick build + run
npm run cli -- status ./my-project
```

### Adding a new database engine

Create a new file in `src/introspect/` (e.g. `mssql.ts`) implementing `BaseIntrospector`:

```typescript
import { BaseIntrospector } from './base';

export class MSSQLIntrospector extends BaseIntrospector {
  async extractAll(): Promise<IntrospectResult> {
    // 1. Connect to database
    // 2. Query information_schema
    // 3. Call this.makeNode() / this.makeEdge()
    // 4. Return IntrospectResult
  }
}
```

Then register it in `src/introspect/index.ts`:

```typescript
case 'mssql':
  return new MSSQLIntrospector(config);
```

## References

- **[AGENTS.md](AGENTS.md)** — OpenCode AI Agent project guide with dev commands and architecture overview
- **CodeGraph** — This project uses CodeGraph indexing (`.codegraph/`) for fast structural queries

## Acknowledgments

DBGraph\'s architecture and MCP design were inspired by [CodeGraph](https://github.com/colbymchenry/codegraph), an excellent code knowledge graph tool that extracts codebase structure into a queryable graph. This project adapts those ideas to the database schema domain.

## License

MIT
