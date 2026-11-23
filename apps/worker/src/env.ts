import type { Snapshot } from '@lx/shared';

export interface Env {
  SNAPSHOT: KVNamespace;
  DB: D1Database;
  INGEST_SECRET: string;
  /** 登录密码的 PBKDF2 哈希；可在数据库 settings 里覆盖。 */
  ADMIN_PASSWORD_HASH?: string;
  /** 会话 Cookie 的 HMAC 密钥。 */
  SESSION_SECRET?: string;
  /** 代理密码/内核配置的 AES-GCM 密钥（base64 或 hex 32 字节）；缺省时由 SESSION_SECRET 派生。 */
  PROXY_ENC_KEY?: string;
  /** Actions 的 cn job 拉取代理池用的 Bearer Token。 */
  RUNNER_TOKEN?: string;
  /** 网页触发 GitHub Actions 的细粒度令牌（操作：读取和写入）。 */
  GH_DISPATCH_TOKEN?: string;
  /** GitHub 仓库，形如 owner/name；缺省用内置值。 */
  GH_REPO?: string;
  /** 只读统计令牌（复用 CF_API_TOKEN），用于 KV/D1 用量查询。 */
  CF_ANALYTICS_TOKEN?: string;
  /** Cloudflare 账号 ID，用于统计查询。 */
  CF_ACCOUNT_ID?: string;
  /** D1 数据库 ID，用于过滤统计里的其它数据库。 */
  D1_ID?: string;
  SITE_NAME?: string;
  PUBLIC_ORIGIN?: string;
  ASSETS?: Fetcher;
}

export const SNAPSHOT_KEY = 'snapshot:latest';
export const ADMIN_PASSWORD_SETTING = 'admin_password_hash';

export type StoredSnapshot = Snapshot;
