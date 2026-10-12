/**
 * WebSocket broadcaster + dashboard host.
 *
 * A single HTTP server on wsPort serves:
 *   GET /            → live status dashboard page (src/dashboard.js)
 *   GET /health      → {"ok":true,...}
 *   Upgrade to WS    → realtime events to API clients & dashboard
 *
 * Server-side state makes refreshing the page lossless:
 *   lastDevice  → replayed to every new WS client (status card is instant)
 *   scanHistory → last N scans replayed so history survives refresh
 */
const http = require('http');
const { WebSocketServer } = require('ws');
const logger = require('./logger');

const SCAN_HISTORY_LIMIT = 50;

class WsHub {
  constructor(port) {
    this.port = port;
    this.httpServer = null;
    this.wss = null;
    this.connectedClients = 0;
    // The device's CURRENT authoritative state — defaults to "unknown",
    // which the UI shows as its initial "Waiting" pose, NOT as "disconnected".
    this.lastDevice = { event: null, serialNumber: null, at: null };
    this.scanHistory = [];
  }

  start() {
    this.httpServer = http.createServer((req, res) => {
      // NOTE: Dashboard (registered after start) replaces this handler entirely.
      if (!this._routes) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }
    });

    this.httpServer.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        logger.err('WS', `Port ${this.port} is already in use!`);
        logger.err('WS', `→ Fix: kill the old process:  sudo lsof -t -i :${this.port} | xargs kill`);
        process.exit(1);
      }
      logger.err('WS', `WebSocket error: ${e.message}`);
    });

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.httpServer.listen(this.port, () => {
      logger.ok('WS', `WS + dashboard listening on http://0.0.0.0:${this.port}`);
    });

    this.wss.on('connection', (socket, req) => {
      this.connectedClients++;
      logger.ok('WS', `Client connected (${req.socket.remoteAddress}) — ${this.connectedClients} client(s) online`);

      // ── Catch-up for refreshes / late joiners ──
      // Only send a device state we actually KNOW. If nothing is known yet,
      // send NOTHING — the page keeps its "Waiting…" pose until real news.
      if (this.lastDevice.event) {
        socket.send(JSON.stringify({ type: 'device', data: this.lastDevice }));
      }
      // Replay scan history so the feed isn't empty after a refresh
      if (this.scanHistory.length) {
        socket.send(JSON.stringify({ type: 'attendance', data: this.scanHistory }));
      }

      socket.on('close', () => {
        this.connectedClients--;
        logger.log('WS', `Client disconnected — ${this.connectedClients} client(s) online`);
      });
      socket.on('error', () => {});
    });
  }

  stop() {
    if (this.wss) {
      this.wss.clients.forEach((c) => c.terminate());
      this.wss.close();
    }
    if (this.httpServer) this.httpServer.close();
  }

  broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === 1 /* OPEN */) client.send(msg);
    }
  }

  /** Attendance pipeline: keep server-side history + fan out */
  addScans(records) {
    this.scanHistory.unshift(...records);
    if (this.scanHistory.length > SCAN_HISTORY_LIMIT) {
      this.scanHistory.length = SCAN_HISTORY_LIMIT;
    }
    this.broadcast({ type: 'attendance', data: records });
  }

  /** Device lifecycle (single source of truth for status card) */
  setDeviceState(event, serialNumber) {
    this.lastDevice = { event, serialNumber, at: new Date().toISOString() };
    this.broadcast({ type: 'device', data: this.lastDevice });
  }
}

module.exports = { WsHub };
