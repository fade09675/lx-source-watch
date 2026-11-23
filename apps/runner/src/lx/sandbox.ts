import vm from 'node:vm';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { httpRequest, simpleFetch, type ProxyConfig } from '../net/http.js';
import { errorMessage, isRecord, withTimeout } from '../util.js';
import { parseScriptMeta, scriptInfo, type LxMeta } from './meta.js';

interface RequestTrace {
  host: string;
  status?: number;
  error?: string;
}

/** 记录一次取链调用期间脚本发起的请求，用于把“空错误”补全成可诊断的信息。 */
const traceStore = new AsyncLocalStorage<RequestTrace[]>();

function hostOf(raw: string): string {
  try {
    const u = new URL(raw);
    return u.hostname + (u.pathname.length > 32 ? `${u.pathname.slice(0, 32)}…` : u.pathname);
  } catch {
    return raw.slice(0, 48);
  }
}

function enrichCallError(e: unknown, trace: RequestTrace[]): unknown {
  // vm 里的 Error 与宿主不同 realm，只能读 message 属性判断是否为空。
  const rawMessage = (e as { message?: unknown } | null)?.message;
  const msg = typeof rawMessage === 'string' ? rawMessage.trim() : '';
  if (msg && msg !== '{}' && msg !== '[object Object]') return e;
  const last = [...trace].reverse().find((t) => t.error || (t.status !== undefined && t.status >= 400));
  if (!last) return e;
  const detail = last.error
    ? `脚本请求 ${last.host} 失败：${last.error}`
    : `脚本请求 ${last.host} 返回 HTTP ${last.status}`;
  const err = new Error(detail);
  err.name = 'ScriptRequestError';
  return err;
}

export interface LxSourceDeclaration {
  key: string;
  name: string;
  actions: string[];
  qualitys: string[];
}

export interface LxInitData {
  openDevTools?: boolean;
  sources?: Record<string, Partial<LxSourceDeclaration>>;
}

export interface ActionPayload {
  source: string;
  action: string;
  info: { type: string; musicInfo: Record<string, unknown> };
}

export interface LoadOptions {
  code: string;
  filename?: string;
  initTimeoutMs?: number;
  scriptTimeoutMs?: number;
  proxy?: ProxyConfig;
  allowPrivate?: boolean;
}

export interface LoadedSource {
  meta: LxMeta;
  sources: Record<string, LxSourceDeclaration>;
  logs: string[];
  call(payload: ActionPayload, timeoutMs?: number): Promise<string>;
  dispose(): void;
}

type Timer = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value);
  // vm 里创建的 TypedArray 与宿主不同 realm，instanceof 会失败，用 ArrayBuffer.isView 判断。
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    return Buffer.from(new Uint8Array(value as ArrayBuffer));
  }
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.from(String(value));
}

function normalizeIv(iv: Buffer): Buffer {
  if (iv.length === 16) return iv;
  if (iv.length > 16) return iv.subarray(0, 16);
  return Buffer.concat([iv, Buffer.alloc(16 - iv.length)]);
}

