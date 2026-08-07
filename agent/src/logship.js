// Optional log shipping for the connector.
//
// OFF BY DEFAULT AND ALWAYS OPT-IN. The connector runs on a user's own network
// and its logs describe their printers, so nothing is sent anywhere unless they
// configure a destination themselves. There is no fallback endpoint and no
// vendor default: an unconfigured connector ships nothing.
//
// Two protocols, chosen by URL scheme:
//   http(s)://host:3100   -> Grafana Loki push API
//   syslog://host:514     -> RFC5424 over UDP
import dgram from 'node:dgram';

const MAX_BATCH = 200;
const FLUSH_MS = 5000;

let cfg = { url: '', labels: {}, enabled: false };
let queue = [];
let timer = null;

export function configureLogShipping({ url, name } = {}) {
  const u = String(url || '').trim();
  cfg = {
    url: u,
    enabled: Boolean(u),
    labels: { job: 'openprinthq-connector', connector: name || 'connector', host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown' }
  };
  if (cfg.enabled && !timer) timer = setInterval(flush, FLUSH_MS).unref?.() || setInterval(flush, FLUSH_MS);
  return cfg.enabled;
}

export function shipLog(line) {
  if (!cfg.enabled || !line) return;
  queue.push([String(Date.now() * 1e6), String(line)]);
  // Bound the queue: a connector that cannot reach its log server must not grow
  // memory without limit. Oldest lines are dropped first.
  if (queue.length > MAX_BATCH * 5) queue = queue.slice(-MAX_BATCH * 5);
}

async function flush() {
  if (!cfg.enabled || !queue.length) return;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    if (cfg.url.startsWith('syslog://')) await sendSyslog(batch);
    else await sendLoki(batch);
  } catch {
    // Never let a logging failure disturb the connector. Drop the batch rather
    // than retrying forever against a server that may be gone.
  }
}

async function sendLoki(batch) {
  const body = JSON.stringify({ streams: [{ stream: cfg.labels, values: batch }] });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(cfg.url.replace(/\/$/, '') + '/loki/api/v1/push', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctrl.signal
    });
  } finally { clearTimeout(t); }
}

function sendSyslog(batch) {
  return new Promise((resolve) => {
    const m = /^syslog:\/\/([^:/]+)(?::(\d+))?/.exec(cfg.url);
    if (!m) return resolve();
    const [, host, port] = m;
    const sock = dgram.createSocket('udp4');
    const tag = cfg.labels.connector.replace(/[^\w-]/g, '');
    let left = batch.length;
    const done = () => { if (--left <= 0) { try { sock.close(); } catch { /* */ } resolve(); } };
    for (const [, line] of batch) {
      // RFC5424: <priority>version timestamp host app procid msgid message
      const msg = `<134>1 ${new Date().toISOString()} ${cfg.labels.host} ${tag} ${process.pid} - - ${line}`;
      sock.send(Buffer.from(msg), Number(port) || 514, host, done);
    }
    if (!batch.length) resolve();
  });
}
