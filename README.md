<div align="center">

# DBGraph

### Database Knowledge Graph — Introspect schemas into a searchable graph, expose over MCP for AI agents

**Zero-guess SQL generation · Sub-millisecond schema lookups · 100% local**

[![npm version](https://img.shields.io/npm/v/dbgraph)](https://www.npmjs.com/package/dbgraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D22.5-brightgreen)](https://nodejs.org/)

[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-supported-blue)](#supported-engines)
[![MySQL](https://img.shields.io/badge/MySQL-supported-blue)](#supported-engines)
[![SQLite](https://img.shields.io/badge/SQLite-supported-blue)](#supported-engines)

</div>

## Get Started

```bash
# Zero-install (recommended)
npx dbgraph

# Or install globally
npm i -g dbgraph
```

### Initialize a project

```bash
cd your-project
npx dbgraph init -i       # init + index in one step
```

<sub>`dbgraph init` creates `.dbgraph/` and a default `dbgraph-db.json` config. Adding `-i` (`--index`) also introspects your databases immediately. Edit `dbgraph-db.json` first to configure your connections.</sub>

### Start the MCP server

```bash
npx dbgraph serve
```

AI agents connected to MCP automatically discover `dbgraph_*` tools for schema-aware SQL generation.

## Why DBGraph?

LLMs write wrong SQL because they **don't know your schema** — guessing table names, column names, and JOIN conditions. DBGraph extracts your complete database schema (tables, columns, types, foreign keys, constraints, indexes) into a **searchable knowledge graph** stored in `.dbgraph/`. AI agents query it via MCP tools directly — no live database connection needed.

```
Without DBGraph:
  LLM → guess names → write SQL → run → error → guess again → loop

With DBGraph:
  LLM → dbgraph_context("orders") → get exact schema
       → write SQL → success
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `init` | Initialize `.dbgraph` project (`-i` to index immediately) |
| `index` | Run database introspection |
| `serve` | Start MCP server (use `--auto-refresh` to watch for schema changes) |
| `query` | Search tables, columns, views, indexes |
| `context` | View full table schema (call before writing SQL) |
| `trace` | Trace foreign key join paths between tables |
| `explore` | Explore multiple related tables at once |
| `sources` | List configured database sources |
| `status` | Knowledge graph statistics |
| `test` | Test database connections |
| `config` | View or create configuration |

All commands default to the current directory. Pass a directory path to target another project:

```bash
npx dbgraph status                  # current directory
npx dbgraph status ./other-project  # another project
```

## MCP Tools

After starting `dbgraph serve`, AI agents can call:

| Tool | Purpose |
|------|---------|
| `dbgraph_search` | Search schema objects by name |
| `dbgraph_context` | **Full table schema** — columns, types, PKs, FKs, indexes |
| `dbgraph_trace` | Trace FK join paths (orders → users) |
| `dbgraph_explore` | Batch schema for multiple tables |
| `dbgraph_sources` | List all database sources |
| `dbgraph_status` | Graph health and statistics |

## Configuration

Edit `dbgraph-db.json` in your project root:

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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `alias` | string | yes | Database alias (`db://@alias` in graph) |
| `engine` | string | yes | `postgresql` / `mysql` / `mariadb` / `sqlite` |
| `host` | string | no | Host address |
| `port` | number | no | Port (default depends on engine) |
| `database` | string | depends | Required for PostgreSQL/MySQL |
| `schemas` | string[] | no | Schemas to introspect (default: all) |
| `path` | string | depends | Required for SQLite |
| `auth` | string | no | `env:VAR_NAME` or `~/.pgpass` |
| `ssl` | boolean | no | Enable SSL |

## Supported Engines

| Engine | Status |
|--------|--------|
| PostgreSQL | ✅ Full support |
| MySQL / MariaDB | ✅ Full support |
| SQLite | ✅ Full support |
| SQL Server | 🔜 Planned |
| Oracle | 🔜 Planned |

## Development

```bash
git clone https://github.com/ZhangYaoSong/dbgraph.git
cd dbgraph
npm install
npm run build
npm run cli -- init -i   # init current dir + index
npm run cli -- serve      # start MCP server from source
```

## Acknowledgments

Inspired by [CodeGraph](https://github.com/colbymchenry/codegraph) — an excellent code knowledge graph tool that this project adapts to the database schema domain.

## License

MIT