function extractUrl(result: unknown): string | undefined {
  if (typeof result === 'string') return result.trim() || undefined;
  if (isRecord(result)) {
    for (const key of ['url', 'musicUrl', 'src']) {
      const v = result[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    if (isRecord(result.data)) {
      for (const key of ['url', 'musicUrl', 'src']) {
        const v = result.data[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  return undefined;
}

function normalizeSources(data: unknown): Record<string, LxSourceDeclaration> | undefined {
  if (!isRecord(data) || !isRecord(data.sources)) return undefined;
  const out: Record<string, LxSourceDeclaration> = {};
  for (const [key, value] of Object.entries(data.sources)) {
    if (!isRecord(value)) continue;
    const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : key;
    const actions = Array.isArray(value.actions)
      ? value.actions.filter((a): a is string => typeof a === 'string')
      : ['musicUrl'];
    const qualitys = Array.isArray(value.qualitys)
      ? value.qualitys.filter((q): q is string => typeof q === 'string')
      : ['128k'];
    out[key] = { key, name, actions, qualitys };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function makeLxRequest(proxy: ProxyConfig | undefined, allowPrivate: boolean | undefined) {
  return function request(
    url: string | URL,
    options?: Record<string, unknown> | ((err: unknown, resp?: unknown, body?: unknown) => void),
    callback?: (err: unknown, resp?: unknown, body?: unknown) => void,
  ): unknown {
    let opts: Record<string, unknown> = {};
    if (typeof options === 'function') {
      callback = options as typeof callback;
    } else if (options) {
      opts = options;
    }
    const ac = new AbortController();

    const promise = (async () => {
      try {
        const headers: Record<string, string> = {};
      const rawHeaders = opts.headers;
      if (rawHeaders && typeof (rawHeaders as { forEach?: unknown }).forEach === 'function') {
        (rawHeaders as { forEach: (fn: (v: string, k: string) => void) => void }).forEach((v, k) => {
          headers[k] = v;
        });
      } else if (isRecord(rawHeaders)) {
        for (const [k, v] of Object.entries(rawHeaders)) headers[k] = String(v);
      }

      let body: string | Buffer | undefined;
      if (isRecord(opts.form)) {
        body = new URLSearchParams(
          Object.entries(opts.form).map(([k, v]) => [k, String(v)]),
        ).toString();
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
          headers['content-type'] = 'application/x-www-form-urlencoded';
        }
      } else if (isRecord(opts.formData)) {
        const boundary = `----lx${crypto.randomBytes(8).toString('hex')}`;
        const parts: Buffer[] = [];
        for (const [k, v] of Object.entries(opts.formData)) {
          parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n`));
          parts.push(toBuffer(v));
          parts.push(Buffer.from('\r\n'));
        }
        parts.push(Buffer.from(`--${boundary}--\r\n`));
        body = Buffer.concat(parts);
        headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
      } else if (opts.body !== undefined) {
        if (typeof opts.body === 'string' || Buffer.isBuffer(opts.body)) {
          body = opts.body;
        } else if (opts.body instanceof Uint8Array) {
          body = Buffer.from(opts.body);
        } else {
          body = JSON.stringify(opts.body);
          if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
            headers['content-type'] = 'application/json';
          }
        }
      }

      const rawTimeout = Number(opts.timeout);
      const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(rawTimeout, 60_000) : 20_000;
      const follow = Number(opts.follow_max ?? opts.followMax ?? 5);
      const maxRedirects = follow === 0 ? 0 : 5;

      const res = await httpRequest(String(url), {
        method: typeof opts.method === 'string' ? opts.method : 'GET',
        headers,
        body,
        timeoutMs,
        maxRedirects,
        signal: ac.signal,
        proxy,
        allowPrivate,
      });

      const contentType = res.headers['content-type'] ?? '';
      const text = res.body.toString('utf8');
      let parsed: unknown = text;
      const head = text.slice(0, 64).trimStart();
      if (contentType.includes('json') || head.startsWith('{') || head.startsWith('[')) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      traceStore.getStore()?.push({ host: hostOf(String(url)), status: res.status });
      return {
        statusCode: res.status,
        statusMessage: res.statusText,
        headers: res.headers,
        body: parsed,
        raw: res.body,
        bytes: res.body.length,
      };
      } catch (e) {
        traceStore.getStore()?.push({ host: hostOf(String(url)), error: errorMessage(e) });
        throw e;
      }
    })();

    if (callback) {
      promise.then(
        (resp) => {
          try {
            callback?.(null, resp, (resp as { body: unknown }).body);
          } catch {
            // 第三方脚本的回调自身抛错时，不能让它变成未处理拒绝拖垮整轮。
          }
        },
        (err) => {
          try {
            callback?.(err);
          } catch {
            // 同上。
          }
        },
      ).catch(() => undefined);
    } else {
      promise.catch(() => undefined);
    }

    const cancel = (() => ac.abort()) as unknown as {
      (): void;
      abort: () => void;
      then: (a?: unknown, b?: unknown) => Promise<unknown>;
    };
    cancel.abort = cancel;
    cancel.then = (a?: unknown, b?: unknown) => {
      const derived = promise.then(
        a as (v: unknown) => unknown,
        b as (e: unknown) => unknown,
      );
      // 脚本常见写法 lx.request(...).then(...) 不带 catch；给派生 Promise 兜底，
      // 避免 Node 把未处理拒绝升级成进程崩溃。
      derived.catch(() => undefined);
      return derived;
    };
    return cancel;
  };
}

function promisifyZlib(
  fn: (buf: Buffer, cb: (err: Error | null, out: Buffer) => void) => void,
): (buf: unknown, cb?: (err: Error | null, out?: Buffer) => void) => Promise<Buffer> {
  return (buf: unknown, cb?: (err: Error | null, out?: Buffer) => void) => {
    const p = new Promise<Buffer>((resolve, reject) => {
      fn(toBuffer(buf), (err, out) => (err ? reject(err) : resolve(out)));
    });
    if (typeof cb === 'function') p.then((out) => cb(null, out), (err) => cb(err as Error));
    return p;
  };
}

export async function loadLxSource(opts: LoadOptions): Promise<LoadedSource> {
  const {
    code,
    filename = 'source.js',
    initTimeoutMs = 12_000,
    scriptTimeoutMs = 15_000,
    proxy,
    allowPrivate,
  } = opts;

  const meta = parseScriptMeta(code, filename);
  const logs: string[] = [];
  const timers = new Set<Timer>();
  const intervals = new Set<Interval>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let disposed = false;
  let inited = false;
  let resolveInit!: (value: unknown) => void;
  let rejectInit!: (reason: unknown) => void;
  const initPromise = new Promise<unknown>((resolve, reject) => {
    resolveInit = resolve;
    rejectInit = reject;
  });

  const log = (level: string, args: unknown[]): void => {
    if (logs.length < 200) {
      logs.push(`${level}: ${args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ')}`.slice(0, 500));
    }
  };

  const pushTimer = (t: Timer): Timer => {
    timers.add(t);
    return t;
  };
  const clearTimer = (t: Timer): void => {
    timers.delete(t);
    clearTimeout(t);
  };
  const wrapSetTimeout = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timer =>
    pushTimer(
      setTimeout(() => {
        try {
          fn(...args);
        } catch (e) {
          log('error', [errorMessage(e)]);
        }
      }, Math.min(Number(ms) || 0, 60_000)),
    );
  const wrapSetInterval = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Interval => {
    const t = setInterval(() => {
      try {
        fn(...args);
      } catch (e) {
        log('error', [errorMessage(e)]);
      }
    }, Math.min(Math.max(Number(ms) || 1, 1), 60_000));
    intervals.add(t);
    return t;
  };

  const lx = {
    version: '2.0.0',
    env: 'desktop',
    currentScriptInfo: scriptInfo(meta, code, filename),
    EVENT_NAMES: Object.freeze({
      inited: 'inited',
      request: 'request',
      updateAlert: 'updateAlert',
      log: 'log',
      downloadProgress: 'downloadProgress',
    }),
    on(name: string, handler: (...args: unknown[]) => unknown): void {
      if (typeof handler === 'function') handlers.set(name, handler);
    },
    send(name: string, data?: unknown): void {
      if (name !== 'inited' || inited) return;
      inited = true;
      resolveInit(data);
    },
    request: makeLxRequest(proxy, allowPrivate),
    utils: {
      buffer: {
        from: (data: unknown, encoding?: BufferEncoding): Buffer =>
          typeof data === 'string' ? Buffer.from(data, encoding) : toBuffer(data),
        bufToString: (buf: unknown, encoding: BufferEncoding = 'utf8'): string =>
          toBuffer(buf).toString(encoding),
      },
      crypto: {
        md5: (data: unknown): string => crypto.createHash('md5').update(toBuffer(data)).digest('hex'),
        randomBytes: (size: number): Buffer => crypto.randomBytes(Math.max(1, Math.min(Number(size) || 1, 4096))),
        aesEncrypt: (data: unknown, mode: string, key: unknown, iv: unknown): Buffer => {
          const algorithm = typeof mode === 'string' && mode.startsWith('aes-') ? mode : 'aes-128-cbc';
          const keyBuf = toBuffer(key);
          const ivBuf = toBuffer(iv);
          // ECB 不接受 IV，必须传 null；CBC 的 IV 统一成 16 字节，兼容传空/传长的脚本。
          const normalizedIv = /-ecb$/i.test(algorithm) ? null : normalizeIv(ivBuf);
          const cipher = crypto.createCipheriv(algorithm, keyBuf, normalizedIv);
          return Buffer.concat([cipher.update(toBuffer(data)), cipher.final()]);
        },
        rsaEncrypt: (data: unknown, key: unknown): Buffer => {
          const keyBuf = toBuffer(key);
          const input = toBuffer(data);
          const padded = Buffer.concat([Buffer.alloc(Math.max(0, 128 - input.length)), input.subarray(0, 128)]);
          return crypto.publicEncrypt(
            { key: keyBuf, padding: crypto.constants.RSA_NO_PADDING },
            padded,
          );
        },
      },
      zlib: {
        inflate: promisifyZlib((buf, cb) => zlib.inflate(buf, cb)),
        deflate: promisifyZlib((buf, cb) => zlib.deflate(buf, cb)),
      },
    },
  };

  const noop = (): void => {};
  const consoleStub = {
    log: (...args: unknown[]) => log('log', args),
    info: (...args: unknown[]) => log('info', args),
    warn: (...args: unknown[]) => log('warn', args),
    error: (...args: unknown[]) => log('error', args),
    debug: (...args: unknown[]) => log('debug', args),
    // 音源脚本常用 group/table 等浏览器方法，缺失会导致整个源初始化失败。
    trace: noop,
    dir: noop,
    dirxml: noop,
    table: noop,
    group: noop,
    groupCollapsed: noop,
    groupEnd: noop,
    time: noop,
    timeEnd: noop,
    timeLog: noop,
    count: noop,
    countReset: noop,
    clear: noop,
    assert: (condition: unknown, ...args: unknown[]): void => {
      if (!condition) log('error', ['Assertion failed', ...args]);
    },
  };

  const sandbox: Record<string, unknown> = {
    lx,
    console: consoleStub,
    setTimeout: wrapSetTimeout,
    clearTimeout: clearTimer,
    setInterval: wrapSetInterval,
    clearInterval: (t: Interval) => {
      intervals.delete(t);
      clearInterval(t);
    },
    setImmediate: (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
      pushTimer(setTimeout(() => fn(...args), 0) as unknown as Timer),
    clearImmediate: (t: Timer) => clearTimer(t),
    queueMicrotask: (fn: () => void) => queueMicrotask(fn),
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    Headers,
    Request,
    Response,
    fetch: (input: string | URL, init?: Record<string, unknown>) =>
      simpleFetch(input, init as never, proxy),
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    structuredClone,
    process: {
      env: {},
      platform: process.platform,
      version: process.version,
      nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
      argv: [],
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  try {
    const context = vm.createContext(sandbox, {
      name: filename,
      codeGeneration: { strings: true, wasm: false },
    });
    const script = new vm.Script(code, { filename });
    script.runInContext(context, { timeout: scriptTimeoutMs, displayErrors: true });
  } catch (e) {
    throw new Error(`脚本执行失败：${errorMessage(e)}`);
  }

  let initData: unknown;
  try {
    initData = await withTimeout(initPromise, initTimeoutMs, `初始化超时（${initTimeoutMs}ms）`);
  } catch (e) {
    throw new Error(`初始化失败：${errorMessage(e)}`);
  }

  if (isRecord(initData) && initData.status === false) {
    const reason =
      (typeof initData.errorMessage === 'string' && initData.errorMessage) ||
      (typeof initData.message === 'string' && initData.message) ||
      '脚本返回 status=false';
    throw new Error(`初始化失败：${reason}`);
  }

  const sources = normalizeSources(initData);
  if (!sources) {
    throw new Error('初始化失败：音源未声明任何平台（inited.sources 为空）');
  }

  const call = async (payload: ActionPayload, timeoutMs = 20_000): Promise<string> => {
    if (disposed) throw new Error('沙箱已释放');
    const handler = handlers.get('request') ?? handlers.get('musicUrl');
    if (!handler) throw new Error('脚本未注册 request 事件');
    const trace: RequestTrace[] = [];
    const invoke = (): Promise<unknown> =>
      handler.length >= 2
        ? new Promise<unknown>((resolve, reject) => {
            handler(payload, (err: unknown, res: unknown) => (err ? reject(err) : resolve(res)));
          })
        : Promise.resolve(handler(payload));
    let result: unknown;
    try {
      result = await traceStore.run(trace, () =>
        withTimeout(invoke(), timeoutMs, `取链超时（${timeoutMs}ms）`),
      );
    } catch (e) {
      throw enrichCallError(e, trace);
    }
    const url = extractUrl(result);
    if (!url) throw new Error('脚本未返回播放地址');
    return url;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const t of timers) clearTimeout(t);
    for (const t of intervals) clearInterval(t);
    timers.clear();
    intervals.clear();
    handlers.clear();
    rejectInit(new Error('沙箱已释放'));
    initPromise.catch(() => undefined);
  };

  return { meta, sources, logs, call, dispose };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
