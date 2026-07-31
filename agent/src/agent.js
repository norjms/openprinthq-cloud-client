// OpenPrintHQ Local Connector — agent
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs on the same LAN as your printers and gives cloud-hosted OpenPrintHQ a
// way to reach them WITHOUT any inbound port-forward — so it works behind a
// home router, a strict firewall, or carrier-grade NAT (CGNAT).
//
// How it works (outbound-only):
//   1. The agent opens a long-lived Server-Sent-Events stream *out* to the
//      control-plane:  GET /api/connector/stream   (Bearer <connector token>)
//      Because the connection is initiated from inside your network, no
//      inbound firewall rule / port-forward is ever needed.
//   2. The control-plane pushes "jobs" down that stream — each job is a single
//      HTTP request it wants performed against a printer on your LAN
//      (e.g. GET http://10.10.10.121:7125/printer/info on a Moonraker box).
//   3. The agent performs the request locally and POSTs the response back:
//      POST /api/connector/result
//
// Security: the agent will ONLY talk to hosts/ports on its allow-list (private
// ranges + printer ports by default). A compromised or malicious control-plane
// therefore cannot use the agent to reach arbitrary internet hosts (SSRF).
//
// Dependency-free: uses only Node ≥ 20 built-ins (global fetch, streams).

import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { registerBambuStream, localFrameUrl, localMjpegUrl, bambuSupportsRtsp } from './camera.js';
import * as gateway from './gateway.js';

