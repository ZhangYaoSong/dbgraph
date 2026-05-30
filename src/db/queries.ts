/**
 * Database Queries
 *
 * Prepared statements for CRUD operations on the database knowledge graph.
 */

import { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import {
  Node, Edge, NodeKind, EdgeKind, DbSourceRecord,
  GraphStats, SearchOptions, SearchResult,
} from '../types';
import { safeJsonParse } from '../utils';

// =============================================================================
// Row types (snake_case from SQLite)
// =============================================================================

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  docstring: string | null;
  signature: string | null;
  metadata: string | null;
  updated_at: number;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  provenance: string | null;
}

interface DbSourceRow {
  alias: string;
  engine: string;
  database: string;
  host: string | null;
  port: number | null;
  display_uri: string;
  indexed_at: number;
  node_count: number;
  errors: string | null;
}

// =============================================================================
// Row converters
// =============================================================================

function rowToNode(row: NodeRow): Node {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language,
    startLine: row.start_line,
    endLine: row.end_line,
    docstring: row.docstring ?? undefined,
    signature: row.signature ?? undefined,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
    updatedAt: row.updated_at,
  };
}

function rowToEdge(row: EdgeRow): Edge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
    provenance: row.provenance as Edge['provenance'],
  };
}

function rowToDbSource(row: DbSourceRow): DbSourceRecord {
  return {
    alias: row.alias,
    engine: row.engine as DbSourceRecord['engine'],
    database: row.database,
    host: row.host ?? undefined,
    port: row.port ?? undefined,
    displayUri: row.display_uri,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    errors: row.errors ? safeJsonParse(row.errors, undefined) : undefined,
  };
}

// =============================================================================
// QueryBuilder
// =============================================================================

export class QueryBuilder {
  private db: SqliteDatabase;
  private nodeCache: Map<string, Node> = new Map();
  private readonly maxCacheSize = 1000;

