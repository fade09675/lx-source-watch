import { describe, expect, it } from 'vitest';
import {
  MAX_SOURCE_FILE_BYTES,
  downloadFilename,
  parseScriptMeta,
  sanitizeSourceFilename,
  scriptUrl,
  sha256Hex,
  validateUpload,
} from '../src/sourceFiles.js';

const validScript = `/**
 * @name 测试音源
 * @version 1.0.0
 * @author 测试作者
 */
const source = { name: '测试音源' };
module.exports = source;
`;

describe('validateUpload', () => {
  it('接受带元数据的 .js 脚本', () => {
    const result = validateUpload({
      filename: '测试 音源.js',
      content: validScript,
      testAfterSave: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('测试音源');
    expect(result.value.author).toBe('测试作者');
    expect(result.value.category).toBe('上传');
    expect(result.value.testAfterSave).toBe(true);
    expect(result.value.bytes).toBeGreaterThan(50);
  });

  it('拒绝非 js、空内容、HTML、过短脚本', () => {
    expect(validateUpload({ filename: 'a.txt', content: validScript }).ok).toBe(false);
    expect(validateUpload({ filename: 'a.js', content: '' }).ok).toBe(false);
    expect(validateUpload({ filename: 'a.js', content: '<!doctype html><html></html>' }).ok).toBe(false);
    expect(validateUpload({ filename: 'a.js', content: 'short' }).ok).toBe(false);
  });

  it('拒绝超过 2MB 的脚本', () => {
    const huge = `// ${'x'.repeat(MAX_SOURCE_FILE_BYTES)}\n`;
    expect(validateUpload({ filename: 'a.js', content: huge }).ok).toBe(false);
  });
});

describe('parseScriptMeta', () => {
  it('解析 @name/@version/@author/@description', () => {
    expect(
      parseScriptMeta('/**\n * @name 甲\n * @version 2.1\n * @author 乙\n * @description 丙\n */\nconst a = 1;'),
    ).toEqual({ name: '甲', version: '2.1', author: '乙', description: '丙' });
  });
});

describe('文件名与哈希', () => {
  it('清理路径与控制字符', () => {
    expect(sanitizeSourceFilename('C:\\tmp\\a<b>.js')).toBe('a_b_.js');
    expect(downloadFilename('测试/音源.js')).toBe('音源.js');
  });

  it('sha256 稳定且为 64 位 hex', async () => {
    const first = await sha256Hex('abc');
    const second = await sha256Hex('abc');
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('生成公开哈希地址', () => {
    const sha = 'a'.repeat(64);
    expect(scriptUrl('https://example.com', sha)).toBe(`https://example.com/scripts/${sha}.js`);
  });
});
