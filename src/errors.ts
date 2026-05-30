/**
 * DBGraph Error Classes
 */

/**
 * Base error class for all DBGraph errors
 */
export class DBGraphError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'DBGraphError';
    this.code = code;
    this.context = context;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error with database introspection
 */
export class IntrospectError extends DBGraphError {
  readonly source: string;

  constructor(message: string, source: string, cause?: Error) {
    super(message, 'INTROSPECT_ERROR', { source, cause: cause?.message });
    this.name = 'IntrospectError';
    this.source = source;
    if (cause) this.cause = cause;
  }
}

/**
 * Error with database operations
 */
export class DatabaseError extends DBGraphError {
  readonly operation: string;

  constructor(message: string, operation: string, cause?: Error) {
    super(message, 'DATABASE_ERROR', { operation, cause: cause?.message });
    this.name = 'DatabaseError';
    this.operation = operation;
    if (cause) this.cause = cause;
  }
}

/**
 * Error with search operations
 */
export class SearchError extends DBGraphError {
  readonly query: string;

  constructor(message: string, query: string, cause?: Error) {
    super(message, 'SEARCH_ERROR', { query, cause: cause?.message });
    this.name = 'SearchError';
    this.query = query;
    if (cause) this.cause = cause;
  }
}

/**
 * Error with configuration
 */
export class ConfigError extends DBGraphError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', details);
    this.name = 'ConfigError';
  }
}

/**
 * Error with database connection
 */
export class ConnectionError extends DBGraphError {
  readonly source: string;

  constructor(message: string, source: string, cause?: Error) {
    super(message, 'CONNECTION_ERROR', { source, cause: cause?.message });
    this.name = 'ConnectionError';
    this.source = source;
    if (cause) this.cause = cause;
  }
}
