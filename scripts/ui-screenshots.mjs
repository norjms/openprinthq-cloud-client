// Screenshots of the app window's web UI (app/ui), with sample data and a stand-in for the Tauri bridge.
//
//   node scripts/ui-screenshots.mjs <out dir>
//
// Needs the playwright package with Chromium and WebKit (WebView2 on Windows is Chromium; WKWebView on macOS and
// WebKitGTK on Linux are WebKit). Each view is the window's content at a real window size under a neutral title
// bar: the default 960 x 640 and the narrowest useful 440 x 600. A view fails when the page itself scrolls, a box
// clips its content, a script throws, Manrope did not load, text uses a colour outside artisanhub-ui's text set,
// or the copy holds an em dash. Nothing here talks to an instance or starts a connector.
import { chromium, webkit } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = join(root, 'app', 'ui');
const out = resolve(process.argv[2] || join(root, 'shots'));
const version = JSON.parse(readFileSync(join(root, 'app', 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
const TITLE = 38;

const bridge = (state) => `<script>(function(){
  const state = ${JSON.stringify(state)};
  const cfg = state === 'wizard' ? { control_url: '' } : { control_url: 'https://openprinthq.com', token: 'ophqc_xxxxxxxxxxxxxxxxxxxx',
    name: 'basement-print-room', allow: 'private', allow_ports: '80,443,7125,8080,8883,990', test_printer: '192.0.2.50:7125',
    signing_pubkey: '', log_url: '', autostart: true, debug: false };
  const answers = {
    app_version: '${version}', get_config: cfg,
    get_status: state === 'service' ? { running: true, connected: true, managed_by_service: true } : { running: true, connected: true, message: 'connected' },
    run_self_test: { cloud_ok: true, cloud_detail: 'openprinthq.com answered in 38 ms', printer_ok: true, printer_detail: '192.0.2.50:7125 Moonraker answered' },
  };
  window.__TAURI__ = { core: { invoke: async (cmd) => answers[cmd] }, event: { listen: async () => () => {} } };
})();</script>`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/frame') {
    const [w, h, state] = [u.searchParams.get('w'), u.searchParams.get('h'), u.searchParams.get('state')];
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#0f151b;overflow:hidden}
.bar{height:${TITLE}px;display:flex;align-items:center;justify-content:center;position:relative;background:#1f262d;color:rgba(236,243,248,.85);
font:13px system-ui,sans-serif;border-bottom:1px solid rgba(255,255,255,.08)}.bar i{position:absolute;left:14px;display:flex;gap:7px}
.bar i b{width:12px;height:12px;border-radius:6px;background:rgba(255,255,255,.25)}iframe{border:0;display:block;width:${w}px;height:${h}px}</style></head>
<body><div class="bar"><i><b></b><b></b><b></b></i>OpenPrintHQ Cloud Client</div><iframe id="app" src="/app/index.html?state=${state}"></iframe></body></html>`);
    return;
  }
  let f = join(ui, decodeURIComponent(u.pathname.replace(/^\/app\//, '/')));
  if (!f.startsWith(ui) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  let body = readFileSync(f);
  if (f.endsWith('index.html')) body = Buffer.from(body.toString().replace('<head>', '<head>' + bridge(u.searchParams.get('state') || 'normal')));
  res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const TEXT = ['rgb(241, 246, 250)', 'rgba(236, 243, 248, 0.85)', 'rgba(236, 243, 248, 0.75)', 'rgb(191, 230, 255)', 'rgb(143, 211, 255)',
  'rgb(29, 42, 52)', 'rgb(255, 179, 138)', 'rgb(155, 226, 143)', 'rgb(168, 230, 176)', 'rgb(211, 245, 204)', 'rgb(255, 217, 196)',
  'rgb(255, 208, 208)', 'rgb(212, 239, 255)'];
const audit = (TEXTS) => {
  const bad = [];
  const se = document.scrollingElement;
  if (se.scrollHeight > innerHeight + 1 || se.scrollWidth > innerWidth + 1) bad.push(`page scrolls ${se.scrollWidth - innerWidth} x ${se.scrollHeight - innerHeight}`);
  for (const e of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || e.closest('[hidden]') || e.closest('details:not([open])') && e.tagName !== 'SUMMARY') continue;
    if ((cs.overflowX === 'hidden' || cs.overflowY === 'hidden') && e.tagName !== 'BODY' && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)) bad.push('clipped ' + e.tagName + '.' + e.className);
    const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own && !TEXTS.includes(cs.color)) bad.push(`colour ${cs.color} on "${e.textContent.trim().slice(0, 30)}"`);
  }
  if (document.body.innerText.includes('—')) bad.push('em dash');
  if (![...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Manrope' && f.status === 'loaded')) bad.push('Manrope not loaded');
  const main = document.querySelector('main');
  return { bad, mainScrolls: main.scrollHeight > main.clientHeight + 1 };
};

mkdirSync(out, { recursive: true });
const VIEWS = [
  { state: 'normal', sizes: [[960, 640], [440, 600]] },
  { state: 'selftest', sizes: [[960, 640]], click: '#selftest' },
  { state: 'service', sizes: [[960, 640]] },
  { state: 'advanced', sizes: [[960, 640]], click: 'summary' },
  { state: 'wizard', sizes: [[960, 640], [440, 600]] },
  { state: 'wizard', name: 'wizard-connect', sizes: [[960, 640]], click: '#wnext0' },
];
let failures = 0;
for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch();
  for (const v of VIEWS) {
    for (const [w, h] of v.sizes) {
      const page = await browser.newPage({ viewport: { width: w, height: h + TITLE } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`${base}/frame?w=${w}&h=${h}&state=${v.state}`);
      const app = page.frame({ url: /index\.html/ });
      await app.waitForLoadState();
      await app.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      if (v.click) { await app.click(v.click); await page.waitForTimeout(400); }
      const r = await app.evaluate(audit, TEXT);
      const problems = [...errors, ...r.bad];
      // The default window must show everything without scrolling; a narrower window scrolls inside main only.
      if (w >= 960 && r.mainScrolls && v.state !== 'advanced') problems.push('content scrolls at the default window size');
      const file = `${engineName}-${v.name || v.state}-${w}x${h}.png`;
      await page.screenshot({ path: join(out, file) });
      console.log((problems.length ? 'FAIL ' : 'ok   ') + file + (problems.length ? '\n     ' + problems.slice(0, 8).join('\n     ') : ''));
      failures += problems.length ? 1 : 0;
      await page.close();
    }
  }
  await browser.close();
}
server.close();
console.log(failures ? `${failures} view(s) failed` : 'all views pass');
process.exit(failures ? 1 : 0);
