import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../src/csv.js';

describe('csvCell', () => {
  it('普通值不加引号', () => {
    expect(csvCell('pdone-changqing')).toBe('pdone-changqing');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(true)).toBe('true');
    expect(csvCell('')).toBe('');
    expect(csvCell(null)).toBe('');
  });

  it('含逗号、双引号、换行时才加引号', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('首尾空白加引号以保留内容', () => {
    expect(csvCell('  padded  ')).toBe('"  padded  "');
  });
});

describe('toCsv', () => {
  it('输出表头与一行数据', () => {
    const text = toCsv([
      {
        id: 'demo',
        title: '示例, 源',
        url: 'https://example.com/a.js',
        homepage: undefined,
        status: 'available',
        ok: 2,
        tested: 2,
        total: 2,
        platforms: [{ key: 'wy', ok: true, tested: true, ms: 12 }],
      },
    ]);
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('id,title,url,mirror,homepage,status,ok,tested,total,platforms');
    expect(lines[1]).toBe('demo,"示例, 源",https://example.com/a.js,,,available,2,2,2,wy:ok');
  });
});
