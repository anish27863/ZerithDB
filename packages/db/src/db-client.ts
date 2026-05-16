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
import { wrapIDBOperation } from "./internal/wrap-idb-operation.js";
import type { BackupExportOptions, BackupSnapshot } from "./backup.js";

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
  if (a === null || a === undefined) {
    if (b === null || b === undefined) return 0;
    return -1;
  }
  if (b === null || b === undefined) return 1;
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

type IndexCondition = {
  op: "$eq" | "$gt" | "$gte" | "$lt" | "$lte";
  value: unknown;
};

const lowerBound = (
  entries: IndexEntry[],
  key: unknown,
  compare: IndexComparator<unknown>
): number => {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(entries[mid]?.key, key) < 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
};

const upperBound = (
  entries: IndexEntry[],
  key: unknown,
  compare: IndexComparator<unknown>
): number => {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(entries[mid]?.key, key) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
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

    try {
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
    } catch (err) {
      if (err instanceof ZerithDBError && err.code === ErrorCode.SDK_INVALID_CONFIG) {
        throw err;
      }
      throw new ZerithDBError(
        ErrorCode.DB_READ_FAILED,
        `Failed to create index "${def.name}" on "${this.collectionName}"`,
        { cause: err }
      );
    }
  }

  private selectIndex(filter: QueryFilter<T>): { index: IndexState<T>; condition: IndexCondition } | undefined {
    for (const [field, rawCondition] of Object.entries(filter)) {
      const index = [...this.indexes.values()].find((i) => i.field === field);
      if (!index) continue;

      if (rawCondition === null || typeof rawCondition !== "object") {
        return { index, condition: { op: "$eq", value: rawCondition } };
      }

      const ops = rawCondition as Record<string, unknown>;
      if ("$eq" in ops) return { index, condition: { op: "$eq", value: ops["$eq"] } };
      if ("$gt" in ops) return { index, condition: { op: "$gt", value: ops["$gt"] } };
      if ("$gte" in ops) return { index, condition: { op: "$gte", value: ops["$gte"] } };
      if ("$lt" in ops) return { index, condition: { op: "$lt", value: ops["$lt"] } };
      if ("$lte" in ops) return { index, condition: { op: "$lte", value: ops["$lte"] } };
    }
    return undefined;
  }

  private getIndexCandidateIds(index: IndexState<T>, condition: IndexCondition): DocumentId[] {
    const { entries, compare } = index;
    let start = 0;
    let end = entries.length;
    switch (condition.op) {
      case "$gt":
        start = upperBound(entries, condition.value, compare);
        break;
      case "$gte":
        start = lowerBound(entries, condition.value, compare);
        break;
      case "$lt":
        end = lowerBound(entries, condition.value, compare);
        break;
      case "$lte":
        end = upperBound(entries, condition.value, compare);
        break;
      case "$eq":
        start = lowerBound(entries, condition.value, compare);
        end = upperBound(entries, condition.value, compare);
        break;
    }
    return entries.slice(start, end).map((entry) => entry.id);
  }

  private insertIndexEntry(index: IndexState<T>, entry: IndexEntry): void {
    const entries = index.entries;
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareEntries(index.compare, entries[mid]!, entry) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    entries.splice(lo, 0, entry);
  }

  private findEntryIndex(index: IndexState<T>, key: unknown, id: DocumentId): number {
    const start = lowerBound(index.entries, key, index.compare);
    const end = upperBound(index.entries, key, index.compare);
    for (let i = start; i < end; i += 1) {
      if (index.entries[i]?.id === id) return i;
    }
    return -1;
  }

  private setDocIndexKey(id: DocumentId, indexName: string, key: unknown): void {
    if (!this.docIndexKeys.has(id)) {
      this.docIndexKeys.set(id, new Map());
    }
    this.docIndexKeys.get(id)?.set(indexName, key);
  }

  private removeDocIndexKey(id: DocumentId, indexName: string): void {
    const entry = this.docIndexKeys.get(id);
    if (!entry) return;
    entry.delete(indexName);
    if (entry.size === 0) this.docIndexKeys.delete(id);
  }

  private applyIndexInsert(doc: Document<T>): void {
    for (const index of this.indexes.values()) {
      const key = (doc as Record<string, unknown>)[index.field as string];
      if (index.compare === defaultIndexCompare) {
        defaultIndexCompare(key, key);
      }
      const entry = { key, id: doc._id };
      this.insertIndexEntry(index, entry);
      this.setDocIndexKey(doc._id, index.name, key);
    }
  }

  private applyIndexDelete(doc: Document<T>): void {
    for (const index of this.indexes.values()) {
      const key = this.docIndexKeys.get(doc._id)?.get(index.name);
      if (key === undefined) continue;
      const idx = this.findEntryIndex(index, key, doc._id);
      if (idx >= 0) index.entries.splice(idx, 1);
      this.removeDocIndexKey(doc._id, index.name);
    }
  }

  private applyIndexUpdate(oldDoc: Document<T>, newDoc: Document<T>): void {
    this.applyIndexDelete(oldDoc);
    this.applyIndexInsert(newDoc);
  }

  private async rebuildIndexes(): Promise<void> {
    if (this.indexes.size === 0) return;
    const docs = await this.table.toArray();
    this.docIndexKeys.clear();
    for (const index of this.indexes.values()) {
      const entries: IndexEntry[] = docs.map((doc) => ({
        key: (doc as Record<string, unknown>)[index.field as string],
        id: doc._id,
      }));
      entries.sort((a, b) => compareEntries(index.compare, a, b));
      index.entries = entries;
      for (const entry of entries) {
        this.setDocIndexKey(entry.id, index.name, entry.key);
      }
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
      this.applyIndexInsert(doc);
      await this.table.add(doc);
      return { id };
    } catch (err) {
      await this.rebuildIndexes();
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
      for (const doc of docs) {
        this.applyIndexInsert(doc);
      }
      await this.table.bulkAdd(docs);
      return docs.map((d) => ({ id: d._id }));
    } catch (err) {
      await this.rebuildIndexes();
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
      const indexMatch = this.selectIndex(filter);
      if (!indexMatch) {
        const all = await this.table.toArray();
        return all.filter((doc) => this.matchesFilter(doc, filter));
      }

      const { index, condition } = indexMatch;
      const candidateIds = this.getIndexCandidateIds(index, condition);
      if (candidateIds.length === 0) return [];

      const docs = await Promise.all(candidateIds.map((id) => this.table.get(id)));
      const comparatorOverrides = new Map<string, IndexComparator<unknown>>([
        [index.field as string, index.compare],
      ]);

      return (docs as (Document<T> | undefined)[])
        .filter((doc): doc is Document<T> => Boolean(doc))
        .filter((doc) => this.matchesFilter(doc, filter, comparatorOverrides));
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
    return wrapIDBOperation(
      ErrorCode.DB_READ_FAILED,
      `Failed to get document "${id}" from "${this.collectionName}"`,
      () => this.table.get(id)
    );
  }

  /**
   * Update documents matching a filter.
   * Returns the number of updated documents.
   */
  async update(filter: QueryFilter<T>, spec: UpdateSpec<T>): Promise<number> {
    try {
      const matches = await this.find(filter);
      const now = Date.now();

      const updatedDocs = matches.map((doc) => ({
        ...doc,
        ...(spec.$set ?? {}),
        _updatedAt: now,
      })) as Document<T>[];

      for (let i = 0; i < matches.length; i++) {
        this.applyIndexUpdate(matches[i]!, updatedDocs[i]!);
      }

      await this.table.bulkPut(updatedDocs);

      return matches.length;
    } catch (err) {
      await this.rebuildIndexes();
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
      for (const doc of matches) {
        this.applyIndexDelete(doc);
      }
      await this.table.bulkDelete(matches.map((d) => d._id));
      return matches.length;
    } catch (err) {
      await this.rebuildIndexes();
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
      this.docIndexKeys.clear();
      for (const index of this.indexes.values()) {
        index.entries = [];
      }
      await this.table.clear();
    } catch (err) {
      await this.rebuildIndexes();
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

  private matchesFilter(
    doc: Document<T>,
    filter: QueryFilter<T>,
    comparators?: Map<string, IndexComparator<unknown>>
  ): boolean {
    for (const [key, condition] of Object.entries(filter)) {
      const fieldValue = (doc as Record<string, any>)[key];
      const comparator = comparators?.get(key);

      if (condition === null || typeof condition !== "object") {
        if (fieldValue !== condition) return false;
        continue;
      }

      const ops = condition as Record<string, any>;
      if ("$eq" in ops && fieldValue !== ops["$eq"]) return false;
      if ("$ne" in ops && fieldValue === ops["$ne"]) return false;
      if ("$gt" in ops && !(comparator ? comparator(fieldValue, ops["$gt"]) > 0 : (fieldValue as any) > (ops["$gt"] as never)))
        return false;
      if ("$gte" in ops && !(comparator ? comparator(fieldValue, ops["$gte"]) >= 0 : (fieldValue as any) >= (ops["$gte"] as never)))
        return false;
      if ("$lt" in ops && !(comparator ? comparator(fieldValue, ops["$lt"]) < 0 : (fieldValue as any) < (ops["$lt"] as never)))
        return false;
      if ("$lte" in ops && !(comparator ? comparator(fieldValue, ops["$lte"]) <= 0 : (fieldValue as any) <= (ops["$lte"] as never)))
        return false;
      if ("$in" in ops && !(ops["$in"] as unknown[]).includes(fieldValue)) return false;
      if ("$nin" in ops && (ops["$nin"] as unknown[]).includes(fieldValue)) return false;
    }
    return true;
  }
}

/**
 * Internal Dexie subclass that manages dynamic collection creation.
 * Collections are added lazily via schema version upgrades.
 */
class ZerithDBDexie extends Dexie {
  private readonly tableMap = new Map<string, Table>();
  private _currentSchema: Record<string, string> = {};
  private _pendingVersion = 0;

  constructor(appId: string) {
    super(`zerithdb_${appId}`);
  }

  /**
   * Ensure a named collection exists, creating it via a Dexie version
   * upgrade if it has not been registered yet.
   *
   * @param name - The collection name to create or retrieve
   * @returns The Dexie {@link Table} handle for the collection
   */
  ensureCollection(name: string): Table {
    if (!this.tableMap.has(name)) {
      this._currentSchema[name] = "_id, _createdAt, _updatedAt";
      
      // We must increment the version for every new collection added dynamically
      const nextVersion = Math.max(this.verno, this._pendingVersion) + 1;
      this._pendingVersion = nextVersion;

      if (this.isOpen()) {
        this.close();
      }

      this.version(nextVersion).stores(this._currentSchema);
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
  private readonly appId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly collections = new Map<string, CollectionClient<any>>();

  constructor(config: ZerithDBConfig) {
    this.appId = config.appId;
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
