import type { Snapshot } from '@lx/shared';

export interface Env {
  SNAPSHOT: KVNamespace;
  DB: D1Database;
  INGEST_SECRET: string;
  /** 登录密码的 PBKDF2 哈希；可在数据库 settings 里覆盖。 */
  ADMIN_PASSWORD_HASH?: string;
  /** 会话 Cookie 的 HMAC 密钥。 */
  SESSION_SECRET?: string;
  SITE_NAME?: string;
  PUBLIC_ORIGIN?: string;
  ASSETS?: Fetcher;
}

export const SNAPSHOT_KEY = 'snapshot:latest';
export const ADMIN_PASSWORD_SETTING = 'admin_password_hash';

export type StoredSnapshot = Snapshot;
