/**
 * MongoDB Introspector
 *
 * Extracts collections, views, indexes, and schema validation rules
 * from a MongoDB database. No document sampling — field-level schema
 * is inferred from $jsonSchema validation rules only.
 *
 * Connection: manages its own MongoClient lifecycle (does NOT use the
 * SQL-centric createConnection() factory in connection.ts).
 * The driver import is guarded so a missing `mongodb` is reported at
 * connect() time, not at module load time.
 */

import {
  IntrospectResult,
  DbConnectionConfig,
  Node,
  Edge,
} from '../types';
import { BaseIntrospector } from './base';
import { parseAuth } from './connection';

// =============================================================================
// Lazy MongoDB Driver Import
// =============================================================================

let mongoModule: any;
try {
  mongoModule = require('mongodb');
} catch {
  /* handled at connect() time — see private importMongoDriver() */ 
}

// =============================================================================
// MongoDBIntrospector
// =============================================================================

export class MongoDBIntrospector extends BaseIntrospector {
  constructor(config: DbConnectionConfig) {
    super(config);
  }

  /**
   * Override testConnection() — MongoDB does not use the
   * SQL-centric createConnection() factory from connection.ts.
   */
  async testConnection(): Promise<boolean> {
    try {
      const client = await this.connectClient();
      await client.close();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Full schema introspection.
   *
   * 1. Connect to MongoDB
   * 2. List collections (collecting regular collections and views)
   * 3. For each collection: indexes + estimatedDocumentCount
   * 4. Build Node[] + Edge[] with schema→collection→index hierarchy
   * 5. Close connection and return IntrospectResult
   */
  async extractAll(): Promise<IntrospectResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    let client: any;
    try {
      client = await this.connectClient();
    } catch (err: any) {
      return {
        nodes: [],
        edges: [],
        durationMs: Date.now() - startTime,
        errors: [err.message],
      };
    }

    try {
      const db = client.db(this.config.database);
      const dbName = this.config.database;

      // NOTE: config.schemas is silently ignored — MongoDB has no schema layer.

      // -----------------------------------------------------------------------
      // 1. List all collections (non-system, user-accessible)
      // -----------------------------------------------------------------------
      const collectionsRaw = await db
        .listCollections(
          {},
          { nameOnly: false, authorizedCollections: true },
        )
        .toArray();

      // Separate regular collections, timeseries, and views;
      // exclude system collections (system.*)
      const collections = collectionsRaw.filter(
        (c: any) =>
          !c.name.startsWith('system.') &&
          (!c.type || c.type === 'collection' || c.type === 'timeseries'),
      );
      const views = collectionsRaw.filter((c: any) => c.type === 'view');

      if (collections.length === 0 && views.length === 0) {
        errors.push('No collections or views found in database');
        return { nodes, edges, durationMs: Date.now() - startTime, errors };
      }

      // -----------------------------------------------------------------------
      // 2. Create schema (database) node
      // -----------------------------------------------------------------------
      const schemaNode = this.makeNode(
        'schema',
        dbName,
        this.qn(dbName),
        this.schemaFilePath(dbName),
      );
      nodes.push(schemaNode);

      // -----------------------------------------------------------------------
      // 3. Process each collection
      // -----------------------------------------------------------------------
      for (const coll of collections) {
        const collName: string = coll.name;
        const collQual = this.qn(dbName, collName);
        const collFp = this.schemaFilePath(dbName);

        // Gather indexes and document count for this collection
        let indexes: any[] = [];
        let docCount: number | undefined;
        const mongoColl = db.collection(collName);
        try {
          indexes = await mongoColl.indexes();
        } catch (err: any) {
          errors.push(
            `Skipping indexes for ${collName}: ${err.message}`,
          );
        }
        try {
          // estimatedDocumentCount() — fast metadata read.
          // NOTE: on sharded clusters this may be approximate.
          docCount = await mongoColl.estimatedDocumentCount();
        } catch (err: any) {
          errors.push(
            `Skipping document count for ${collName}: ${err.message}`,
          );
        }

        // Build metadata from collection options and validator
        const collOptions = coll.options || {};
        const validator = collOptions.validator;
        const validationSchema =
          validator && validator.$jsonSchema
            ? {
                $jsonSchema: validator.$jsonSchema,
                ...(collOptions.validationAction ? { validationAction: collOptions.validationAction } : {}),
                ...(collOptions.validationLevel ? { validationLevel: collOptions.validationLevel } : {}),
              }
            : undefined;

        const collNode = this.makeNode(
          'table',
          collName,
          collQual,
          collFp,
          {
            metadata: {
              documentCount: docCount,
              ...(validationSchema ? { validation: validationSchema } : {}),
              ...(collOptions.capped || collOptions.size || collOptions.max || collOptions.collation || collOptions.timeseries
                ? {
                    collectionOptions: {
                      ...(collOptions.capped !== undefined ? { capped: collOptions.capped } : {}),
                      ...(collOptions.size !== undefined ? { size: collOptions.size } : {}),
                      ...(collOptions.max !== undefined ? { max: collOptions.max } : {}),
                      ...(collOptions.collation ? { collation: collOptions.collation } : {}),
                      ...(collOptions.timeseries ? { timeseries: collOptions.timeseries } : {}),
                    },
                  }
                : {}),
            },
          },
        );
        nodes.push(collNode);
        edges.push(this.containEdge(schemaNode.id, collNode.id));

        // Create index nodes
        for (const idx of indexes) {
          const idxName: string = idx.name;
          const idxQual = this.qn(dbName, collName, idxName);

          // Determine index type from key values
          const keyValues = Object.values(idx.key || {}) as any[];
          const SPECIAL_KEY_TYPES = new Set(['text', '2dsphere', '2d', 'hashed']);
          const idxType =
            keyValues.find((v: any) => SPECIAL_KEY_TYPES.has(v)) || 'regular';

          const idxNode = this.makeNode(
            'index',
            idxName,
            idxQual,
            collFp,
            {
              metadata: {
                key: idx.key,
                unique: idx.unique || false,
                sparse: idx.sparse || undefined,
                indexType: idxType,
                partialFilterExpression:
                  idx.partialFilterExpression || undefined,
                ttl: idx.expireAfterSeconds || undefined,
                automatic: idxName === '_id_' ? true : undefined,
              },
            },
          );
          nodes.push(idxNode);
          edges.push(this.containEdge(collNode.id, idxNode.id));
          edges.push(
            this.makeEdge(collNode.id, idxNode.id, 'indexed_by'),
          );
        }
      }

      // -----------------------------------------------------------------------
      // 4. Process views
      // -----------------------------------------------------------------------
      for (const view of views) {
        const viewName: string = view.name;
        const viewQual = this.qn(dbName, viewName);
        const viewFp = this.schemaFilePath(dbName);
        const viewOptions = view.options || {};

        const viewNode = this.makeNode(
          'view',
          viewName,
          viewQual,
          viewFp,
          {
            signature: JSON.stringify(viewOptions.pipeline || [], null, 2),
            metadata: {
              viewOn: viewOptions.viewOn,
            },
          },
        );
        nodes.push(viewNode);
        edges.push(this.containEdge(schemaNode.id, viewNode.id));
      }
    } catch (err: any) {
      errors.push(`Introspection error: ${err.message}`);
    } finally {
      if (client) await client.close();
    }

    return {
      nodes,
      edges,
      durationMs: Date.now() - startTime,
      errors,
    };
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Lazy-import the mongodb driver and throw a helpful error if absent.
   */
  private importMongoDriver(): any {
    if (!mongoModule) {
      throw new Error(
        `mongodb package is not installed.\n` +
        `Connect to ${this.config.alias} (mongodb) by running: npm install mongodb`,
      );
    }
    return mongoModule;
  }

  /**
   * Build a MongoDB connection URI from the config.
   * NOTE: encodeURIComponent() is required for passwords containing
   * special characters (@, :, /, ?, #, %). parseAuth() does raw split only.
   */
  private buildUri(): string {
    const auth = parseAuth(this.config.auth);
    const host = this.config.host || 'localhost';
    const port = this.config.port || 27017;

    const encodedDb = encodeURIComponent(this.config.database);

    if (auth.user && auth.password) {
      return `mongodb://${encodeURIComponent(auth.user)}:${encodeURIComponent(auth.password)}@${host}:${port}/${encodedDb}`;
    }
    if (auth.user) {
      return `mongodb://${encodeURIComponent(auth.user)}@${host}:${port}/${encodedDb}`;
    }
    return `mongodb://${host}:${port}/${encodedDb}`;
  }

  /**
   * Connect to MongoDB and return the MongoClient.
   */
  private async connectClient(): Promise<any> {
    const mongodb = this.importMongoDriver();
    const uri = this.buildUri();
    return mongodb.MongoClient.connect(uri, {
      tls: this.config.ssl ?? false,
      tlsAllowInvalidCertificates: this.config.tlsInsecure ?? false,
      connectTimeoutMS: 10_000,
      serverSelectionTimeoutMS: 10_000,
    });
  }
}