function readPubKey() {
  const inline = process.env.OPHQ_SIGNING_PUBKEY;
  if (inline && inline.trim()) return inline.trim();
  const file = process.env.OPHQ_SIGNING_PUBKEY_FILE;
  if (file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
  return '';
}

const CONFIG = {
  controlUrl: (process.env.OPHQ_CONTROL_URL || '').replace(/\/+$/, ''),
  token: process.env.OPHQ_CONNECTOR_TOKEN || '',
  // Allow-list: comma-separated hosts, CIDRs, or the keyword "private".
  allow: (process.env.OPHQ_ALLOW || 'private').split(',').map((s) => s.trim()).filter(Boolean),
  // Allowed destination ports (printer APIs, cameras). "*" allows any.
  allowPorts: (process.env.OPHQ_ALLOW_PORTS || '80,443,7125,8080,8081,8888,3000,1883,8883,990,21').split(',').map((s) => s.trim()),
  name: process.env.OPHQ_CONNECTOR_NAME || 'connector',
  // Optional RSA public key (PEM). When set, the agent verifies that every
  // command it receives is signed by the control-plane's matching private key.
  signPubKeyPem: readPubKey(),
  maxClockSkewMs: Number(process.env.OPHQ_MAX_CLOCK_SKEW_MS || 120000),
  // Keep-alive: if no bytes (control-plane sends a ':ping' comment ~every 20s)
  // arrive within this window, treat the tunnel as dead and reconnect. Catches
  // silent drop-outs (half-open TCP, NAT timeouts) that never send a FIN.
  streamTimeoutMs: Number(process.env.OPHQ_STREAM_TIMEOUT_MS || 60000),
  reconnectMinMs: 2000,
  reconnectMaxMs: 30000,
  requestTimeoutMs: Number(process.env.OPHQ_REQUEST_TIMEOUT_MS || 20000),
  // ---- broker/rendezvous gateway (docs/broker-architecture.md) ----
  // Local gateway listen port (bound 0.0.0.0). Forward this on the router for
  // remote access. Browsers connect here directly; the cloud only brokers it.
  gatewayPort: Number(process.env.OPHQ_GATEWAY_PORT || 8787),
  // The public endpoint to advertise to the broker. publicHost = the user's
  // DDNS name or public IP; publicPort = the externally-forwarded port that maps
  // to gatewayPort. If publicHost is empty the broker falls back to the source
  // IP it sees, and publicPort defaults to gatewayPort.
  publicHost: (process.env.OPHQ_PUBLIC_HOST || '').trim(),
  publicPort: Number(process.env.OPHQ_PUBLIC_PORT || 0) || 0,
  // How often to re-register (heartbeat) our endpoint + printer inventory.
  registerIntervalMs: Number(process.env.OPHQ_REGISTER_INTERVAL_MS || 30000),
  // Raw TCP passthrough port for the cloud engine (forward this too).
  tcpPort: Number(process.env.OPHQ_TCP_PORT || 8788)
};

// Logs go to stderr so stdout stays clean (e.g. for `--pubkey`).
function log(...a) { console.error(new Date().toISOString(), '[connector]', ...a); }
function fail(msg) { console.error('FATAL:', msg); process.exit(1); }

// Verbose tracing — set OPHQ_DEBUG=1 to see every job the connector receives and
// every request/probe it performs on the LAN (helps trace where a scan or a
// printer call breaks down). Off by default so normal logs stay quiet.
const DEBUG = /^(1|true|yes|on)$/i.test(process.env.OPHQ_DEBUG || '');
function dbg(...a) { if (DEBUG) console.error(new Date().toISOString(), '[connector][debug]', ...a); }

// ---- command signature verification (optional but recommended) -----------
const PSS = { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST };
let signPubKey = null;
if (CONFIG.signPubKeyPem) {
  try { signPubKey = crypto.createPublicKey(CONFIG.signPubKeyPem); }
  catch { fail('OPHQ_SIGNING_PUBKEY is not a valid PEM public key'); }
}
const seenIds = new Set();   // replay defence (bounded)
function rememberId(id) { seenIds.add(id); if (seenIds.size > 5000) seenIds.delete(seenIds.values().next().value); }
function canonJob(j) {
  return Buffer.from(JSON.stringify([
    j.id ?? null, j.ts ?? null, j.kind ?? null,
    j.host ?? null, j.port ?? null, j.scheme ?? null,
    j.path ?? null, j.method ?? null, j.headers ?? null, j.body ?? null
  ]));
}
const isCommand = (j) => j.kind === undefined || j.kind === 'tcp-open' || j.kind === 'tcp-probe';
let warnedUnsigned = false;
function verifyCommand(job) {
  if (!signPubKey) {
    if (!warnedUnsigned) { warnedUnsigned = true; log('WARNING: OPHQ_SIGNING_PUBKEY not set — command signatures are NOT enforced. Set it for best security.'); }
    return true;
  }
  if (!isCommand(job)) return true;   // stream data/close ride an already-authenticated stream id
  if (!job.sig || !job.ts) { log('rejected unsigned command', job.id); return false; }
  if (Math.abs(Date.now() - Number(job.ts)) > CONFIG.maxClockSkewMs) { log('rejected stale command', job.id); return false; }
  if (seenIds.has(job.id)) { log('rejected replayed command', job.id); return false; }
  let ok = false;
  try { ok = crypto.verify('sha256', canonJob(job), { key: signPubKey, ...PSS }, Buffer.from(job.sig, 'base64')); }
  catch { ok = false; }
  if (!ok) { log('rejected bad-signature command', job.id); return false; }
  rememberId(job.id);
  return true;
}

// ---- mutual auth: this connector's own key pair --------------------------
// The connector proves itself to the control-plane (SSH-style): it holds a
// private key and you register its public key in Settings → Connectors. On
// every connect it signs `${token}.${ts}` so a leaked bearer token alone can't
// impersonate it. The key is persisted (OPHQ_CLIENT_KEY_FILE) so the public key
// stays stable across restarts.
function loadOrCreateClientKey() {
  const inline = process.env.OPHQ_CLIENT_PRIVKEY;
  if (inline && inline.trim()) return crypto.createPrivateKey(inline.trim());
  const file = process.env.OPHQ_CLIENT_KEY_FILE;
  if (!file) return null;
  try {
    if (fs.existsSync(file)) return crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    fs.writeFileSync(file, privateKey, { mode: 0o600 });
    log(`generated a new connector key at ${file}`);
    return crypto.createPrivateKey(privateKey);
  } catch (e) { log('client key error:', e.message); return null; }
}
const clientKey = loadOrCreateClientKey();
const clientPubPem = clientKey ? crypto.createPublicKey(clientKey).export({ type: 'spki', format: 'pem' }).toString() : null;

// `node src/agent.js --pubkey` prints the public key to register, then exits.
if (process.argv.includes('--pubkey')) {
  if (!clientPubPem) fail('set OPHQ_CLIENT_KEY_FILE (or OPHQ_CLIENT_PRIVKEY) first, then re-run with --pubkey');
  process.stdout.write(clientPubPem);
  process.exit(0);
}

function clientAuthHeaders() {
  if (!clientKey) return {};
  const ts = String(Date.now());
  const sig = crypto.sign('sha256', Buffer.from(`${CONFIG.token}.${ts}`), { key: clientKey, ...PSS }).toString('base64');
  // Present our public key too (base64 PEM, header-safe). On the FIRST connect
  // with a valid token the server locks onto this key (trust-on-first-use), so
  // the user never has to copy/paste it. Later connects still prove possession
  // via the signature above; a different key is rejected until the server key
  // is reset. Harmless to send every time.
  const pub = clientPubPem ? Buffer.from(clientPubPem).toString('base64') : '';
  return { 'x-ophq-client-ts': ts, 'x-ophq-client-sig': sig, 'x-ophq-client-pubkey': pub };
}

// ---- allow-list ----------------------------------------------------------
function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function inCidr(ip, cidr) {
  const [range, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const a = ipToInt(ip), b = ipToInt(range);
  if (a == null || b == null || Number.isNaN(bits)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16'];
function hostAllowed(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  const isIp = ipToInt(h) != null;
  for (const rule of CONFIG.allow) {
    if (rule === 'private') { if (isIp && PRIVATE.some((c) => inCidr(h, c))) return true; continue; }
    if (rule.includes('/')) { if (isIp && inCidr(h, rule)) return true; continue; }
    if (rule === h) return true;                                   // exact host / IP
    if (rule.startsWith('*.') && h.endsWith(rule.slice(1))) return true; // wildcard domain
  }
  return false;
}
function portAllowed(port) {
  return CONFIG.allowPorts.includes('*') || CONFIG.allowPorts.includes(String(port));
}

// ---- perform one proxied job --------------------------------------------
async function runHttpJob(job) {
  const { host, port = 80, scheme = 'http', path = '/', method = 'GET', headers = {}, body } = job;
  if (!hostAllowed(host)) return { status: 403, error: `host ${host} not in allow-list` };
  if (!portAllowed(port)) return { status: 403, error: `port ${port} not in allow-list` };
  const url = `${scheme}://${host}:${port}${path.startsWith('/') ? path : '/' + path}`;
  dbg('-> LAN request', method, url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.requestTimeoutMs);
  try {
    const init = { method, headers: { ...headers }, signal: ctrl.signal };
    delete init.headers.host; delete init.headers.Host;
    if (body != null && method !== 'GET' && method !== 'HEAD') init.body = Buffer.from(body, 'base64');
    const res = await fetch(url, init);
    const buf = Buffer.from(await res.arrayBuffer());
    const outHeaders = {};
    res.headers.forEach((v, k) => { outHeaders[k] = v; });
    return { status: res.status, headers: outHeaders, body: buf.toString('base64') };
  } catch (e) {
    return { status: 502, error: (e && e.name === 'AbortError') ? 'timeout' : (e?.message || 'request failed') };
  } finally { clearTimeout(timer); }
}

// Optional raw TCP probe (used for connectivity checks, e.g. Bambu MQTT 8883).
async function runTcpProbe(job) {
  const { host, port } = job;
  if (!hostAllowed(host) || !portAllowed(port)) return { ok: false, error: 'not allowed' };
  return await new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 4000 }, () => { sock.destroy(); resolve({ ok: true }); });
    sock.on('error', (e) => resolve({ ok: false, error: e.message }));
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

async function post(body) {
  try {
    await fetch(`${CONFIG.controlUrl}/api/connector/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CONFIG.token}` },
      body: JSON.stringify(body)
    });
  } catch (e) { log('post failed', body?.id, e?.message); }
}

// ---- raw TCP tunnelling --------------------------------------------------
// Multiplexed byte streams keyed by stream id. Cloud→agent bytes arrive as
// `tcp-data` SSE events; agent→cloud bytes are POSTed as {event:'data'}. This
// carries any TCP protocol — Bambu MQTT (8883), FTP (990), etc.
const sockets = new Map();   // streamId -> net.Socket

function openTcp(job) {
  const { id, host, port } = job;
  if (!hostAllowed(host) || !portAllowed(port)) { post({ id, event: 'close', error: 'not allowed' }); return; }
  const sock = net.connect({ host, port });
  sockets.set(id, sock);
  sock.on('connect', () => post({ id, event: 'open' }));
  sock.on('data', (chunk) => post({ id, event: 'data', data: chunk.toString('base64') }));
  sock.on('error', (e) => { post({ id, event: 'close', error: e.message }); sockets.delete(id); });
  sock.on('close', () => { post({ id, event: 'close' }); sockets.delete(id); });
  sock.setTimeout(0);
}
function dataTcp(job) { const s = sockets.get(job.id); if (s && job.data) s.write(Buffer.from(job.data, 'base64')); }
function closeTcp(job) { const s = sockets.get(job.id); if (s) { s.end(); sockets.delete(job.id); } }

// ---- LAN printer discovery (SSDP) ---------------------------------------
// Runs on THIS connector's own network — where the printers actually are. The
// cloud engine can't see the LAN, so discovery has to happen here and the
// results travel back up the tunnel. Listens for Bambu SSDP broadcasts (the
// printers announce themselves) and also sends an active M-SEARCH.
function parseSsdpHeaders(text) {
  const h = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return h;
}
async function runDiscover(job) {
  const windowMs = Math.min(Math.max(Number(job.window_ms) || 4000, 1000), 12000);
  const found = new Map();   // key -> device
  const addBambu = (h, ip) => {
    if (!ip) return;
    found.set('bambu:' + ip, {
      vendor: 'bambu', ip,
      name: h['devname.bambu.com'] || h['dev-name'] || 'Bambu printer',
      model: (h['devmodel.bambu.com'] || '').replace(/^3DPrinter-/i, '') || '',
      serial: h['usn'] || '',
      port: 8883, source: 'ssdp'
    });
  };
  const sniff = (msg, rinfo) => {
    const text = msg.toString('utf8');
    if (/bambu|3dprinter|bambulab/i.test(text)) addBambu(parseSsdpHeaders(text), rinfo.address);
  };
  // Klipper/Moonraker printers don't broadcast; probe the LAN for :7125.
  const probeKlipper = async (deadline) => {
    const bases = new Set();
    // If the job names a subnet (CIDR /24..'/32'), scan ONLY that; else fall back
    // to this host's own interfaces (all /24s).
    const sub = (job.subnet || '').toString().trim();
    const m = sub.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}\/(\d{1,2})$/);
    if (m && Number(m[4]) >= 24 && Number(m[4]) <= 32) {
      bases.add(`${m[1]}.${m[2]}.${m[3]}`);   // /24 base; caps a scan at 254 hosts
    } else {
      const nets = os.networkInterfaces();
      for (const list of Object.values(nets)) {
        for (const ni of list || []) {
          if (ni && ni.family === 'IPv4' && !ni.internal) {
            const p = ni.address.split('.');
            if (p.length === 4) bases.add(p.slice(0, 3).join('.'));  // /24
          }
        }
      }
    }
    const hosts = [];
    for (const b of bases) for (let i = 1; i <= 254; i++) hosts.push(`${b}.${i}`);
    let idx = 0;
    const probeOne = async (ip) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 800);
      try {
        const res = await fetch(`http://${ip}:7125/printer/info`, { signal: ac.signal });
        if (res.status === 200 || res.status === 401) {
          let name = '';
          if (res.status === 200) { try { const j = await res.json(); name = j?.result?.hostname || ''; } catch { /* */ } }
          found.set('klipper:' + ip, { vendor: 'klipper', ip, name: name || 'Klipper printer', model: '', serial: '', port: 7125, source: 'moonraker' });
        }
      } catch { /* not a Moonraker host */ }
      finally { clearTimeout(t); }
    };
    const CONC = 48;
    const worker = async () => { while (idx < hosts.length && Date.now() < deadline) await probeOne(hosts[idx++]); };
    await Promise.all(Array.from({ length: CONC }, worker));
  };
  const sockets2 = [];
  const listen = (port) => new Promise((resolve) => {
    let s;
    try { s = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { return resolve(); }
    sockets2.push(s);
    s.on('error', () => { try { s.close(); } catch { /* */ } });
    s.on('message', sniff);
    try { s.bind(port, () => { try { s.addMembership('239.255.255.250'); } catch { /* */ } resolve(); }); }
    catch { resolve(); }
  });
  // Bambu printers broadcast SSDP NOTIFY to 239.255.255.250 on :1990 and :2021.
  await Promise.all([listen(2021), listen(1990)]);
  // Active M-SEARCH so anything that only answers on request replies now too.
  try {
    const q = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST:239.255.255.250:1900\r\nMAN:"ssdp:discover"\r\nMX:2\r\nST:ssdp:all\r\n\r\n');
    const s3 = dgram.createSocket('udp4'); sockets2.push(s3);
    s3.on('message', sniff);
    s3.bind(() => { try { s3.setBroadcast(true); } catch { /* */ } try { s3.send(q, 1900, '239.255.255.250'); s3.send(q, 2021, '239.255.255.250'); } catch { /* */ } });
  } catch { /* */ }
  // Run the SSDP listen window and the Klipper subnet probe together.
  const deadline = Date.now() + windowMs;
  await Promise.all([
    new Promise((r) => setTimeout(r, windowMs)),
    probeKlipper(deadline).catch(() => {})
  ]);
  for (const s of sockets2) { try { s.close(); } catch { /* */ } }
  const devices = [...found.values()];
  dbg('discover complete', { found: devices.length, bambu: devices.filter((d) => d.vendor === 'bambu').length, klipper: devices.filter((d) => d.vendor === 'klipper').length, window_ms: windowMs });
  return { ok: true, devices };
}

