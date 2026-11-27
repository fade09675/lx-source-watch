import { describe, expect, it } from 'vitest';
import { parseJsonl, textToJsonl } from '../src/run-log.js';

describe('textToJsonl', () => {
  it('把带时间的日志转换成一行一个 JSON', () => {
    const text = [
      '03:12:34 开始探测',
      '03:12:35 ! 拉流失败',
      '03:12:36 ✓ 完成',
    ].join('\n');
    const lines = parseJsonl(textToJsonl(text));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ at: '03:12:34', level: 'info', message: '开始探测' });
    expect(lines[1]).toMatchObject({ level: 'warn', message: '拉流失败' });
    expect(lines[2]).toMatchObject({ level: 'success', message: '完成' });
  });

  it('识别方括号 ISO 时间并从消息中移除', () => {
    const lines = parseJsonl(textToJsonl('[2026-11-27T12:54:05.080Z] 国内补测开始'));
    expect(lines[0]).toMatchObject({ at: '2026-11-27T12:54:05.080Z', message: '国内补测开始' });
  });

  it('没有时间的行也保留', () => {
    const lines = parseJsonl(textToJsonl('普通消息\n\n▶ 阶段'));
    expect(lines).toHaveLength(2);
    expect(lines[0]?.message).toBe('普通消息');
    expect(lines[1]?.level).toBe('step');
  });
});
