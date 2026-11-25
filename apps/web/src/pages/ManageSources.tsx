import { useEffect, useState } from 'react';
import { ApiError, api, type AdminSource, type SourceInputPayload, type SourceListResult } from '../api';
import { ErrorBox, Spinner } from '../components/Feedback';

interface FormState {
  title: string;
  url: string;
  category: string;
  homepage: string;
  mirrors: string;
  notes: string;
}

const EMPTY_FORM: FormState = { title: '', url: '', category: '在线', homepage: '', mirrors: '', notes: '' };

function splitMirrors(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function short(value: string): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toPayload(form: FormState): SourceInputPayload {
  return {
    title: form.title.trim(),
    url: form.url.trim(),
    category: form.category.trim() || '在线',
    homepage: form.homepage.trim(),
    mirrors: splitMirrors(form.mirrors),
    notes: form.notes.trim(),
  };
}

export function ManageSourcesPage() {
  const [data, setData] = useState<SourceListResult | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [openLinks, setOpenLinks] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setError('');
    try {
      setData(await api.sources());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }

  async function run(action: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(okText);
      await load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    await run(async () => {
      await api.createSource(toPayload(form));
      setForm(EMPTY_FORM);
    }, '已新增音源');
  }

  function startEdit(source: AdminSource) {
    setEditingId(source.id);
    setEditForm({
      title: source.title,
      url: source.url,
      category: source.category,
      homepage: source.homepage,
      mirrors: source.mirrors.join('\n'),
      notes: source.notes,
    });
  }

  async function saveEdit(id: string) {
    await run(async () => {
      await api.updateSource(id, toPayload(editForm));
      setEditingId(null);
    }, '已保存');
  }

  async function toggle(source: AdminSource) {
    await run(() => api.updateSource(source.id, { enabled: !source.enabled }), source.enabled ? '已停用' : '已启用');
  }

  async function remove(source: AdminSource) {
    if (!window.confirm(`删除音源「${source.title}」？只删除网页清单，不影响已探测数据。`)) return;
    await run(() => api.deleteSource(source.id), '已删除');
  }

  async function test(source: AdminSource) {
    await run(() => api.testSource(source.id), `已触发「${source.title}」的单独探测（30–60 秒后可在运行与日志看到）`);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage('已复制');
    } catch {
      setMessage('复制失败，请手动选中');
    }
  }

  if (error) return <ErrorBox message={error} onRetry={() => void load()} />;
  if (!data) return <Spinner label="加载音源清单…" />;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">SOURCES</p>
          <h1>音源管理</h1>
          <p className="muted">
            这里维护探测用的音源清单；保存后下一轮探测生效（探测任务从公开接口读取，读不到时回退仓库内清单）。
          </p>
        </div>
        <span className="pill">{data.sources.length} 个音源</span>
      </div>

      {message && <div className="notice">{message}</div>}

      <section className="panel">
        <div className="panel-head">
          <h2>新增音源</h2>
          <span className="muted">支持主地址 + 自定义镜像；加速镜像会按设置页的模板自动补全。</span>
        </div>
        <div className="source-form">
          <label>
            名称
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="例如：某聚合音源"
            />
          </label>
          <label className="wide">
            脚本地址
            <input
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://raw.githubusercontent.com/owner/repo/main/source.js"
            />
          </label>
          <label>
            分类
            <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </label>
          <label>
            主页
            <input
              value={form.homepage}
              onChange={(e) => setForm({ ...form, homepage: e.target.value })}
              placeholder="可选"
            />
          </label>
          <label className="wide">
            自定义镜像（每行一个，可选）
            <textarea
              rows={2}
              value={form.mirrors}
              onChange={(e) => setForm({ ...form, mirrors: e.target.value })}
              placeholder="https://gh-proxy.com/https://raw.githubusercontent.com/..."
            />
          </label>
          <label className="wide">
            备注
            <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="可选" />
          </label>
          <div className="form-actions">
            <button className="primary-button" disabled={busy || !form.title.trim() || !form.url.trim()} onClick={() => void create()}>
              新增
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>音源列表</h2>
          <span className="muted">停用后不会进入探测清单；删除只影响清单。</span>
        </div>
        <div className="table-wrap">
          <table className="data-table source-table">
            <thead>
              <tr>
                <th>音源</th>
                <th>状态</th>
                <th>版本</th>
                <th>接入点</th>
                <th>最近变化</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  busy={busy}
                  editing={editingId === source.id}
                  editForm={editForm}
                  openLinks={openLinks === source.id}
                  onEditForm={setEditForm}
                  onStartEdit={() => startEdit(source)}
                  onCancelEdit={() => setEditingId(null)}
                  onSave={() => void saveEdit(source.id)}
                  onToggle={() => void toggle(source)}
                  onRemove={() => void remove(source)}
                  onTest={() => void test(source)}
                  onCopy={(text) => void copy(text)}
                  onToggleLinks={() => setOpenLinks(openLinks === source.id ? null : source.id)}
                />
              ))}
              {data.sources.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    还没有音源，先在上方新增一个。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function SourceRow(props: {
  source: AdminSource;
  busy: boolean;
  editing: boolean;
  editForm: FormState;
  openLinks: boolean;
  onEditForm: (form: FormState) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onToggle: () => void;
  onRemove: () => void;
  onTest: () => void;
  onCopy: (text: string) => void;
  onToggleLinks: () => void;
}) {
  const { source, editForm, onEditForm } = props;

  return (
    <>
      <tr className={source.enabled ? '' : 'row-disabled'}>
        <td>
          <strong>{source.title}</strong>
          <div className="muted mono small">{source.id}</div>
          <div className="muted small">{source.category}{source.trusted ? ' · 受信任' : ''}</div>
          {source.origin && <div className="muted small" title={source.origin}>来源 {source.origin}</div>}
        </td>
        <td>
          <span className={`pill tone-${source.enabled ? source.status : 'idle'}`}>
            {source.enabled ? source.status : '已停用'}
          </span>
        </td>
        <td>
          <div>{source.version || '未知版本'}</div>
          <div className="muted mono small">{source.sha ? source.sha.slice(0, 8) : '—'}</div>
        </td>
        <td>
          {source.endpointsTotal ? (
            <span className={source.endpointsOk > 0 ? 'text-ok' : 'text-bad'}>
              {source.endpointsOk}/{source.endpointsTotal}
            </span>
          ) : (
            '—'
          )}
        </td>
        <td className="muted small">{short(source.lastChangeAt || source.updatedAt)}</td>
        <td>
          <div className="row-actions">
            <button className="ghost-button" onClick={props.onStartEdit} disabled={props.busy}>
              编辑
            </button>
            <button className="ghost-button" onClick={props.onTest} disabled={props.busy || !source.enabled}>
              测试
            </button>
            <button className="ghost-button" onClick={props.onToggle} disabled={props.busy}>
              {source.enabled ? '停用' : '启用'}
            </button>
            <button className="ghost-button danger" onClick={props.onRemove} disabled={props.busy}>
              删除
            </button>
          </div>
          <button className="link-button" onClick={props.onToggleLinks}>
            {props.openLinks ? '收起导入链接' : `导入链接（${source.links.length}）`}
          </button>
        </td>
      </tr>
      {props.openLinks && (
        <tr>
          <td colSpan={6}>
            <div className="link-list">
              {source.links.map((link) => (
                <div className="link-row" key={link.url}>
                  <span className="link-label">{link.label}{link.primary ? ' · 推荐' : ''}</span>
                  <code className="mono">{link.url}</code>
                  <button className="ghost-button" onClick={() => props.onCopy(link.url)}>
                    复制
                  </button>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
      {props.editing && (
        <tr>
          <td colSpan={6}>
            <div className="source-form">
              <label>
                名称
                <input value={editForm.title} onChange={(e) => onEditForm({ ...editForm, title: e.target.value })} />
              </label>
              <label className="wide">
                脚本地址
                <input value={editForm.url} onChange={(e) => onEditForm({ ...editForm, url: e.target.value })} />
              </label>
              <label>
                分类
                <input value={editForm.category} onChange={(e) => onEditForm({ ...editForm, category: e.target.value })} />
              </label>
              <label>
                主页
                <input value={editForm.homepage} onChange={(e) => onEditForm({ ...editForm, homepage: e.target.value })} />
              </label>
              <label className="wide">
                自定义镜像（每行一个）
                <textarea
                  rows={2}
                  value={editForm.mirrors}
                  onChange={(e) => onEditForm({ ...editForm, mirrors: e.target.value })}
                />
              </label>
              <label className="wide">
                备注
                <input value={editForm.notes} onChange={(e) => onEditForm({ ...editForm, notes: e.target.value })} />
              </label>
              <div className="form-actions">
                <button className="primary-button" onClick={props.onSave} disabled={props.busy}>
                  保存
                </button>
                <button className="ghost-button" onClick={props.onCancelEdit}>
                  取消
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
