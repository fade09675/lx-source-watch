import { useEffect, useState } from 'react';
import { api, type AppSettingsView, type SchedulerStatus, type SystemView } from '../api';
import { ErrorBox, Spinner } from '../components/Feedback';

type Draft = AppSettingsView;

const EMPTY_DRAFT: Draft = {
  probeEnabled: true,
  probeIntervalHours: 4,
  probeLimit: 0,
  probeConcurrency: 2,
  probeDeep: false,
  preferMirror: true,
  cnEnabled: true,
  cnMaxProxies: 8,
  cnConcurrency: 5,
  cnMaxHops: 5,
  cnAutoSwitch: true,
  proxyFetchUserAgent: '',
  proxyTestEnabled: true,
  proxyTestIntervalHours: 6,
  proxyTestConcurrency: 5,
  proxyTestTimeoutMs: 20_000,
  discoveryEnabled: true,
  discoveryIntervalHours: 12,
  autoPromoteCandidates: true,
  autoPromoteMaxPerRun: 3,
  retentionDetailDays: 14,
  retentionDailyDays: 180,
  retentionEventDays: 180,
  quotaKvWrites: 920,
  quotaD1Writes: 90_000,
};

function formatWhen(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

interface NumberFieldProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

function NumberField({ label, hint, value, min, max, onChange }: NumberFieldProps) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

interface TextFieldProps {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  onChange: (value: string) => void;
}

function TextField({ label, hint, value, placeholder, maxLength, onChange }: TextFieldProps) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

interface SwitchFieldProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

function SwitchField({ label, hint, checked, onChange }: SwitchFieldProps) {
  return (
    <label className="switch-field">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <span className="field-label">{label}</span>
        {hint ? <span className="field-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

function JobStatus({ title, job }: { title: string; job?: { intervalHours: number; nextAt: string; lastAt?: string; lastOk?: boolean; lastError?: string; enabled?: boolean } }) {
  if (!job) {
    return (
      <div className="schedule-item">
        <strong>{title}</strong>
        <span className="muted">未启用</span>
      </div>
    );
  }
  return (
    <div className="schedule-item">
      <strong>{title}</strong>
      <span>每 {job.intervalHours} 小时</span>
      <span>{job.enabled === false ? '已关闭，未安排下次运行' : `下次：${formatWhen(job.nextAt)}`}</span>
      <span className={job.enabled === false ? 'text-bad' : 'text-ok'}>
        {job.enabled === false ? '已关闭' : job.lastOk === false ? `上次失败：${job.lastError ?? '未知原因'}` : '正常'}
      </span>
    </div>
  );
}

export function SettingsPage() {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [system, setSystem] = useState<SystemView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsResult, systemResult] = await Promise.all([api.settings(), api.system()]);
      setDraft(settingsResult.settings);
      setScheduler(settingsResult.scheduler);
      setSystem(systemResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载设置失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.saveSettings(draft);
      setDraft(result.settings);
      setScheduler(result.scheduler);
      setNotice('设置已保存，下一轮调度按新参数执行');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm('恢复默认设置？当前改动会丢失。')) return;
    setSaving(true);
    try {
      const result = await api.resetSettings();
      setDraft(result.settings);
      setScheduler(result.scheduler);
      setNotice('已恢复默认设置');
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复失败');
    } finally {
      setSaving(false);
    }
  };

  const runDiscovery = async () => {
    try {
      await api.runDiscovery();
      setNotice('已触发一次自动发现，稍后到候选源查看结果');
    } catch (err) {
      setError(err instanceof Error ? err.message : '触发失败');
    }
  };

  const promote = async () => {
    try {
      const result = await api.promoteCandidates();
      setNotice(`自动收录完成：收录 ${result.promoted.length} 个，跳过 ${result.skipped} 个${result.errors.length ? `，${result.errors.length} 个失败` : ''}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '收录失败');
    }
  };

  const clearRejected = async () => {
    if (!window.confirm('删除全部“已拒绝”的候选？')) return;
    try {
      const result = await api.deleteRejectedCandidates();
      setNotice(`已删除 ${result.deleted} 个已拒绝候选`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '清理失败');
    }
  };

  if (loading) return <Spinner label="读取设置" />;
  if (error && !system) return <ErrorBox message={error} onRetry={load} />;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>设置</h1>
          <p className="page-sub">探测、国内补测、代理测活、候选自动收录与数据保留，都从这里调整。</p>
        </div>
        <div className="page-actions">
          <button type="button" className="ghost-button" onClick={load} disabled={saving}>
            重新读取
          </button>
          <button type="button" className="primary-button" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      </header>

      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="notice notice-bad">{error}</p> : null}

      <div className="settings-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>探测调度</h2>
            <span className="muted">调度由云端每 5 分钟检查一次</span>
          </div>
          <div className="settings-body">
            <SwitchField
              label="启用定时探测"
              hint="关闭后只能从工作台手动运行"
              checked={draft.probeEnabled}
              onChange={(value) => update('probeEnabled', value)}
            />
            <NumberField
              label="探测间隔（小时）"
              min={1}
              max={24}
              value={draft.probeIntervalHours}
              onChange={(value) => update('probeIntervalHours', value)}
            />
            <NumberField
              label="每轮最多测几个源"
              hint="0 表示全部"
              min={0}
              max={999}
              value={draft.probeLimit}
              onChange={(value) => update('probeLimit', value)}
            />
            <NumberField
              label="源并发"
              min={1}
              max={8}
              value={draft.probeConcurrency}
              onChange={(value) => update('probeConcurrency', value)}
            />
            <SwitchField
              label="深度音质检测"
              hint="从脚本声明的最高音质开始试，失败再降级"
              checked={draft.probeDeep}
              onChange={(value) => update('probeDeep', value)}
            />
            <SwitchField
              label="优先镜像下载"
              hint="主地址失败时先用加速镜像"
              checked={draft.preferMirror}
              onChange={(value) => update('preferMirror', value)}
            />
          </div>
          {scheduler ? (
            <div className="schedule-list">
              <JobStatus title="探测" job={scheduler.probe} />
              <JobStatus title="自动发现" job={scheduler.discovery} />
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>订阅拉取</h2>
            <span className="muted">Worker 与 Actions 共用</span>
          </div>
          <div className="settings-body">
            <TextField
              label="默认 User-Agent"
              hint="订阅没单独设置 UA 时使用；留空用内置 UA"
              value={draft.proxyFetchUserAgent}
              placeholder="ClashforWindows/0.20.39"
              maxLength={200}
              onChange={(value) => update('proxyFetchUserAgent', value)}
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>国内补测</h2>
            <span className="muted">独立标记，不影响整体可用状态</span>
          </div>
          <div className="settings-body">
            <SwitchField
              label="启用国内补测"
              hint="探测完成后用国内代理再测一遍播放地址"
              checked={draft.cnEnabled}
              onChange={(value) => update('cnEnabled', value)}
            />
            <NumberField
              label="最多尝试几个代理"
              min={1}
              max={20}
              value={draft.cnMaxProxies}
              onChange={(value) => update('cnMaxProxies', value)}
            />
            <NumberField
              label="补测并发"
              min={1}
              max={10}
              value={draft.cnConcurrency}
              onChange={(value) => update('cnConcurrency', value)}
            />
            <NumberField
              label="内核跳板数"
              hint="内核节点最多试几个普通代理作为跳板"
              min={1}
              max={5}
              value={draft.cnMaxHops}
              onChange={(value) => update('cnMaxHops', value)}
            />
            <SwitchField
              label="失败自动换节点"
              hint="关闭后首个代理失败就停止，不再尝试下一个"
              checked={draft.cnAutoSwitch}
              onChange={(value) => update('cnAutoSwitch', value)}
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>代理测活</h2>
            <span className="muted">定时测试代理出口与延迟</span>
          </div>
          <div className="settings-body">
            <SwitchField
              label="启用定时测活"
              checked={draft.proxyTestEnabled}
              onChange={(value) => update('proxyTestEnabled', value)}
            />
            <NumberField
              label="测活间隔（小时）"
              min={1}
              max={72}
              value={draft.proxyTestIntervalHours}
              onChange={(value) => update('proxyTestIntervalHours', value)}
            />
            <NumberField
              label="测活并发"
              min={1}
              max={10}
              value={draft.proxyTestConcurrency}
              onChange={(value) => update('proxyTestConcurrency', value)}
            />
            <NumberField
              label="单节点超时（毫秒）"
              hint="5000–90000"
              min={5_000}
              max={90_000}
              value={draft.proxyTestTimeoutMs}
              onChange={(value) => update('proxyTestTimeoutMs', value)}
            />
          </div>
          {scheduler ? <div className="schedule-list"><JobStatus title="代理测活" job={scheduler.proxyTest} /></div> : null}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>候选与自动收录</h2>
            <span className="muted">发现只抓清单，收录前要求初始化通过</span>
          </div>
          <div className="settings-body">
            <SwitchField
              label="定时自动发现"
              hint="从配置的仓库里找新的 .js 音源"
              checked={draft.discoveryEnabled}
              onChange={(value) => update('discoveryEnabled', value)}
            />
            <NumberField
              label="发现间隔（小时）"
              min={1}
              max={168}
              value={draft.discoveryIntervalHours}
              onChange={(value) => update('discoveryIntervalHours', value)}
            />
            <SwitchField
              label="自动收录候选"
              hint="初始化通过并声明了平台，就自动进入正式清单"
              checked={draft.autoPromoteCandidates}
              onChange={(value) => update('autoPromoteCandidates', value)}
            />
            <NumberField
              label="每轮最多收录"
              min={1}
              max={10}
              value={draft.autoPromoteMaxPerRun}
              onChange={(value) => update('autoPromoteMaxPerRun', value)}
            />
          </div>
          <div className="form-actions">
            <button type="button" className="ghost-button" onClick={runDiscovery}>
              立即发现
            </button>
            <button type="button" className="ghost-button" onClick={promote}>
              立即收录
            </button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>数据保留</h2>
            <span className="muted">每天清理一次</span>
          </div>
          <div className="settings-body">
            <NumberField
              label="运行明细（天）"
              hint="单轮逐源/逐平台结果"
              min={3}
              max={60}
              value={draft.retentionDetailDays}
              onChange={(value) => update('retentionDetailDays', value)}
            />
            <NumberField
              label="日汇总（天）"
              min={30}
              max={365}
              value={draft.retentionDailyDays}
              onChange={(value) => update('retentionDailyDays', value)}
            />
            <NumberField
              label="事件（天）"
              min={7}
              max={365}
              value={draft.retentionEventDays}
              onChange={(value) => update('retentionEventDays', value)}
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>额度护栏</h2>
            <span className="muted">达到阈值时暂停自动派发</span>
          </div>
          <div className="settings-body">
            <NumberField
              label="KV 每日写入上限"
              hint="默认 920；免费额度为 1000 次/天"
              min={100}
              max={1_000}
              value={draft.quotaKvWrites}
              onChange={(value) => update('quotaKvWrites', value)}
            />
            <NumberField
              label="D1 每日写入上限"
              hint="默认 90000；免费额度为 100000 行/天"
              min={10_000}
              max={100_000}
              value={draft.quotaD1Writes}
              onChange={(value) => update('quotaD1Writes', value)}
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>系统信息</h2>
            <span className="muted">部署与令牌状态</span>
          </div>
          {system ? (
            <div className="settings-body">
              <p className="muted">
                {system.site} · 仓库 {system.repo} · 数据结构 v{system.schemaVersion}
              </p>
              <p className="muted">
                令牌：GitHub 触发 {system.tokens.github ? '已配置' : '未配置'}；Cloudflare 统计{' '}
                {system.tokens.cloudflare ? '已配置' : '未配置'}；Runner {system.tokens.runner ? '已配置' : '未配置'}；
                上报 {system.tokens.ingest ? '已配置' : '未配置'}
              </p>
              <p className="muted">
                正式音源 {system.counts.sources} 个；候选{' '}
                {Object.entries(system.counts.candidates)
                  .map(([state, count]) => `${state} ${count}`)
                  .join('、') || '无'}
              </p>
              <p className="muted">服务器时间：{formatWhen(system.serverTime)}</p>
            </div>
          ) : null}
        </section>

        <section className="panel panel-danger">
          <div className="panel-head">
            <h2>危险操作</h2>
          </div>
          <div className="settings-body">
            <p className="muted">恢复默认设置会覆盖当前所有调度参数；清空已拒绝候选不可恢复。</p>
          </div>
          <div className="form-actions">
            <button type="button" className="ghost-button danger" onClick={reset}>
              恢复默认设置
            </button>
            <button type="button" className="ghost-button danger" onClick={clearRejected}>
              清空已拒绝候选
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
