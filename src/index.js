#!/usr/bin/env node
/**
 * ZKTeco F18 — realtime WebSocket bridge entry point.
 *
 * 1. PushServer listens on TCP 4370 and receives events FROM the F18 device
 * 2. WsHub listens on WS 8080 and broadcasts those events TO your API
 * 3. (Next step) your API subscribes here and writes records to the database
 *
 * DATA POLICY: displayed values (the log count and check-in time) come from
 * the MACHINE's pushed data — its clock, its records — and retransmissions of
 * the same device log entry are deduped, never re-invented by the bridge.
 */
const { PushServer } = require('./push-server');
const { WsHub } = require('./ws-hub');
const { Dashboard } = require('./dashboard');
const { DeviceLog } = require('./device-log');
const { ApiForwarder } = require('./api-forwarder');
const config = require('../config');
const logger = require('./logger');

const api = new ApiForwarder(config.hrApi);

const wsHub = new WsHub(config.wsPort);
const deviceLog = new DeviceLog(); // the machine's own log, deduped by raw line

/**
 * Format a punch time exactly as the device clock reported it, 24h:
 * PUSH/ADMS stores seconds since 2000-01-01 in device-local time — reading the
 * stored value back through UTC formatting reproduces the device's own clock.
 */
function toDevice24h(isoTs) {
  return new Date(isoTs).toISOString().slice(0, 19).replace('T', ' ');
}

// 'wsHub' is referenced in callbacks below but created above so it's defined
// at the time the callbacks fire.
const push = new PushServer(config.pushPort, {
  onAttendance(records, sn) {
    // Machine→bridge ingest: dedupe by the device's own raw log line so
    // the count never double-counts a retransmitted entry.
    const fresh = deviceLog.ingest(sn, records);
    for (const rec of fresh) {
      logger.data('BRIDGE', `employeeID=${rec.userId}   checkinTime=${rec.device24h || toDevice24h(rec.timestamp)}`);
      api.send(rec); // forward to HR API ( EmployeID + checkinTime )
    }
    wsHub.addScans(fresh);
  },

  onDevice(event, sn) {
    const icon = event === 'connected' ? '🔌' : event === 'reconnected' ? '🔄' : '📴';
    const label = event === 'connected' ? 'connected (first contact)' : event === 'reconnected' ? 'RE-connected — back online' : 'disconnected — waiting for device';
    logger.log('BRIDGE', `${icon} Scanner ${label}${sn ? ' — SN=' + sn : ''}`);
    wsHub.setDeviceState(event, sn || null);
  },
}, config.allowedDeviceIps || [], config.bindIp || '0.0.0.0', config.offlineAfterSec || 300, config.showRawData !== false);

push.start();
wsHub.start();
new Dashboard(wsHub);

// If either listener has a fatal startup error, the corresponding start() call
// returns, but the process would silently be half-dead. If the WS hub or push
// server crashed after start, exit instead of looking "connected".
setInterval(() => {
  const pushDead = !push.server || !push.server.listening;
  const wsDead = !wsHub.wss || !wsHub.wss._server || wsHub.wss._server.listening === false;
  if (pushDead) {
    logger.err('BRIDGE', 'Push server is NOT running — device can never connect!');
    logger.err('BRIDGE', '→ Most common cause: port 4370 already in use. Fix and restart.');
    process.exit(1);
  }
  if (wsDead) {
    logger.err('BRIDGE', 'WebSocket server is NOT running — API clients can never connect!');
    logger.err('BRIDGE', '→ Most common cause: port 8080 already in use. Fix and restart.');
    process.exit(1);
  }
}, 3000);

logger.log('BRIDGE', `Scanner (F18) expected at: ${config.deviceIp || 'any'}  → push server bound to ${config.bindIp}:${config.pushPort}`);
logger.log('BRIDGE', 'API clients should connect to: ws://<this-pc-ip>:' + config.wsPort);

process.on('SIGINT', () => {
  logger.warn('BRIDGE', 'Shutting down…');
  push.stop();
  wsHub.stop();
  process.exit(0);
});
