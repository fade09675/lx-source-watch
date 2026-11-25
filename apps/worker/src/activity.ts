import type { Env } from './env';

export interface AdminActivityView {
  id: string;
  at: string;
  method: string;
  path: string;
  action: string;
  target: string;
  ok: boolean;
  status: number;
  message: string;
}

interface ActivityRow {
  id: string;
  at: string;
  method: string;
  path: string;
  action: string;
  target: string;
  ok: number;
  status: number;
  message: string;
}

function toView(row: ActivityRow): AdminActivityView {
  return {
    id: row.id,
    at: row.at,
    method: row.method,
    path: row.path,
    action: row.action,
    target: row.target,
    ok: row.ok === 1,
    status: row.status,
    message: row.message,
  };
}

/** 把接口路径翻译成人能看懂的操作名。 */
export function actionLabel(method: string, path: string): string {
  const m = method.toUpperCase();
  if (path.includes('/auth/change-password')) return '修改密码';
  if (path.endsWith('/admin/settings/reset')) return '恢复默认设置';
  if (path.endsWith('/admin/settings')) return '保存设置';
  if (path.endsWith('/admin/runs/purge')) return '清理运行记录';
  if (path.endsWith('/admin/mirrors/reset')) return '恢复镜像模板';
  if (path.endsWith('/admin/mirrors')) return '保存镜像模板';
  if (path.includes('/admin/proxies/preview')) return '预览代理导入';
  if (path.includes('/admin/proxies/import-url')) return '按地址导入订阅';
  if (path.includes('/admin/proxies/import')) return '导入代理';
  if (path.includes('/admin/proxies/refresh')) return '刷新订阅';
  if (path.includes('/admin/proxies/subscriptions')) return m === 'DELETE' ? '删除订阅' : '保存订阅';
  if (path.includes('/admin/proxies/test')) return '手动测活';
  if (path.includes('/admin/proxies')) return m === 'DELETE' ? '删除代理' : '保存代理';
  if (path.includes('/admin/proxy-tests')) return '测活日志';
  if (path.endsWith('/admin/tasks/dispatch')) return '派发排队任务';
  if (path.endsWith('/admin/tasks/reap')) return '清理卡死任务';
  if (path.endsWith('/admin/tasks') && m === 'POST') return '创建任务';
  if (path.endsWith('/cancel')) return '取消任务';
  if (path.endsWith('/admin/sources') && m === 'POST') return '新增音源';
  if (path.includes('/admin/sources/') && path.endsWith('/test')) return '测试音源';
  if (path.includes('/admin/sources/') && m === 'PATCH') return '修改音源';
  if (path.includes('/admin/sources/') && m === 'DELETE') return '删除音源';
  if (path.endsWith('/admin/candidates/promote')) return '收录候选';
  if (path.endsWith('/admin/candidates/rejected')) return '清空已拒绝候选';
  if (path.includes('/admin/candidates/')) return '修改候选状态';
  if (path.endsWith('/admin/duplicates/merge')) return '合并重复源';
  if (path.endsWith('/admin/aliases/ignore')) return '忽略别名';
  if (path.endsWith('/admin/aliases/restore')) return '恢复别名';
  if (path.endsWith('/admin/run/probe')) return '手动探测';
  if (path.endsWith('/admin/run/discovery')) return '手动发现';
  if (path.endsWith('/admin/run/proxy-test')) return '手动测活';
  if (path.endsWith('/admin/usage/refresh')) return '刷新额度';
  if (path.endsWith('/admin/workflows')) return '工作流操作';
  return `${m} ${path.replace('/api', '')}`;
}

const ID_LIKE = /^(?:(?:task|run|sub|proxy)_[A-Za-z0-9_-]+|[0-9a-f][0-9a-f-]{7,})$/i;
const ACTION_SEGMENTS = new Set([
  'cancel',
  'dispatch',
  'reap',
  'test',
  'refresh',
  'merge',
  'promote',
  'restore',
  'ignore',
  'rejected',
]);

export function targetOf(path: string): string {
  const clean = path.split('?')[0]?.replace(/\/+$/, '') ?? '';
  const parts = clean.split('/').filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  if (ID_LIKE.test(last)) return last;
  const previous = parts[parts.length - 2] ?? '';
  if (ACTION_SEGMENTS.has(last.toLowerCase()) && ID_LIKE.test(previous)) return previous;
  return '';
}

/** 记录一条后台操作；日志失败不能影响主请求。 */
export async function recordAdminActivity(
  env: Env,
  input: { method: string; path: string; status: number; message?: string; at?: string },
): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  const message = (input.message ?? '').slice(0, 500);
  try {
    await env.DB.prepare(
      `INSERT INTO admin_activity (id, at, method, path, action, target, ok, status, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        at,
        input.method.toUpperCase().slice(0, 10),
        input.path.slice(0, 400),
        actionLabel(input.method, input.path),
        targetOf(input.path),
        input.status >= 200 && input.status < 400 ? 1 : 0,
        input.status,
        message,
      )
      .run();
  } catch {
    // 操作日志是旁路，写不进去也不影响业务。
  }
}

export async function listAdminActivity(
  db: D1Database,
  options: { limit?: number; offset?: number; ok?: boolean } = {},
): Promise<{ items: AdminActivityView[]; total: number }> {
  const limit = options.limit === 0 ? 5000 : Math.max(1, Math.min(200, options.limit ?? 20));
  const offset = Math.max(0, options.offset ?? 0);
  const where = options.ok === undefined ? '' : 'WHERE ok = ?';
  const binds = options.ok === undefined ? [] : [options.ok ? 1 : 0];
  const [rows, count] = await Promise.all([
    db
      .prepare(`SELECT * FROM admin_activity ${where} ORDER BY at DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all<ActivityRow>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM admin_activity ${where}`)
      .bind(...binds)
      .first<{ n: number }>(),
  ]);
  return { items: rows.results.map(toView), total: count?.n ?? 0 };
}
