// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Broker/rendezvous gateway (see docs/broker-architecture.md).
//
// The cloud is a BROKER only: it records where this client lives (public
// host:port) and which printers it fronts, and hands that to authorized
// browsers. The browser then connects DIRECTLY here - the cloud never carries
// printer bytes. This module is that local gateway: a listening HTTP server that
// bridges inbound browser requests to the printers on this LAN, plus periodic
// registration of our public endpoint + printer inventory with the broker.
//
// Reachability: the listener binds 0.0.0.0 so a router port-forward can reach it.
// This does NOT traverse CG-NAT (no inbound port). Accepted limitation.

'use strict';
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');

// ---- browser token verification -----------------------------------------
// The broker issues short-lived tokens to browsers; the client verifies them so
// the open gateway port is not world-usable. Tokens are HMAC-signed with a
// per-connector gateway secret shared with the broker at registration time.
function verifyBrowserToken(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expect = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
  // constant-time compare
  const a = Buffer.from(sig); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); } catch { return null; }
  if (!claims.exp || Date.now() > Number(claims.exp)) return null;   // expired
  return claims;   // { printer_id?, exp, scope? }
}

// ---- per-printer bridge targets -----------------------------------------
// The registered printers, keyed by id, with the local endpoints to bridge to.
//   { id, vendor, ip, moonraker_port, camera_url }
let printerTargets = new Map();
function setPrinters(list) {
  printerTargets = new Map();
  for (const p of list || []) printerTargets.set(String(p.id), p);
}

// ---- Moonraker HTTP + WS reverse proxy ----------------------------------
// Proxies /printer/... and /server/... plus the /websocket upgrade straight to
// the Klipper host. Keeps the browser talking a normal Moonraker API, just
// pointed at this gateway instead of the LAN IP.
function proxyHttp(clientReq, clientRes, target, pathAndQuery) {
  const opts = { host: target.ip, port: target.moonraker_port || 7125, method: clientReq.method,
                 path: pathAndQuery, headers: { ...clientReq.headers, host: `${target.ip}:${target.moonraker_port || 7125}` } };
  const upstream = http.request(opts, (up) => {
    clientRes.writeHead(up.statusCode || 502, up.headers);
    up.pipe(clientRes);
  });
  upstream.on('error', (e) => { if (!clientRes.headersSent) clientRes.writeHead(502); clientRes.end(`upstream error: ${e.message}`); });
  clientReq.pipe(upstream);
}

function proxyWs(clientReq, clientSocket, head, target) {
  // Raw TCP splice for the WebSocket upgrade to Moonraker's /websocket.
  const up = net.connect(target.moonraker_port || 7125, target.ip, () => {
    // Re-send the upgrade request line + headers to the printer.
    let head_ = `${clientReq.method} ${clientReq.url} HTTP/1.1\r\n`;
    for (let i = 0; i < clientReq.rawHeaders.length; i += 2) head_ += `${clientReq.rawHeaders[i]}: ${clientReq.rawHeaders[i + 1]}\r\n`;
    head_ += '\r\n';
    up.write(head_);
    if (head && head.length) up.write(head);
    up.pipe(clientSocket);
    clientSocket.pipe(up);
  });
  up.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => up.destroy());
}

// ---- generic TCP bridge (Bambu MQTT 8883, FTP 990, camera) --------------
// A browser opens a WebSocket to /tcp/:printerId/:port and we splice it to the
// printer's TCP port. Carries any protocol (MQTT/TLS, FTP, etc.) as binary WS
// frames. (Browsers can't open raw TCP, so we frame it over WS.)
function bridgeTcpOverWs(ws, target, port) {
  const sock = net.connect(port, target.ip);
  sock.on('data', (chunk) => { try { ws.send(chunk); } catch { /* closed */ } });
  sock.on('close', () => { try { ws.close(); } catch {} });
  sock.on('error', () => { try { ws.close(); } catch {} });
  ws.on('message', (data) => { try { sock.write(data); } catch {} });
  ws.on('close', () => sock.destroy());
  ws.on('error', () => sock.destroy());
}

