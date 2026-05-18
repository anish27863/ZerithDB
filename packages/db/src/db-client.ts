import { Dexie, type Table, liveQuery } from "dexie";
import { v7 as uuidv7 } from "uuid";

import type {
  ZerithDBConfig,
  Document,
  QueryFilter,
  QueryOptions,
  InsertResult,
  UpdateSpec,
  ValidatorRegistry,
} from "zerithdb-core";
import { ZerithDBError, ErrorCode, ZerithValidationError } from "zerithdb-core";
import { wrapIDBOperation } from "./internal/wrap-idb-operation.js";
import { EventEmitter } from "zerithdb-core";
import type { BackupExportOptions, BackupSnapshot } from "./backup.js";
import { GraphClient } from "./graph-client.js";
import type { GraphNode, GraphEdge } from "zerithdb-core";
/**
 * Minimal interface for an opt-in schema validator (e.g. a Zod schema).
 * Kept loosely typed so `zod` itself is an optional peer dependency.
 */
export interface ZerithSchema<T> {
  parse(data: unknown): T;
}

/**
 * A handle to a single named collection within the ZerithDB local database.
 * All operations are async and backed by IndexedDB.
 */
export class CollectionClient<T extends Record<string, any> = Record<string, any>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private schema: ZerithSchema<T> | null = null;

  constructor(
    private readonly dbClient: DbClient,
    private readonly collectionName: string
  ) {}

  private async checkBiometric(operationDescription: string): Promise<void> {
    if (this.auth?.biometric?.isBiometricRequiredForDB()) {
      const authorized = await this.auth.biometric.promptBiometric(
        `Authorize sensitive database operation: ${operationDescription} in collection "${this.collectionName}"`
      );
      if (!authorized) {
        throw new ZerithDBError(
          ErrorCode.AUTH_SIGN_FAILED,
          "Database operation cancelled or biometric authentication failed."
        );
      }
    }
  }

  /**
   * Subscribe to changes in the collection.
   * Uses Dexie's liveQuery to reactively notify when documents change.
   *
   * @param callback - Function called with the updated list of all documents
   * @returns An unsubscribe function
   */
  subscribe(callback: (documents: Document<T>[]) => void): () => void {
    const observable = liveQuery(() => this.find());
    const subscription = observable.subscribe({
      next: (docs) => callback(docs),
      error: (err) => console.error(`Error in collection subscription:`, err),
    });
    return () => subscription.unsubscribe();
  }

  /**
   * Attach a Zod (or compatible) schema to this collection for opt-in validation.
   * Returns `this` so calls can be chained directly after {@link DbClient.collection}.
   *
   * Validation runs before every `insert`, `insertMany`, and `update` call.
   * Collections without a schema continue to work exactly as before.
   *
   * @param schema - Any object with a `parse(data): T` method (e.g. a Zod schema)
   * @returns The same `CollectionClient` instance (fluent API)
   *
   * @example
   * ```typescript
   * import { z } from "zod";
   * const userSchema = z.object({ name: z.string(), age: z.number() });
   * const users = app.db("users").withSchema(userSchema);
   * await users.insert({ name: "Alice", age: 30 }); // validated ✓
   * ```
   */
  withSchema(schema: ZerithSchema<T>): this {
    this.schema = schema;
    return this;
  }

  /**
   * Validates `data` against the attached schema (if any).
   * Throws {@link ZerithValidationError} on failure.
   * @internal
   */
  private validateData(data: unknown, context: string): void {
    if (!this.schema) return;

    // For updates, we try to use a partial version of the schema if it's a Zod schema.
    // This allows $set payload to only contain a subset of fields.
    let schemaToUse = this.schema;
    if (context.startsWith("update") && typeof (this.schema as any).partial === "function") {
      schemaToUse = (this.schema as any).partial();
    }

    try {
      schemaToUse.parse(data);
    } catch (err: unknown) {
      // Check for Zod-shaped error (has `.errors` array)
      if (
        err !== null &&
        typeof err === "object" &&
        "errors" in err &&
        Array.isArray((err as { errors: unknown }).errors)
      ) {
        throw ZerithValidationError.fromZodError(
          err as {
            errors: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
          },
          `"${this.collectionName}" — ${context}`
        );
      }
      // Re-throw unknown validation errors as-is
      throw err;
    }
  }

  /**
   * Insert a new document into the collection.
   * Automatically assigns `_id`, `_createdAt`, and `_updatedAt`.
   */
  async insert(document: T): Promise<InsertResult> {
    if (document === null || document === undefined) {
      throw new ZerithDBError(ErrorCode.DB_WRITE_FAILED, "Document cannot be null or undefined");
    }
    await this.checkBiometric("Insert Document");

    // Validate before writing — throws ZerithValidationError on failure
    this.validateData(document, "insert");
    const now = Date.now();
    const id = uuidv7();

    const doc: Document<T> = {
      ...document,
      _id: id,
      _createdAt: now,
      _updatedAt: now,
    };

    return wrapIDBOperation(
      ErrorCode.DB_WRITE_FAILED,
      `Failed to insert into collection "${this.collectionName}"`,
      async () => {
        await table.add(doc);
        return { id };
      }
    );
  }

  async insertMany(documents: T[]): Promise<InsertResult[]> {
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new ZerithDBError(ErrorCode.DB_WRITE_FAILED, "Documents must be a non-empty array");
    }
    await this.checkBiometric("Bulk Insert Documents");
    
    // Validate each document before writing
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      if (doc === null || doc === undefined) {
        throw new ZerithDBError(
          ErrorCode.DB_WRITE_FAILED,
          "Documents array cannot contain null or undefined"
        );
      }
      this.validateData(doc, `insertMany[${i}]`);
    }
    const now = Date.now();

    const docs = documents.map((doc) => ({
      ...doc,
      _id: uuidv7(),
      _createdAt: now,
      _updatedAt: now,
    })) as Document<T>[];

    return wrapIDBOperation(
      ErrorCode.DB_WRITE_FAILED,
      `Failed to bulk insert into collection "${this.collectionName}"`,
      async () => {
        await table.bulkAdd(docs);
        return docs.map((d) => ({ id: d._id }));
      }
    );
  }

  async find(filter: QueryFilter<T> = {}): Promise<Document<T>[]> {
    const table = await this.getTable();
    return wrapIDBOperation(
      ErrorCode.DB_READ_FAILED,
      `Failed to query collection "${this.collectionName}"`,
      async () => {
        const all = await table.toArray();
        return all.filter((doc) => this.matchesFilter(doc, filter));
      }
    );
  }

  async findById(id: string): Promise<Document<T> | undefined> {
    const table = await this.getTable();
    return wrapIDBOperation(
      ErrorCode.DB_READ_FAILED,
      `Failed to get document "${id}" from "${this.collectionName}"`,
      () => table.get(id)
    );
  }

  async update(filter: QueryFilter<T>, spec: UpdateSpec<T>): Promise<number> {
    if (
      !spec ||
      Object.keys(spec).length === 0 ||
      ((!spec.$set || Object.keys(spec.$set).length === 0) &&
        (!spec.$unset || Object.keys(spec.$unset).length === 0))
    ) {
      throw new ZerithDBError(
        ErrorCode.DB_WRITE_FAILED,
        "Update spec cannot be empty. Must provide non-empty $set or $unset."
      );
    }
    await this.checkBiometric("Update Documents");

    // Validate the $set payload against the schema (if attached)
    if (spec.$set !== undefined) {
      this.validateData(spec.$set, "update.$set");
    }
    return wrapIDBOperation(
      ErrorCode.DB_WRITE_FAILED,
      `Failed to update documents in "${this.collectionName}"`,
      async () => {
        const matches = await this.find(filter);
        const now = Date.now();
        await table.bulkPut(matches.map((doc) => this.applyUpdateSpec(doc, spec, now)));
        return matches.length;
      }
    );
  }

  async delete(filter: QueryFilter<T>): Promise<number> {
    const table = await this.getTable();
    return wrapIDBOperation(
      ErrorCode.DB_DELETE_FAILED,
      `Failed to delete documents from "${this.collectionName}"`,
      async () => {
        const matches = await this.find(filter);
        await table.bulkDelete(matches.map((d) => d._id));
        return matches.length;
      }
    );
  }

  async clearAll(): Promise<void> {
    const table = await this.getTable();
    return wrapIDBOperation(
      ErrorCode.DB_DELETE_FAILED,
      `Failed to clear collection "${this.collectionName}"`,
      () => table.clear()
    );
  }

  /** Alias for {@link clearAll} */
  async clear(): Promise<void> {
    return this.clearAll();
  }

  /**
   * Count documents matching a filter.
   */
  async count(filter: QueryFilter<T> = {}): Promise<number> {
    const docs = await this.find(filter);
    return docs.length;
  }

  private applyUpdateSpec(doc: Document<T>, spec: UpdateSpec<T>, updatedAt: number): Document<T> {
    const next = {
      ...doc,
      ...(spec.$set ?? {}),
      _updatedAt: updatedAt,
    } as Record<string, any>;

    for (const key of Object.keys(spec.$unset ?? {})) {
      delete next[key];
    }

    next._id = doc._id;
    next._createdAt = doc._createdAt;
    next._updatedAt = updatedAt;

    return next as Document<T>;
  }

  private matchesFilter(doc: Document<T>, filter: QueryFilter<T>): boolean {
    for (const [key, condition] of Object.entries(filter)) {
      const value = (doc as any)[key];

      if (condition === null || typeof condition !== "object") {
        if (value !== condition) return false;
        continue;
      }

      // Distinguish operator objects ({ $gt: 3 }) from plain object values ({ key: "v" }).
      // Only treat as operators if at least one key starts with "$".
      const conditions = condition as Record<string, any>;
      const isOperatorObject = Object.keys(conditions).some((k) => k.startsWith("$"));

      if (!isOperatorObject) {
        // Deep equality check for plain object / array values
        if (JSON.stringify(fieldValue) !== JSON.stringify(condition)) return false;
        continue;
      }

      if ("$eq" in conditions && fieldValue !== conditions["$eq"]) return false;
      if ("$ne" in conditions && fieldValue === conditions["$ne"]) return false;
      if ("$gt" in conditions && !((fieldValue as any) > (conditions["$gt"] as never))) return false;
      if ("$gte" in conditions && !((fieldValue as any) >= (conditions["$gte"] as never))) return false;
      if ("$lt" in conditions && !((fieldValue as any) < (conditions["$lt"] as never))) return false;
      if ("$lte" in conditions && !((fieldValue as any) <= (conditions["$lte"] as never))) return false;
      if ("$in" in conditions && !(conditions["$in"] as unknown[]).includes(fieldValue)) return false;
      if ("$nin" in conditions && (conditions["$nin"] as unknown[]).includes(fieldValue)) return false;
    }

    return true;
  }

  private applyUpdateSpec(
    doc: Document<T>,
    spec: UpdateSpec<T>,
    now: number
  ): Document<T> {
    return {
      ...doc,
      ...(spec.$set ?? {}),
      _updatedAt: now,
    };
  }
}

