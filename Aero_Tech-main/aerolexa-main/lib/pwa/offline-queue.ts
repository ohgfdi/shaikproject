/**
 * Offline Mutation Queue for Ledgerly PWA
 * Uses IndexedDB to queue mutations when offline
 * Syncs via Service Worker Background Sync when online
 */

import { openDB, DBSchema, IDBPDatabase } from "idb";

/** A queued write that the service worker must replay once the browser is
 * back online. Exported so consumers can type their pending-mutation views. */
export interface OfflineMutation {
  id: string;
  method: "POST" | "PATCH" | "DELETE" | "PUT";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timestamp: number;
  retries: number;
  priority?: "high" | "normal" | "low";
}

interface OfflineQueueDBSchema extends DBSchema {
  mutations: {
    key: string;
    value: OfflineMutation;
    indexes: { "by-timestamp": number; "by-url": string; "by-priority": string };
  };
  metadata: {
    key: string;
    value: { key: string; value: unknown };
  };
}

const DB_NAME = "ledgerly-offline-queue";
const DB_VERSION = 1;
const MUTATION_STORE = "mutations";
const METADATA_STORE = "metadata";

let dbInstance: IDBPDatabase<OfflineQueueDBSchema> | null = null;

async function getDB(): Promise<IDBPDatabase<OfflineQueueDBSchema>> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB<OfflineQueueDBSchema>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(MUTATION_STORE)) {
        const store = db.createObjectStore(MUTATION_STORE, { keyPath: "id" });
        store.createIndex("by-timestamp", "timestamp");
        store.createIndex("by-url", "url");
        store.createIndex("by-priority", "priority");
      }
      if (!db.objectStoreNames.contains(METADATA_STORE)) {
        db.createObjectStore(METADATA_STORE, { keyPath: "key" });
      }
    },
  });

  return dbInstance;
}

export class OfflineQueue {
  private static instance: OfflineQueue;
  private syncInProgress = false;
  private listeners: Set<(pending: number) => void> = new Set();

  static getInstance(): OfflineQueue {
    if (!OfflineQueue.instance) {
      OfflineQueue.instance = new OfflineQueue();
    }
    return OfflineQueue.instance;
  }

  private constructor() {
    if (typeof window !== "undefined") {
      this.init();
    }
  }

  private async init() {
    await getDB();
    this.listenForOnline();
    this.registerSWMessageHandler();
  }

  private listenForOnline() {
    window.addEventListener("online", () => this.flushQueue());
    window.addEventListener("focus", () => this.flushQueue());
  }

  private registerSWMessageHandler() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "QUEUE_STATUS_CHANGED") {
          this.notifyListeners(event.data.pending);
        }
      });
    }
  }

  subscribe(listener: (pending: number) => void): () => void {
    this.listeners.add(listener);
    this.getPendingCount().then(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(pending: number) {
    this.listeners.forEach((l) => l(pending));
  }

  async getPendingCount(): Promise<number> {
    const db = await getDB();
    return db.count(MUTATION_STORE);
  }

  async getPendingMutations(): Promise<OfflineMutation[]> {
    const db = await getDB();
    return db.getAllFromIndex(MUTATION_STORE, "by-timestamp");
  }

  async queueMutation(mutation: Omit<OfflineMutation, "id" | "timestamp" | "retries">): Promise<string> {
    const db = await getDB();
    const id = crypto.randomUUID();
    const fullMutation: OfflineMutation = {
      ...mutation,
      id,
      timestamp: Date.now(),
      retries: 0,
    };

    await db.add(MUTATION_STORE, fullMutation);
    this.notifyListeners(await this.getPendingCount());
    await this.requestBackgroundSync();
    return id;
  }

  async removeMutation(id: string): Promise<void> {
    const db = await getDB();
    await db.delete(MUTATION_STORE, id);
    this.notifyListeners(await this.getPendingCount());
  }

  async updateMutationRetry(id: string, retries: number): Promise<void> {
    const db = await getDB();
    const mutation = await db.get(MUTATION_STORE, id);
    if (mutation) {
      mutation.retries = retries;
      await db.put(MUTATION_STORE, mutation);
    }
  }

  async clearQueue(): Promise<void> {
    const db = await getDB();
    await db.clear(MUTATION_STORE);
    this.notifyListeners(0);
  }

  async flushQueue(): Promise<{ success: number; failed: number; retried: number }> {
    if (this.syncInProgress || !navigator.onLine) return { success: 0, failed: 0, retried: 0 };

    this.syncInProgress = true;
    const mutations = await this.getPendingMutations();
    let success = 0;
    let failed = 0;
    let retried = 0;

    for (const mutation of mutations) {
      if (!navigator.onLine) break;

      try {
        const response = await fetch(mutation.url, {
          method: mutation.method,
          headers: {
            "Content-Type": "application/json",
            ...mutation.headers,
          },
          body: mutation.body ? JSON.stringify(mutation.body) : undefined,
          credentials: "include",
        });

        if (response.ok) {
          await this.removeMutation(mutation.id);
          success++;
        } else if (response.status >= 500 && mutation.retries < 3) {
          await this.updateMutationRetry(mutation.id, mutation.retries + 1);
          retried++;
        } else {
          await this.removeMutation(mutation.id);
          failed++;
        }
      } catch {
        if (mutation.retries < 3) {
          await this.updateMutationRetry(mutation.id, mutation.retries + 1);
          retried++;
        } else {
          await this.removeMutation(mutation.id);
          failed++;
        }
      }
    }

    this.syncInProgress = false;

    if (retried > 0) {
      await this.requestBackgroundSync();
    }

    this.notifyListeners(await this.getPendingCount());
    return { success, failed, retried };
  }

  private async requestBackgroundSync(): Promise<void> {
    const swProto = window.ServiceWorkerRegistration?.prototype as
      (ServiceWorkerRegistration & { sync?: unknown }) | undefined;
    if ("serviceWorker" in navigator && swProto && "sync" in swProto) {
      try {
        const registration = await navigator.serviceWorker.ready;
        // Background Sync is feature-detected above; the DOM typings do not
        // declare `sync` on ServiceWorkerRegistration in every TS lib version.
        const sync = (
          registration as ServiceWorkerRegistration & {
            sync?: { register: (tag: string) => Promise<void> };
          }
        ).sync;
        if (!sync) return;
        await sync.register("ledgerly-sync-mutations");
      } catch (error) {
        console.warn("Background sync registration failed:", error);
      }
    }
  }

  async getQueueStatus(): Promise<{ pending: number; mutations: OfflineMutation[] }> {
    const mutations = await this.getPendingMutations();
    return { pending: mutations.length, mutations };
  }

  isOnline(): boolean {
    return navigator.onLine;
  }

  isSyncing(): boolean {
    return this.syncInProgress;
  }
}

export const offlineQueue = OfflineQueue.getInstance();

export async function queueAPIMutation(
  url: string,
  method: "POST" | "PATCH" | "DELETE" | "PUT",
  body?: unknown,
  headers?: Record<string, string>,
  priority: "high" | "normal" | "low" = "normal",
): Promise<string> {
  return offlineQueue.queueMutation({ url, method, body, headers, priority });
}

export function useOfflineQueue() {
  return offlineQueue;
}
