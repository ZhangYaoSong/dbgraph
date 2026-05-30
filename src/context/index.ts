/**
 * Context Builder
 *
 * Builds rich schema context from the database knowledge graph.
 * Composes table schemas, relationship chains, and formats them
 * as markdown for LLM consumption.
 */

import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from '../graph/traversal';
import {
  Node,
  Edge,
  EdgeKind,
  TableSchema,
  ColumnSchema,
  ForeignKeySchema,
  IndexSchema,
} from '../types';

// =============================================================================
// ContextBuilder
// =============================================================================

export class ContextBuilder {
  /**
   * @param projectRoot - Root path of the project (used for resolving .dbgraph/)
   * @param queries     - QueryBuilder instance for raw lookups
   * @param traverser   - GraphTraverser instance for BFS / ancestor / child queries
   */
  constructor(
    private readonly projectRoot: string,
    private readonly queries: QueryBuilder,
    private readonly traverser: GraphTraverser,
  ) {}

  // ---------------------------------------------------------------------------
  // getTableSchema
  // ---------------------------------------------------------------------------

  /**
   * Build a complete TableSchema description from the graph.
   *
   * Resolution steps:
   *  1. Fetch the table / view node.
   *  2. Fetch child nodes via `contains` edges — separate columns from indexes.
   *  3. Identify primary-key columns via `primary_key` edges.
   *  4. Identify foreign-key columns via `references` edges on each column.
   *  5. Collect index metadata from child index nodes.
   *  6. Collect FK constraints via `foreign_key` edges and incoming `references`.
   *  7. Assemble and return a TableSchema.
   *
   * @param nodeId - The graph node ID of the table or view.
   */
  async getTableSchema(nodeId: string): Promise<TableSchema> {
    // ---- 1. Fetch the focal node -------------------------------------------
    const tableNode = this.queries.getNodeById(nodeId);
    if (!tableNode) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    if (tableNode.kind !== 'table' && tableNode.kind !== 'view') {
      throw new Error(
        `Expected table or view node, got "${tableNode.kind}" (${nodeId})`,
      );
    }

    // ---- 2. Children: columns + indexes + constraints -----------------------
    const children = this.traverser.getChildren(nodeId);
    const columnNodes: Node[] = [];
    const indexNodes: Node[] = [];
    const constraintNodes: Node[] = [];

    for (const child of children) {
      switch (child.kind) {
        case 'column':
          columnNodes.push(child);
          break;
        case 'index':
          indexNodes.push(child);
          break;
        case 'constraint':
        case 'foreign_key':
          constraintNodes.push(child);
          break;
        // ignore other child kinds (triggers, sequences, etc.)
      }
    }

    // ---- 3. Primary-key columns ---------------------------------------------
    const pkEdges = this.queries.getOutgoingEdges(nodeId, ['primary_key']);
    const pkColumnIds = new Set<string>(pkEdges.map((e) => e.target));

    // ---- 4. Foreign-key references from columns ------------------------------
    // `references` edges originate at foreign-key columns and point at
    // referenced columns. We need the referenced column → its parent table.
    const fkColumnMap = new Map<string, { refColumnId: string }>();
    for (const col of columnNodes) {
      const refs = this.queries.getOutgoingEdges(col.id, ['references']);
      for (const ref of refs) {
        fkColumnMap.set(col.id, { refColumnId: ref.target });
      }
    }

    // Resolve referenced column → parent table lookups in a single batch.
    const refColumnIds = [...new Set([...fkColumnMap.values()].map((v) => v.refColumnId))];
    const refColumnNodes =
      refColumnIds.length > 0
        ? this.queries.getNodesByIds(refColumnIds)
        : new Map<string, Node>();

    // For each referenced column, find its parent table via incoming `contains`.
    const refTableCache = new Map<string, Node | null>();
    function resolveRefTable(
      colId: string,
      queries: QueryBuilder,
    ): Node | null {
      if (refTableCache.has(colId)) return refTableCache.get(colId) ?? null;
      const parents = queries.getIncomingEdges(colId, ['contains']);
      for (const p of parents) {
        const pNode = queries.getNodeById(p.source);
        if (pNode && (pNode.kind === 'table' || pNode.kind === 'view')) {
          refTableCache.set(colId, pNode);
          return pNode;
        }
      }
      refTableCache.set(colId, null);
      return null;
    }

    // ---- 5. Indexes ---------------------------------------------------------
    const indexes: IndexSchema[] = [];
    for (const idx of indexNodes) {
      const meta = idx.metadata ?? {};
      const idxCols: string[] = Array.isArray(meta.columns)
        ? (meta.columns as string[])
        : this._getIndexedColumnNames(idx, columnNodes);

      indexes.push({
        name: idx.name,
        columns: idxCols,
        unique: (meta.unique as boolean) ?? false,
        primary: (meta.primary as boolean) ?? false,
        method: (meta.method as string) ?? undefined,
      });
    }

    // ---- 6. Foreign-key constraints -----------------------------------------
    const foreignKeys: ForeignKeySchema[] = [];

    // 6a. Direct foreign_key edges (table → table constraint nodes)
    const fkConstraintEdges = this.queries.getOutgoingEdges(nodeId, ['foreign_key']);
    for (const fkEdge of fkConstraintEdges) {
      const fkNode = this.queries.getNodeById(fkEdge.target);
      if (!fkNode) continue;
      const meta = fkNode.metadata ?? {};

      foreignKeys.push({
        constraintName: fkNode.name,
        columns: Array.isArray(meta.columns)
          ? (meta.columns as string[])
          : [],
        referencedTable:
          (meta.referencedTable as string) ?? fkNode.qualifiedName,
        referencedColumns: Array.isArray(meta.referencedColumns)
          ? (meta.referencedColumns as string[])
          : [],
        onDelete: (meta.onDelete as string) ?? undefined,
        onUpdate: (meta.onUpdate as string) ?? undefined,
      });
    }

    // 6b. Derive FK info from column-level `references` edges when no
    //     constraint node exists.
    for (const col of columnNodes) {
      const entry = fkColumnMap.get(col.id);
      if (!entry) continue;

      const refColNode = refColumnNodes.get(entry.refColumnId);
      if (!refColNode) continue;

      const refTable = resolveRefTable(
        refColNode.id,
        this.queries,
      );

      // Avoid duplicating a constraint that was already captured above.
      const refTableName = refTable?.qualifiedName ?? refColNode.qualifiedName;
      const alreadyAdded = foreignKeys.some(
        (fk) =>
          fk.columns.length === 1 &&
          fk.columns[0] === col.name &&
          fk.referencedTable === refTableName,
      );
      if (alreadyAdded) continue;

      // Name derived from column name and referenced table
      const constraintName = `fk_${tableNode.name}_${col.name}`;

      foreignKeys.push({
        constraintName,
        columns: [col.name],
        referencedTable: refTableName,
        referencedColumns: [refColNode.name],
        onDelete: undefined,
        onUpdate: undefined,
      });
    }

    // ---- 7. Assemble columns ------------------------------------------------
    const primaryKeyColumns = columnNodes
      .filter((c) => pkColumnIds.has(c.id))
      .map((c) => c.name);

    const columns: ColumnSchema[] = columnNodes.map((col) => {
      const meta = col.metadata ?? {};
      const fkEntry = fkColumnMap.get(col.id);

      return {
        name: col.name,
        dataType: this._columnDataType(col, meta),
        isNullable: this._columnIsNullable(col, meta),
        defaultValue: this._columnDefault(col, meta),
        isPrimaryKey: pkColumnIds.has(col.id),
        maxLength: (meta.maxLength as number) ?? undefined,
        numericPrecision: (meta.numericPrecision as number) ?? undefined,
        numericScale: (meta.numericScale as number) ?? undefined,
        comment: col.docstring,
        charSet: (meta.charSet as string) ?? undefined,
        collation: (meta.collation as string) ?? undefined,
        autoIncrement: (meta.autoIncrement as boolean) ?? undefined,
      };
    });

    // ---- 8. Return ----------------------------------------------------------
    return {
      name: tableNode.name,
      qualifiedName: tableNode.qualifiedName,
      source: tableNode.filePath,
      comment: tableNode.docstring,
      columns,
      primaryKey: primaryKeyColumns,
      foreignKeys,
      indexes,
      kind: tableNode.kind === 'view' ? 'view' : 'table',
      definition: tableNode.signature ?? undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // buildContext
  // ---------------------------------------------------------------------------

  /**
   * Build a markdown context string for a table or view.
   *
   * Accepts either:
   *  - A graph node ID (exact `id` lookup)
   *  - A qualified or simple name (searched via `searchNodes`)
   *
   * The output includes:
   *  - Full table schema (columns, PKs, FKs, indexes)
   *  - Parent hierarchy (database → schema → table)
   *  - Tables that reference this table (incoming FK relationships)
   *
   * @param tableNameOrId - Table name, qualified name, or graph node ID.
   */
  async buildContext(tableNameOrId: string): Promise<string> {
    // ------------------------------------------------------------------
    // 1. Resolve node
    // ------------------------------------------------------------------
    let tableNode: Node | null = this.queries.getNodeById(tableNameOrId);

    if (!tableNode) {
      // Try qualified-name lookup first, then fall back to full-text search
      const exact = this.queries.getNodesByQualifiedName(tableNameOrId);
      if (exact.length > 0) {
        tableNode = exact[0]!;
      } else {
        const results = this.queries.searchNodes(tableNameOrId, {
          kinds: ['table', 'view'],
          limit: 10,
        });
        // Pick the highest-scoring table/view
        const match = results.find((r) =>
          r.node.kind === 'table' || r.node.kind === 'view',
        );
        if (!match) {
          return `**Error:** No table or view found matching "${tableNameOrId}".`;
        }
        tableNode = match.node;
      }
    }

    if (tableNode.kind !== 'table' && tableNode.kind !== 'view') {
      return `**Error:** "${tableNode.name}" is a **${tableNode.kind}**, not a table or view.`;
    }

    // ------------------------------------------------------------------
    // 2. Build TableSchema
    // ------------------------------------------------------------------
    const schema = await this.getTableSchema(tableNode.id);

    // ------------------------------------------------------------------
    // 3. Ancestor chain (database → schema → table)
    // ------------------------------------------------------------------
    const ancestors = this.traverser.getAncestors(tableNode.id);
    const hierarchy = ancestors
      .filter((a) => a.kind === 'database' || a.kind === 'schema')
      .map((a) => `${a.kind}: ${a.name}`);

    // ------------------------------------------------------------------
    // 4. Inbound references (tables that have FKs pointing at us)
    // ------------------------------------------------------------------
    const incomingRefs = this.queries.getIncomingEdges(tableNode.id, [
      'foreign_key',
      'references',
    ]);
    const inboundTableIds = new Set<string>();
    const inboundRefLines: string[] = [];
    for (const ref of incomingRefs) {
      const sourceNode = this.queries.getNodeById(ref.source);
      if (!sourceNode) continue;
      const tblId =
        sourceNode.kind === 'column'
          ? this._parentTableId(sourceNode)
          : sourceNode.kind === 'foreign_key' || sourceNode.kind === 'constraint'
            ? null
            : sourceNode.id;

      if (tblId && !inboundTableIds.has(tblId)) {
        inboundTableIds.add(tblId);
        const tbl = this.queries.getNodeById(tblId);
        if (tbl) {
          inboundRefLines.push(`- \`${tbl.qualifiedName}\``);
        }
      }
    }

    // ------------------------------------------------------------------
    // 5. Format markdown
    // ------------------------------------------------------------------
    const lines: string[] = [];
    const header = schema.kind === 'view' ? 'View' : 'Table';

    lines.push(`## ${header}: ${schema.qualifiedName}`);
    lines.push('');

    if (hierarchy.length > 0) {
      lines.push(`**Path:** ${hierarchy.join(' › ')}`);
      lines.push('');
    }

    // Database source line
    const dbEngine = tableNode.language ?? 'unknown';
    const sourceLabel = schema.source.replace(/^db:\/\//, '');
    lines.push(`**Source:** ${sourceLabel} (${dbEngine})`);
    if (schema.comment) {
      lines.push('');
      lines.push(`> ${schema.comment}`);
    }
    lines.push('');

    // Columns table
    lines.push('### Columns');
    lines.push('');
    lines.push(
      '| # | Column | Type | Nullable | Default | PK | FK | Comment |',
    );
    lines.push(
      '|---|--------|------|----------|---------|----|----|---------|',
    );

    schema.columns.forEach((col, i) => {
      const fk = schema.foreignKeys.find((fk) => fk.columns.includes(col.name));
      const fkDisplay = fk
        ? `${fk.referencedTable}(${fk.referencedColumns.join(',')})`
        : '';
      const defaultDisplay = col.defaultValue ?? '';
      const commentDisplay = col.comment ?? '';
      lines.push(
        `| ${i + 1} | ${col.name} | ${col.dataType} | ${col.isNullable ? 'YES' : 'NO'} | ${defaultDisplay} | ${col.isPrimaryKey ? 'PK' : ''} | ${fkDisplay} | ${commentDisplay} |`,
      );
    });
    lines.push('');

    // Primary key
    if (schema.primaryKey.length > 0) {
      lines.push(`**Primary Key:** ${schema.primaryKey.join(', ')}`);
      lines.push('');
    }

    // Indexes
    if (schema.indexes.length > 0) {
      lines.push('### Indexes');
      lines.push('');
      lines.push('| Name | Columns | Unique | Method |');
      lines.push('|------|---------|--------|--------|');
      for (const idx of schema.indexes) {
        lines.push(
          `| ${idx.name} | ${idx.columns.join(', ')} | ${idx.unique ? 'YES' : 'NO'} | ${idx.method ?? 'btree'} |`,
        );
      }
      lines.push('');
    }

    // Foreign keys
    if (schema.foreignKeys.length > 0) {
      lines.push('### Foreign Keys');
      lines.push('');
      lines.push('| Constraint | Columns | References | On Delete | On Update |');
      lines.push('|------------|---------|------------|-----------|-----------|');
      for (const fk of schema.foreignKeys) {
        const cols = fk.columns.join(', ');
        const refs = `${fk.referencedTable}(${fk.referencedColumns.join(', ')})`;
        lines.push(
          `| ${fk.constraintName} | ${cols} | ${refs} | ${fk.onDelete ?? ''} | ${fk.onUpdate ?? ''} |`,
        );
      }
      lines.push('');
    }

    // Inbound references
    if (inboundRefLines.length > 0) {
      lines.push('### Referenced By');
      lines.push('');
      for (const r of inboundRefLines) lines.push(r);
      lines.push('');
    }

    // View definition
    if (schema.definition) {
      lines.push('### Definition');
      lines.push('');
      lines.push('```sql');
      lines.push(schema.definition);
      lines.push('```');
      lines.push('');
    }

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract the parent table ID for a column node by tracing its incoming
   * `contains` edge.
   */
  private _parentTableId(columnNode: Node): string | null {
    const parents = this.queries.getIncomingEdges(columnNode.id, ['contains']);
    for (const p of parents) {
      const pNode = this.queries.getNodeById(p.source);
      if (pNode && (pNode.kind === 'table' || pNode.kind === 'view')) {
        return pNode.id;
      }
    }
    return null;
  }

  /**
   * Resolve the data type for a column node.
   * Priority: metadata.dataType → parse from signature → "unknown".
   */
  private _columnDataType(col: Node, meta: Record<string, unknown>): string {
    if (typeof meta.dataType === 'string' && meta.dataType.length > 0) {
      return meta.dataType as string;
    }
    if (col.signature) {
      // Common signature formats:
      //   "integer NOT NULL DEFAULT 0"
      //   "varchar(255)"
      //   "numeric(12,4)"
      const typePart = col.signature.split(/\s+/)[0];
      if (typePart) return typePart;
    }
    return 'unknown';
  }

  /**
   * Determine whether a column is nullable.
   * Priority: metadata.isNullable → parse from signature → true.
   */
  private _columnIsNullable(
    col: Node,
    meta: Record<string, unknown>,
  ): boolean {
    if (typeof meta.isNullable === 'boolean') return meta.isNullable as boolean;
    if (col.signature) {
      const upper = col.signature.toUpperCase();
      if (upper.includes('NOT NULL')) return false;
      if (upper.includes('NULL')) return true;
    }
    return true;
  }

  /**
   * Extract default value for a column.
   * Priority: metadata.defaultValue → parse from signature.
   */
  private _columnDefault(
    col: Node,
    meta: Record<string, unknown>,
  ): string | undefined {
    if (typeof meta.defaultValue === 'string' && meta.defaultValue.length > 0) {
      return meta.defaultValue as string;
    }
    if (col.signature) {
      // Match DEFAULT <value> (stops at next keyword or end)
      const match = col.signature.match(
        /\bDEFAULT\s+('(?:[^']|'')*'|[^\s,)]+)/i,
      );
      if (match) return match[1]!;
    }
    return undefined;
  }

  /**
   * Derive which columns an index covers by looking at the index node's
   * metadata or its `indexed_by` edges to column nodes.
   */
  private _getIndexedColumnNames(
    indexNode: Node,
    tableColumns: Node[],
  ): string[] {
    // Prefer metadata.columns
    const meta = indexNode.metadata ?? {};
    if (Array.isArray(meta.columns)) {
      return meta.columns as string[];
    }
    if (typeof meta.column === 'string') {
      return [meta.column as string];
    }

    return [];
  }
}
