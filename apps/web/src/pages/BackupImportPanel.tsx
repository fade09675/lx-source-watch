import { useMemo, useState } from 'react';
import { api, type AdminSource, type BackupPreview, type BackupPreviewItem } from '../api';
import { ErrorBox } from '../components/Feedback';

interface Props {
  sources: AdminSource[];
  onDone: () => void | Promise<void>;
}

function statusText(item: BackupPreviewItem): string {
  switch (item.status) {
    case 'matched':
      return item.matchKind === 'manual' ? '已指定' : '已匹配';
    case 'already':
      return '已存在';
    case 'ambiguous':
      return '多个同名';
    case 'unmatched':
      return '未匹配';
    case 'invalid':
      return '地址无效';
    case 'unreachable':
      return '下载失败';
    default:
      return item.status;
  }
}

function tone(item: BackupPreviewItem): string {
  if (item.status === 'matched') return 'ok';
  if (item.status === 'already') return 'idle';
  return 'bad';
}

export function BackupImportPanel({ sources, onDone }: Props) {
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [manualSourceId, setManualSourceId] = useState('');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const importable = useMemo(
    () => (preview?.items ?? []).filter((item) => item.status === 'matched' && item.sourceId),
    [preview],
  );

  const reset = () => {
    setPreview(null);
    setSelected(new Set());
    setError('');
  };

  const runPreview = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api.previewBackups({
        text,
        ...(mode === 'manual' && manualSourceId ? { sourceId: manualSourceId } : {}),
      });
      setPreview(result);
      setSelected(new Set(importableIds(result)));
    } catch (err) {
      setError(err instanceof Error ? err.message : '解析失败');
    } finally {
      setBusy(false);
    }
  };

  const importSelected = async () => {
    const items = importable
      .filter((item) => selected.has(item.url) && item.sourceId)
      .map((item) => ({ url: item.url, sourceId: item.sourceId as string }));
    if (!items.length) {
      setError('没有勾选可导入的地址');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api.importBackups(items);
      setMessage(`已导入 ${result.imported} 条备用地址，跳过 ${result.skipped} 条${result.errors.length ? `，${result.errors.length} 条失败` : ''}`);
      setPreview(null);
      setSelected(new Set());
      setText('');
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (url: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  return (
    <details className="panel">
      <summary className="panel-head">
        <h2>导入备用线路</h2>
        <span className="muted">把 anhe 等第三方托管的脚本地址作为现有音源的备用镜像，不改变主地址</span>
      </summary>
      <div className="panel-body">
        {message ? <p className="notice">{message}</p> : null}
        {error ? <ErrorBox message={error} /> : null}
        <div className="chip-row">
          <button type="button" className={`chip ${mode === 'auto' ? 'chip-active' : ''}`} onClick={() => { setMode('auto'); reset(); }}>
            自动匹配
          </button>
          <button type="button" className={`chip ${mode === 'manual' ? 'chip-active' : ''}`} onClick={() => { setMode('manual'); reset(); }}>
            手动指定音源
          </button>
        </div>
        {mode === 'manual' ? (
          <label className="field">
            <span>目标音源</span>
            <select className="search-input" value={manualSourceId} onChange={(event) => setManualSourceId(event.target.value)}>
              <option value="">选择音源</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field">
          <span>备用脚本地址（每行一个，最多 20 个）</span>
          <textarea
            rows={5}
            value={text}
            onChange={(event) => { setText(event.target.value); reset(); }}
            placeholder="https://anhe-player.loc.cc/sources/xxxxxxxx.js"
          />
        </label>
        <div className="form-actions">
          <button type="button" className="ghost-button" disabled={busy || !text.trim() || (mode === 'manual' && !manualSourceId)} onClick={() => void runPreview()}>
            解析并预览
          </button>
          {preview ? (
            <button type="button" className="primary-button" disabled={busy || selected.size === 0} onClick={() => void importSelected()}>
              导入所选 {selected.size} 条
            </button>
          ) : null}
        </div>

        {preview ? (
          <>
            <p className="muted">
              共 {preview.summary.total} 条：匹配 {preview.summary.matched}、已存在 {preview.summary.already}、多个同名{' '}
              {preview.summary.ambiguous}、未匹配 {preview.summary.unmatched}、无效 {preview.summary.invalid}、下载失败{' '}
              {preview.summary.unreachable}。只有匹配成功的地址能导入；仅标题匹配默认不勾选，请核对后再选。
            </p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>选择</th>
                    <th>脚本标题</th>
                    <th>作者</th>
                    <th>匹配音源</th>
                    <th>状态</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.items.map((item) => (
                    <tr key={item.url}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(item.url)}
                          disabled={item.status !== 'matched' || !item.sourceId}
                          onChange={() => toggle(item.url)}
                        />
                      </td>
                      <td>{item.title || '—'}</td>
                      <td>{item.author || '—'}</td>
                      <td>{item.sourceTitle || '—'}</td>
                      <td>
                        <span className={`badge badge-${tone(item)}`}>{statusText(item)}</span>
                      </td>
                      <td className="muted">{item.message || (item.matchKind === 'title' ? '仅标题匹配' : '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>
    </details>
  );
}

function importableIds(preview: BackupPreview): string[] {
  return preview.items
    .filter((item) => item.status === 'matched' && item.sourceId && item.matchKind !== 'title')
    .map((item) => item.url);
}
