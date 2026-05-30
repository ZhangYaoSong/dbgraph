/**
 * MCP Engine
 *
 * Manages the DBGraph instance lifecycle and dispatches to the tool handler.
 *
 * One engine serves many sessions (direct stdio mode or daemon socket mode).
 * Initialization is lazy — started in the background on MCP initialize and
 * retried synchronously before the first tool call. This lets the MCP server
 * respond to initialize immediately without blocking on schema introspection.
 */

import { DBGraph } from '../index';
import { findNearestDBGraphRoot } from '../directory';
import { DBGraphToolHandler } from './tools';
import { SERVER_INSTRUCTIONS } from './server-instructions';
import { createConnection, DBConnection } from '../introspect/connection';
import type { ToolDefinition, ToolResult } from './tools';

/**
 * MCP Engine — shared state for one or more MCP sessions.
 */
export class MCPEngine {
  private dbgraph: DBGraph | null = null;
  private toolHandler: DBGraphToolHandler;
  private initPromise: Promise<void> | null = null;
  private projectPath: string | null = null;
  private closed = false;

  constructor() {
    // Pass a getter so the handler always reads the live instance.
    // The `!` assert is safe because the handler is only called after
    // ensureInitialized succeeds.
    this.toolHandler = new DBGraphToolHandler(() => this.dbgraph!);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Whether the default project's DBGraph is open and ready. */
  isReady(): boolean {
    return this.dbgraph !== null;
  }

  /** Get tool definitions. */
  getTools(): ToolDefinition[] {
    return this.toolHandler.getTools();
  }

  /** Get server instructions for the MCP initialize response. */
  getServerInstructions(): string {
    return SERVER_INSTRUCTIONS;
  }

  /** Get the underlying tool handler (for direct dispatch in server mode). */
  getToolHandler(): DBGraphToolHandler {
    return this.toolHandler;
  }

  /** The project root that was resolved on init (null if none). */
  getProjectPath(): string | null {
    return this.projectPath;
  }

  /**
   * Start initialization in the background (called from MCP initialize).
   *
   * Non-blocking — the engine will be ready by the time the first tool call
   * arrives thanks to ensureInitialized / retry logic in the session layer.
   * Multiple calls are idempotent; only the first starts the init flow.
   */
  startBackgroundInit(projectPath?: string): void {
    if (this.closed) return;
    if (this.dbgraph) return; // already initialized
    if (this.initPromise) return; // already in-flight

    const searchFrom = projectPath ?? process.cwd();
    this.projectPath = searchFrom;
    this.initPromise = this.doInitialize(searchFrom).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[DBGraph MCP] Background init failed: ${msg}\n`);
    });
  }

  /**
   * Ensure the DBGraph instance is initialized — called before every tool call.
   *
   * If background init already succeeded (or is in-flight), this returns
   * immediately (awaiting the in-flight promise if needed). If no background
   * init was started, it runs synchronously.
   *
   * Throws if initialization fails, which the session layer catches and
   * surfaces as an MCP error response.
   */
  async ensureInitialized(projectPath?: string): Promise<void> {
    if (this.closed) return;
    if (this.dbgraph) return;

    // If background init is running, await it
    if (this.initPromise) {
      await this.initPromise;
      // Retry once more if background init failed — the .dbgraph/ directory
      // may have appeared after the background attempt (user ran `dbgraph init`
      // in another terminal between listTools and tools/call).
      if (!this.dbgraph) {
        const searchFrom = projectPath ?? this.projectPath ?? process.cwd();
        this.projectPath = searchFrom;
        this.tryOpenSync(searchFrom);
      }
      if (this.dbgraph) return;
      throw new Error(
        `DBGraph not initialized. Searched from: ${projectPath ?? this.projectPath ?? process.cwd()}\n` +
        'Run `dbgraph init` in your project directory first, then point your ' +
        'MCP client to the project path.',
      );
    }

    // No background init was started — run synchronously now
    const searchFrom = projectPath ?? process.cwd();
    this.projectPath = searchFrom;
    this.tryOpenSync(searchFrom);

    if (!this.dbgraph) {
      throw new Error(
        `DBGraph not initialized. Searched from: ${searchFrom}\n` +
        'Run `dbgraph init` in your project directory to create the .dbgraph/ index.',
      );
    }
  }

  /**
   * Execute a tool by name.
   */
  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.toolHandler.execute(name, args);
  }

  /**
   * Full re-index of all configured databases.
   * Optionally store a schema fingerprint after success (for watch mode).
   */
  async executeReindex(fingerprint?: string): Promise<{
    sourcesIndexed: number;
    nodesCreated: number;
    edgesCreated: number;
    errors: string[];
  }> {
    if (!this.dbgraph) {
      throw new Error('DBGraph not initialized. Cannot re-index.');
    }
    const config = this.dbgraph.getConfig();
    if (!config || config.databases.length === 0) {
      throw new Error('No databases configured. Create a dbgraph-db.json file.');
    }
    const result = await this.dbgraph.indexAll();

    // Store fingerprint after successful re-index so next poll can compare
    if (fingerprint) {
      this.dbgraph.getQueryBuilder().setMetadata('schema_fingerprint', fingerprint);
    }

    return {
      sourcesIndexed: result.sourcesIndexed,
      nodesCreated: result.nodesCreated,
      edgesCreated: result.edgesCreated,
      errors: result.errors,
    };
  }

  /**
   * Check if the database schema changed by comparing a lightweight
   * fingerprint (column list hash) against the last known value.
   * Only supports MySQL/MariaDB for now.
   */
  async checkSchemaChanged(): Promise<{ changed: boolean; detail: string; currentFingerprint?: string }> {
    if (!this.dbgraph) return { changed: false, detail: 'No graph loaded' };

    const config = this.dbgraph.getConfig();
    if (!config || config.databases.length === 0) return { changed: false, detail: 'No databases configured' };

    const dbConfigs = config.databases.filter(d => d.engine === 'mysql' || d.engine === 'mariadb');
    if (dbConfigs.length === 0) return { changed: false, detail: 'No MySQL/MariaDB databases' };

    // Compute current fingerprint: for each DB, MD5 of all (table.column, type, nullable)
    const currentParts: string[] = [];

    for (const db of dbConfigs) {
      let conn: DBConnection | undefined;
      try {
        conn = await createConnection(db);
        const rows: Array<{ fingerprint: string }> = await conn.query(
          `SELECT MD5(GROUP_CONCAT(
            CONCAT_WS('.', TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE)
            ORDER BY TABLE_NAME, ORDINAL_POSITION
          )) AS fingerprint
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ?`,
          [db.database],
        );
        const fp = rows[0]?.fingerprint ?? '';
        currentParts.push(`${db.alias}=${fp}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        currentParts.push(`${db.alias}=ERROR:${msg}`);
      } finally {
        if (conn) await conn.close().catch(() => {});
      }
    }

