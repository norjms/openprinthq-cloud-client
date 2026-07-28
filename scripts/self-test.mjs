// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenPrintHQ Cloud Client — connectivity self-test.
//
// Checks that this machine can reach (1) your cloud instance on 443 and
// (2) an optional named printer. Outbound-only: it never opens a listener.
//
//   node self-test.mjs [https://your-instance] [printerHost[:port]]
//
// With no args it reads the shared config.json (control_url + test_printer).

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

function defaultConfigDir() {
  if (process.platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'OpenPrintHQ');
  if (process.platform === 'darwin') return '/Library/Application Support/OpenPrintHQ';
  return '/etc/openprinthq';
}

function readCfg() {
  const p = process.env.OPHQ_CONFIG_FILE || path.join(defaultConfigDir(), 'config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function splitHostPort(s, def) {
  const i = s.lastIndexOf(':');
  if (i > 0 && /^\d+$/.test(s.slice(i + 1))) return [s.slice(0, i), Number(s.slice(i + 1))];
  return [s, def];
}

function tcp(host, port, timeout = 6000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout }, () => { sock.destroy(); resolve({ ok: true }); });
    sock.on('error', (e) => resolve({ ok: false, error: e.message }));
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

const cfg = readCfg();
const controlUrl = process.argv[2] || cfg.control_url || 'https://openprinthq.com';
const printerArg = process.argv[3] || cfg.test_printer || '';

const u = controlUrl.replace(/^https?:\/\//, '').split('/')[0];
const [chost, cport] = splitHostPort(u, controlUrl.startsWith('http://') ? 80 : 443);

let fail = 0;
const cloud = await tcp(chost, cport);
console.log(`Cloud   ${cloud.ok ? 'OK  ' : 'FAIL'}  ${chost}:${cport}${cloud.ok ? '' : '  (' + cloud.error + ')'}`);
if (!cloud.ok) fail++;

if (printerArg) {
  const [phost, pport] = splitHostPort(printerArg, 80);
  const pr = await tcp(phost, pport);
  console.log(`Printer ${pr.ok ? 'OK  ' : 'FAIL'}  ${phost}:${pport}${pr.ok ? '' : '  (' + pr.error + ')'}`);
  if (!pr.ok) fail++;
} else {
  console.log('Printer -     (no test printer configured)');
}

process.exit(fail ? 1 : 0);
