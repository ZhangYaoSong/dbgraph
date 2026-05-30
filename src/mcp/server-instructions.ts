/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the dbgraph toolset before it
 * sees individual tool descriptions.
 */

export const SERVER_INSTRUCTIONS = `# DBGraph — database knowledge graph for schema-aware SQL generation

DBGraph is a SQLite knowledge graph of every database schema object (tables,
columns, views, indexes, foreign keys) in your project. The schema is
introspected ahead of time — reads are sub-millisecond and require no live
database connection.

**Always consult dbgraph BEFORE writing SQL.** Understanding the schema first
is the single largest quality lever for generated queries. A minute of
schema exploration saves many rounds of "fix the column name" corrections.

## Recommended workflow

1. **\`dbgraph_search\`** — Find tables, columns, or views by name. Start here
   when you know roughly what you're looking for.

2. **\`dbgraph_context\`** (PRIMARY) — Get the full schema of a table or view:
   columns, types, primary keys, foreign keys, indexes, and what references it.
   This is the main tool for understanding a schema object.

3. **\`dbgraph_trace\`** — Trace foreign key join paths between two tables.
   Use this to discover how tables relate before writing JOIN clauses.

4. **\`dbgraph_explore\`** — Fetch schemas for several related tables at once
   (fewer round-trips than calling \`dbgraph_context\` repeatedly).

5. **\`dbgraph_sources\`** — List all configured databases and their engines.
   Useful when you don't know which database alias contains the table you need.

6. **\`dbgraph_status\`** — See overall graph statistics: node/edge counts,
   breakdown by kind, and last index time. Quick health check.

## When to use each tool

| You want to... | Use this tool |
|---|---|
| Find a table or column by name | \`dbgraph_search\` |
| See a table's full schema (columns, PKs, FKs, indexes) | \`dbgraph_context\` |
| Discover how two tables join (FK path) | \`dbgraph_trace\` |
| Explore several related tables at once | \`dbgraph_explore\` |
| List available databases | \`dbgraph_sources\` |
| Check if the schema index is healthy | \`dbgraph_status\` |

## Common chains

- **Write a correct JOIN**: \`dbgraph_context\` on each table → \`dbgraph_trace\`
  to confirm the FK path → then write SQL.
- **Understand an unfamiliar schema**: \`dbgraph_search\` for key terms →
  \`dbgraph_context\` on the main tables → \`dbgraph_explore\` on related ones.
- **Debug a broken query**: \`dbgraph_context\` on each referenced table →
  check column names and types → \`dbgraph_trace\` to verify join columns.

## Anti-patterns

- **Don't guess column names** — use \`dbgraph_context\` to see them.
- **Don't chain many \`dbgraph_context\` calls** — use \`dbgraph_explore\` with
  space-separated table names for a batch view.
- **Don't write JOINs without tracing** — \`dbgraph_trace\` reveals the FK path
  and often shows intermediate tables you didn't know existed.
`;

