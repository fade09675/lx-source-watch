import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useTheme } from '../theme';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

const GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: '监测',
    items: [
      { to: '/', label: '工作台', icon: '◈', end: true },
      { to: '/sources', label: '音源总览', icon: '◎' },
      { to: '/candidates', label: '候选源', icon: '＋' },
    ],
  },
  {
    title: '运行',
    items: [
      { to: '/admin/proxies', label: '国内代理', icon: '⇄' },
      { to: '/admin', label: '运行与日志', icon: '▤' },
    ],
  },
  {
    title: '其他',
    items: [{ to: '/about', label: '设置与说明', icon: 'i' }],
  },
];

const TABS: NavItem[] = [
  { to: '/', label: '工作台', icon: '◈', end: true },
  { to: '/sources', label: '总览', icon: '◎' },
  { to: '/candidates', label: '候选', icon: '＋' },
  { to: '/admin/proxies', label: '代理', icon: '⇄' },
  { to: '/admin', label: '日志', icon: '▤' },
];

export function Layout() {
  const { site, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [stale, setStale] = useState<boolean | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);

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
                    {item.icon}
                  </span>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="muted">GitHub Actions 执行 · Cloudflare 展示</span>
          <NavLink to="/about" className="sidebar-link subtle">
            关于与设置
          </NavLink>
          <button type="button" className="ghost-button" onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <div className="brand mobile-brand">
            <span className="brand-mark">LX</span>
            <strong>{site}</strong>
          </div>
          <div className="topbar-right">
            {stale === true && (
              <span className="pill pill-warn" title="超过 8 小时没有新的检测结果">
                数据已过期
              </span>
            )}
            {stale === false && (
              <span className="pill pill-ok" title={lastRunAt ?? '刚刚更新'}>
                数据正常
              </span>
            )}
            <button
              type="button"
              className="icon-button theme-toggle"
              onClick={toggle}
              aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
              title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
            >
              {theme === 'dark' ? '☀' : '☾'}
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
              {item.icon}
            </span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
