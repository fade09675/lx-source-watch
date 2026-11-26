import { describe, expect, it } from 'vitest';
import { D1_BATCH_SIZE, runInBatches } from '../src/batch.js';

describe('runInBatches', () => {
  it('288 条语句按 50 条一批提交，最后一批 38 条', async () => {
    const sizes: number[] = [];
    const statements = Array.from({ length: 288 }, (_, index) => index);

    await runInBatches(
      {
        async batch(batch) {
          sizes.push(batch.length);
          return [];
        },
      },
      statements,
    );

    expect(D1_BATCH_SIZE).toBe(50);
    expect(sizes).toEqual([50, 50, 50, 50, 50, 38]);
  });

  it('没有语句时不发起 batch', async () => {
    let calls = 0;
    await runInBatches(
      {
        async batch() {
          calls += 1;
          return [];
        },
      },
      [],
    );
    expect(calls).toBe(0);
  });
});