    const currentFingerprint = currentParts.join('|');

    // Load last fingerprint from project metadata
    const lastFingerprint = this.dbgraph.getQueryBuilder().getMetadata('schema_fingerprint') ?? '';

    if (currentFingerprint === lastFingerprint) {
      return { changed: false, detail: 'Schema unchanged', currentFingerprint };
    }

    return { changed: true, detail: 'Schema changed: re-index required', currentFingerprint };
  }

  /**
   * Close the DBGraph instance and release resources.
   * Idempotent — safe to call multiple times.
   */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.dbgraph) {
      try {
        this.dbgraph.close();
      } catch {
        // Ignore close errors — resources may already be freed
      }
      this.dbgraph = null;
    }
    this.initPromise = null;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Background initialization — walks up from searchFrom to find .dbgraph/,
   * opens the database, and sets up the DBGraph instance.
   */
  private async doInitialize(searchFrom: string): Promise<void> {
    const resolvedRoot = findNearestDBGraphRoot(searchFrom);
    if (!resolvedRoot) {
      // No .dbgraph/ found — that's normal. The session layer will retry
      // on the first tool call, at which point the user may have run init.
      this.projectPath = searchFrom;
      return;
    }

    this.projectPath = resolvedRoot;
    try {
      this.dbgraph = await DBGraph.open(resolvedRoot);
      process.stderr.write(
        `[DBGraph MCP] Opened schema graph at ${resolvedRoot}\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[DBGraph MCP] Failed to open schema graph at ${resolvedRoot}: ${msg}\n`,
      );
      throw err;
    }
  }

  /**
   * Synchronous open used as a fallback retry when background init missed
   * a newly-created .dbgraph/ directory.
   */
  private tryOpenSync(searchFrom: string): void {
    try {
      const resolvedRoot = findNearestDBGraphRoot(searchFrom);
      if (!resolvedRoot) return;

      this.dbgraph = DBGraph.openSync(resolvedRoot);
      this.projectPath = resolvedRoot;
      process.stderr.write(
        `[DBGraph MCP] Opened schema graph at ${resolvedRoot}\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[DBGraph MCP] Sync open failed: ${msg}\n`);
      this.dbgraph = null;
    }
  }
}