  private stmts: Record<string, SqliteStatement | undefined> = {};

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  insertNode(node: Node): void {
    if (!this.stmts.insertNode) {
      this.stmts.insertNode = this.db.prepare(`
        INSERT OR REPLACE INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, docstring, signature, metadata, updated_at
        ) VALUES (
          @id, @kind, @name, @qualifiedName, @filePath, @language,
          @startLine, @endLine, @docstring, @signature, @metadata, @updatedAt
        )
      `);
    }
    if (!node.id || !node.kind || !node.name || !node.filePath) return;

    this.nodeCache.delete(node.id);
    this.stmts.insertNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language ?? 'unknown',
      startLine: node.startLine ?? 0,
      endLine: node.endLine ?? 0,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      metadata: node.metadata ? JSON.stringify(node.metadata) : null,
      updatedAt: node.updatedAt ?? Date.now(),
    });
  }

  insertNodes(nodes: Node[]): void {
    for (const node of nodes) this.insertNode(node);
  }

  deleteNodesBySource(source: string): void {
    if (!this.stmts.deleteNodesBySource) {
      this.stmts.deleteNodesBySource = this.db.prepare(
        'DELETE FROM nodes WHERE file_path LIKE ?'
      );
    }
    // Invalidate cache for nodes matching this source
    for (const [id, node] of this.nodeCache) {
      if (node.filePath.startsWith(source)) this.nodeCache.delete(id);
    }
    this.stmts.deleteNodesBySource.run(`${source}%`);
  }

  getNodeById(id: string): Node | null {
    if (this.nodeCache.has(id)) {
      const cached = this.nodeCache.get(id)!;
      this.nodeCache.delete(id);
      this.nodeCache.set(id, cached);
      return cached;
    }
    if (!this.stmts.getNodeById) {
      this.stmts.getNodeById = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    }
    const row = this.stmts.getNodeById.get(id) as NodeRow | undefined;
    if (!row) return null;
    const node = rowToNode(row);
    this.cacheNode(node);
    return node;
  }

  getNodesByIds(ids: readonly string[]): Map<string, Node> {
    const out = new Map<string, Node>();
    if (ids.length === 0) return out;

    const misses: string[] = [];
    for (const id of ids) {
      const cached = this.nodeCache.get(id);
      if (cached !== undefined) {
        this.nodeCache.delete(id);
        this.nodeCache.set(id, cached);
        out.set(id, cached);
      } else {
        misses.push(id);
      }
    }
    if (misses.length === 0) return out;

    const CHUNK = 500;
    for (let i = 0; i < misses.length; i += CHUNK) {
      const chunk = misses.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
        .all(...chunk) as NodeRow[];
      for (const row of rows) {
        const node = rowToNode(row);
        out.set(node.id, node);
        this.cacheNode(node);
      }
    }
    return out;
  }

  private cacheNode(node: Node): void {
    if (this.nodeCache.size >= this.maxCacheSize) {
      const firstKey = this.nodeCache.keys().next().value;
      if (firstKey) this.nodeCache.delete(firstKey);
    }
    this.nodeCache.set(node.id, node);
  }

  clearCache(): void { this.nodeCache.clear(); }

  getNodesByKind(kind: NodeKind): Node[] {
    if (!this.stmts.getNodesByKind) {
      this.stmts.getNodesByKind = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
    }
    return (this.stmts.getNodesByKind.all(kind) as NodeRow[]).map(rowToNode);
  }

  getNodesByName(name: string): Node[] {
    if (!this.stmts.getNodesByName) {
      this.stmts.getNodesByName = this.db.prepare('SELECT * FROM nodes WHERE name = ?');
    }
    return (this.stmts.getNodesByName.all(name) as NodeRow[]).map(rowToNode);
  }

  getNodesByQualifiedName(qualifiedName: string): Node[] {
    if (!this.stmts.getNodesByQualifiedName) {
      this.stmts.getNodesByQualifiedName = this.db.prepare(
        'SELECT * FROM nodes WHERE qualified_name = ?'
      );
    }
    return (this.stmts.getNodesByQualifiedName.all(qualifiedName) as NodeRow[]).map(rowToNode);
  }

  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    const { kinds, source, limit = 100, offset = 0 } = options;

    // FTS5 prefix search
    const ftsQuery = query
      .replace(/['"*():^]/g, '')
      .split(/\s+/)
      .filter(t => t.length > 0)
      .filter(t => !/^(AND|OR|NOT|NEAR)$/i.test(t))
      .map(t => `"${t}"*`)
      .join(' OR ');

    if (!ftsQuery) return [];

    const ftsLimit = Math.max(limit * 5, 100);

    let sql = `
      SELECT nodes.*, bm25(nodes_fts, 0, 20, 5, 1) as score
      FROM nodes_fts
      JOIN nodes ON nodes_fts.id = nodes.id
      WHERE nodes_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (kinds && kinds.length > 0) {
      sql += ` AND nodes.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (source) {
      sql += ` AND nodes.file_path LIKE ?`;
      params.push(`${source}%`);
    }

    sql += ' ORDER BY score LIMIT ? OFFSET ?';
    params.push(ftsLimit, offset);

    try {
      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      return rows.map(row => ({ node: rowToNode(row), score: Math.abs(row.score) }));
    } catch {
      // FTS query failed — try LIKE fallback
      return this.searchNodesLike(query, options);
    }
  }

  private searchNodesLike(query: string, options: SearchOptions): SearchResult[] {
    const { kinds, source, limit = 100 } = options;
    // Escape LIKE wildcards so `user_id` doesn't match `userXid`
    const esc = (s: string) => s.replace(/[%_]/g, '\\$&');
    const escaped = esc(query);
    const likeEsc = ` LIKE ? ESCAPE '\\'`;
    let sql = `
      SELECT nodes.*,
        CASE
          WHEN name = ? THEN 1.0
          WHEN name${likeEsc} THEN 0.9
          WHEN name${likeEsc} THEN 0.8
          WHEN qualified_name${likeEsc} THEN 0.7
          ELSE 0.5
        END as score
      FROM nodes
      WHERE (name${likeEsc} OR qualified_name${likeEsc} OR name${likeEsc})
    `;
    const pPrefix = `${escaped}%`;
    const pContain = `%${escaped}%`;
    const params: (string | number)[] = [
      query, pPrefix, pContain, pContain,
      pContain, pContain, pPrefix,
    ];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    if (source) {
      sql += ' AND file_path LIKE ?';
      params.push(`${source}%`);
    }

    sql += ' ORDER BY score DESC, length(name) ASC LIMIT ?';
    params.push(limit);

    return (this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[])
      .map(row => ({ node: rowToNode(row), score: row.score }));
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  insertEdge(edge: Edge): void {
    if (!this.stmts.insertEdge) {
      this.stmts.insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, kind, metadata, provenance)
        VALUES (@source, @target, @kind, @metadata, @provenance)
      `);
    }
    this.stmts.insertEdge.run({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      provenance: edge.provenance ?? null,
    });
  }

  insertEdges(edges: Edge[]): void {
    if (edges.length === 0) return;
    for (const edge of edges) this.insertEdge(edge);
  }

  deleteEdgesBySource(sourceId: string): void {
    if (!this.stmts.deleteEdgesBySource) {
      this.stmts.deleteEdgesBySource = this.db.prepare('DELETE FROM edges WHERE source = ?');
    }
    this.stmts.deleteEdgesBySource.run(sourceId);
  }

  deleteEdgesByTarget(targetId: string): void {
    if (!this.stmts.deleteEdgesByTarget) {
      this.stmts.deleteEdgesByTarget = this.db.prepare('DELETE FROM edges WHERE target = ?');
    }
    this.stmts.deleteEdgesByTarget.run(targetId);
  }

  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[]): Edge[] {
    if (kinds && kinds.length > 0) {
      const sql = `SELECT * FROM edges WHERE source = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
      return (this.db.prepare(sql).all(sourceId, ...kinds) as EdgeRow[]).map(rowToEdge);
    }
    if (!this.stmts.getEdgesBySource) {
      this.stmts.getEdgesBySource = this.db.prepare('SELECT * FROM edges WHERE source = ?');
    }
    return (this.stmts.getEdgesBySource.all(sourceId) as EdgeRow[]).map(rowToEdge);
  }

  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    if (kinds && kinds.length > 0) {
      const sql = `SELECT * FROM edges WHERE target = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
      return (this.db.prepare(sql).all(targetId, ...kinds) as EdgeRow[]).map(rowToEdge);
    }
    if (!this.stmts.getEdgesByTarget) {
      this.stmts.getEdgesByTarget = this.db.prepare('SELECT * FROM edges WHERE target = ?');
    }
    return (this.stmts.getEdgesByTarget.all(targetId) as EdgeRow[]).map(rowToEdge);
  }

  findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
    if (nodeIds.length === 0) return [];
    const idsJson = JSON.stringify(nodeIds);
    let sql = `SELECT * FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?))`;
    const params: string[] = [idsJson, idsJson];
    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    return (this.db.prepare(sql).all(...params) as EdgeRow[]).map(rowToEdge);
  }

  // ===========================================================================
  // DB Source Operations
  // ===========================================================================

  upsertDbSource(source: DbSourceRecord): void {
    if (!this.stmts.upsertDbSource) {
      this.stmts.upsertDbSource = this.db.prepare(`
        INSERT INTO db_sources (alias, engine, database, host, port, display_uri, indexed_at, node_count, errors)
        VALUES (@alias, @engine, @database, @host, @port, @displayUri, @indexedAt, @nodeCount, @errors)
        ON CONFLICT(alias) DO UPDATE SET
          engine = @engine, database = @database, host = @host, port = @port,
          display_uri = @displayUri, indexed_at = @indexedAt, node_count = @nodeCount, errors = @errors
      `);
    }
    this.stmts.upsertDbSource.run({
      alias: source.alias,
      engine: source.engine,
      database: source.database,
      host: source.host ?? null,
      port: source.port ?? null,
      displayUri: source.displayUri,
      indexedAt: source.indexedAt,
      nodeCount: source.nodeCount,
      errors: source.errors ? JSON.stringify(source.errors) : null,
    });
  }

  getDbSource(alias: string): DbSourceRecord | null {
    if (!this.stmts.getDbSource) {
      this.stmts.getDbSource = this.db.prepare('SELECT * FROM db_sources WHERE alias = ?');
    }
    const row = this.stmts.getDbSource.get(alias) as DbSourceRow | undefined;
    return row ? rowToDbSource(row) : null;
  }

  getAllDbSources(): DbSourceRecord[] {
    if (!this.stmts.getAllDbSources) {
      this.stmts.getAllDbSources = this.db.prepare('SELECT * FROM db_sources ORDER BY alias');
    }
    return (this.stmts.getAllDbSources.all() as DbSourceRow[]).map(rowToDbSource);
  }

  deleteDbSource(alias: string): void {
    if (!this.stmts.deleteDbSource) {
      this.stmts.deleteDbSource = this.db.prepare('DELETE FROM db_sources WHERE alias = ?');
    }
    this.stmts.deleteDbSource.run(alias);
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  getNodeAndEdgeCount(): { nodes: number; edges: number } {
    return this.db
      .prepare('SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM edges) AS edges')
      .get() as { nodes: number; edges: number };
  }

  getStats(): GraphStats {
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT COUNT(*) FROM db_sources) AS db_count
    `).get() as { node_count: number; edge_count: number; db_count: number };

    const nodesByKind: Record<string, number> = {};
    const nodeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of nodeKindRows) nodesByKind[row.kind] = row.count;

    const edgesByKind: Record<string, number> = {};
    const edgeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM edges GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of edgeKindRows) edgesByKind[row.kind] = row.count;

    const lastIndexed = this.db
      .prepare('SELECT MAX(indexed_at) AS ts FROM db_sources')
      .get() as { ts: number | null } | undefined;

    return {
      nodeCount: counts.node_count,
      edgeCount: counts.edge_count,
      dbCount: counts.db_count ?? 0,
      nodesByKind,
      edgesByKind,
      dbSizeBytes: 0,
      lastUpdated: lastIndexed?.ts ?? 0,
    };
  }

  clear(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM edges');
      this.db.exec('DELETE FROM nodes');
      this.db.exec('DELETE FROM db_sources');
    })();
    this.nodeCache.clear();
  }

  getMetadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setMetadata(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO project_metadata (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }
}
