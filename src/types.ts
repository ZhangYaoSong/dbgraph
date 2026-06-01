/**
 * DBGraph Type Definitions
 *
 * Core types for the database schema knowledge graph system.
 */

// =============================================================================
// Union Types
// =============================================================================

/**
 * Types of nodes in the database knowledge graph.
 */
export const NODE_KINDS = [
  // Container / namespace
  'server',
  'database',
  'schema',

  // Schema objects
  'table',
  'view',
  'column',
  'index',
  'trigger',
  'stored_procedure',
  'function',
  'sequence',
  'constraint',
  'foreign_key',

  // Legacy code-symbol kinds kept for graph-generic query compatibility
  'module',
  'namespace',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Types of edges (relationships) between nodes
 */
export type EdgeKind =
  // Structural
  | 'contains'        // Parent contains child (schema→table, table→column)

  // Database-specific
  | 'references'      // Column references another column (FK)
  | 'primary_key'     // Column is part of primary key
  | 'foreign_key'     // Foreign key constraint (table→table)
  | 'indexed_by'      // Table/column indexed by an index
  | 'depends_on'      // View/trigger depends on table

  // Generic (kept for compatibility)
  | 'imports'
  | 'exports';

/**
 * Database engine types
 */
export const DB_ENGINES = [
  'postgresql',
  'mysql',
  'mariadb',
  'mssql',
  'sqlite',
  'oracle',
  'mongodb',
] as const;

export type DbEngine = (typeof DB_ENGINES)[number];

// =============================================================================
// Core Graph Types
// =============================================================================

/**
 * A node in the database knowledge graph representing a schema object
 */
export interface Node {
  /** Unique identifier (hash of source URI + qualified name) */
  id: string;

  /** Type of schema object */
  kind: NodeKind;

  /** Simple name (e.g., "orders", "total_amount") */
  name: string;

  /** Fully qualified name (e.g., "ecommerce.public.orders.total_amount") */
  qualifiedName: string;

  /** Source identifier: db://@alias/schema or db://host:port/db/schema */
  filePath: string;

  /** Database engine */
  language: string;

  /** Starting line number (for views/SPs that have source) */
  startLine: number;
  endLine: number;

  /** Additional properties as JSON object */
  metadata?: Record<string, unknown>;

  /** DDL / definition string (e.g., CREATE VIEW statement, column definition) */
  signature?: string;

  /** Comment / description */
  docstring?: string;

  /** When the node was last updated */
  updatedAt: number;
}

/**
 * An edge representing a relationship between two schema objects
 */
export interface Edge {
  /** Source node ID */
  source: string;

  /** Target node ID */
  target: string;

  /** Type of relationship */
  kind: EdgeKind;

  /** Additional context about the relationship */
  metadata?: Record<string, unknown>;

  /** How this edge was created */
  provenance?: 'introspect' | 'heuristic' | 'manual';
}

/**
 * Metadata about a tracked database
 */
export interface DbSourceRecord {
  /** Unique alias (as defined in config) */
  alias: string;

  /** Database engine type */
  engine: DbEngine;

  /** Database name */
  database: string;

  /** Host (for network DBs) */
  host?: string;

  /** Port */
  port?: number;

  /** Connection URI for display */
  displayUri: string;

  /** When last indexed */
  indexedAt: number;

  /** Number of nodes extracted from this source */
  nodeCount: number;

  /** Any extraction errors */
  errors?: string[];
}

// =============================================================================
// Extraction Types
// =============================================================================

/**
 * Result from introspecting a database
 */
export interface IntrospectResult {
  /** Extracted nodes */
  nodes: Node[];

  /** Extracted edges */
  edges: Edge[];

  /** Extraction duration in milliseconds */
  durationMs: number;

  /** Any errors during extraction */
  errors: string[];
}

/**
 * Database connection config (from config file)
 */
export interface DbConnectionConfig {
  /** Unique alias for this database */
  alias: string;

  /** Database engine */
  engine: DbEngine;

  /** Hostname or IP */
  host?: string;

  /** Port number */
  port?: number;

  /** Database name */
  database: string;

  /** Schemas to include (default: all) */
  schemas?: string[];

  /** Path for file-based DBs (SQLite) */
  path?: string;

  /** Authentication method */
  auth?: string;

  /** Authentication type for MSSQL: 'password' (default) or 'integrated' (Windows Auth) */
  authType?: 'password' | 'integrated';

  /** SSL settings */
  ssl?: boolean;

  /** TLS insecure mode (MongoDB): allow self-signed certificates */
  tlsInsecure?: boolean;

  /** Use mongodb+srv:// protocol (MongoDB Atlas). When true, port is ignored and TLS is forced. */
  srv?: boolean;

  /** MongoDB: auth database name (defaults to the target database if not set, commonly "admin") */
  authSource?: string;
}

// =============================================================================
// Query Types
// =============================================================================

/**
 * A subgraph containing a subset of the knowledge graph
 */
export interface Subgraph {
  /** Nodes in this subgraph */
  nodes: Map<string, Node>;

  /** Edges in this subgraph */
  edges: Edge[];

  /** Root node IDs (entry points) */
  roots: string[];
}

/**
 * Options for graph traversal
 */
export interface TraversalOptions {
  /** Maximum depth to traverse (default: Infinity) */
  maxDepth?: number;

  /** Edge types to follow (default: all) */
  edgeKinds?: EdgeKind[];

  /** Node types to include (default: all) */
  nodeKinds?: NodeKind[];

  /** Direction of traversal */
  direction?: 'outgoing' | 'incoming' | 'both';

  /** Maximum nodes to return */
  limit?: number;

  /** Whether to include the starting node */
  includeStart?: boolean;
}

/**
 * Options for searching the graph
 */
export interface SearchOptions {
  /** Node types to search */
  kinds?: NodeKind[];

  /** Source filter (db://@alias prefix) */
  source?: string;

  /** Maximum results to return */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Whether search is case-sensitive */
  caseSensitive?: boolean;
}

/**
 * A search result with relevance scoring
 */
export interface SearchResult {
  /** Matching node */
  node: Node;

  /** Relevance score (0-1) */
  score: number;

  /** Matched text snippets for highlighting */
  highlights?: string[];
}

// =============================================================================
// Context Types
// =============================================================================

/**
 * Context information for schema understanding
 */
export interface Context {
  /** Primary node being examined */
  focal: Node;

  /** Nodes containing the focal node (database, schema, table) */
  ancestors: Node[];

  /** Nodes directly contained by focal node */
  children: Node[];

  /** Incoming references (what references this node) */
  incomingRefs: Array<{ node: Node; edge: Edge }>;

  /** Outgoing references (what this node references) */
  outgoingRefs: Array<{ node: Node; edge: Edge }>;
}

/**
 * Full schema description for a table (composed from graph)
 */
export interface TableSchema {
  /** Table name */
  name: string;

  /** Qualified name */
  qualifiedName: string;

  /** Database source */
  source: string;

  /** Table comment */
  comment?: string;

  /** Columns */
  columns: ColumnSchema[];

  /** Primary key columns */
  primaryKey: string[];

  /** Foreign keys */
  foreignKeys: ForeignKeySchema[];

  /** Indexes */
  indexes: IndexSchema[];

  /** Table type (table, view) */
  kind: 'table' | 'view';

  /** View DDL if applicable */
  definition?: string;
}

/**
 * Column schema
 */
export interface ColumnSchema {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue?: string;
  isPrimaryKey: boolean;
  maxLength?: number;
  numericPrecision?: number;
  numericScale?: number;
  comment?: string;
  charSet?: string;
  collation?: string;
  autoIncrement?: boolean;
}

/**
 * Foreign key relationship
 */
export interface ForeignKeySchema {
  constraintName: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onUpdate?: string;
  onDelete?: string;
}

/**
 * Index information
 */
export interface IndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method?: string;
}

// =============================================================================
// Statistics
// =============================================================================

/**
 * Statistics about the knowledge graph
 */
export interface GraphStats {
  /** Total number of nodes */
  nodeCount: number;

  /** Total number of edges */
  edgeCount: number;

  /** Number of tracked databases */
  dbCount: number;

  /** Node counts by kind */
  nodesByKind: Record<string, number>;

  /** Edge counts by kind */
  edgesByKind: Record<string, number>;

  /** Database size in bytes */
  dbSizeBytes: number;

  /** Last update timestamp */
  lastUpdated: number;
}