// ---- camera relay (agent-local; see camera.js for architecture credit) ----
// Register a Bambu RTSPS stream in the local go2rtc so frames can be fetched.
async function runCameraRegister(job) {
  const { vendor, ip, access_code, model, name } = job;
  try {
    if (vendor === 'bambu') {
      if (!bambuSupportsRtsp(model)) return { ok: false, error: 'model has no RTSPS camera (A1/P1 chamber-image not supported)' };
      const stream = await registerBambuStream({ name: name || ('p' + (job.printer_id || 'x')), ip, accessCode: access_code });
      return { ok: true, stream };
    }
    // Klipper/other: nothing to register — frames are fetched from the webcam URL
    // directly via the HTTP relay.
    return { ok: true, stream: null };
  } catch (e) { return { ok: false, error: e.message || 'camera register failed' }; }
}

// Fetch one JPEG frame locally and relay it up. For Bambu, from the local
// go2rtc single-frame endpoint; for Klipper, from the webcam snapshot URL.
async function runCameraFrame(job) {
  const { vendor, name, snapshot_url } = job;
  let url;
  if (vendor === 'bambu') url = localFrameUrl(name || ('p' + (job.printer_id || 'x')));
  else url = snapshot_url; // klipper/external: absolute local webcam snapshot URL
  if (!url) return { status: 502, error: 'no camera url' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'image/jpeg' }, body: buf.toString('base64') };
  } catch (e) { return { status: 502, error: (e && e.name === 'AbortError') ? 'timeout' : (e?.message || 'frame fetch failed') }; }
  finally { clearTimeout(t); }
}

