import pc from 'picocolors';

const debugEnabled = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

function stamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

export const log = {
  info(msg: string): void {
    console.log(`${pc.dim(stamp())} ${msg}`);
  },
  step(msg: string): void {
    console.log(`\n${pc.bold(pc.cyan('▶'))} ${pc.bold(msg)}`);
  },
  success(msg: string): void {
    console.log(`${pc.green('✔')} ${msg}`);
  },
  warn(msg: string): void {
    console.warn(`${pc.yellow('!')} ${msg}`);
  },
  error(msg: string): void {
    console.error(`${pc.red('✖')} ${msg}`);
  },
  debug(msg: string): void {
    if (debugEnabled) console.error(`${pc.dim('·')} ${pc.dim(msg)}`);
  },
};
