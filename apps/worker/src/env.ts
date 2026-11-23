import type { Snapshot } from '@lx/shared';

export interface Env {
  SNAPSHOT: KVNamespace;
  DB: D1Database;
  INGEST_SECRET: string;
  SITE_NAME?: string;
  PUBLIC_ORIGIN?: string;
  ASSETS?: Fetcher;
}

export const SNAPSHOT_KEY = 'snapshot:latest';

export type StoredSnapshot = Snapshot;
