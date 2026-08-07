// Local camera relay (agent side).
//
// Architecture credit: OctoEverywhere by Quinn Damerell
// (https://github.com/QuinnDamerell/OctoPrint-OctoEverywhere, AGPL-3.0). The
// approach — the on-LAN agent holds the printer camera connection locally and
// relays frames up over the tunnel, rather than the cloud reaching the printer's
// LAN IP — is adapted from OctoEverywhere's webcamhelper / octohttprequest.
//
// Bambu H2C/H2D/X1/P2S/etc. speak RTSPS on port 322 with a printer-pinned TLS
// cert, so they can't be transparently TCP-relayed to a different host. Instead
// the agent runs a local go2rtc that holds ONE RTSPS pull on the LAN (where TLS
// + reachability are fine) and re-serves plain-HTTP MJPEG / single-frame JPEG on
// 127.0.0.1:1984. The cloud fetches those frames through the agent's existing
// HTTP relay. (Stream shape per Bambuddy's camera docs.)
//
// Klipper/Moonraker webcams are already plain HTTP MJPEG on the host; those are
// fetched locally the same way with no go2rtc needed.

import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';

// Somewhere writable for go2rtc's config. Prefer the directory already holding
// the connector's key so all agent state lives together; fall back to the OS
// temp dir, which is always writable even for a packaged install.
function shortPathIfNeeded(p) {
  if (!p || process.platform !== 'win32' || !p.includes(' ')) return p;
  // Ask Windows for the 8.3 name via the scripting host rather than `for %I`:
  // execFileSync re-quotes the argument, so the cmd one-liner echoed back a
  // mangled string that still contained spaces and was silently discarded.
  try {
    const vbs = 'WScript.Echo(CreateObject("Scripting.FileSystemObject").GetFile(WScript.Arguments(0)).ShortPath)';
    const f = path.join(os.tmpdir(), `ophq-shortpath-${process.pid}.vbs`);
    writeFileSync(f, vbs, 'utf8');
    let out = '';
    try { out = execFileSync('cscript.exe', ['//Nologo', f, p], { encoding: 'utf8' }); }
    finally { try { unlinkSync(f); } catch { /* best effort */ } }
    const short = out.trim().split(/\r?\n/).pop().trim();
    return short && !short.includes(' ') ? short : p;
  } catch { return p; }
}

function stateDir() {
  const keyFile = process.env.OPHQ_CLIENT_KEY_FILE;
  const dir = keyFile ? path.dirname(keyFile) : path.join(os.tmpdir(), 'openprinthq');
  try { mkdirSync(dir, { recursive: true }); return dir; }
  catch { const t = path.join(os.tmpdir(), 'openprinthq'); mkdirSync(t, { recursive: true }); return t; }
}

const GO2RTC_API = 'http://127.0.0.1:1984';
let go2rtcProc = null;
let go2rtcStarting = null;
const registered = new Map(); // streamName -> src

function log(...a) { console.log('[camera]', ...a); }

// Bambu internal model codes / marketing names that expose RTSPS on 322.
// (A1/A1MINI/P1P/P1S use the chamber-image protocol on 6000 — not go2rtc-able.)
// Which Bambu models expose an RTSPS camera (as opposed to the A1/P1
// chamber-image protocol, which go2rtc can't source).
//
// Printers report an SSDP devmodel code ("O1D"), not the marketing name
// ("H2D"), and users sometimes rename them — so both forms have to match. This
// MUST stay a superset of supportsRtsp() in the control-plane's go2rtc.js: when
// the two disagreed, a printer worked on the cloud path and failed on the
// connector path with "model has no RTSPS camera", which reads like a camera
// bug rather than a list mismatch. BL-P001 (the X1 Carbon) was in exactly that
// gap.
const RTSP_PREFIXES = /^(x1|x2|h2|p2)/i;
const RTSP_DEVMODELS = new Set([
  'BLP001',                                   // X1 / X1 Carbon
  'C11', 'C13',
  'N6', 'N7',
  'O1C', 'O1C2',                              // H2C
  'O1D',                                      // H2D
  'O1S', 'O1E', 'O2D'
]);
export function bambuSupportsRtsp(model) {
  if (!model) return false;
  const m = String(model).replace(/[\s_-]/g, '').toUpperCase();
  return RTSP_PREFIXES.test(m) || RTSP_DEVMODELS.has(m);
}

