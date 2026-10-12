/**
 * Web dashboard — a tiny status/monitor page served by the bridge itself.
 *
 * GET http://localhost:8080/          → this HTML page (live device status + scans)
 * WS  ws://host:8080                  → same WebSocket the API will use
 *
 * Page shows:
 *   • Device status card: 🟢 Connected / 🔴 Disconnected / 🟠 Waiting…
 *   • Each new fingerprint scan (employeeID, checkinTime)
 *   • Connection history (last 20 events)
 */
const logger = require('./logger');

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>F18 Scanner — Live Status</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --text:#e2e8f0; --muted:#94a3b8;
          --green:#22c55e; --red:#ef4444; --amber:#f59e0b; --accent:#38bdf8; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:system-ui,-apple-system,'Segoe UI',sans-serif; background:var(--bg);
         color:var(--text); min-height:100vh; padding:24px; }
  .wrap { max-width:860px; margin:0 auto; }
  h1 { font-size:1.35rem; margin-bottom:4px; }
  .sub { color:var(--muted); font-size:.85rem; margin-bottom:20px; }
  .card { background:var(--card); border-radius:14px; padding:20px 24px; margin-bottom:18px;
          box-shadow:0 4px 14px rgba(0,0,0,.25); }
  .status-row { display:flex; align-items:center; gap:14px; }
  .dot { width:16px; height:16px; border-radius:50%; flex-shrink:0; }
  .dot.on  { background:var(--green); box-shadow:0 0 10px var(--green); animation:pulse 2s infinite; }
  .dot.off { background:var(--red); }
  .dot.wait{ background:var(--amber); animation:pulse 1.2s infinite; }
  @keyframes pulse { 50% { opacity:.4; } }
  .status-text { font-size:1.1rem; font-weight:600; }
  .status-meta { color:var(--muted); font-size:.8rem; margin-left:auto; text-align:right; }
  table#scanTable { width:100%; border-collapse:collapse; table-layout:fixed; font-size:.9rem; }
  table#scanTable thead th { text-align:left; padding:8px 10px; color:var(--muted);
          border-bottom:2px solid rgba(148,163,184,.4); font-weight:600; }
  table#scanTable tbody td { padding:8px 10px; border-bottom:1px solid rgba(148,163,184,.15);
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  td.emp { font-weight:700; color:var(--accent); overflow:visible; }
  td.time{ color:var(--muted); }
  .scan-scroll { max-height:380px; overflow-y:auto; }
  ul#history { list-style:none; max-height:200px; overflow-y:auto; }
  li.ev.ok::before  { content:'✅ '; }
  li.ev.bad::before { content:'📴 '; }
  .empty { color:var(--muted); font-style:italic; font-size:.85rem; }
  .reconnecting { color:var(--amber); font-size:.8rem; margin-top:6px; display:none; }
  .empty, li.ev { color:var(--muted); font-size:.82rem; }
  li.ev .t { color:var(--accent); margin-right:8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1> continental ZKTeco F18 — Live Scanner Monitor</h1>
  <div class="sub">ws bridge on :4370 (push) / :8080 (dashboard + API) · device 192.168.50.33</div>

  <div class="card">
    <div class="status-row">
      <div id="dot" class="dot wait"></div>
      <div id="status" class="status-text">Waiting for device…</div>
      <div id="meta" class="status-meta">—</div>
    </div>
    <div id="reconnecting" class="reconnecting">⏳ watching for the device to come back…</div>
  </div>

  <div class="card">
    <h2>Fingerprints — real-time</h2>
    <div class="scan-scroll">
      <table id="scanTable">
        <thead>
          <tr><th>EmployeID</th><th>Checkin status</th><th>Checkin Time</th></tr>
        </thead>
        <tbody id="scans">
          <tr class="empty"><td colspan="3">No scans yet. Press your finger on the device.</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <h2>Connection history</h2>
    <ul id="history"></ul>
  </div>
</div>

<script>
  const dot = document.getElementById('dot');
  const status = document.getElementById('status');
  const meta = document.getElementById('meta');
  const scans = document.getElementById('scans');
  const history = document.getElementById('history');
  const rec = document.getElementById('reconnecting');

  function addHistory(text, cls) {
    const li = document.createElement('li');
    li.className = 'ev ' + (cls || '');
    li.innerHTML = '<span class="t">' + new Date().toLocaleTimeString() + '</span>' + text;
    history.prepend(li);
    while (history.children.length > 20) history.lastChild.remove();
  }
  function setOnline() {
    dot.className = 'dot on';
    status.textContent = 'Device connected';
    status.style.color = 'var(--green)';
    rec.style.display = 'none';
    meta.textContent = 'SN: ' + (window._sn || '—');
  }
  function setOffline() {
    dot.className = 'dot off';
    status.textContent = 'Device disconnected';
    status.style.color = 'var(--red)';
    rec.style.display = 'block';
  }

  let ws; let tries = 0;
  function applyDeviceState(d) {
    if (d.event === 'connected' || d.event === 'reconnected') {
      window._sn = d.serialNumber;
      setOnline();
      if (d.event === 'connected') addHistory('scanner connected (SN ' + window._sn + ')', 'ok');
      else addHistory('scanner back online ✅', 'ok');
    } else if (d.event === 'disconnected') {
      setOffline(); addHistory('scanner disconnected', 'bad');
    }
  }

  function connect() {
    ws = new WebSocket('ws://' + location.host);
    ws.onopen = () => {
      tries = 0;
      // DON'T change the status card on websocket open/reopen — the card
      // shows the DEVICE's state, and a page refresh/re-open must simply
      // display the current truth (which the server replays right after).
      addHistory('monitor connected', 'ok');
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'device') {
        applyDeviceState(msg.data);
      } else if (msg.type === 'attendance') {
        if (dot.className !== 'dot on') setOnline(); // scan implies device alive
        for (const r of msg.data) {
          if (r.serialNumber && !window._sn) { window._sn = r.serialNumber; setOnline(); }
          const emptyRow = scans.querySelector('tr.empty');
          if (emptyRow) emptyRow.remove();
          const tr = document.createElement('tr');
          tr.innerHTML = '<td class="emp">' + r.userId + '</td>'
            + '<td>' + (r.statusLabel || '') + '</td>'
            + '<td>' + (r.device24h || r.timestamp) + '</td>';
          scans.prepend(tr);
        }
      }
    };
    ws.onclose = () => {
      // The MONITOR lost its websocket — that's NOT the device going offline!
      // Show a subtle reconnecting banner but LEAVE the device card as-is.
      rec._wsLost = true;
      addHistory('monitor reconnecting…', 'bad');
      setTimeout(connect, Math.min(1000 * ++tries, 5000));
    };
  }
  connect();
</script>
</body>
</html>`;

class Dashboard {
  /**
   * Attaches the dashboard page to the existing HsHub's HTTP server so that
   * both the page and the WS API share port wsPort.
   * @param {WsHub} wsHub an already-started WsHub whose backing server is exposed
   */
  constructor(wsHub) {
    this.wsHub = wsHub;
    const httpSrv = wsHub.httpServer;
    if (!httpSrv) {
      logger.warn('UI', 'No HTTP server attached — dashboard disabled');
      return;
    }
    // Replace the WS hub's default handler entirely — two listeners on the
    // same 'request' event both writing headers would crash (ERR_HTTP_HEADERS_SENT).
    httpSrv.removeAllListeners('request');
    httpSrv.on('request', (req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE);
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) }));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    logger.ok('UI', `Dashboard ready → http://localhost:${wsHub.port}/`);
  }
}

module.exports = { Dashboard };
