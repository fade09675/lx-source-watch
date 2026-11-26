import { useEffect, useState } from 'react';
import type { MirrorTemplate } from '@lx/shared';
import { ApiError, api } from '../api';
import { Spinner } from './Feedback';

export function MirrorSettings() {
  const [templates, setTemplates] = useState<MirrorTemplate[] | null>(null);
  const [custom, setCustom] = useState(false);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const config = await api.mirrors();
      setTemplates(config.templates);
      setCustom(config.custom);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : '读取镜像模板失败');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function update(id: string, patch: Partial<MirrorTemplate>) {
    setTemplates((list) => list?.map((item) => (item.id === id ? { ...item, ...patch } : item)) ?? null);
  }

  function add() {
    setTemplates((list) => [
      ...(list ?? []),
      {
        id: `custom-${Date.now().toString(36)}`,
        name: '新镜像',
        template: 'https://example.com/{url}',
        enabled: true,
      },
    ]);
  }

  function remove(id: string) {
    setTemplates((list) => list?.filter((item) => item.id !== id) ?? null);
  }

  async function save() {
    if (!templates) return;
    setSaving(true);
    setMessage('');
    try {
      const config = await api.saveMirrors(templates);
      setTemplates(config.templates);
      setCustom(config.custom);
      setMessage('已保存。下一轮探测会使用新模板。');
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setSaving(true);
    setMessage('');
    try {
      const config = await api.resetMirrors();
      setTemplates(config.templates);
      setCustom(config.custom);
      setMessage('已恢复内置 8 条模板。');
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : '恢复失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel panel-wide">
      <div className="panel-head">
        <h2>加速镜像</h2>
        <span className="muted">探测时逐个下载，按文件指纹判断版本</span>
      </div>
      <p className="muted">
        公共镜像会失效，失效后在这里替换即可，下一轮探测自动生效。模板里可用 <code>{'{url}'}</code> 表示完整原始地址，或用{' '}
        <code>{'{owner}/{repo}/{branch}/{path}'}</code> 拼路径。
      </p>
      {!templates ? (
        <Spinner />
      ) : (
        <>
          <div className="mirror-list">
            {templates.map((mirror) => (
              <div className="mirror-row" key={mirror.id}>
                <input
                  aria-label="镜像名称"
                  value={mirror.name}
                  onChange={(event) => update(mirror.id, { name: event.target.value })}
                />
                <input
                  aria-label="镜像模板"
                  className="mono"
                  value={mirror.template}
                  onChange={(event) => update(mirror.id, { template: event.target.value })}
                />
                <label className="check">
                  <input
                    type="checkbox"
                    checked={mirror.enabled}
                    onChange={(event) => update(mirror.id, { enabled: event.target.checked })}
                  />
                  <span>启用</span>
                </label>
                <button type="button" className="row-link danger" onClick={() => remove(mirror.id)}>
                  删除
                </button>
              </div>
            ))}
          </div>
          <div className="run-form">
            <button type="button" className="ghost-button" onClick={add}>
              添加一条
            </button>
            <button type="button" className="primary-button" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存模板'}
            </button>
            <button type="button" className="ghost-button" onClick={() => void reset()} disabled={saving}>
              恢复默认 8 条
            </button>
            <span className="muted">{custom ? '当前使用自定义模板' : '当前使用内置默认模板'}</span>
          </div>
          {message && <div className="form-message">{message}</div>}
        </>
      )}
    </section>
  );
}
