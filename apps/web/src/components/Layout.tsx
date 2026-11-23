import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useTheme } from '../theme';

const NAV = [
  { to: '/', label: '总览', icon: '◎' },
  { to: '/candidates', label: '候选', icon: '＋' },
  { to: '/admin/proxies', label: '代理', icon: '⇄' },
  { to: '/admin', label: '管理', icon: '⚙' },
  { to: '/about', label: '关于', icon: 'i' },
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
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">LX</span>
          <div>
            <strong>{site}</strong>
            <span className="brand-sub">音源可用性监测</span>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          {stale === true && <span className="pill pill-warn" title="超过 8 小时没有新的检测结果">数据已过期</span>}
          {stale === false && <span className="pill pill-ok" title={lastRunAt ?? '刚刚更新'}>数据正常</span>}
          <button
            type="button"
            className="icon-button theme-toggle"
            onClick={toggle}
            aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
            title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button type="button" className="ghost-button" onClick={() => void logout()}>
            退出
          </button>
        </div>
      </header>

      <main className="main">
        <Outlet />
      </main>

      <nav className="tabbar" aria-label="移动端导航">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => (isActive ? 'tabbar-item active' : 'tabbar-item')}
          >
            <span className="tabbar-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <footer className="footer">
        <span>检测由 GitHub Actions 执行 · 展示由 Cloudflare Worker 提供 · 每 4 小时一轮</span>
        <span>数据仅供参考：云端网络与你的本地网络不同，是否可用请以播放器实际播放为准。</span>
      </footer>
    </div>
  );
}
