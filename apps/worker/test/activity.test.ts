import { describe, expect, it } from 'vitest';
import { actionLabel } from '../src/activity';

describe('actionLabel', () => {
  it('识别常用后台写操作', () => {
    expect(actionLabel('PUT', '/api/admin/settings')).toBe('保存设置');
    expect(actionLabel('POST', '/api/admin/settings/reset')).toBe('恢复默认设置');
    expect(actionLabel('POST', '/api/admin/runs/purge')).toBe('清理运行记录');
    expect(actionLabel('POST', '/api/admin/proxies/import')).toBe('导入代理');
    expect(actionLabel('POST', '/api/admin/proxies/preview')).toBe('预览代理导入');
    expect(actionLabel('POST', '/api/admin/proxies/test')).toBe('手动测活');
    expect(actionLabel('POST', '/api/admin/tasks')).toBe('创建任务');
    expect(actionLabel('POST', '/api/auth/change-password')).toBe('修改密码');
  });

  it('区分删除与保存', () => {
    expect(actionLabel('DELETE', '/api/admin/proxies/proxy_1')).toBe('删除代理');
    expect(actionLabel('PATCH', '/api/admin/sources/sha_1')).toBe('修改音源');
  });

  it('未知路径保留方法和大致的路径', () => {
    expect(actionLabel('POST', '/api/admin/unknown-thing')).toBe('POST /admin/unknown-thing');
  });
});