async function handleJob(job) {
  dbg('job received', { id: job.id, kind: job.kind || 'http', host: job.host, port: job.port, scheme: job.scheme, method: job.method, path: job.path });
  if (!verifyCommand(job)) return;   // drop commands not signed by the control-plane
  if (job.kind === 'tcp-open') return openTcp(job);
  if (job.kind === 'tcp-data') return dataTcp(job);
  if (job.kind === 'tcp-close') return closeTcp(job);
  if (job.kind === 'discover') { const r = await runDiscover(job); dbg('job result', { id: job.id, kind: 'discover', found: r.devices.length }); await post({ id: job.id, ...r }); return; }
  if (job.kind === 'camera-register') { const r = await runCameraRegister(job); await post({ id: job.id, ...r }); return; }
  if (job.kind === 'camera-frame') { const r = await runCameraFrame(job); await post({ id: job.id, ...r }); return; }
  const result = (job.kind === 'tcp-probe') ? await runTcpProbe(job) : await runHttpJob(job);
  dbg('job result', { id: job.id, kind: job.kind || 'http', status: result.status, ok: result.ok, error: result.error });
  await post({ id: job.id, ...result });
}

// Compute this host's LAN /24 CIDRs from its real interfaces. With
// network_mode: host (the documented deploy), os.networkInterfaces() reports the
// Docker HOST's interfaces, so this is the host's subnet — what we want to scan.
function hostCidrs() {
  const nets = os.networkInterfaces();
  const out = new Set();
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni && ni.family === 'IPv4' && !ni.internal) {
        const p = ni.address.split('.');
        if (p.length === 4) out.add(p.slice(0, 3).join('.') + '.0/24');
      }
    }
  }
  return [...out];
}
// The single best-guess host CIDR to report (first non-internal /24).
function primaryHostCidr() { return hostCidrs()[0] || ''; }

