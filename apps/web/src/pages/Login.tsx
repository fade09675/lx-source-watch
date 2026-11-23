import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';

export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const next = params.get('next') || '/';

  useEffect(() => {
    if (status === 'authed') navigate(next, { replace: true });
  }, [status, navigate, next]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError('');
    setSubmitting(true);
    try {
      await login(password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark large">LX</span>
          <h1>音源监测</h1>
          <p className="muted">输入访问密码后查看监测数据</p>
        </div>
        <form onSubmit={(event) => void onSubmit(event)}>
          <label className="field">
            <span>访问密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
              autoComplete="current-password"
              placeholder="请输入密码"
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="primary-button" disabled={submitting || !password}>
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>
        <p className="login-foot">未授权访问将被拒绝；连续输错 5 次会锁定 10 分钟。</p>
      </div>
    </div>
  );
}
