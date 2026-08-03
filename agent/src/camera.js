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

import { spawn } from 'node:child_process';
import net from 'node:net';

const GO2RTC_API = 'http://127.0.0.1:1984';
let go2rtcProc = null;
let go2rtcStarting = null;
const registered = new Map(); // streamName -> src

function log(...a) { console.log('[camera]', ...a); }

// Bambu internal model codes / marketing names that expose RTSPS on 322.
// (A1/A1MINI/P1P/P1S use the chamber-image protocol on 6000 — not go2rtc-able.)
const RTSP_MODELS = /^(x1|x1c|x1e|x2d|p2s|h2c|h2d|h2dpro|h2s|o1d|o1c2|o1c|c13|c11)/i;
export function bambuSupportsRtsp(model) {
  return !!model && RTSP_MODELS.test(String(model).replace(/[\s_-]/g, ''));
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
      const ffmpegBin = process.env.OPHQ_FFMPEG_BIN;
      const cfg = buildConfig(ffmpegBin, currentIce);
      go2rtcProc = spawn(go2rtcBin, ['-config', cfg], { stdio: 'ignore', detached: false });
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
function buildConfig(ffmpegBin, ice) {
  const cfg = {
    api: { listen: '127.0.0.1:1984' },
    webrtc: { listen: `:${WEBRTC_PORT}`, ice_servers: ice && ice.length ? ice : [{ urls: 'stun:stun.cloudflare.com:3478' }] },
    log: { level: 'warn' }
  };
  if (ffmpegBin) cfg.ffmpeg = { bin: ffmpegBin };
  return JSON.stringify(cfg);
}

// go2rtc reads ice_servers at startup, so a changed credential set means a
// respawn. Cloudflare TURN credentials are short-lived, so this happens on a
// normal cadence rather than only at install time. Streams are re-registered on
// demand, so a respawn costs one reconnect, not lost configuration.
function iceChanged(next) {
  try { return JSON.stringify(next || []) !== JSON.stringify(currentIce || []); }
  catch { return true; }
}
export async function applyIceServers(ice) {
  if (!iceChanged(ice)) return false;
  currentIce = Array.isArray(ice) ? ice : [];
  if (go2rtcProc) {
    log('ICE servers changed — restarting go2rtc to pick them up');
    try { go2rtcProc.kill(); } catch { /* already gone */ }
    go2rtcProc = null;
    await new Promise((r) => setTimeout(r, 300));
  }
  return true;
}

// Hand a browser's SDP offer to the LOCAL go2rtc and return its answer. This is
// the whole point of the agent-local model: only the offer/answer text crosses
// the cloud, and the media then flows browser <-> this host.
export async function webrtcOffer(name, offer) {
  const up = (await isGo2rtcUp()) || (await ensureGo2rtc());
  if (!up) throw new Error('go2rtc unavailable on the connector host');
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
export async function registerBambuStream({ name, ip, accessCode }) {
  const src = `rtsps://bblp:${accessCode}@${ip}:322/streaming/live/1`;
  if (registered.get(name) === src) return name; // already registered, same src
  const up = await ensureGo2rtc();
  if (!up) throw new Error('go2rtc unavailable on the connector host');
  const r = await fetch(`${GO2RTC_API}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, { method: 'PUT' });
  if (!r.ok) throw new Error(`go2rtc register failed: ${r.status}`);
  registered.set(name, src);
  log('registered', name, '->', ip + ':322');
  return name;
}

// The local URLs the agent's HTTP relay can fetch for a registered Bambu stream.
// frame.jpeg = fast single JPEG (snapshot); stream.mjpeg = motion JPEG.
export function localFrameUrl(name) { return `${GO2RTC_API}/api/frame.jpeg?src=${encodeURIComponent(name)}`; }
export function localMjpegUrl(name) { return `${GO2RTC_API}/api/stream.mjpeg?src=${encodeURIComponent(name)}`; }
