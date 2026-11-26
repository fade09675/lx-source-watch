import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE_URL ?? 'https://dash.dpdns.org';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const OUT = process.env.E2E_OUT ?? 'out/e2e';
const DESKTOP = { width: 1440, height: 1000 };
const MOBILE = { width: 390, height: 844 };

if (!PASSWORD) {
  console.error('缺少 E2E_PASSWORD。请用 E2E_PASSWORD=站点访问密码 运行。');
  process.exit(2);
}

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [];
  const cache = join(homedir(), 'AppData', 'Local', 'ms-playwright');
  if (existsSync(cache)) {
    for (const name of readdirSync(cache).filter((item) => item.startsWith('chromium-')).sort().reverse()) {
      candidates.push(
        join(cache, name, 'chrome-win64', 'chrome.exe'),
        join(cache, name, 'chrome-win', 'chrome.exe'),
      );
    }
    for (const name of readdirSync(cache).filter((item) => item.startsWith('chromium_headless_shell-')).sort().reverse()) {
      candidates.push(join(cache, name, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    }
  }
  candidates.push(
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  );
  return candidates.find((item) => existsSync(item));
}

const executablePath = findChrome();
if (!executablePath) {
  console.error('找不到 Chromium/Chrome。请设置 CHROME_PATH，或先安装 Playwright Chromium。');
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

const failures = [];
const passed = [];
const localTarget = /(^|\/\/)(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE);
function check(name, condition, detail = '') {
  if (condition) {
    passed.push(name);
    console.log(`  ok  ${name}`);
  } else {
    failures.push(`${name}${detail ? `：${detail}` : ''}`);
    console.log(`FAIL  ${name}${detail ? `：${detail}` : ''}`);
  }
}

async function text(page, selector) {
  return (await page.locator(selector).first().textContent().catch(() => ''))?.trim() ?? '';
}

async function login(context) {
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'commit', timeout: 60_000 });
  await page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForSelector('h1', { timeout: 20_000 });
  await page.close();
}