// ---- SSE stream consumer -------------------------------------------------
// ---- broker registration + local gateway (docs/broker-architecture.md) ----
let gatewaySecret = null;          // shared HMAC secret for browser tokens
let gatewayServer = null;
let knownPrinters = [];            // last inventory we registered

// Ask the broker to register our public endpoint + printer inventory. The broker
// returns a per-connector gatewaySecret we use to verify browser tokens. The
// browser data path never touches the cloud - this is control-plane signaling
// only, over the same authenticated channel as the job stream.
async function registerWithBroker() {
  try {
    const body = {
      public_host: CONFIG.publicHost || null,          // null => broker uses source IP
      public_port: CONFIG.publicPort || CONFIG.gatewayPort,
      gateway_port: CONFIG.gatewayPort,
      printers: knownPrinters
    };
    const res = await fetch(`${CONFIG.controlUrl}/api/connector/register-endpoint`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CONFIG.token}`, 'content-type': 'application/json', ...clientAuthHeaders() },
      body: JSON.stringify(body)
    });
    if (!res.ok) { dbg('register-endpoint failed', res.status); return; }
    const out = await res.json().catch(() => ({}));
    if (out.gateway_secret && out.gateway_secret !== gatewaySecret) {
      gatewaySecret = out.gateway_secret;
      dbg('received gateway secret from broker');
    }
    if (Array.isArray(out.printers)) {
      knownPrinters = out.printers;
      gateway.setPrinters(out.printers);                 // bridge targets = what the broker says we front
      dbg('registered', out.printers.length, 'printer(s) with the gateway');
    }
    if (out.public_host) dbg('broker sees us at', out.public_host + ':' + (out.public_port || CONFIG.gatewayPort));
  } catch (e) { dbg('register error', e?.message); }
}

// Camera frame URL for a printer: Bambu goes through local go2rtc (see camera.js);
// others may expose a direct snapshot. Returns null if no camera.
function cameraFrameUrlFor(printerId, target) {
  if (target && target.vendor === 'bambu') return localFrameUrl(`p${printerId}`);
  return null;
}

function ensureGateway() {
  if (gatewayServer) return;
  gatewayServer = gateway.startGateway({
    port: CONFIG.gatewayPort,
    gatewaySecretRef: () => gatewaySecret,               // read live (arrives from broker)
    cameraFrameUrl: cameraFrameUrlFor,
    log
  });
  // Raw TCP passthrough for the cloud engine (server-to-server). Uses a separate
  // forwarded port so HTTP and raw TCP don't share a listener.
  gateway.startTcpPassthrough({
    port: CONFIG.tcpPort,
    verify: (tok) => gateway.verifyBrowserToken(tok, gatewaySecret),
    log
  });
}

async function connectOnce() {
  const url = `${CONFIG.controlUrl}/api/connector/stream?name=${encodeURIComponent(CONFIG.name)}&host_cidr=${encodeURIComponent(primaryHostCidr())}`;
  const ac = new AbortController();
  let idle = setTimeout(() => ac.abort(), CONFIG.streamTimeoutMs);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), CONFIG.streamTimeoutMs); };
  let res;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${CONFIG.token}`, accept: 'text/event-stream', ...clientAuthHeaders() },
      signal: ac.signal
    });
  } catch (e) { clearTimeout(idle); throw e; }
  if (res.status === 401 || res.status === 403) { clearTimeout(idle); fail(`control-plane rejected the connector (${res.status}). If mutual auth is enabled, register this connector's public key (run with --pubkey to print it).`); }
  if (!res.ok || !res.body) { clearTimeout(idle); throw new Error(`stream failed: HTTP ${res.status}`); }
  log(`connected to ${CONFIG.controlUrl} as "${CONFIG.name}" — waiting for jobs (keep-alive ${Math.round(CONFIG.streamTimeoutMs / 1000)}s)`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed by server');
      bump();                                                // any byte (incl. ':ping') resets the watchdog
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = raw.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;                                 // heartbeat comment ": ping"
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let job; try { job = JSON.parse(payload); } catch { continue; }
        if (job && job.id && (job.host || job.kind)) handleJob(job);  // fire-and-forget
      }
    }
  } finally { clearTimeout(idle); }
}

