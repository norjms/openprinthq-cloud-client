// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenPrintHQ Cloud Client — service launcher.
//
// Reads the shared config.json (written by the tray/menu-bar app) and starts
// the connector agent with the matching OPHQ_* environment. Used by the
// platform services (Windows Service / launchd LaunchDaemon / systemd) so the
// connector runs at boot with no login. The tray app and the service therefore
// share one config file and one on-disk key.
//
//   node run-connector.mjs [path/to/config.json]
//
// Config path resolution: $OPHQ_CONFIG_FILE, then argv[2], then the per-OS
// machine-wide default below. Real environment variables always win over the
// config file, so you can still override any value in the service unit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function defaultConfigDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.ProgramData || 'C:\\ProgramData', 'OpenPrintHQ');
  }
  if (process.platform === 'darwin') {
    return '/Library/Application Support/OpenPrintHQ';
  }
  return '/etc/openprinthq';
}

const cfgPath =
  process.env.OPHQ_CONFIG_FILE ||
  process.argv[2] ||
  path.join(defaultConfigDir(), 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return null;
  }
}

// Wait (rather than exit) until a valid config appears. Under a service
// manager with restart-on-exit (launchd KeepAlive / systemd Restart=always),
// exiting here would crash-loop before the user has pasted a token. Instead we
// stay up and poll, so the daemon can be installed and enabled at boot and
// simply activates once the tray/menu-bar app writes the config.
let cfg = readConfig();
let warned = false;
while (!cfg || !cfg.control_url || !cfg.token) {
  if (!warned) {
    console.error(`[run-connector] waiting for configuration at ${cfgPath} — paste your instance URL and token in the OpenPrintHQ app.`);
    warned = true;
  }
  await new Promise((r) => setTimeout(r, 5000));
  cfg = readConfig();
}

const map = {
  control_url: 'OPHQ_CONTROL_URL',
  token: 'OPHQ_CONNECTOR_TOKEN',
  name: 'OPHQ_CONNECTOR_NAME',
  allow: 'OPHQ_ALLOW',
  allow_ports: 'OPHQ_ALLOW_PORTS',
  signing_pubkey: 'OPHQ_SIGNING_PUBKEY',
};
for (const [k, envName] of Object.entries(map)) {
  if (cfg[k] != null && cfg[k] !== '' && !process.env[envName]) {
    process.env[envName] = String(cfg[k]);
  }
}
// Persist the connector's own key next to the config for stable mutual auth.
if (!process.env.OPHQ_CLIENT_KEY_FILE) {
  process.env.OPHQ_CLIENT_KEY_FILE = path.join(path.dirname(cfgPath), 'connector-key.pem');
}
// Where the agent pins the control-plane's command-signing key. Same directory,
// same persistence guarantees. Without it the agent refuses to start, because
// running without a pinned key means executing unauthenticated commands against
// the user's LAN.
if (!process.env.OPHQ_SIGNING_PUBKEY_FILE) {
  process.env.OPHQ_SIGNING_PUBKEY_FILE = path.join(path.dirname(cfgPath), 'ophq-signing.pub.pem');
}

// Resolve the agent: $OPHQ_AGENT_FILE, else a sibling ../agent/src/agent.js.
const agentFile =
  process.env.OPHQ_AGENT_FILE ||
  path.resolve(__dirname, '..', 'agent', 'src', 'agent.js');

if (!fs.existsSync(agentFile)) {
  console.error(`[run-connector] agent not found at ${agentFile} (set OPHQ_AGENT_FILE)`);
  process.exit(3);
}

// Importing the agent runs its main() with the env we just set.
await import(pathToFileURL(agentFile).href);
