/**
 * MCP Tool Definitions & Handlers
 *
 * Defines the tools exposed by the DBGraph MCP server and implements their
 * execution against a DBGraph knowledge graph instance.
 */

import { DBGraph } from '../index';
import type {
  Node,
  Edge,
  SearchResult,
  DbSourceRecord,
  TableSchema,
  GraphStats,
} from '../types';
import { SchemaFormatter } from '../context/formatter';

// =============================================================================
// Types
// =============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
}

interface PropertySchema {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum output length to prevent context bloat (characters) */
const MAX_OUTPUT_LENGTH = 15_000;

/** Node kinds filterable in dbgraph_search */
const SEARCH_NODE_KINDS = ['table', 'column', 'view', 'index', 'constraint'] as const;

// =============================================================================
// Tool Definitions
// =============================================================================

const tools: ToolDefinition[] = [
  {
    name: 'dbgraph_search',
    description:
      'Search database schema objects by name. Returns matching tables, columns, views, indexes, and constraints with relevance scores. Use this FIRST to find schema objects before calling dbgraph_context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Name or partial name to search for (e.g., "orders", "user", "total_amount")',
        },
        kind: {
          type: 'string',
          description: 'Filter results to a specific schema object kind',
          enum: [...SEARCH_NODE_KINDS],
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 20)',
          default: 20,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'dbgraph_context',
    description:
      'PRIMARY TOOL — Get the full schema context for a table or view. Returns columns with types, nullability, defaults, primary keys, foreign keys, indexes, comments, and a list of tables that reference this one. Call this BEFORE writing SQL against a table.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Table or view name — can be a simple name ("orders"), qualified name ("public.orders"), or fully qualified ("ecommerce.public.orders")',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'dbgraph_trace',
    description:
      'Trace foreign key relationships between two tables. Returns the join path (sequence of tables and FK columns) from source to target, or explains why no path exists. Use this to discover how to JOIN tables correctly.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description:
            'Starting table name (simple or qualified, e.g., "orders" or "public.orders")',
        },
        to: {
          type: 'string',
          description:
            'Target table name (simple or qualified, e.g., "users" or "public.users")',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'dbgraph_explore',
    description:
      'Get schema context for several related tables or views in a single call. Provide multiple names separated by spaces. More efficient than calling dbgraph_context repeatedly.',
    inputSchema: {
      type: 'object',
      properties: {
        objects: {
          type: 'string',
          description:
            'Space-separated list of table or view names to explore (e.g., "orders users order_items")',
        },
      },
      required: ['objects'],
    },
  },
  {
    name: 'dbgraph_sources',
    description:
      'List all configured database sources. Returns a table of database aliases with engine type, host, object count, and last index time. Use this to discover what databases are available.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'dbgraph_status',
    description:
      'Show knowledge graph statistics: total nodes, edges, database count, and breakdown by kind (tables, columns, views, indexes, foreign keys, etc.). Use this to verify the graph is healthy and complete.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// =============================================================================
// Tool Handler
// =============================================================================

/**
 * Executes dbgraph MCP tools against a DBGraph instance.
 *
 * The handler does NOT own the DBGraph lifecycle — the caller (MCPEngine)
 * provides a getter so the handler always uses the current (possibly
 * lazily-initialized) instance.
 */
export class DBGraphToolHandler {
  private readonly formatter = new SchemaFormatter();

  constructor(private readonly getDBGraph: () => DBGraph) {}

  /**
   * Return the tool definitions, optionally enriched with dynamic context
   * (e.g. stats) from the live graph.
   */
  getTools(): ToolDefinition[] {
    return tools;
  }

  /**
   * Execute a tool by name.
   */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case 'dbgraph_search':
          return await this.handleSearch(args);
        case 'dbgraph_context':
          return await this.handleContext(args);
        case 'dbgraph_trace':
          return await this.handleTrace(args);
        case 'dbgraph_explore':
          return await this.handleExplore(args);
        case 'dbgraph_sources':
          return await this.handleSources();
        case 'dbgraph_status':
          return await this.handleStatus();
        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return errorResult(
        `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  /**
   * dbgraph_search — Search schema objects by name. Delegates to
   * QueryBuilder.searchNodes with optional kind filter and limit, then
   * formats via SchemaFormatter.
   */
  private async handleSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const query = validateString(args.query, 'query');
    if (isErrorResult(query)) return query;

    const kind = args.kind as string | undefined;
    const rawLimit = Number(args.limit) || 20;

    // Validate kind if provided
    if (kind !== undefined && !(SEARCH_NODE_KINDS as readonly string[]).includes(kind)) {
      return errorResult(
        `Invalid kind "${kind}". Valid values: ${SEARCH_NODE_KINDS.join(', ')}`,
      );
    }

    const dbgraph = this.getDBGraph();
    const results: SearchResult[] = dbgraph.getQueryBuilder().searchNodes(query, {
      kinds: kind ? [kind as any] : undefined,
      limit: Math.min(Math.max(rawLimit, 1), 100),
    });

    if (results.length === 0) {
      return textResult(`No results found for "${query}"`);
    }

    const formatted = this.formatter.formatSearchResults(results);
    return textResult(truncateOutput(formatted));
  }

  /**
   * dbgraph_context — Get full schema context for a table or view.
   *
   * Resolves the name (simple, qualified, or fully qualified) via
   * ContextBuilder.buildContext, which searches the graph and returns a
   * complete markdown description.
   */
  private async handleContext(args: Record<string, unknown>): Promise<ToolResult> {
    const name = validateString(args.name, 'name');
    if (isErrorResult(name)) return name;

    const dbgraph = this.getDBGraph();
    const markdown = await dbgraph.getContextBuilder().buildContext(name);
    return textResult(truncateOutput(markdown));
  }

  /**
   * dbgraph_trace — Trace FK join path between two tables.
   *
   * Resolves both names to nodes, then runs GraphTraverser.findPath over
   * 'references', 'foreign_key', and 'contains' edges. Formats the
   * resulting path as a readable join chain.
   */
  private async handleTrace(args: Record<string, unknown>): Promise<ToolResult> {
    const from = validateString(args.from, 'from');
    if (isErrorResult(from)) return from;
    const to = validateString(args.to, 'to');
    if (isErrorResult(to)) return to;

    const dbgraph = this.getDBGraph();

    // Resolve start table
    const fromNodes = this.resolveTableNodes(from, dbgraph);
    if (fromNodes.length === 0) {
      return textResult(`Table "${from}" not found in any indexed database.`);
    }

    // Resolve target table
    const toNodes = this.resolveTableNodes(to, dbgraph);
    if (toNodes.length === 0) {
      return textResult(`Table "${to}" not found in any indexed database.`);
    }

    // Try each candidate pair — pick the first valid path
    const edgeKinds: Edge['kind'][] = ['references', 'foreign_key', 'contains'];
    const MAX_HOPS = 10;
    let path: Array<{ node: Node; edge: Edge | null }> | null = null;
    let notFoundReason = '';

    for (const f of fromNodes.slice(0, 3)) {
      for (const t of toNodes.slice(0, 3)) {
        const p = dbgraph.getTraverser().findPath(f.id, t.id, edgeKinds);
        if (!p || p.length <= 1) {
          if (!notFoundReason) {
            notFoundReason = 'No foreign key join path exists between these tables. They may belong to different databases or schemas with no FK relationship.';
          }
          continue;
        }
        if (p.length <= MAX_HOPS) {
          path = p;
          break;
        }
        // Path exists but is very long — use it as fallback
        if (!path || p.length < path.length) path = p;
      }
      if (path && path.length <= MAX_HOPS) break;
    }

    if (!path) {
      return textResult(notFoundReason);
    }

    // Format the path as readable markdown
    const lines: string[] = [];
    lines.push(`## FK Trace: ${from} → ${to}`);
    lines.push('');
    lines.push(`${path.length - 1} hop(s):`);
    lines.push('');

    // Each step in path has { node, edge } — edge is null for the start node.
    // For subsequent steps, edge is the connecting edge from previous → current.
    for (let i = 0; i < path.length; i++) {
      const step = path[i]!;
      const edge = step.edge;
      const node = step.node;

      const label = i === 0 ? '**Start**' : `**Step ${i}**`;
      const kindIcon = node.kind === 'table'
        ? '📋'
        : node.kind === 'view'
          ? '👁️'
          : '📎';

      lines.push(`${label}: ${kindIcon} \`${node.qualifiedName}\` (${node.kind})`);

      if (edge) {
        const edgeDesc = describeEdge(edge);
        lines.push(`  └─ via ${edgeDesc}`);
      }
      lines.push('');
    }

    return textResult(truncateOutput(lines.join('\n')));
  }

  /**
   * dbgraph_explore — Fetch schema context for multiple objects in one call.
   *
   * Splits the space-separated names, finds each table/view node, and calls
   * ContextBuilder.getTableSchema for each. Assembles a single markdown
   * document.
   */
  private async handleExplore(args: Record<string, unknown>): Promise<ToolResult> {
    const raw = validateString(args.objects, 'objects');
    if (isErrorResult(raw)) return raw;

    const names = raw
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (names.length === 0) {
      return errorResult('Provide at least one table or view name');
    }

    const dbgraph = this.getDBGraph();
    const parts: string[] = [];
    let errors = 0;

    for (const name of names) {
      const nodes = this.resolveTableNodes(name, dbgraph);
      if (nodes.length === 0) {
        parts.push(`**${name}** — *not found*`);
        errors++;
        continue;
      }

      // Pick the first match for each name
      const node = nodes[0]!;
      try {
        const schema: TableSchema = await dbgraph.getContextBuilder().getTableSchema(node.id);
        parts.push(this.formatter.formatTableSchema(schema));
      } catch (err) {
        parts.push(
          `**${name}** — *error: ${err instanceof Error ? err.message : 'unknown'}*`,
        );
        errors++;
      }
    }

    if (parts.length === 0) {
      return textResult('None of the specified objects were found.');
    }

    const summary =
      errors > 0
        ? `\n\n---\n*${errors} object(s) not found or errored.*\n`
        : '';

    return textResult(truncateOutput(parts.join('\n---\n\n') + summary));
  }

  /**
   * dbgraph_sources — List all database sources.
   */
  private async handleSources(): Promise<ToolResult> {
    const dbgraph = this.getDBGraph();
    const sources: DbSourceRecord[] = dbgraph.getQueryBuilder().getAllDbSources();
    const stats = dbgraph.getQueryBuilder().getStats();

    if (sources.length === 0) {
      return textResult('*No database sources configured. Run `dbgraph init` first.*');
    }

    const formatted = this.formatter.formatDatabaseOverview(sources, stats);
    return textResult(truncateOutput(formatted));
  }

  /**
   * dbgraph_status — Show graph statistics.
   */
  private async handleStatus(): Promise<ToolResult> {
    const dbgraph = this.getDBGraph();
    const stats: GraphStats = dbgraph.getQueryBuilder().getStats();

    const lines: string[] = [];
    lines.push('## DBGraph Status');
    lines.push('');

    if (stats.nodeCount === 0) {
      lines.push('*The knowledge graph is empty. Run `dbgraph index` to introspect your databases.*');
      lines.push('');
      return textResult(lines.join('\n'));
    }

    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Total nodes | ${stats.nodeCount.toLocaleString()} |`);
    lines.push(`| Total edges | ${stats.edgeCount.toLocaleString()} |`);
    lines.push(`| Databases | ${stats.dbCount.toLocaleString()} |`);

    if (stats.lastUpdated) {
      const date = new Date(stats.lastUpdated).toISOString();
      lines.push(`| Last indexed | ${date} |`);
    }

    if (stats.dbSizeBytes > 0) {
      const size =
        stats.dbSizeBytes > 1_048_576
          ? `${(stats.dbSizeBytes / 1_048_576).toFixed(1)} MB`
          : `${(stats.dbSizeBytes / 1024).toFixed(1)} KB`;
      lines.push(`| Database size | ${size} |`);
    }

    lines.push('');

    // Node breakdown by kind
    const kindLabels: Record<string, string> = {
      table: 'Tables',
      view: 'Views',
      column: 'Columns',
      index: 'Indexes',
      foreign_key: 'Foreign Keys',
      constraint: 'Constraints',
      trigger: 'Triggers',
      stored_procedure: 'Stored Procedures',
      function: 'Functions',
      sequence: 'Sequences',
      schema: 'Schemas',
      database: 'Databases',
      server: 'Servers',
    };

    lines.push('**Nodes by kind:**');
    lines.push('');
    for (const [kind, count] of Object.entries(stats.nodesByKind)) {
      if (count > 0) {
        const label = kindLabels[kind] ?? kind;
        lines.push(`- ${label}: ${count.toLocaleString()}`);
      }
    }

    if (Object.keys(stats.edgesByKind).length > 0) {
      lines.push('');
      lines.push('**Edges by kind:**');
      lines.push('');
      for (const [kind, count] of Object.entries(stats.edgesByKind)) {
        if (count > 0) {
          lines.push(`- ${kind}: ${count.toLocaleString()}`);
        }
      }
    }

    lines.push('');
    lines.push(`Project root: \`${dbgraph.getProjectRoot()}\``);

    return textResult(lines.join('\n'));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve a table or view name to graph nodes.
   *
   * Attempts, in order:
   *  1. Exact node ID lookup
   *  2. Qualified name lookup
   *  3. FTS5 search for table/view kind
   */
  private resolveTableNodes(name: string, dbgraph: DBGraph): Node[] {
    // 1. Try as node ID
    const byId = dbgraph.getQueryBuilder().getNodeById(name);
    if (byId && (byId.kind === 'table' || byId.kind === 'view')) {
      return [byId];
    }

    // 2. Try as qualified name
    const byQualified: Node[] = dbgraph.getQueryBuilder().getNodesByQualifiedName(name);
    const tableLike = byQualified.filter(
      (n: Node) => n.kind === 'table' || n.kind === 'view',
    );
    if (tableLike.length > 0) return tableLike;

    // 3. FTS5 fallback
    const results: SearchResult[] = dbgraph.getQueryBuilder().searchNodes(name, {
      kinds: ['table', 'view'],
      limit: 10,
    });
    return results.map((r: SearchResult) => r.node);
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/** Create a successful text result */
function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Create an error result */
function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Check if a result from validateString is an error */
function isErrorResult(value: string | ToolResult): value is ToolResult {
  return typeof value !== 'string';
}

/**
 * Validate that a value is a non-empty string within length bounds.
 * Returns the string if valid, or a ToolResult with the error.
 */
function validateString(value: unknown, name: string, maxLength = 10_000): string | ToolResult {
  if (typeof value !== 'string' || value.length === 0) {
    return errorResult(`${name} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    return errorResult(
      `${name} exceeds maximum length of ${maxLength} characters (got ${value.length})`,
    );
  }
  return value;
}

/**
 * Truncate output to the maximum allowed length.
 */
function truncateOutput(text: string, maxLength = MAX_OUTPUT_LENGTH): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  return `${truncated}\n\n_… (output truncated at ${maxLength.toLocaleString()} characters)_`;
}

/**
 * Build a human-readable description of an edge for the trace output.
 */
function describeEdge(edge: Edge): string {
  switch (edge.kind) {
    case 'references':
      return `FK reference \`${edge.metadata?.constraintName ?? '(columns)'}\``;
    case 'foreign_key':
      return `foreign key constraint \`${edge.metadata?.constraintName ?? edge.kind}\``;
    case 'contains':
      return 'containment';
    case 'primary_key':
      return 'primary key';
    case 'indexed_by':
      return 'index';
    case 'depends_on':
      return 'dependency';
    default:
      return edge.kind;
  }
}