async function isGo2rtcUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`${GO2RTC_API}/api/streams`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

// Start a local go2rtc if one isn't already reachable. We prefer a go2rtc binary
// on PATH; if absent, camera relay for Bambu RTSPS is unavailable (Klipper MJPEG
// still works via direct local HTTP fetch). Idempotent.
export async function ensureGo2rtc() {
  if (await isGo2rtcUp()) return true;
  if (go2rtcStarting) return go2rtcStarting;
  go2rtcStarting = (async () => {
    try {
      const go2rtcBin = process.env.OPHQ_GO2RTC_BIN || 'go2rtc';
      // Point go2rtc at the bundled ffmpeg (RTSPS->MJPEG transcode) when present,
      // and bind its API to localhost only.
      // go2rtc splits ffmpeg.bin on whitespace when it builds the command, so a
      // path like "C:\\Program Files\\..." becomes argv[0]="C:\\Program" and it
      // reports "executable file not found in %PATH%". Hand it the 8.3 short
      // path on Windows, which has no spaces.
      const ffmpegBin = shortPathIfNeeded(process.env.OPHQ_FFMPEG_BIN);
      // go2rtc MUST be given a config FILE, not an inline JSON string. With an
      // inline config it has nowhere to persist changes, so every write through
      // the API is refused with "400: config file disabled" — which is exactly
      // how camera registration failed: the RTSPS source was always valid, but
      // PUT /api/streams could never be accepted.
      // Named .yaml now. Any go2rtc.json left by an earlier build is JSON with
      // yaml appended and will never parse again, so remove it rather than
      // leaving a file that permanently breaks startup.
      const stale = path.join(stateDir(), 'go2rtc.json');
      try { if (existsSync(stale)) unlinkSync(stale); } catch { /* best effort */ }
      const cfgPath = path.join(stateDir(), 'go2rtc.yaml');
      writeFileSync(cfgPath, buildConfig(ffmpegBin, currentIce), 'utf8');
      go2rtcProc = spawn(go2rtcBin, ['-config', cfgPath], { stdio: 'ignore', detached: false });
      go2rtcProc.on('exit', (code) => { log('go2rtc exited', code); go2rtcProc = null; });
      // wait up to ~5s for it to come up
      for (let i = 0; i < 25; i++) {
        if (await isGo2rtcUp()) { log('go2rtc up'); return true; }
        await new Promise((r) => setTimeout(r, 200));
      }
      log('go2rtc did not become ready');
      return false;
    } catch (e) {
      log('go2rtc spawn failed (bundled sidecar missing?):', e.message);
      return false;
    } finally { go2rtcStarting = null; }
  })();
  return go2rtcStarting;
}

// go2rtc config. The WebRTC listener is what lets the browser talk to this host
// directly instead of pulling video through the cloud: go2rtc gathers its own
// ICE candidates here and answers the browser's offer.
//
// ice_servers matter because the printer LAN is usually behind CGNAT. Host
// candidates are useless to a remote browser and STUN reflexive candidates often
// fail to pair through carrier NAT, so without a TURN relay to fall back to the
// negotiation simply never completes.
const WEBRTC_PORT = process.env.OPHQ_GO2RTC_WEBRTC_PORT || '18555';
let currentIce = [];
// Emit YAML, not JSON. go2rtc persists API changes by APPENDING yaml to this
// file, so a file that starts as a JSON object ends up as a JSON object with
// yaml stuck on the end: valid as neither. It parses on first run, accepts the
// stream registration, writes itself, and then fails to start ever again. YAML
// from the outset means what go2rtc appends stays consistent with what we wrote.
function yamlQuote(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }
function buildConfig(ffmpegBin, ice) {
  const servers = ice && ice.length ? ice : [{ urls: 'stun:stun.cloudflare.com:3478' }];
  const lines = [
    'api:',
    "  listen: '127.0.0.1:1984'",
    'webrtc:',
    `  listen: ':${WEBRTC_PORT}'`,
    '  ice_servers:'
  ];
  for (const s of servers) {
    const urls = [].concat(s.urls || []);
    lines.push(`    - urls: [${urls.map(yamlQuote).join(', ')}]`);
    if (s.username) lines.push(`      username: ${yamlQuote(s.username)}`);
    if (s.credential) lines.push(`      credential: ${yamlQuote(s.credential)}`);
  }
  lines.push('log:', '  level: warn');
  if (ffmpegBin) {
    lines.push('ffmpeg:', `  bin: ${yamlQuote(ffmpegBin)}`);
    // Bambu printers present a self-signed certificate on their RTSPS port.
    // go2rtc's native RTSPS client cannot accept it (on Windows the handshake
    // fails inside SChannel with 0x80090325 and the producer simply stops ~60ms
    // after starting, logging nothing), so the stream is pulled with ffmpeg
    // instead. -tls_verify 0 has to precede -i, which is why this is an input
    // TEMPLATE rather than an extra argument: go2rtc appends raw args after the
    // input, where ffmpeg rejects them.
    lines.push("  bambu: '-rtsp_transport tcp -tls_verify 0 -i {input}'");
  }
  lines.push('');
  return lines.join('\n');
}

