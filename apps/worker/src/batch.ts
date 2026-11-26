/**
 * D1 的 batch 能显著减少跨网络往返；但一次塞太多语句也会放大单个请求。
 * 统一按小块提交，既避免几百条串行 UPDATE，也避免单个超大 batch。
 */
export const D1_BATCH_SIZE = 50;

export async function runInBatches<T>(
  db: { batch(statements: T[]): Promise<unknown> },
  statements: T[],
  size = D1_BATCH_SIZE,
): Promise<void> {
  if (size <= 0) throw new Error('batch size must be positive');
  for (let index = 0; index < statements.length; index += size) {
    await db.batch(statements.slice(index, index + size));
  }
}
