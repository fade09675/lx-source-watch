import { describe, expect, it } from 'vitest';
import { MirrorConfigError, validateMirrorTemplates } from '../src/mirrors';

const first = { id: 'gh-proxy', name: 'gh-proxy', template: 'https://gh-proxy.com/{url}', enabled: true };
const second = {
  id: 'jsd',
  name: 'jsDelivr',
  template: 'https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}',
  enabled: false,
};

describe('validateMirrorTemplates', () => {
  it('接受合法列表', () => {
    expect(validateMirrorTemplates([first, second])).toHaveLength(2);
  });

  it('拒绝空列表', () => {
    expect(() => validateMirrorTemplates([])).toThrow(MirrorConfigError);
    expect(() => validateMirrorTemplates([])).toThrow(/至少保留一条/);
  });

  it('拒绝非法模板地址', () => {
    expect(() =>
      validateMirrorTemplates([{ id: 'bad', name: 'bad', template: 'http://x/{url}', enabled: true }]),
    ).toThrow(/https/);
  });

  it('拒绝重复 id 与重复地址', () => {
    expect(() => validateMirrorTemplates([first, { ...second, id: 'gh-proxy' }])).toThrow(/id 重复/);
    expect(() => validateMirrorTemplates([first, { ...second, template: first.template }])).toThrow(/地址重复/);
  });

  it('拒绝超过 10 条', () => {
    const many = Array.from({ length: 11 }, (_, index) => ({
      id: `t${index}`,
      name: `T${index}`,
      template: 'https://gh-proxy.com/{url}',
      enabled: true,
    }));
    expect(() => validateMirrorTemplates(many)).toThrow(MirrorConfigError);
  });
});