/**
 * Internal Dexie subclass that manages dynamic collection creation.
 * Collections are added lazily via schema version upgrades.
 */
class ZerithDBDexie extends Dexie {
  private readonly tableMap = new Map<string, Table>();
  private _currentSchema: Record<string, string> = {};
  private _initPromise: Promise<void> | null = null;
  private _pendingVersion = 0;

  constructor(appId: string) {
    super(`zerithdb_${appId}`);
  }

  /**
   * Ensure a named collection exists, creating it via a Dexie version
   * upgrade if it has not been registered yet.
   *
   * @param name - The collection name to create or retrieve
   * @returns A promise that resolves to the Dexie {@link Table} handle for the collection
   */
  async ensureCollectionAsync(name: string): Promise<Table> {
    if (this.tableMap.has(name)) {
      return this.tableMap.get(name)!;
    }

    return this.tableMap.get(name)!;
  }

  private async _performSchemaUpgrade(name: string): Promise<void> {
    this._currentSchema[name] = "_id, _createdAt, _updatedAt";

    // Obtain the actual database version from IndexedDB
    let actualVersion = this.verno;
    if (!this.isOpen()) {
      try {
        await this.open();
        actualVersion = this.verno;
      } catch (e) {
        // If the DB doesn't exist yet, open() will succeed and set verno to 1
        actualVersion = this.verno || 0;
      }
    }

    // Determine the next version, ensuring it strictly increases
    const nextVersion = Math.max(actualVersion, this._pendingVersion) + 1;
    this._pendingVersion = nextVersion;

    if (this.isOpen()) {
      this.close();
    }

    this.version(nextVersion).stores(this._currentSchema);
    this.tableMap.set(name, this.table(name));

    await this.open();
  }
}

