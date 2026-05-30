# DBGraph Agents Guide

Database knowledge graph — Introspect database schemas into a local-first knowledge graph, stored in SQLite with FTS5 full-text search, exposed over MCP for AI agents.

## Project Overview

DBGraph is a TypeScript CLI + MCP Server that introspects database schemas into a SQLite knowledge graph (with FTS5 full-text search) and exposes it to AI agents via MCP tools.

- **CLI entry**: `src/bin/dbgraph.ts` → built output `dist/bin/dbgraph.js`
- **Main class**: `DBGraph` in `src/index.ts`
- **Type definitions**: `src/types.ts`
- **Database introspection**: `src/introspect/` — one file per engine (`postgres.ts`, `mysql.ts`, `sqlite.ts`), all extending `BaseIntrospector`
- **MCP Server**: `src/mcp/` — supports stdio mode and daemon socket mode
- **Graph traversal**: `src/graph/traversal.ts` (BFS/DFS/pathfinding)

## Dev Commands

```bash
npm install          # Install dependencies
npm run build        # tsc + copy schema.sql + chmod
npm run dev          # tsc --watch
npm run cli -- <args>  # build then run dist/bin/dbgraph.js
npm test             # vitest run (no tests yet)
npm run clean        # delete dist/
```

**Build note**: `npm run build` runs `tsc`, then copies `src/db/schema.sql` to `dist/db/` and makes the CLI executable. If you change schema.sql, you must rebuild.

## Architecture

- **Node.js >= 22.5.0** — relies on built-in `node:sqlite`
- **CommonJS modules** — `tsconfig.json` sets `module: "commonjs"`
- **SQLite storage**: `.dbgraph/dbgraph.db` with core tables `nodes` + `edges` + `db_sources` + `nodes_fts` (FTS5)
- **Config file**: `dbgraph-db.json`, supports JSONC (comments)
- **Config discovery**: `findConfigFile()` walks up from the current directory
- **Concurrency safety**: `FileLock` (cross-process) + `Mutex` (in-process)
- **Node IDs**: Deterministic hash via `hashString()` on qualified name

## CLI Quick Reference

All commands: `dbgraph <command> [options] [directory]`

| Command | Description |
|---------|-------------|
| `init [dir]` | Initialize `.dbgraph` project (+ optional `--index`, `-c` config) |
| `index [dir]` | Run database introspection |
| `serve [dir]` | Start MCP stdio server (`--daemon` for background, `--auto-refresh`) |
| `query <term> [dir]` | Search tables/columns/views/indexes (`--kind table`, `--json`, `--limit N`) |
| `context <name> [dir]` | View full table schema (supports `schema.table`) |
| `status [dir]` | Knowledge graph statistics |
| `sources [dir]` | List data sources |
| `test [dir]` | Test database connections (`-c` for config) |
| `config [dir]` | View/create config (`--init` creates default config) |

## MCP Tools (exposed by `serve`)

| Tool | Description |
|------|-------------|
| `dbgraph_search` | Search tables/columns/views/indexes |
| `dbgraph_context` | Full table schema + columns + FKs + indexes (call before writing SQL) |
| `dbgraph_trace` | Trace FK join paths (find JOIN chains between tables) |
| `dbgraph_explore` | Explore multiple tables at once |
| `dbgraph_sources` | List configured database sources |
| `dbgraph_status` | Knowledge graph statistics |

## Adding a New Database Engine

1. Create a new file in `src/introspect/` implementing the `BaseIntrospector` abstract class
2. Register it in `src/introspect/index.ts` in the `createIntrospector()` factory
3. Add the engine name to the `DB_ENGINES` array in `src/types.ts`

## Test Status

- **No test files** — `__tests__/` directory does not exist, no `*.spec.ts` / `*.test.ts` files
- vitest is installed but not configured (no `vitest.config.*`), uses defaults
- Create tests in `__tests__/` to add coverage

## Using CodeGraph

This project has a CodeGraph index (`.codegraph/`). Prefer codegraph tools over grep for structural queries:

- `codegraph_context` — Understand a module\'s purpose and structure
- `codegraph_search` — Find symbol definitions by name
- `codegraph_explore` — View source of multiple related symbols at once
- `codegraph_impact` — Analyze how changes affect other code