// go2rtc reads ice_servers at startup, so a changed credential set means a
// respawn. Cloudflare TURN credentials are short-lived, so this happens on a
// normal cadence rather than only at install time. Streams are re-registered on
// demand, so a respawn costs one reconnect, not lost configuration.
// Compare ICE servers by their URLS ONLY, never by credentials.
//
// Cloudflare mints short-lived TURN credentials, so a fresh set arrives with
// every request and a naive deep-compare saw a change every single time. Each
// "change" restarted go2rtc, which wiped every registered stream, so opening a
// live view destroyed the very stream it was about to play and every camera
// died with "stream not found". The URLs are what go2rtc actually needs at
// startup; rotating credentials do not warrant a restart.
function iceFingerprint(list) {
  try {
    return (list || [])
      .map((s) => [].concat(s.urls || []).join(','))
      .sort()
      .join('|');
  } catch { return ''; }
}
function iceChanged(next) {
  return iceFingerprint(next) !== iceFingerprint(currentIce);
}
export async function applyIceServers(ice) {
  // If go2rtc is not running yet, just record them: it will start with these
  // servers in its config, so a restart would be pointless work.
  if (!go2rtcProc) { currentIce = Array.isArray(ice) ? ice : []; return false; }
  if (!iceChanged(ice)) return false;
  currentIce = Array.isArray(ice) ? ice : [];
  if (go2rtcProc) {
    log('ICE servers changed - restarting go2rtc to pick them up');
    try { go2rtcProc.kill(); } catch { /* already gone */ }
    go2rtcProc = null;
    await new Promise((r) => setTimeout(r, 300));
    // Bring the streams back with it, or the request that triggered this will
    // find nothing and every camera dies at the moment live view is opened.
    if (await ensureGo2rtc()) await restoreStreams();
  }
  return true;
}

// Hand a browser's SDP offer to the LOCAL go2rtc and return its answer. This is
// the whole point of the agent-local model: only the offer/answer text crosses
// the cloud, and the media then flows browser <-> this host.
export async function webrtcOffer(name, offer) {
  const up = (await isGo2rtcUp()) || (await ensureGo2rtc());
  if (!up) throw new Error('go2rtc unavailable on the connector host');
  // The frame path already re-registers a lost stream; this one did not, so a
  // go2rtc restart left live view answering "stream not found" indefinitely
  // while snapshots quietly recovered.
  if (!(await streamRegistered(name))) throw new Error(`stream ${name} is not registered`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${GO2RTC_API}/api/webrtc?src=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof offer === 'string' ? offer : JSON.stringify(offer),
      signal: ctrl.signal
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`go2rtc webrtc failed: ${r.status} ${text.slice(0, 200)}`);
    return text;
  } finally { clearTimeout(timer); }
}

