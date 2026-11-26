import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useTheme } from '../theme';
import { Icon, type IconName } from './Icon';
import { StatusBadge } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

const GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: '监测',
    items: [
      { to: '/', label: '工作台', icon: 'dashboard', end: true },
      { to: '/sources', label: '音源总览', icon: 'sources' },
      { to: '/admin/sources', label: '音源管理', icon: 'database' },
      { to: '/candidates', label: '候选音源', icon: 'candidate' },
      { to: '/admin/duplicates', label: '重复与别名', icon: 'duplicate' },
    ],
  },
  {
    title: '补测',
    items: [
      { to: '/admin/proxies', label: '国内代理', icon: 'proxy' },
      { to: '/admin/proxy-tests', label: '代理测活记录', icon: 'pulse' },
    ],
  },
  {
    title: '日志',
    items: [{ to: '/runs', label: '运行与日志', icon: 'runs' }],
  },
  {
    title: '系统',
    items: [
      { to: '/admin/settings', label: '设置', icon: 'settings' },
      { to: '/about', label: '说明', icon: 'info' },
    ],
  },
];

const TABS: NavItem[] = [
  { to: '/', label: '工作台', icon: 'dashboard', end: true },
  { to: '/sources', label: '总览', icon: 'sources' },
  { to: '/candidates', label: '候选', icon: 'candidate' },
  { to: '/admin/proxies', label: '代理', icon: 'proxy' },
  { to: '/runs', label: '日志', icon: 'runs' },
];

const ROUTE_LABELS: Array<{ path: string; group: string; label: string }> = [
  { path: '/', group: '监测', label: '工作台' },
  { path: '/sources', group: '监测', label: '音源总览' },
  { path: '/candidates', group: '监测', label: '候选音源' },
  { path: '/admin/duplicates', group: '监测', label: '重复与别名' },
  { path: '/admin/sources', group: '监测', label: '音源管理' },
  { path: '/runs', group: '日志', label: '运行与日志' },
  { path: '/admin/proxies', group: '补测', label: '国内代理' },
  { path: '/admin/proxy-tests', group: '补测', label: '代理测活记录' },
  { path: '/admin/settings', group: '系统', label: '设置' },
  { path: '/about', group: '系统', label: '说明' },
];

function routeMeta(pathname: string): { group: string; label: string } {
  if (pathname.startsWith('/s/')) return { group: '监测', label: '音源详情' };
  if (pathname.startsWith('/runs/')) return { group: '运行', label: '运行详情' };
  const exact = ROUTE_LABELS.find((item) => item.path === pathname);
  if (exact) return exact;
  return { group: '系统', label: '页面不存在' };
}

export function Layout() {
  const { site, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { pathname } = useLocation();
  const [stale, setStale] = useState<boolean | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const current = routeMeta(pathname);

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((health) => {
        if (cancelled) return;
        setStale(health.stale);
        setLastRunAt(health.lastRun?.finishedAt ?? null);
      })
      .catch(() => {
        if (!cancelled) setStale(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dataText = stale === true ? '数据已过期' : stale === false ? '数据正常' : '状态未知';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">LX</span>
          <div>
            <strong>{site}</strong>
            <span className="brand-sub">音源可用性监测</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          {GROUPS.map((group) => (
            <div className="sidebar-group" key={group.title}>
              <span className="sidebar-title">{group.title}</span>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => (isActive ? 'sidebar-link active' : 'sidebar-link')}
                >
                  <span className="sidebar-icon" aria-hidden="true">
                    <Icon name={item.icon} size={17} />
                  </span>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="sidebar-status">
            <span className={`status-dot ${stale === true ? 'is-warn' : stale === false ? 'is-ok' : ''}`} />
            <span className="sidebar-status-text">
              {dataText}
              <small>GitHub Actions · Cloudflare</small>
            </span>
          </div>
          <button type="button" className="sidebar-logout" onClick={() => void logout()}>
            <span>退出登录</span>
            <Icon name="logout" size={15} />
          </button>
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <div className="topbar-left">
            <div className="brand mobile-brand">
              <span className="brand-mark">LX</span>
              <strong>{site}</strong>
            </div>
            <div className="topbar-context">
              <span>{current.group}</span>
              <Icon name="chevron-right" size={12} />
              <strong>{current.label}</strong>
            </div>
          </div>

          <div className="topbar-right">
            {stale !== null && (
              <span title={stale ? '超过 8 小时没有新的检测结果' : (lastRunAt ?? '刚刚更新')}>
                <StatusBadge tone={stale ? 'warn' : 'ok'}>{dataText}</StatusBadge>
              </span>
            )}
            <button
              type="button"
              className="icon-button theme-toggle"
              onClick={toggle}
              aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
              title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
            </button>
            <button type="button" className="ghost-button hide-mobile" onClick={() => void logout()}>
              退出
            </button>
          </div>
        </header>

        <main className="main">
          <Outlet />
        </main>

        <footer className="footer">
          <span>检测由 GitHub Actions 执行 · 展示由 Cloudflare Worker 提供 · 每 4 小时一轮</span>
          <span>数据仅供参考：云端网络与你的本地网络不同，是否可用请以播放器实际播放为准。</span>
        </footer>
      </div>

      <nav className="tabbar" aria-label="移动端导航">
        {TABS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? 'tabbar-item active' : 'tabbar-item')}
          >
            <span className="tabbar-icon" aria-hidden="true">
              <Icon name={item.icon} size={20} />
            </span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
