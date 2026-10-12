#!/usr/bin/env node
/**
 * Demo WebSocket client — shows exactly what your future API will receive.
 *
 * Usage:
 *   node tests/ws-client.js            (connects to ws://127.0.0.1:8080)
 *   WS_HOST=localhost WS_PORT=8080 node tests/ws-client.js
 */
const WebSocket = require('ws');

const host = process.env.WS_HOST || '127.0.0.1';
const port = parseInt(process.env.WS_PORT || '8080', 10);

const ws = new WebSocket(`ws://${host}:${port}`);

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'attendance') {
    for (const rec of msg.data) {
      console.log(
        `[WS CLIENT] 🎯 punch → userId=${rec.userId}  status=${rec.statusLabel}` +
        `  verify=${rec.verifyModeLabel}  time=${rec.timestamp}  SN=${rec.serialNumber}`
      );
    }
  } else {
    console.log(`[WS CLIENT] ${msg.type}:`, JSON.stringify(msg.data));
  }
});

ws.on('open', () => console.log(`[WS CLIENT] Connected to ws://${host}:${port}`));
ws.on('error', (e) => console.error(`[WS CLIENT] Error: ${e.message}`));
