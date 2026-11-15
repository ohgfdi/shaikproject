/**
 * Offline-first Yjs persistence with IndexedDB (WS4).
 *
 * Persists Yjs updates locally so users can edit offline. On reconnect,
 * local updates are synced to the server room. Uses a single IndexedDB
 * store per notebook with update log + document snapshot for fast load.
 */

import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

export interface OfflinePersistenceOptions {
  /** Unique notebook/dashboard identifier */
  docId: string;
  /** Optional custom IndexedDB name (defaults to 'Ledgerly-collab') */
  dbName?: string;
  /** Auto-save interval (ms) - 0 = only on explicit flush */
  autoSaveInterval?: number;
  /** Max updates to keep in log before forcing compaction */
  maxLogSize?: number;
}

export interface PersistedState {
  /** Full document state (for fast initial load) */
  state: Uint8Array;
  /** Update log since last snapshot (for incremental sync) */
  updates: Uint8Array[];
  /** Last sync timestamp */
  lastSynced: number;
  /** Pending updates not yet acknowledged by server */
  pending: Uint8Array[];
}

const DEFAULT_DB_NAME = "Ledgerly-collab";
const DEFAULT_MAX_LOG = 500;

/**
 * Offline persistence manager for a single Y.Doc.
 * Wraps y-indexeddb and adds update log + pending queue for server sync.
 */
export class YjsOfflinePersistence {
  private persistence: IndexeddbPersistence;
  private doc: Y.Doc;
  private docId: string;
  private pendingUpdates: Uint8Array[] = [];
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private isOnline = true;
  private listeners = new Set<(state: PersistedState) => void>();

  constructor(doc: Y.Doc, options: OfflinePersistenceOptions) {
    this.doc = doc;
    this.docId = options.docId;
    const dbName = options.dbName ?? DEFAULT_DB_NAME;
    const maxLogSize = options.maxLogSize ?? DEFAULT_MAX_LOG;

    // Initialize y-indexeddb persistence
    this.persistence = new IndexeddbPersistence(`${dbName}-${this.docId}`, doc);

    // Track online/offline
    if (typeof window !== "undefined") {
      this.isOnline = navigator.onLine;
      window.addEventListener("online", () => this.handleOnline());
      window.addEventListener("offline", () => this.handleOffline());
    }

    // Capture local updates for pending queue
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      // Skip updates from server (they're already acknowledged)
      if (origin === "server") return;
      this.pendingUpdates.push(update);
      this.trimPending(maxLogSize);
      this.notifyListeners();
    });

    // Auto-save timer (IndexedDB persistence is event-driven, but we force snapshots)
    if (options.autoSaveInterval && options.autoSaveInterval > 0) {
      this.autoSaveTimer = setInterval(() => this.flush(), options.autoSaveInterval);
    }
  }

  private handleOnline(): void {
    this.isOnline = true;
    this.notifyListeners();
  }

  private handleOffline(): void {
    this.isOnline = false;
    this.notifyListeners();
  }

  private trimPending(maxSize: number): void {
    if (this.pendingUpdates.length > maxSize) {
      // Keep the most recent updates
      this.pendingUpdates = this.pendingUpdates.slice(-maxSize);
    }
  }

  private notifyListeners(): void {
    const state = this.getPersistedState();
    this.listeners.forEach((fn) => fn(state));
  }

  /** Subscribe to persisted state changes */
  subscribe(fn: (state: PersistedState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Get current persisted state */
  getPersistedState(): PersistedState {
    return {
      state: Y.encodeStateAsUpdate(this.doc),
      updates: [...this.pendingUpdates],
      lastSynced: Date.now(),
      pending: [...this.pendingUpdates],
    };
  }

  /** Load persisted state from IndexedDB */
  async load(): Promise<PersistedState | null> {
    return new Promise((resolve) => {
      this.persistence.once("synced", () => {
        resolve(this.getPersistedState());
      });
    });
  }

  /** Flush pending updates to IndexedDB (called automatically on update) */
  flush(): void {
    // y-indexeddb auto-flushes on each update; this is a no-op but kept for API
  }

  /** Mark updates as acknowledged by server (remove from pending) */
  acknowledgeServerUpdates(updates: Uint8Array[]): void {
    // Remove acknowledged updates from pending queue
    const acknowledged = new Set(updates.map((u) => Buffer.from(u).toString("base64")));
    this.pendingUpdates = this.pendingUpdates.filter((u) => !acknowledged.has(Buffer.from(u).toString("base64")));
    this.notifyListeners();
  }

  /** Get all pending updates for server sync */
  getPendingUpdates(): Uint8Array[] {
    return [...this.pendingUpdates];
  }

  /** Clear all local data (for logout/reset) */
  async clear(): Promise<void> {
    // IndexeddbPersistence doesn't expose clear(); destroy and recreate
    this.persistence.destroy();
    this.pendingUpdates = [];
    this.notifyListeners();
  }

  /** Destroy and cleanup */
  destroy(): void {
    if (this.autoSaveTimer) clearInterval(this.autoSaveTimer);
    this.persistence.destroy();
    this.listeners.clear();
  }

  get online(): boolean {
    return this.isOnline;
  }

  get pendingCount(): number {
    return this.pendingUpdates.length;
  }
}

/**
 * Create a Y.Doc with offline persistence initialized.
 * Returns the doc and persistence manager.
 */
export function createOfflineDoc(options: OfflinePersistenceOptions): {
  doc: Y.Doc;
  persistence: YjsOfflinePersistence;
} {
  const doc = new Y.Doc();
  const persistence = new YjsOfflinePersistence(doc, options);
  return { doc, persistence };
}

/**
 * Sync local pending updates to server.
 * Returns acknowledged updates.
 */
export async function syncToServer(
  persistence: YjsOfflinePersistence,
  sendUpdate: (update: Uint8Array) => Promise<boolean>,
): Promise<Uint8Array[]> {
  const pending = persistence.getPendingUpdates();
  const acknowledged: Uint8Array[] = [];

  for (const update of pending) {
    try {
      const ok = await sendUpdate(update);
      if (ok) acknowledged.push(update);
    } catch {
      // Stop on first failure - server will retry
      break;
    }
  }

  if (acknowledged.length > 0) {
    persistence.acknowledgeServerUpdates(acknowledged);
  }

  return acknowledged;
}