// ---- the gateway server --------------------------------------------------
function startGateway({ port, gatewaySecretRef, cameraFrameUrl, log }) {
  const secret = () => (typeof gatewaySecretRef === 'function' ? gatewaySecretRef() : gatewaySecretRef);
  const server = http.createServer((req, res) => {
    // CORS: the browser app (openprinthq.com) calls us cross-origin.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const u = new URL(req.url, 'http://gateway.local');

    // health / liveness (no auth) so the broker + browser can probe reachability
    if (u.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }

    // everything else requires a valid browser token (query ?t= or Bearer)
    const token = u.searchParams.get('t') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const claims = verifyBrowserToken(token, secret());
    if (!claims) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"invalid or expired token"}'); }

    // route: /p/:printerId/moonraker/*  -> Moonraker HTTP
    const m = u.pathname.match(/^\/p\/([^/]+)\/moonraker(\/.*)?$/);
    if (m) {
      const target = printerTargets.get(m[1]);
      if (!target) { res.writeHead(404); return res.end('unknown printer'); }
      if (claims.printer_id && String(claims.printer_id) !== m[1]) { res.writeHead(403); return res.end('token not for this printer'); }
      const rest = (m[2] || '/') + (u.search || '');
      return proxyHttp(req, res, target, rest);
    }

    // route: /p/:printerId/camera/frame -> local go2rtc JPEG (Bambu) or MJPEG proxy
    const c = u.pathname.match(/^\/p\/([^/]+)\/camera\/frame$/);
    if (c && cameraFrameUrl) {
      const target = printerTargets.get(c[1]);
      if (!target) { res.writeHead(404); return res.end('unknown printer'); }
      const frameUrl = cameraFrameUrl(c[1], target);
      if (!frameUrl) { res.writeHead(404); return res.end('no camera'); }
      http.get(frameUrl, (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); })
          .on('error', (e) => { res.writeHead(502); res.end(e.message); });
      return;
    }

    res.writeHead(404); res.end('not found');
  });

  // WebSocket upgrades: Moonraker /p/:id/moonraker/websocket, and /p/:id/tcp/:port
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://gateway.local');
    const token = u.searchParams.get('t');
    const claims = verifyBrowserToken(token, secret());
    if (!claims) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }

    const mw = u.pathname.match(/^\/p\/([^/]+)\/moonraker\/websocket$/);
    if (mw) {
      const target = printerTargets.get(mw[1]);
      if (!target) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy(); }
      return proxyWs(req, socket, head, target);
    }
    // /p/:id/tcp/:port handled by the WS layer in agent.js if a ws lib is present;
    // for now we splice raw here too (browser sends a WS handshake we accept).
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy();
  });

  server.on('error', (e) => log && log('gateway server error:', e.message));
  server.listen(port, '0.0.0.0', () => log && log(`gateway listening on 0.0.0.0:${port} (forward this port on your router for remote access)`));
  return server;
}


// ---- authenticated raw TCP passthrough (for the engine, server-to-server) ---
// The cloud engine (not a browser) reaches a printer's raw TCP port through the
// gateway. It opens a connection and sends a single line preamble:
//     OPHQ1 <token> <printerId> <targetPort>\n
// We verify the token, look up the printer's LAN ip, and splice to ip:targetPort.
// Bambu MQTT is TLS end-to-end (cert pinned to the printer); we only forward
// bytes, so the engine's TLS terminates at the printer as normal.
function startTcpPassthrough({ port, gatewaySecretRef, verify, log }) {
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    let pre = Buffer.alloc(0);
    let armed = true;
    const onPreamble = (chunk) => {
      pre = Buffer.concat([pre, chunk]);
      const nl = pre.indexOf(0x0a);
      if (nl === -1) { if (pre.length > 512) sock.destroy(); return; }   // guard
      armed = false;
      sock.removeListener('data', onPreamble);
      const line = pre.slice(0, nl).toString('utf8').trim();
      const rest = pre.slice(nl + 1);
      const parts = line.split(/\s+/);
      if (parts[0] !== 'OPHQ1' || parts.length !== 4) { sock.destroy(); return; }
      const [, token, printerId, targetPortStr] = parts;
      const claims = verify(token);
      if (!claims || (claims.printer_id && String(claims.printer_id) !== String(printerId))) { sock.destroy(); return; }
      const target = printerTargets.get(String(printerId));
      const targetPort = Number(targetPortStr);
      if (!target || !Number.isInteger(targetPort)) { sock.destroy(); return; }
      const up = net.connect(targetPort, target.ip, () => {
        if (rest.length) up.write(rest);
        up.pipe(sock); sock.pipe(up);
      });
      up.on('error', () => sock.destroy());
      sock.on('error', () => up.destroy());
      sock.on('close', () => up.destroy());
    };
    sock.on('data', onPreamble);
    sock.on('error', () => {});
  });
  server.on('error', (e) => log && log('tcp passthrough error:', e.message));
  server.listen(port, '0.0.0.0', () => log && log(`tcp passthrough listening on 0.0.0.0:${port}`));
  return server;
}

module.exports = { startGateway, setPrinters, verifyBrowserToken, bridgeTcpOverWs, startTcpPassthrough };