/* ================= CLIENT ================= */

export class DbClient {
  private readonly dexie: ZerithDBDexie;
  private readonly appId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly collections = new Map<string, CollectionClient<any>>();

  /**
   * Internal Dexie table accessor
   */
  private get table(): Table<Document<T>> {
    return this.dexie.table(this.collectionName);
  }

  collection<T extends Record<string, any>>(name: string): CollectionClient<T> {
    if (!this.collections.has(name)) {
      const table = this.dexie.ensureCollection(name);
      this.collections.set(
        name,
        new CollectionClient<T>(table as Table<Document<T>>, name)
      );
    }

    return this.collections.get(name)!;
  }

  async getTable<T extends Record<string, any>>(name: string): Promise<Table<Document<T>>> {
    return (await this.dexie.ensureCollectionAsync(name)) as Table<Document<T>>;
  }

  /**
   * Returns per-collection document counts for DevTools memory reporting.
   */
  async getMemoryStats(): Promise<{ recordCount: number; collections: Record<string, number> }> {
    const collections: Record<string, number> = {};
    let recordCount = 0;

    for (const [key, client] of this.collections) {
      // Strip the ":uuid" / ":autoincrement" suffix for the stat label
      const name = key.split(":")[0]!;
      const count = await client.count();

      collections[name] = count;
      recordCount += count;
    }

    return { recordCount, collections };
  }

