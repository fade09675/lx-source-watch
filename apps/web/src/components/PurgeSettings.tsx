import { useState } from 'react';
import { formatDateTime } from '@lx/shared';
import { ApiError, api, type RunPurgePreview } from '../api';

export function PurgeSettings() {
  const [days, setDays] = useState('30');
  const [preview, setPreview] = useState<RunPurgePreview | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function previewPurge() {
    const value = Number(days);
    if (!Number.isInteger(value) || value < 1) {
      setMessage('请输入大于 0 的整数天数');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await api.previewRunPurge(value);
      setPreview(result.preview);
      setMessage(
        result.preview.runs === 0 && result.preview.proxyTestRuns === 0 && result.preview.sourceEndpoints === 0
          ? '没有需要清理的记录。'
          : '',
      );
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : '预览失败');
    } finally {
      setBusy(false);
    }
  }

  async function confirmPurge() {
    if (!preview) return;
    const ok = window.confirm(
      `确认删除 ${preview.runs} 轮运行、${preview.proxyTestRuns} 轮测活及对应明细？此操作不可恢复，最新一轮会保留。`,
    );
    if (!ok) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await api.purgeRuns(preview.days);
      setMessage(
        `已删除：运行 ${result.result.runs} 轮、逐源 ${result.result.sourceRuns} 条、接入点 ${result.result.sourceEndpoints} 条、平台 ${result.result.platformResults} 条、测活 ${result.result.proxyTestRuns} 轮、操作记录 ${result.result.activity} 条。`,
      );
      setPreview(null);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : '清理失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel panel-wide">
      <div className="panel-head">
        <h2>清理运行记录</h2>
        <span className="muted">手动清理，自动清理见数据保留</span>
      </div>
      <p className="muted">
        只删除指定天数之前的探测与测活记录；最新一轮探测和最新一轮测活始终保留，避免首页快照失效。先预览，再确认删除。
      </p>
      <div className="run-form">
        <label className="field inline">
          <span>保留最近</span>
          <input
            value={days}
            onChange={(event) => {
              setDays(event.target.value);
              setPreview(null);
            }}
            inputMode="numeric"
            aria-label="保留天数"
          />
          <span>天</span>
        </label>
        <button type="button" className="ghost-button" onClick={() => void previewPurge()} disabled={busy}>
          {busy ? '统计中…' : '预览清理'}
        </button>
        <button type="button" className="primary-button danger" onClick={() => void confirmPurge()} disabled={!preview || busy}>
          确认删除
        </button>
      </div>
      {preview && (
        <div className="notice">
          <div>
            将删除：运行 {preview.runs} 轮、逐源 {preview.sourceRuns} 条、接入点 {preview.sourceEndpoints} 条、平台{' '}
            {preview.platformResults} 条、任务 {preview.tasks} 条、测活 {preview.proxyTestRuns} 轮/
            {preview.proxyTestResults} 条、操作记录 {preview.activity} 条。
          </div>
          <div className="muted">
            截止 {formatDateTime(preview.cutoff)}；最新探测 {preview.latestRunAt ? formatDateTime(preview.latestRunAt) : '无'}；最新测活{' '}
            {preview.latestProxyTestAt ? formatDateTime(preview.latestProxyTestAt) : '无'}。
          </div>
          {preview.clamped && <div className="muted">保留天数早于最新记录，实际只删除最新一轮之前的记录。</div>}
        </div>
      )}
      {message && <div className="form-message">{message}</div>}
    </section>
  );
}
