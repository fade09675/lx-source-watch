import { useEffect, useState } from 'react';
import { STATUS_META, type SourceStatus } from '@lx/shared';
import { ApiError, api, type AdminSource, type SourceInputPayload, type SourceListResult } from '../api';
import { ErrorBox, Spinner } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { Pagination, useClientPager } from '../components/Pagination';
import { Drawer, PageHeader, SectionCard } from '../components/ui';
import { BackupImportPanel } from './BackupImportPanel';

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

function toForm(source: AdminSource): FormState {
  return {
    title: source.title,
    url: source.url,
    category: source.category,
    homepage: source.homepage,
    mirrors: source.mirrors.join('\n'),
    notes: source.notes,
  };
}

function statusMeta(source: AdminSource): { label: string; tone: string } {
  if (!source.enabled) return { label: '已停用', tone: 'idle' };
  const meta = STATUS_META[source.status as SourceStatus];
  return meta ? { label: meta.label, tone: meta.tone } : { label: source.status, tone: 'idle' };
}

export function ManageSourcesPage() {
  const [data, setData] = useState<SourceListResult | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createMode, setCreateMode] = useState<'remote' | 'upload'>('remote');
  const [upload, setUpload] = useState<{ filename: string; content: string; bytes: number } | null>(null);
  const [uploadTest, setUploadTest] = useState(false);
  const [editing, setEditing] = useState<AdminSource | null>(null);
  const [openLinks, setOpenLinks] = useState<string | null>(null);
  const sourcePager = useClientPager(data?.sources ?? []);

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

  function openCreate() {
    setForm(EMPTY_FORM);
    setCreateMode('remote');
    setUpload(null);
    setUploadTest(false);
    setCreating(true);
  }

  function switchCreateMode(mode: 'remote' | 'upload') {
    setCreateMode(mode);
    setForm((current) => ({
      ...current,
      category:
        mode === 'upload' && current.category.trim() === '在线'
          ? '上传'
          : mode === 'remote' && current.category.trim() === '上传'
            ? '在线'
            : current.category,
    }));
  }

  async function create() {
    if (createMode === 'upload') {
      if (!upload) {
        setMessage('先选择一个 .js 脚本文件');
        return;
      }
      setBusy(true);
      setMessage('');
      try {
        const result = await api.uploadSource({
          filename: upload.filename,
          content: upload.content,
          title: form.title.trim(),
          category: form.category.trim() || '上传',
          homepage: form.homepage.trim(),
          notes: form.notes.trim(),
          testAfterSave: uploadTest,
        });
        setMessage(
          result.testTaskId
            ? `已上传「${result.source.title}」，并创建单源测试任务 ${result.testTaskId}`
            : `已上传「${result.source.title}」，地址：${result.file.url}`,
        );
        setCreating(false);
        setUpload(null);
        await load();
      } catch (e) {
        setMessage(e instanceof ApiError ? e.message : '上传失败');
      } finally {
        setBusy(false);
      }
      return;
    }
    await run(async () => {
      await api.createSource(toPayload(form));
      setForm(EMPTY_FORM);
      setCreating(false);
    }, '已新增音源');
  }

  async function pickFile(file: File | null) {
    if (!file) {
      setUpload(null);
      return;
    }
    if (!/\.js$/i.test(file.name)) {
      setMessage('只支持 .js 脚本文件');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setMessage(`脚本超过 2MB（当前 ${(file.size / 1024 / 1024).toFixed(1)}MB）`);
      return;
    }
    const content = await file.text();
    setUpload({ filename: file.name, content, bytes: file.size });
    setMessage('');
  }

  async function download(source: AdminSource) {
    setBusy(true);
    setMessage('');
    try {
      const { blob, filename } = await api.downloadSourceScript(source.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setMessage(`已下载 ${filename}`);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : '下载脚本失败');
    } finally {
      setBusy(false);
    }
  }

  function startEdit(source: AdminSource) {
    setEditing(source);
    setEditForm(toForm(source));
  }

  async function saveEdit() {
    if (!editing) return;
    await run(async () => {
      await api.updateSource(editing.id, toPayload(editForm));
      setEditing(null);
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
    setBusy(true);
    setMessage('');
    try {
      const result = await api.testSource(source.id);
      setMessage(result.message || `已创建「${source.title}」的单源测试任务，请到任务中心查看`);
      await load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : '触发单源测试失败');
    } finally {
      setBusy(false);
    }
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

  const enabled = data.sources.filter((item) => item.enabled).length;

  return (
    <div className="page">
      <PageHeader
        eyebrow="SOURCES"
        title="音源管理"
        description="维护探测用的音源清单；保存后下一轮探测生效。停用不会删除历史，删除只影响网页清单。"
        actions={
          <button className="primary-button" onClick={openCreate}>
            <Icon name="plus" size={15} />
            新增音源
          </button>
        }
      />

      {message && <div className="notice">{message}</div>}

      <SectionCard
        title="音源清单"
        description="主地址 + 自定义镜像；测试只触发该音源的单独探测"
        actions={
          <span className="muted small">
            共 {data.sources.length} 个 · 启用 {enabled} · 停用 {data.sources.length - enabled}
          </span>
        }
      >
        <details className="fold-panel fold-panel-inline">
          <summary>
            <span>
              <Icon name="import" size={15} />
              备用线路导入
            </span>
            <span className="muted small">按标题/作者自动匹配，或手动指定音源，追加到 mirrors</span>
          </summary>
          <div className="fold-body">
            <BackupImportPanel sources={data.sources} onDone={load} />
          </div>
        </details>

        <div className="admin-source-list">
          {sourcePager.pageItems.map((source) => {
            const linksOpen = openLinks === source.id;
            return (
              <article key={source.id} className={source.enabled ? 'admin-source-row' : 'admin-source-row is-disabled'}>
                <div className="admin-source-main">
                  <div className="admin-source-title">
                    <strong>{source.title}</strong>
                    <span className="pill">{source.version ? `v${source.version}` : '版本未知'}</span>
                    <span className={`pill tone-${statusMeta(source).tone}`}>
                      {statusMeta(source).label}
                    </span>
                    {source.origin === 'upload' && <span className="pill">上传</span>}
                    {source.trusted && <span className="pill tone-ok">受信任</span>}
                  </div>
                  <div className="admin-source-sub">
                    <code className="mono">{source.id}</code>
                    <span>{source.category}</span>
                    {source.origin && (
                      <span className="source-origin" title={source.origin}>
                        来源 {source.origin}
                      </span>
                    )}
                  </div>
                </div>

                <div className="admin-source-metrics">
                  <div>
                    <span>接入点</span>
                    <strong className={source.endpointsOk > 0 ? 'text-ok' : 'text-bad'}>
                      {source.endpointsTotal ? `${source.endpointsOk}/${source.endpointsTotal}` : '—'}
                    </strong>
                  </div>
                  <div>
                    <span>镜像</span>
                    <strong>{source.mirrors.length}</strong>
                  </div>
                  <div>
                    <span>最近变化</span>
                    <strong>{short(source.lastChangeAt || source.updatedAt)}</strong>
                  </div>
                </div>

                <div className="admin-source-actions">
                  {source.origin === 'upload' && (
                    <button className="row-link" onClick={() => void download(source)} disabled={busy}>
                      下载
                    </button>
                  )}
                  <button className="row-link" onClick={() => startEdit(source)} disabled={busy}>
                    编辑
                  </button>
                  <button className="row-link" onClick={() => void test(source)} disabled={busy || !source.enabled}>
                    测试
                  </button>
                  <button className="row-link muted-action" onClick={() => void toggle(source)} disabled={busy}>
                    {source.enabled ? '停用' : '启用'}
                  </button>
                  <button className="row-link danger" onClick={() => void remove(source)} disabled={busy}>
                    删除
                  </button>
                </div>

                <button className="admin-source-links-toggle" onClick={() => setOpenLinks(linksOpen ? null : source.id)}>
                  <Icon name={linksOpen ? 'chevron-down' : 'chevron-right'} size={13} />
                  导入链接（{source.links.length}）
                </button>

                {linksOpen && (
                  <div className="admin-source-links">
                    {source.links.map((link) => (
                      <div className="link-row" key={link.url}>
                        <span className="link-label">
                          {link.label}
                          {link.primary ? ' · 推荐' : ''}
                        </span>
                        <code className="mono">{link.url}</code>
                        <button className="row-link" onClick={() => void copy(link.url)}>
                          复制
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
          {data.sources.length === 0 && (
            <div className="ui-empty">
              <strong>还没有音源</strong>
              <p>先新增一个脚本地址，或从候选源收录。</p>
            </div>
          )}
        </div>
        {data.sources.length > 0 && <Pagination {...sourcePager.pagination} label="个音源" />}
      </SectionCard>

      <Drawer
        open={creating}
        title="新增音源"
        description="在线链接或上传 JS 脚本；上传的脚本会生成公开哈希地址，测试会创建单源测试任务。"
        onClose={() => setCreating(false)}
        footer={
          <div className="drawer-actions">
            <button className="ghost-button" onClick={() => setCreating(false)}>
              取消
            </button>
            <button
              className="primary-button"
              disabled={
                busy ||
                (createMode === 'upload' ? !upload : !form.title.trim() || !form.url.trim())
              }
              onClick={() => void create()}
            >
              {createMode === 'upload' ? '上传并新增' : '新增'}
            </button>
          </div>
        }
      >
        <div className="segmented source-create-tabs">
          <button
            className={`segmented-item ${createMode === 'remote' ? 'active' : ''}`}
            onClick={() => switchCreateMode('remote')}
          >
            在线链接
          </button>
          <button
            className={`segmented-item ${createMode === 'upload' ? 'active' : ''}`}
            onClick={() => switchCreateMode('upload')}
          >
            上传 JS
          </button>
        </div>
        {createMode === 'remote' ? (
          <SourceFields form={form} onChange={setForm} />
        ) : (
          <div className="source-form drawer-form">
            <label className="wide">
              JS 脚本文件（≤2MB）
              <input
                type="file"
                accept=".js,application/javascript,text/javascript"
                onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
              />
            </label>
            {upload && (
              <p className="muted small">
                已选择 {upload.filename} · {(upload.bytes / 1024).toFixed(1)} KB · sha256 去重
              </p>
            )}
            <label>
              名称
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="默认取 @name 或文件名"
              />
            </label>
            <label>
              分类
              <input
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="上传"
              />
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
              备注
              <input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="可选"
              />
            </label>
            <label className="checkbox-line wide">
              <input
                type="checkbox"
                checked={uploadTest}
                onChange={(e) => setUploadTest(e.target.checked)}
              />
              保存后立即测试（创建单源测试任务）
            </label>
          </div>
        )}
      </Drawer>

      <Drawer
        open={Boolean(editing)}
        title={editing ? `编辑「${editing.title}」` : '编辑音源'}
        description="修改后下一轮探测生效；清空镜像可移除自定义镜像。"
        onClose={() => setEditing(null)}
        footer={
          <div className="drawer-actions">
            <button className="ghost-button" onClick={() => setEditing(null)}>
              取消
            </button>
            <button className="primary-button" disabled={busy} onClick={() => void saveEdit()}>
              保存
            </button>
          </div>
        }
      >
        <SourceFields form={editForm} onChange={setEditForm} />
      </Drawer>
    </div>
  );
}

function SourceFields({ form, onChange }: { form: FormState; onChange: (form: FormState) => void }) {
  return (
    <div className="source-form drawer-form">
      <label>
        名称
        <input value={form.title} onChange={(e) => onChange({ ...form, title: e.target.value })} placeholder="例如：某聚合音源" />
      </label>
      <label className="wide">
        脚本地址
        <input
          value={form.url}
          onChange={(e) => onChange({ ...form, url: e.target.value })}
          placeholder="https://raw.githubusercontent.com/owner/repo/main/source.js"
        />
      </label>
      <label>
        分类
        <input value={form.category} onChange={(e) => onChange({ ...form, category: e.target.value })} />
      </label>
      <label>
        主页
        <input value={form.homepage} onChange={(e) => onChange({ ...form, homepage: e.target.value })} placeholder="可选" />
      </label>
      <label className="wide">
        自定义镜像（每行一个，可选）
        <textarea
          rows={3}
          value={form.mirrors}
          onChange={(e) => onChange({ ...form, mirrors: e.target.value })}
          placeholder="https://gh-proxy.com/https://raw.githubusercontent.com/..."
        />
      </label>
      <label className="wide">
        备注
        <input value={form.notes} onChange={(e) => onChange({ ...form, notes: e.target.value })} placeholder="可选" />
      </label>
    </div>
  );
}