  collectionNames(): string[] {
    // Deduplicate in case same collection opened with different strategies
    return [...new Set(Array.from(this.collections.keys()).map((k) => k.split(":")[0]!))];
  }

  allCollectionNames(): string[] {
    return this.dexie.tables.map((t) => t.name).filter((name) => !name.startsWith("_"));
  }

  async exportSnapshot(
    options: BackupExportOptions = {}
  ): Promise<BackupSnapshot> {
    if (this.auth?.biometric?.isBiometricRequiredForDB()) {
      const authorized =
        await this.auth.biometric.promptBiometric(
          "Authorize sensitive operation: Export full database backup snapshot"
        );

      if (!authorized) {
        throw new ZerithDBError(
          ErrorCode.AUTH_SIGN_FAILED,
          "Database export cancelled or biometric authentication failed."
        );
      }
    }

    return wrapIDBOperation(
      ErrorCode.DB_READ_FAILED,
      "Failed to export local backup snapshot",
      async () => {
        const collectionNames =
          options.collections ?? this.allCollectionNames();

        const collections: BackupSnapshot["collections"] = {};

        for (const name of collectionNames) {
          const table = await this.dexie.ensureCollectionAsync(name);
          collections[name] = (await table.toArray()) as Document<Record<string, any>>[];
        }

        return {
          format: "zerithdb.local-backup.v1",
          appId: this.appId,
          generatedAt: new Date().toISOString(),
          collections,
        };
      }
    );
  }

  async dispose(): Promise<void> {
    // Remove all EventEmitter listeners before closing to prevent memory leaks
    // from dangling references to this DbClient instance after disposal.
    this.removeAllListeners();
    this.dexie.close();
  }
}