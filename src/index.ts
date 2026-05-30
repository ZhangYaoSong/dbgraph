/**
 * DBGraph
 *
 * Database knowledge graph — introspect database schemas into a local
 * knowledge graph and expose it over MCP for LLM-powered SQL generation.
 */

import * as path from 'path';
import {
  Node, Edge, SearchOptions, SearchResult, GraphStats,
  IntrospectResult, DbConnectionConfig, DbSourceRecord,
  TableSchema,
} from './types';
import { DatabaseConnection, getDatabasePath } from './db';
import { QueryBuilder } from './db/queries';
import {
  isInitialized, createDirectory, removeDirectory, validateDirectory,
  findNearestDBGraphRoot,
} from './directory';
import { GraphTraverser } from './graph/traversal';
import { ContextBuilder } from './context';
import { createIntrospector } from './introspect';
import { loadConfig, findConfigFile, DBGraphConfig, CONFIG_FILENAME } from './config';
import { Mutex, FileLock } from './utils';
import { MCPServer } from './mcp';

// Re-exports
export * from './types';
export { getDatabasePath } from './db';
export { getDBGraphDir, isInitialized, findNearestDBGraphRoot, DBGRAPH_DIR } from './directory';
export { MCPServer } from './mcp';

const LOCK_TIMEOUT_MS = 30000;

/**
 * Constructor options for DBGraph
 */
export interface InitOptions {
  /** Path to dbgraph-db.json config file */
  config?: string;
  /** Whether to run initial indexing after init */
  index?: boolean;
  /** Progress callback */
  onProgress?: (msg: string, current: number, total: number) => void;
}

export interface OpenOptions {
  /** Whether to run sync if sources have changed */
  sync?: boolean;
  /** Read-only mode */
  readOnly?: boolean;
}

export interface IndexOptions {
  /** Progress callback */
  onProgress?: (msg: string, current: number, total: number) => void;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Main DBGraph class
 */
export class DBGraph {
  private db: DatabaseConnection;
  private queries: QueryBuilder;
  private projectRoot: string;
  private traverser: GraphTraverser;
  private contextBuilder: ContextBuilder;
  private config: DBGraphConfig | null = null;

  // Mutex + file lock for concurrent safety
  private indexMutex = new Mutex();
  private fileLock: FileLock;