async function auditContext(context, viewport, suffix) {
  const pages = [
    ['工作台', '/', '概览'],
    ['音源总览', '/sources', '音源总览'],
    ['候选源', '/candidates', '候选源'],
    ['重复与别名', '/admin/duplicates', '重复与别名'],
    ['音源管理', '/admin/sources', '音源管理'],
    ['运行与日志', '/runs', '运行与日志'],
    ['国内代理', '/admin/proxies', '国内代理池'],
    ['测活日志', '/admin/proxy-tests', '代理测活日志'],
    ['设置', '/admin/settings', '设置'],
    ['说明', '/about', '关于这个项目'],
  ];
  for (const [name, path, expected] of pages) {
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    const response = await page.goto(`${BASE}${path}`, { waitUntil: 'commit', timeout: 60_000 });
    await page.waitForSelector('h1', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(900);
    const heading = await text(page, 'h1');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    const relevantErrors = localTarget
      ? errors.filter((message) => !/status of 503/.test(message))
      : errors;
    await page.screenshot({ path: `${OUT}/${suffix}-${name}.png`, fullPage: true });
    check(`${suffix} ${name} 状态`, response?.status() === 200, `HTTP ${response?.status()}`);
    check(`${suffix} ${name} 标题`, heading.includes(expected), heading || '空');
    check(`${suffix} ${name} 无横向溢出`, !overflow);
    check(`${suffix} ${name} 无控制台错误`, relevantErrors.length === 0, relevantErrors.slice(0, 2).join(' | '));
    await page.close();
  }

  const source = await context.newPage();
  await source.goto(`${BASE}/sources`, { waitUntil: 'commit', timeout: 60_000 });
  const firstSource = await source.locator('a[href^="/s/"]').first().getAttribute('href');
  check(`${suffix} 音源详情链接存在`, Boolean(firstSource));
  if (firstSource) {
    const response = await source.goto(`${BASE}${firstSource}`, { waitUntil: 'commit', timeout: 60_000 });
    await source.waitForSelector('h1', { timeout: 20_000 }).catch(() => {});
    await source.waitForTimeout(300);
    const heading = await text(source, 'h1');
    check(`${suffix} 音源详情`, response?.status() === 200 && Boolean(heading), heading || '空');
    const tabs = source.locator('.detail-tabs button');
    if ((await tabs.count()) > 1) {
      await tabs.nth(1).click();
      await source.waitForTimeout(500);
      await source.screenshot({ path: `${OUT}/${suffix}-音源详情-平台.png`, fullPage: true });
      check(`${suffix} 音源详情切平台`, (await source.locator('.platform-card').count()) > 0);
    }
  }
  await source.close();

  const runs = await context.newPage();
  await runs.goto(`${BASE}/runs`, { waitUntil: 'commit', timeout: 60_000 });
  const firstRun = await runs.locator('a[href^="/runs/"]').first().getAttribute('href');
  check(`${suffix} 运行详情链接存在`, Boolean(firstRun));
  if (firstRun) {
    const response = await runs.goto(`${BASE}${firstRun}`, { waitUntil: 'commit', timeout: 60_000 });
    await runs.waitForSelector('h1', { timeout: 20_000 }).catch(() => {});
    await runs.waitForTimeout(300);
    check(`${suffix} 运行详情`, response?.status() === 200 && (await runs.locator('h1').count()) > 0);
    await runs.screenshot({ path: `${OUT}/${suffix}-运行详情.png`, fullPage: true });
    const logTab = runs.getByRole('button', { name: '运行日志' });
    if ((await logTab.count()) > 0) {
      await logTab.first().click();
      await runs.waitForTimeout(400);
      check(`${suffix} 运行日志 tab`, (await runs.locator('#run-log').count()) > 0);
    }
  }
  await runs.close();

  const admin = await context.newPage();
  await admin.goto(`${BASE}/admin`, { waitUntil: 'commit', timeout: 60_000 });
  await admin.waitForURL('**/admin/settings', { timeout: 10_000 }).catch(() => {});
  await admin.waitForTimeout(300);
  check(`${suffix} 旧控制面板跳转设置`, new URL(admin.url()).pathname === '/admin/settings', admin.url());
  await admin.close();

  const notFound = await context.newPage();
  await notFound.goto(`${BASE}/__e2e_missing__`, { waitUntil: 'commit', timeout: 60_000 });
  await notFound.waitForTimeout(400);
  check(`${suffix} 未知路由 404`, (await text(notFound, 'h1')).includes('页面不存在'));
  await notFound.goto(`${BASE}/s/__e2e_missing__`, { waitUntil: 'commit', timeout: 60_000 });
  await notFound.waitForTimeout(400);
  check(`${suffix} 假音源 404`, (await text(notFound, 'h1')).includes('无法打开音源详情'));
  await notFound.screenshot({ path: `${OUT}/${suffix}-404.png`, fullPage: true });
  await notFound.close();

  const api = await context.request.get(`${BASE}/api/status?cn=bogus`);
  check(`${suffix} cn 非法值返回 400`, api.status() === 400, `HTTP ${api.status()}`);
}

console.log(`目标 ${BASE}，浏览器 ${executablePath}`);
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const desktop = await browser.newContext({ viewport: DESKTOP, ignoreHTTPSErrors: true });
  await login(desktop);
  const state = await desktop.storageState();
  console.log('\n桌面 1440');
  await auditContext(desktop, DESKTOP, 'desktop');
  await desktop.close();

  const mobile = await browser.newContext({ viewport: MOBILE, storageState: state, ignoreHTTPSErrors: true });
  console.log('\n移动 390');
  await auditContext(mobile, MOBILE, 'mobile');
  await mobile.close();
} finally {
  await browser.close();
}

console.log(`\n通过 ${passed.length} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
