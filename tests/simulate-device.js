#!/usr/bin/env node
/**
 * Simulated ZKTeco F18 device (for testing without real hardware).
 *
 * Connects to the PushServer like a real F18 with PUSH/ADMS firmware would:
 *   1. REGISTER  SN=... \n
 *   2. DATA UPDATEuserinfo ...
 *   3. DATA UPDATE Attlog ... (attendance punches)
 *
 * Run with:  npm test
 */
process.env.NODE_ENV = 'test';
const net = require('net');
const config = require('../config');

// Default to the same interface the push server is bound to (config.bindIp),
// so `npm test` works even when the server listens on a specific LAN IP.
// Override with PUSH_HOST=<ip> if needed.
const PUSH_HOST = process.env.PUSH_HOST || config.bindIp || '127.0.0.1';
const PUSH_PORT = parseInt(process.env.PUSH_PORT || String(config.pushPort), 10);
const SN = process.env.SN || 'CJT33227610247';

// ---- fixed test records -----------------------------------------------------
const punches = [
  { userId: '1', seconds: 732245161, status: 0, verify: 1 }, // 2023-03-01 08:19:21 check-in
  { userId: '2', seconds: 732245401, status: 0, verify: 15 }, // fingerprint+pin
  { userId: '1', seconds: 732248261, status: 1, verify: 1 }, // check-out
];

// ------------------------------------------------------------------------------

const socket = net.createConnection({ host: PUSH_HOST, port: PUSH_PORT });

socket.on('connect', () => {
  console.log(`[SIMULATOR] Connected to push server at ${PUSH_HOST}:${PUSH_PORT} (${SN})`);
  socket.write(`REGISTER\tSS=1\tVCS=1\t${'REG'}\tSN=${SN}\tID=1\n`);
});

socket.on('data', (data) => {
  const text = data.toString('latin1');
  console.log(`[SIMULATOR] << ${text.trim()}`);

  // After the REGISTER ack (first OK), push one batch of attendance records.
  if (text.startsWith('OK') && !havePunched) {
    havePunched = true;
    sendAttlogs();
  }
});

let havePunched = false;

/** Send an ATTLOG DATA packet the same way a real F18 does. */
function sendAttlogs() {
  const body = punches
    .map((p) => `${p.userId}\t${p.seconds}\t${p.status}\t${p.verify}\t0\t0`)
    .join('\n');

  const requestId = Math.floor(Math.random() * (1 << 30));
  const header = `DATA UPDATE Attlog\tUART=115200\tAuthorized=1\ttable=ATTLOG\tATType=1\tRequestID=${requestId}\tcount=${punches.length}\tCDATA=${Buffer.byteLength(body, 'latin1')}`;

  socket.write(`${header}\n${body}\n`);
  console.log(`[SIMULATOR] >> ATTLOG packet with ${punches.length} punches`);

  setTimeout(() => {
    console.log('[SIMULATOR] Done. Exiting.');
    socket.end();
    process.exit(0);
  }, 1500);
}

socket.on('error', (e) => {
  console.error(`[SIMULATOR] Error: ${e.message}`);
  process.exit(1);
});
