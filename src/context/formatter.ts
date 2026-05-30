/**
 * Schema Formatter
 *
 * Converts database schema objects into human-readable markdown.
 * Used by the ContextBuilder and CLI to present schema information
 * to LLMs and developers.
 */

import {
  TableSchema,
  ColumnSchema,
  ForeignKeySchema,
  IndexSchema,
  DbSourceRecord,
  GraphStats,
  SearchResult,
} from '../types';

// =============================================================================
// SchemaFormatter
// =============================================================================

export class SchemaFormatter {
  // ---------------------------------------------------------------------------
  // formatTableSchema
  // ---------------------------------------------------------------------------

  /**
   * Format a full table/view schema as markdown.
   *
   * Output structure:
   * ```markdown
   * ## Table: schema_name.table_name
   * Database: alias (engine)
   *
   * > Table comment
   *
   * | Column | Type | Nullable | Default | PK | FK | Comment |
   * |--------|------|----------|---------|----|----|---------|
   * ...
   *
   * **Indexes:**
   * - idx_name on (col1, col2) UNIQUE
   *
   * **Foreign Keys:**
   * - fk_name → ref_table(ref_col) ON DELETE CASCADE
   * ```
   */
  formatTableSchema(schema: TableSchema): string {
    const lines: string[] = [];
    const label = schema.kind === 'view' ? 'View' : 'Table';

    // --- Header ---
    lines.push(`## ${label}: ${schema.qualifiedName}`);
    lines.push('');

    // --- Source line ---
    // schema.source is a URI like db://@alias/schema or db://host:port/db/schema
    const sourceDisplay = schema.source.replace(/^db:\/\//, '');
    lines.push(`Database: ${sourceDisplay}`);
    lines.push('');

    // --- Comment ---
    if (schema.comment) {
      lines.push(`> ${schema.comment}`);
      lines.push('');
    }

    // --- Column table ---
    lines.push('| Column | Type | Nullable | Default | PK | FK | Comment |');
    lines.push('|--------|------|----------|---------|----|----|---------|');

    for (const col of schema.columns) {
      lines.push(this._formatColumnRow(col, schema.foreignKeys));
    }
    lines.push('');

    // --- Primary key ---
    if (schema.primaryKey.length > 0) {
      lines.push(`**Primary Key:** ${schema.primaryKey.join(', ')}`);
      lines.push('');
    }

    // --- Indexes ---
    if (schema.indexes.length > 0) {
      lines.push('**Indexes:**');
      for (const idx of schema.indexes) {
        lines.push(this._formatIndexLine(idx));
      }
      lines.push('');
    }

    // --- Foreign Keys ---
    if (schema.foreignKeys.length > 0) {
      lines.push('**Foreign Keys:**');
      for (const fk of schema.foreignKeys) {
        lines.push(this._formatForeignKeyLine(fk));
      }
      lines.push('');
    }

    // --- View definition ---
    if (schema.definition) {
      lines.push('**Definition:**');
      lines.push('');
      lines.push('```sql');
      lines.push(schema.definition);
      lines.push('```');
      lines.push('');
    }

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // formatDatabaseOverview
  // ---------------------------------------------------------------------------

  /**
   * Format a high-level database overview as markdown.
   *
   * Output:
   * ```markdown
   * ## Database Overview
   *
   * | Database | Engine | Host | Tables | Last Indexed |
   * |----------|--------|------|--------|-------------|
   * | prod     | postgresql | db.example.com:5432 | 42 | 2024-01-15 |
   *
   * **Graph Statistics:**
   * - Total objects: 1,234
   * - Tables: 42
   * - Views: 12
   * - Columns: 856
   * - Indexes: 98
   * - Foreign Keys: 67
   * ```
   */
  formatDatabaseOverview(dbs: DbSourceRecord[], stats: GraphStats): string {
    const lines: string[] = [];

    lines.push('## Database Overview');
    lines.push('');

    if (dbs.length === 0) {
      lines.push('*No databases indexed.*');
      lines.push('');
      return lines.join('\n');
    }

    // --- Database table ---
    lines.push('| Alias | Engine | Host | Objects | Last Indexed |');
    lines.push('|-------|--------|------|---------|-------------|');

    for (const db of dbs) {
      const host = db.host ? (db.port ? `${db.host}:${db.port}` : db.host) : '—';
      const indexed = db.indexedAt
        ? new Date(db.indexedAt).toISOString().slice(0, 10)
        : '—';
      lines.push(
        `| ${db.alias} | ${db.engine} | ${host} | ${db.nodeCount.toLocaleString()} | ${indexed} |`,
      );
    }
    lines.push('');

    // --- Graph statistics ---
    lines.push('**Graph Statistics:**');
    lines.push('');
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
    };

    lines.push(`- Total objects: ${stats.nodeCount.toLocaleString()}`);
    lines.push(`- Total relationships: ${stats.edgeCount.toLocaleString()}`);

    for (const [kind, count] of Object.entries(stats.nodesByKind)) {
      if (count > 0) {
        const label = kindLabels[kind] ?? `${kind}s`;
        lines.push(`- ${label}: ${count.toLocaleString()}`);
      }
    }

    lines.push('');

    if (stats.dbSizeBytes > 0) {
      const size =
        stats.dbSizeBytes > 1_048_576
          ? `${(stats.dbSizeBytes / 1_048_576).toFixed(1)} MB`
          : `${(stats.dbSizeBytes / 1024).toFixed(1)} KB`;
      lines.push(`Database file size: ${size}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // formatSearchResults
  // ---------------------------------------------------------------------------

  /**
   * Format search results as markdown.
   *
   * Output:
   * ```markdown
   * ## Search Results for "orders"
   *
   * | Score | Name | Kind | Source |
   * |-------|------|------|--------|
   * | 1.00 | orders | table | @prod/public |
   * | 0.85 | order_items | table | @prod/public |
   * | 0.72 | total_order_amount | function | @prod/public |
   * ```
   *
   * @param results - Ranked search results from QueryBuilder.searchNodes
   */
  formatSearchResults(results: SearchResult[]): string {
    const lines: string[] = [];

    if (results.length === 0) {
      lines.push('*No results found.*');
      lines.push('');
      return lines.join('\n');
    }

    lines.push('| Score | Name | Kind | Qualified Name |');
    lines.push('|-------|------|------|----------------|');

    for (const r of results) {
      const scoreStr = r.score.toFixed(2);
      const name = r.node.name;
      const kind = r.node.kind;
      const qn = r.node.qualifiedName;
      lines.push(`| ${scoreStr} | ${name} | ${kind} | \`${qn}\` |`);
    }

    lines.push('');

    // Append highlights if present
    let hasHighlights = false;
    for (const r of results) {
      if (r.highlights && r.highlights.length > 0) {
        hasHighlights = true;
        break;
      }
    }

    if (hasHighlights) {
      lines.push('**Matches:**');
      lines.push('');
      for (const r of results) {
        if (r.highlights && r.highlights.length > 0) {
          lines.push(`- \`${r.node.name}\`: ${r.highlights.join('; ')}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Format a single column table row.
   */
  private _formatColumnRow(
    col: ColumnSchema,
    foreignKeys: ForeignKeySchema[],
  ): string {
    const nullable = col.isNullable ? 'YES' : 'NO';
    const defaultVal = col.defaultValue ?? '';
    const pk = col.isPrimaryKey ? 'PK' : '';

    // Find FK that this column participates in
    const fk = foreignKeys.find((fk) => fk.columns.includes(col.name));
    const fkDisplay = fk
      ? `${fk.referencedTable}(${fk.referencedColumns.join(',')})`
      : '';

    const comment = col.comment ?? '';

    // Escape pipe characters in values
    const safeType = this._escapePipe(col.dataType);

    return `| ${col.name} | ${safeType} | ${nullable} | ${defaultVal} | ${pk} | ${fkDisplay} | ${comment} |`;
  }

  /**
   * Format a single index entry.
   *
   * Examples:
   *   - idx_orders_user_id on (user_id)
   *   - pk_orders PRIMARY KEY using btree (id)
   */
  private _formatIndexLine(idx: IndexSchema): string {
    const cols = idx.columns.join(', ');
    if (idx.primary) {
      const method = idx.method ?? 'btree';
      return `- ${idx.name} PRIMARY KEY using ${method} (${cols})`;
    }
    const unique = idx.unique ? ' UNIQUE' : '';
    return `- ${idx.name} on (${cols})${unique}`;
  }

  /**
   * Format a single foreign key entry.
   *
   * Examples:
   *   - fk_orders_user → users(id) ON DELETE CASCADE
   */
  private _formatForeignKeyLine(fk: ForeignKeySchema): string {
    const cols = fk.columns.join(', ');
    const refs = `${fk.referencedTable}(${fk.referencedColumns.join(', ')})`;
    const parts: string[] = [`- ${fk.constraintName} → ${refs}`];

    if (fk.onDelete) parts.push(`ON DELETE ${fk.onDelete.toUpperCase()}`);
    if (fk.onUpdate) parts.push(`ON UPDATE ${fk.onUpdate.toUpperCase()}`);

    return parts.join(' ');
  }

  /**
   * Escape pipe characters so they don't break markdown table columns.
   */
  private _escapePipe(value: string): string {
    return value.replace(/\|/g, '\\|');
  }
}