async function main() {
  if (!CONFIG.controlUrl) fail('OPHQ_CONTROL_URL is required (e.g. https://openprinthq.example.org)');
  if (!CONFIG.token) fail('OPHQ_CONNECTOR_TOKEN is required (create one in Settings → Connectors)');
  log(`starting — control=${CONFIG.controlUrl} gateway-port=${CONFIG.gatewayPort} public=${CONFIG.publicHost || '(broker-detected)'}:${CONFIG.publicPort || CONFIG.gatewayPort} signature-verification=${signPubKey ? 'ENFORCED' : 'off'} client-key=${clientKey ? 'on' : 'off'}`);
  if (clientPubPem) log(`this connector's public key (register it in Settings → Connectors):\n${clientPubPem.trim()}`);
  // Broker/rendezvous: start the local gateway and begin registering our public
  // endpoint. Browsers connect to the gateway directly; the cloud only brokers.
  ensureGateway();
  registerWithBroker();
  setInterval(registerWithBroker, CONFIG.registerIntervalMs);

  let backoff = CONFIG.reconnectMinMs;
  for (;;) {
    try {
      await connectOnce();
      backoff = CONFIG.reconnectMinMs;
    } catch (e) {
      log('disconnected:', e?.message, `— retrying in ${Math.round(backoff / 1000)}s`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(CONFIG.reconnectMaxMs, Math.round(backoff * 1.7));
    }
  }
}

process.on('SIGINT', () => { log('shutting down'); process.exit(0); });
process.on('SIGTERM', () => { log('shutting down'); process.exit(0); });
main();
