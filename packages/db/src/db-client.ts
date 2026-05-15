import Dexie, { type Table } from "dexie";
import { v7 as uuidv7 } from "uuid";
import type {
  ZerithDBConfig,
  Document,
  DocumentId,
  QueryFilter,
  InsertResult,
  UpdateSpec,
} from "zerithdb-core";
import { ZerithDBError, ErrorCode } from "zerithdb-core";

export type IndexComparator<T> = (a: T, b: T) => number;

export type IndexDefinition<T extends Record<string, any>> = {
  name: string;
  field: keyof T;
  compare?: IndexComparator<T[keyof T]>;
};

type IndexEntry = { key: unknown; id: DocumentId };

type IndexState<T extends Record<string, any>> = {
  name: string;
  field: keyof T;
  compare: IndexComparator<unknown>;
  entries: IndexEntry[];
};

const defaultIndexCompare: IndexComparator<unknown> = (a, b) => {
  if (
    (typeof a !== "string" && typeof a !== "number") ||
    (typeof b !== "string" && typeof b !== "number")
  ) {
    throw new ZerithDBError(
      ErrorCode.SDK_INVALID_CONFIG,
      "Index comparator is required for non-string/number field values."
    );
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

const compareEntries = (
  compare: IndexComparator<unknown>,
  a: IndexEntry,
  b: IndexEntry
): number => {
  const result = compare(a.key, b.key);
  if (result !== 0) return result;
  return a.id.localeCompare(b.id);
};

/**
 * A handle to a single named collection within the ZerithDB local database.
 * All operations are async and backed by IndexedDB.
 */
export class CollectionClient<T extends Record<string, any> = Record<string, any>> {
  private readonly indexes = new Map<string, IndexState<T>>();
  private readonly docIndexKeys = new Map<DocumentId, Map<string, unknown>>();

  constructor(
    private table: Table<Document<T>>,
    private readonly collectionName: string
  ) {}

  /**
   * Internal: refresh the underlying Dexie table reference after a schema change.
   */
  setTable(table: Table<Document<T>>): void {
    this.table = table;
  }

  async createIndex(def: IndexDefinition<T>): Promise<void> {
    if (!def.name || typeof def.name !== "string") {
      throw new ZerithDBError(
        ErrorCode.SDK_INVALID_CONFIG,
        "Index name must be a non-empty string."
      );
    }
    if (!def.field || typeof def.field !== "string") {
      throw new ZerithDBError(
        ErrorCode.SDK_INVALID_CONFIG,
        "Index field must be a valid string key."
      );
    }
    if (def.compare !== undefined && typeof def.compare !== "function") {
      throw new ZerithDBError(
        ErrorCode.SDK_INVALID_CONFIG,
        "Index compare must be a function when provided."
      );
    }

    const comparator = (def.compare ?? defaultIndexCompare) as IndexComparator<unknown>;
    const existing = this.indexes.get(def.name);
    if (existing) {
      if (existing.field !== def.field || existing.compare !== comparator) {
        throw new ZerithDBError(
          ErrorCode.SDK_INVALID_CONFIG,
          `Index "${def.name}" already exists with different configuration.`
        );
      }
      return;
    }

    const docs = await this.table.toArray();
    const entries: IndexEntry[] = docs.map((doc) => ({
      key: (doc as Record<string, unknown>)[def.field as string],
      id: doc._id,
    }));

    if (!def.compare) {
      for (const entry of entries) {
        defaultIndexCompare(entry.key, entry.key);
      }
    }

    entries.sort((a, b) => compareEntries(comparator, a, b));
    this.indexes.set(def.name, {
      name: def.name,
      field: def.field,
      compare: comparator,
      entries,
    });

    for (const entry of entries) {
      if (!this.docIndexKeys.has(entry.id)) {
        this.docIndexKeys.set(entry.id, new Map());
      }
      this.docIndexKeys.get(entry.id)?.set(def.name, entry.key);
    }
  }

  /**
   * Insert a new document into the collection.
   * Automatically assigns `_id`, `_createdAt`, and `_updatedAt`.
   */
  async insert(document: T): Promise<InsertResult> {
    const now = Date.now();
    const id = uuidv7();
    const doc: Document<T> = {
      ...document,
      _id: id,
      _createdAt: now,
      _updatedAt: now,
    };

    try {
      await this.table.add(doc);
      return { id };
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_WRITE_FAILED,
        `Failed to insert into collection "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Insert multiple documents in a single atomic operation.
   */
  async insertMany(documents: T[]): Promise<InsertResult[]> {
    const now = Date.now();
    const docs = documents.map((doc) => ({
      ...doc,
      _id: uuidv7(),
      _createdAt: now,
      _updatedAt: now,
    })) as Document<T>[];

    try {
      await this.table.bulkAdd(docs);
      return docs.map((d) => ({ id: d._id }));
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_WRITE_FAILED,
        `Failed to bulk insert into collection "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Find documents matching a filter.
   * All filter fields are ANDed together.
   *
   * @example
   * ```typescript
   * const active = await todos.find({ done: false });
   * const high = await todos.find({ priority: { $gte: 3 } });
   * ```
   */
  async find(filter: QueryFilter<T> = {}): Promise<Document<T>[]> {
    try {
      const all = await this.table.toArray();
      return all.filter((doc) => this.matchesFilter(doc, filter));
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_READ_FAILED,
        `Failed to query collection "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Find a single document by its `_id`.
   */
  async findById(id: string): Promise<Document<T> | undefined> {
    try {
      return await this.table.get(id);
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_READ_FAILED,
        `Failed to get document "${id}" from "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Update documents matching a filter.
   * Returns the number of updated documents.
   */
  async update(filter: QueryFilter<T>, spec: UpdateSpec<T>): Promise<number> {
    try {
      const matches = await this.find(filter);
      const now = Date.now();

      await this.table.bulkPut(
        matches.map((doc) => ({
          ...doc,
          ...(spec.$set ?? {}),
          _updatedAt: now,
        }))
      );

      return matches.length;
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_WRITE_FAILED,
        `Failed to update documents in "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Delete documents matching a filter.
   * Returns the number of deleted documents.
   */
  async delete(filter: QueryFilter<T>): Promise<number> {
    try {
      const matches = await this.find(filter);
      await this.table.bulkDelete(matches.map((d) => d._id));
      return matches.length;
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_DELETE_FAILED,
        `Failed to delete documents from "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Delete every document in the collection.
   */
  async clearAll(): Promise<void> {
    try {
      await this.table.clear();
    } catch (err) {
      throw new ZerithDBError(
        ErrorCode.DB_DELETE_FAILED,
        `Failed to clear collection "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  /**
   * Count documents matching a filter.
   */
  async count(filter: QueryFilter<T> = {}): Promise<number> {
    const docs = await this.find(filter);
    return docs.length;
  }

  private matchesFilter(doc: Document<T>, filter: QueryFilter<T>): boolean {
    for (const [key, condition] of Object.entries(filter)) {
      const fieldValue = (doc as Record<string, any>)[key];

      if (condition === null || typeof condition !== "object") {
        if (fieldValue !== condition) return false;
        continue;
      }

      const ops = condition as Record<string, any>;
      if ("$eq" in ops && fieldValue !== ops["$eq"]) return false;
      if ("$ne" in ops && fieldValue === ops["$ne"]) return false;
      if ("$gt" in ops && !((fieldValue as any) > (ops["$gt"] as never))) return false;
      if ("$gte" in ops && !((fieldValue as any) >= (ops["$gte"] as never))) return false;
      if ("$lt" in ops && !((fieldValue as any) < (ops["$lt"] as never))) return false;
      if ("$lte" in ops && !((fieldValue as any) <= (ops["$lte"] as never))) return false;
      if ("$in" in ops && !(ops["$in"] as unknown[]).includes(fieldValue)) return false;
      if ("$nin" in ops && (ops["$nin"] as unknown[]).includes(fieldValue)) return false;
    }
    return true;
  }
}

class ZerithDBDexie extends Dexie {
  private readonly tableMap = new Map<string, Table>();

  constructor(appId: string) {
    super(`zerithdb_${appId}`);
  }

  ensureCollection(name: string): Table {
    if (!this.tableMap.has(name)) {
      // Dexie requires version upgrade to add tables — we use a dynamic schema pattern
      const version = (this.verno ?? 0) + 1;
      const existingTableNames = this.tableMap.keys();
      const schema: Record<string, string> = { [name]: "_id, _createdAt, _updatedAt" };
      for (const existingName of existingTableNames) {
        schema[existingName] = "_id, _createdAt, _updatedAt";
      }
      this.version(version).stores(schema);
      this.tableMap.set(name, this.table(name));
    }
    // biome-ignore lint: map guarantees this is defined
    return this.tableMap.get(name)!;
  }
}

/**
 * Internal database client. Wraps Dexie and manages collection instances.
 * Use via {@link ZerithDBApp.db} — not instantiated directly.
 */
export class DbClient {
  private readonly dexie: ZerithDBDexie;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly collections = new Map<string, CollectionClient<any>>();

  constructor(config: ZerithDBConfig) {
    this.dexie = new ZerithDBDexie(config.appId);
  }

  collection<T extends Record<string, any>>(name: string): CollectionClient<T> {
    if (!this.collections.has(name)) {
      this.dexie.ensureCollection(name);
      const table = this.dexie.table(name);
      this.collections.set(name, new CollectionClient<T>(table as Table<Document<T>>, name));
      this.refreshCollectionTables();
    }
    return this.collections.get(name) as CollectionClient<T>;
  }

  private refreshCollectionTables(): void {
    for (const [collectionName, collection] of this.collections.entries()) {
      collection.setTable(this.dexie.table(collectionName));
    }
  }

  async dispose(): Promise<void> {
    this.dexie.close();
  }
}