  private constructor(db: DatabaseConnection, queries: QueryBuilder, projectRoot: string) {
    this.db = db;
    this.queries = queries;
    this.projectRoot = projectRoot;
    this.fileLock = new FileLock(path.join(projectRoot, '.dbgraph', 'dbgraph.lock'));
    this.traverser = new GraphTraverser(queries);
    this.contextBuilder = new ContextBuilder(projectRoot, queries, this.traverser);
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Initialize a new DBGraph project
   */
  static async init(projectRoot: string, options: InitOptions = {}): Promise<DBGraph> {
    const resolvedRoot = path.resolve(projectRoot);

    if (isInitialized(resolvedRoot)) {
      throw new Error(`DBGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new DBGraph(db, queries, resolvedRoot);

    // Load config if specified or auto-discover
    const configPath = options.config || findConfigFile(resolvedRoot);
    if (configPath) {
      instance.config = loadConfig(configPath);
    }

    // Run initial indexing if requested
    if (options.index) {
      await instance.indexAll({ onProgress: options.onProgress });
    }

    return instance;
  }

  /**
   * Initialize synchronously (no indexing)
   */
  static initSync(projectRoot: string): DBGraph {
    const resolvedRoot = path.resolve(projectRoot);
    if (isInitialized(resolvedRoot)) {
      throw new Error(`DBGraph already initialized in ${resolvedRoot}`);
    }
    createDirectory(resolvedRoot);
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());
    return new DBGraph(db, queries, resolvedRoot);
  }

  /**
   * Open an existing DBGraph project
   */
  static async open(projectRoot: string, options: OpenOptions = {}): Promise<DBGraph> {
    const resolvedRoot = path.resolve(projectRoot);
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`DBGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid DBGraph directory: ${validation.errors.join(', ')}`);
    }

    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new DBGraph(db, queries, resolvedRoot);

    // Load config
    const configPath = findConfigFile(resolvedRoot);
    if (configPath) {
      instance.config = loadConfig(configPath);
    }

    if (options.sync) {
      await instance.sync();
    }

    return instance;
  }

  /**
   * Open synchronously
   */
  static openSync(projectRoot: string): DBGraph {
    const resolvedRoot = path.resolve(projectRoot);
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`DBGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid DBGraph directory: ${validation.errors.join(', ')}`);
    }
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());
    const instance = new DBGraph(db, queries, resolvedRoot);
    const configPath = findConfigFile(resolvedRoot);
    if (configPath) {
      instance.config = loadConfig(configPath);
    }
    return instance;
  }

  static isInitialized(projectRoot: string): boolean {
    return isInitialized(path.resolve(projectRoot));
  }

  close(): void {
    this.fileLock.release();
    this.db.close();
  }

  getProjectRoot(): string { return this.projectRoot; }

  getConfig(): DBGraphConfig | null { return this.config; }

  /**
   * Set or update the configuration
   */
  setConfig(config: DBGraphConfig): void {
    this.config = config;
  }

  // ===========================================================================
  // Introspection / Indexing
  // ===========================================================================

  /**
   * Index all configured databases
   */
  async indexAll(options: IndexOptions = {}): Promise<{
    success: boolean;
    sourcesIndexed: number;
    nodesCreated: number;
    edgesCreated: number;
    errors: string[];
  }> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, sourcesIndexed: 0, nodesCreated: 0, edgesCreated: 0, errors: ['Could not acquire file lock'] };
      }

      try {
        if (!this.config || this.config.databases.length === 0) {
          return { success: false, sourcesIndexed: 0, nodesCreated: 0, edgesCreated: 0, errors: ['No databases configured. Create a dbgraph-db.json file.'] };
        }

        const before = this.queries.getNodeAndEdgeCount();
        let totalSources = this.config.databases.length;
        let sourcesIndexed = 0;
        let errors: string[] = [];

        for (const dbConfig of this.config.databases) {

          options.onProgress?.(`Introspecting ${dbConfig.alias} (${dbConfig.engine})...`, sourcesIndexed + 1, totalSources);

          try {
            const introspector = createIntrospector(dbConfig);
            const result = await introspector.extractAll();

            if (result.errors.length > 0) {
              errors.push(...result.errors.map(e => `[${dbConfig.alias}] ${e}`));
            }

            // Store in database
            if (result.nodes.length > 0) {
              this.db.transaction(() => {
                // Remove old data for this source
                this.queries.deleteNodesBySource(`db://@${dbConfig.alias}`);

                // Insert new data
                this.queries.insertNodes(result.nodes);
                this.queries.insertEdges(result.edges);
              });

              // Upsert db source record
              this.queries.upsertDbSource({
                alias: dbConfig.alias,
                engine: dbConfig.engine,
                database: dbConfig.database,
                host: dbConfig.host,
                port: dbConfig.port,
                displayUri: introspector.getDisplayUri(),
                indexedAt: Date.now(),
                nodeCount: result.nodes.length,
                errors: result.errors.length > 0 ? result.errors : undefined,
              });
            }

            sourcesIndexed++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`[${dbConfig.alias}] ${msg}`);
          }
        }

        // Run maintenance after bulk writes
        this.db.runMaintenance();

        const after = this.queries.getNodeAndEdgeCount();

        options.onProgress?.('Done.', totalSources, totalSources);

        return {
          success: errors.length === 0,
          sourcesIndexed,
          nodesCreated: after.nodes - before.nodes,
          edgesCreated: after.edges - before.edges,
          errors,
        };
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Sync with current database state (re-index)
   */
  async sync(options: IndexOptions = {}): Promise<{
    sourcesChecked: number;
    sourcesReindexed: number;
  }> {
    // For V1, sync == re-index all (incremental sync via hashing is future work)
    const result = await this.indexAll(options);
    return {
      sourcesChecked: result.sourcesIndexed,
      sourcesReindexed: result.sourcesIndexed,
    };
  }

  /**
   * Test connections to all configured databases
   */
  async testConnections(): Promise<Array<{ alias: string; success: boolean; error?: string }>> {
    if (!this.config) return [];
    const results: Array<{ alias: string; success: boolean; error?: string }> = [];

    for (const dbConfig of this.config.databases) {
      try {
        const introspector = createIntrospector(dbConfig);
        const ok = await introspector.testConnection();
        results.push({ alias: dbConfig.alias, success: ok });
      } catch (err) {
        results.push({
          alias: dbConfig.alias,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  // ===========================================================================
  // Graph Queries
  // ===========================================================================

  /**
   * Search schema objects by name
   */
  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    return this.queries.searchNodes(query, options);
  }

  /**
   * Get a node by ID
   */
  getNode(id: string): Node | null {
    return this.queries.getNodeById(id);
  }

  /**
   * Get nodes of a specific kind
   */
  getNodesByKind(kind: Node['kind']): Node[] {
    return this.queries.getNodesByKind(kind);
  }

  /**
   * Get nodes by exact name
   */
  getNodesByName(name: string): Node[] {
    return this.queries.getNodesByName(name);
  }

  /**
   * Build a complete table schema description from the graph
   */
  getTableSchema(nodeId: string): Promise<TableSchema> {
    return this.contextBuilder.getTableSchema(nodeId);
  }

  /**
   * Build full context for a table as markdown
   */
  async buildContext(name: string): Promise<string> {
    return this.contextBuilder.buildContext(name);
  }

  /**
   * Get outgoing edges (table → columns, FK references)
   */
  getOutgoingEdges(nodeId: string, kinds?: Edge['kind'][]): Edge[] {
    return this.queries.getOutgoingEdges(nodeId, kinds);
  }

  /**
   * Get incoming edges (what references this node)
   */
  getIncomingEdges(nodeId: string, kinds?: Edge['kind'][]): Edge[] {
    return this.queries.getIncomingEdges(nodeId, kinds);
  }

  /**
   * Find FK path between two tables
   */
  findForeignKeyPath(fromName: string, toName: string): Array<{ node: Node; edge: Edge | null }> | null {
    const fromNodes = this.queries.searchNodes(fromName, { kinds: ['table'], limit: 5 });
    const toNodes = this.queries.searchNodes(toName, { kinds: ['table'], limit: 5 });

    if (fromNodes.length === 0 || toNodes.length === 0) return null;

    return this.traverser.findPath(
      fromNodes[0]!.node.id,
      toNodes[0]!.node.id,
      ['references', 'foreign_key', 'contains'],
    );
  }

  /**
   * Get all databases tracked in the graph
   */
  getSources(): DbSourceRecord[] {
    return this.queries.getAllDbSources();
  }

  /**
   * Get graph statistics
   */
  getStats(): GraphStats {
    const stats = this.queries.getStats();
    stats.dbSizeBytes = this.db.getSize();
    return stats;
  }

  // ===========================================================================
  // MCP Server
  // ===========================================================================

  /**
   * Create an MCP server for this project
   */
  createMCPServer(): MCPServer {
    return new MCPServer({ projectPath: this.projectRoot });
  }

  /**
   * Get the underlying QueryBuilder (for advanced use)
   */
  getQueryBuilder(): QueryBuilder {
    return this.queries;
  }

  /**
   * Get the underlying GraphTraverser (for advanced use)
   */
  getTraverser(): GraphTraverser {
    return this.traverser;
  }

  /**
   * Get the underlying ContextBuilder (for advanced use)
   */
  getContextBuilder(): ContextBuilder {
    return this.contextBuilder;
  }

  /**
   * Get the database journal mode
   */
  getJournalMode(): string {
    return this.db.getJournalMode();
  }

  /**
   * Optimize database
   */
  optimize(): void {
    this.db.optimize();
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.queries.clear();
  }

  /**
   * Completely remove DBGraph from the project
   */
  uninitialize(): void {
    this.close();
    removeDirectory(this.projectRoot);
  }
}

export default DBGraph;
