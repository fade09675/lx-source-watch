import { describe, expect, it } from 'vitest';
import { normalizeSourceUrl } from '../src/aliases';

describe('normalizeSourceUrl', () => {
  it('lowercases scheme and host', () => {
    expect(normalizeSourceUrl('HTTPS://Raw.GitHubUserContent.com/a/b.js')).toBe(
      'https://raw.githubusercontent.com/a/b.js',
    );
  });

  it('drops fragments, default ports and trailing slashes', () => {
    expect(normalizeSourceUrl('https://example.com:443/a/b.js/#x')).toBe('https://example.com/a/b.js');
    expect(normalizeSourceUrl('http://example.com:80/a/b.js/')).toBe('http://example.com/a/b.js');
  });

  it('removes cache-busting query keys but keeps meaningful ones', () => {
    expect(normalizeSourceUrl('https://example.com/a.js?t=123&source=cihedai')).toBe(
      'https://example.com/a.js?source=cihedai',
    );
  });

  it('keeps root path as a single slash', () => {
    expect(normalizeSourceUrl('https://example.com')).toBe('https://example.com/');
  });

  it('returns the trimmed input when it is not a URL', () => {
    expect(normalizeSourceUrl('  not a url  ')).toBe('not a url');
  });
});