// Register a Bambu RTSPS source in the local go2rtc. Returns the stream name.
// Klipper/Moonraker webcams serve MJPEG, which go2rtc can ingest and re-publish
// as WebRTC. Without this a Klipper printer could only ever show relayed still
// frames, while the Bambus went live -- the same camera on a different printer
// behaving differently for no reason the user can see.
//
// Transcoding to H264 is required: browsers will not accept MJPEG over WebRTC.
export async function registerMjpegStream({ name, url }) {
  if (!url) throw new Error('no webcam URL for this printer');
  const src = `ffmpeg:${url}#video=h264`;
  if (registered.get(name) === src) return name;
  const up = await ensureGo2rtcRunning();
  if (!up) throw new Error('go2rtc unavailable on the connector host');
  const r = await fetch(`${GO2RTC_API}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, { method: 'PUT' });
  if (!r.ok) {
    let body = '';
    try { body = (await r.text()).trim().slice(0, 200); } catch { /* optional */ }
    throw new Error(`go2rtc rejected the webcam stream (HTTP ${r.status}${body ? ': ' + body : ''}) for ${url}`);
  }
  registered.set(name, src);
  log('registered', name, '-> mjpeg', url);
  return name;
}

export async function streamRegistered(name) {
  try {
    const r = await fetch(`${GO2RTC_API}/api/streams`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return false;
    return Object.prototype.hasOwnProperty.call(await r.json(), name);
  } catch { return false; }
}

// Restore every stream we know about after go2rtc starts.
//
// ensureGo2rtc rewrites the config file on each start, which overwrites the
// streams go2rtc persisted into it -- so any restart silently lost them and the
// next request failed with "stream not found". Rather than try to preserve a
// file go2rtc also owns, keep the registrations in memory and replay them.
async function restoreStreams() {
  for (const [name, src] of [...registered]) {
    try {
      await fetch(`${GO2RTC_API}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`,
        { method: 'PUT', signal: AbortSignal.timeout(5000) });
    } catch { registered.delete(name); }
  }
}

export async function ensureGo2rtcRunning() {
  if (await isGo2rtcUp()) return true;
  const up = await ensureGo2rtc();
  if (up) await restoreStreams();
  return up;
}

export async function registerBambuStream({ name, ip, accessCode }) {
  // Catch the empty cases here: without this both produce an indistinguishable
  // 400 from go2rtc and the real cause stays invisible.
  if (!ip) throw new Error('no printer address for the camera (direct_host missing)');
  if (!accessCode) throw new Error('no printer access code for the camera');
  // Bambu printers present a self-signed certificate on their RTSPS port, so
  // verification must be disabled or the TLS handshake is refused before any
  // video flows. On Windows this surfaced as SChannel error 0x80090325
  // ("Creating security context failed") and go2rtc simply stopped the producer
  // ~60ms after starting it, with no indication why. The connection is to a
  // printer on the local network using a per-device access code, so there is no
  // meaningful trust being given up here.
  const src = `ffmpeg:rtsps://bblp:${accessCode}@${ip}:322/streaming/live/1#input=bambu#video=copy`;
  if (registered.get(name) === src) return name; // already registered, same src
  const up = await ensureGo2rtc();
  if (!up) throw new Error('go2rtc unavailable on the connector host');
  const r = await fetch(`${GO2RTC_API}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, { method: 'PUT' });
  if (!r.ok) {
    // A bare status code is not diagnosable. go2rtc explains itself in the body,
    // and the source it rejected matters — a missing IP or access code produces
    // the same 400 as a malformed URL. The access code is masked because this
    // string travels to the cloud and into logs.
    let body = '';
    try { body = (await r.text()).trim().slice(0, 200); } catch { /* body optional */ }
    const shown = src.replace(/:\/\/bblp:[^@]*@/, '://bblp:***@');
    throw new Error(`go2rtc rejected the camera source (HTTP ${r.status}${body ? ': ' + body : ''}) for ${shown}`);
  }
  registered.set(name, src);
  log('registered', name, '->', ip + ':322');
  return name;
}

// The local URLs the agent's HTTP relay can fetch for a registered Bambu stream.
// frame.jpeg = fast single JPEG (snapshot); stream.mjpeg = motion JPEG.
export function localFrameUrl(name) { return `${GO2RTC_API}/api/frame.jpeg?src=${encodeURIComponent(name)}`; }
export function localMjpegUrl(name) { return `${GO2RTC_API}/api/stream.mjpeg?src=${encodeURIComponent(name)}`; }
