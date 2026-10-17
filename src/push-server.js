/**
 * ZKTeco PUSH / ADMS TCP server.
 *
 * The F18 connects TO this server on port 4370 and pushes events.
 * Protocol reference: https://github.com/LegenDARYFDL/zk_tunnel
 *
 * Packet format:
 *   <CMD>\t<key=param>\t...\n<body bytes>\n
 *
 * Lifecycle:
 *   1. Device sends "REGISTER ..." -> we answer "OK"
 *   2. Device sends "DATA UPDATEuserinfo ..." -> we answer "OK"
 *   3. Device sends "DATA Attlog ..." every time a clock event happens
 *      (or in batches) -> we parse records and hand them to onAttendance
 */
const net = require("net");
const {
  CMD,
  DATA_CMD,
  parseHeader,
  parseOptions,
  parseAttLog,
  humanStatus,
  humanVerifyMode,
} = require("./protocol");
const logger = require("./logger");

/** Normalize IPv4-mapped IPv6 addresses (e.g. '::ffff:192.168.50.33') to plain IPv4. */
function normalizeIp(addr) {
  return String(addr || "").replace(/^::ffff:/, "");
}

/** A small per-connection state machine. */
class DeviceSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.sn = "";
    this.id = "";
    this.pending = null; // command we're currently awaiting data for
  }

  digest() {
    // Hand the whole buffered packet off for processing
    const packet = this.buffer;
    this.buffer = Buffer.alloc(0);
    return packet;
  }
}

class PushServer {
  /**
   * @param {number} port            TCP port to listen on (4370 default)
   * @param {{ onAttendance?: Function, onDevice?: Function, onLog?: Function }} handlers
   * @param {string[]} [allowedIps]  optional whitelist of device IPs (empty/undefined = accept all)
   * @param {string} [bindIp]        local interface to listen on
   * @param {number} [offlineAfterSec] seconds of device silence before 'disconnected'
   * @param {boolean} [showRawData]  dump the full raw device bytes for every request
   */
  constructor(
    port,
    handlers = {},
    allowedIps = [],
    bindIp = "0.0.0.0",
    offlineAfterSec = 300,
    showRawData = false,
  ) {
    this.port = port;
    this.handlers = handlers;
    this.allowedIps = allowedIps || [];
    this.bindIp = bindIp;
    this.offlineAfterSec = offlineAfterSec;
    this.showRawData = showRawData;
    this.devices = new Map(); // sn -> DeviceSession
    this.server = null;
    // Last device clock string seen in any OPLOG row (per SN), so scans in
    // LATER bodies (without OPLOG) still get the machine's verbatim time.
    this.lastDeviceClocks = new Map(); // sn -> 'YYYY-MM-DD HH:MM:SS'
    this.httpHandler = new HttpAdmsHandler(this, showRawData);
  }

  start() {
    this.server = net.createServer((socket) => this.onConnection(socket));

    this.server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        logger.err("PUSH", `Port ${this.port} is already in use!`);
        logger.err(
          "PUSH",
          '→ Another bridge instance (or ZKTeco ZKAccess/ZKTime "Intellicon" service) is running.',
        );
        logger.err(
          "PUSH",
          "→ Fix: kill the old process or run:  sudo lsof -i :" +
            this.port +
            "  then kill <PID>",
        );
        process.exit(1);
      }
      if (e.code === "EADDRNOTAVAIL") {
        logger.err(
          "PUSH",
          `Cannot bind to ${this.bindIp} — this PC does not own that IP!`,
        );
        logger.err(
          "PUSH",
          "→ Check `hostname -I` and set config.js → bindIp to one of those (or 0.0.0.0).",
        );
        process.exit(1);
      }
      logger.err("PUSH", `Server error: ${e.message}`);
    });

    this.server.listen(this.port, this.bindIp, () => {
      logger.ok(
        "PUSH",
        `Listening on ${this.bindIp}:${this.port} (waiting for F18 to connect)`,
      );
    });

    return this.server;
  }

  stop() {
    if (this.server) this.server.close();
  }

  onConnection(socket) {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;

    // Optional IP whitelist (config.allowedDeviceIps)
    const normIp = normalizeIp(socket.remoteAddress);
    if (this.allowedIps.length && !this.allowedIps.includes(normIp)) {
      logger.warn(
        "PUSH",
        `Rejected connection from ${remote} (IP ${normIp} not in allowedDeviceIps)`,
      );
      socket.destroy();
      return;
    }

    // NOTE: HTTP-ADMS firmware opens a NEW TCP connection for EVERY request
    // (handshake, polls, scans…) so "Device connected" per-connection would
    // spam the console forever. Silent-accept here; the ONE-TIME
    // "Scanner connected" event is emitted from HttpAdmsHandler when the
    // device's SN first registers, and "Scanner disconnected" fires only
    // after 90s of true inactivity.

    const session = new DeviceSession(socket);
    session.remote = remote;
    session.mode = null; // 'http' or 'line' — detected on first bytes

    socket.on("data", (chunk) => {
      if (session.mode === null) {
        const head = chunk.slice(0, 12).toString("latin1").toUpperCase();
        if (
          head.startsWith("GET ") ||
          head.startsWith("POST ") ||
          head.startsWith("PUT ") ||
          head.startsWith("HTTP")
        ) {
          session.mode = "http";
        } else {
          session.mode = "line";
          logger.log("PUSH", `Device ${normIp} speaks raw line PUSH protocol`);
        }
      }
      if (session.mode === "http") {
        this.httpHandler.feed(session, chunk);
      } else {
        session.buffer = Buffer.concat([session.buffer, chunk]);
        this.processBuffer(session, remote);
      }
    });

    socket.on("error", (e) => {
      logger.err("PUSH", `Socket error from ${remote}: ${e.message}`);
    });

    socket.on("close", () => {
      // HTTP-ADMS makes a NEW TCP connection for EVERY request/poll (~3s apart).
      // Logging each one as connect/disconnect is pure noise, so for http-mode
      // sessions the real online/offline is tracked via idle timeout in
      // HttpAdmsHandler.touchOnline(). Only raw-line sessions log lifecycle here.
      if (session.mode === "line") {
        logger.log("PUSH", `Device ${session.sn || remote} disconnected`);
        if (session.sn) this.devices.delete(session.sn);
        this.handlers.onDevice &&
          this.handlers.onDevice("disconnected", session.sn || remote);
      }
    });
  }

  processBuffer(session, remote) {
    // Loop in case multiple packets arrived back-to-back in one chunk
    let sawPacket = false;
    for (;;) {
      const buf = session.buffer;
      const newlineIdx = buf.indexOf("\n");
      if (newlineIdx === -1) break; // need more bytes for header

      const headerLine = buf.slice(0, newlineIdx).toString("latin1");
      const header = parseHeader(headerLine);
      if (!header.cmd) break;

      // Body length may be advertised by the device (e.g. DATA commands)
      const bodyLenStr = header.params.CDATA || "0";
      const declared = parseInt(bodyLenStr, 10);

      const bodyStart = newlineIdx + 1;
      const availableBody = buf.length - bodyStart;

      // Some packets (like REG/ACKs) carry no CDATA length
      const expectBody = declared > 0;
      if (expectBody && availableBody < declared) break; // wait for rest

      const body = expectBody
        ? buf.slice(bodyStart, bodyStart + declared)
        : buf.slice(bodyStart, buf.length);

      // Remove consumed bytes (+ trailing \n if body present)
      const consumed =
        bodyStart +
        (expectBody ? declared : 0) +
        (expectBody && availableBody > declared ? 1 : 0);
      session.buffer = buf.slice(consumed);

      this.handlePacket(header, body, session, remote);
      sawPacket = true;
      if (session.buffer.length === 0) break;
    }
    if (sawPacket && typeof this.flushEvents === "function") {
      this.flushEvents(session);
    }
  }

  handlePacket(header, body, session, remote) {
    switch (header.cmd) {
      case CMD.REG_REQUEST: {
        session.sn = header.params.SN || "";
        session.id = header.params.ID || "1";
        this.devices.set(session.sn, session);
        logger.ok(
          "PUSH",
          `Device REGISTERED  SN=${session.sn}  ID=${session.id}  IP=${remote}`,
        );
        this.send(session, `${CMD.REG_RESPONSE}\tOK\n`);
        this.handlers.onDevice &&
          this.handlers.onDevice("connected", session.sn);
        break;
      }

      case "DATA UPDATE userinfo": {
        logger.log(
          "PUSH",
          `User info packet from ${session.sn || remote} (${body.length} bytes)`,
        );
        this.send(
          session,
          `${CMD.ACK_OK}\t${header.params.RequestID || ""}\t1\t${header.params.CounterID || ""}\n`,
        );
        break;
      }

      case "DATA UPDATE fingerprint": {
        logger.log(
          "PUSH",
          `Fingerprint template packet from ${session.sn || remote} (${body.length} bytes)`,
        );
        this.send(session, `${CMD.ACK_UNKNOW}\n`);
        break;
      }

      case DATA_CMD: {
        this.handleData(header, body, session, remote);
        break;
      }

      default: {
        logger.warn("PUSH", `Unknown cmd "${header.cmd}" from ${remote}`);
        this.send(session, `${CMD.ACK_UNKNOW}\n`);
      }
    }
  }

  handleData(header, body, session, remote) {
    const reqId = header.params.RequestID || "";
    switch (header.params.table) {
      case "ATTLOG": {
        const records = parseAttLog(body, reqId);
        for (const r of records) {
          r.serialNumber = session.sn;
          r.deviceIp = remote.split(":")[0];
          r.eventType = "attendance";
          r.statusLabel = humanStatus(r.status);
          r.verifyModeLabel = humanVerifyMode(r.verifyMode);
          r.device24h =
            r.device24h || r.timestamp.slice(0, 19).replace("T", " "); // raw-data seconds win
        }
        if (records.length) {
          logger.data(
            "PUSH",
            `(${records.length}) attendance records from ${session.sn}`,
          );
          this.handlers.onAttendance &&
            this.handlers.onAttendance(records, session.sn);
        }
        this.ack(session, reqId, records.length);
        break;
      }

      case "options": {
        const options = parseOptions(body);
        logger.log(
          "PUSH",
          `Device ${session.sn} options: ${options.FWG_version || "unknown fw"}`,
        );
        this.send(
          session,
          `${CMD.ACK_OK}\t${reqId}\t1\t${options.FWG_version || ""}\n`,
        );
        break;
      }

      case "userinfo": {
        logger.log("PUSH", `User info packet (${records_bytes(body)} bytes)`);
        this.ack(session, reqId, 1);
        break;
      }

      case "fingerprint": {
        logger.log("PUSH", `Fingerprint template packet`);
        this.ack(session, reqId, 1);
        break;
      }

      default:
        logger.warn(
          "PUSH",
          `Unknown DATA table "${header.params.table}" from ${session.sn}`,
        );
        this.ack(session, reqId, 0);
    }
  }

  ack(session, reqId, count) {
    // Reply format: OK\t<requestId>\t<count>\t...\n  -> stops the device retrying
    this.send(session, `${CMD.ACK_OK}\t${reqId}\t${count}\t\n`);
  }

  send(session, text) {
    if (!session.socket.writable) return;
    session.socket.write(text);
  }
}

/** tiny helper for logging */
function records_bytes(buf) {
  return buf ? buf.length : 0;
}

/**
 * ── HTTP-ADMS endpoint (newer ZKTeco firmware, incl. many F18 builds) ──────
 * Device sends GET/POST to:  /iclock/cdata?SN=xxx&table=ATTLOG&CDATA=n...
 * Handshakes go to /iclock/cdata?SN=xxx&options=all (device info)
 * Server replies with a short plain-text HTTP response ("OK", "OK:...").
 *
 * ATTLOG cdata records: userId\tsecondsSince2000\tstatus\tverify\tres1\tres2\n
 */
function parseHttpBuffer(str) {
  const sep = str.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const splitAt = str.indexOf(sep);
  if (splitAt === -1) return null; // headers not complete yet
  const head = str.slice(0, splitAt);
  let body = str.slice(splitAt + sep.length);

  const lines = head.split("\r\n");
  const [method, rawPath] = lines[0].split(" ");
  const qIdx = rawPath.indexOf("?");
  const path = qIdx === -1 ? rawPath : rawPath.slice(0, qIdx);
  const query = {};
  if (qIdx !== -1) {
    // query may continue into body when CDATA= announces body len; keep simple
    const qs = new URLSearchParams(rawPath.slice(qIdx + 1));
    for (const [k, v] of qs) query[k] = v;
  }

  // CDATA may be split across header and body; join them
  const cdataLen = parseInt(query.CDATA || "0", 10);
  if (cdataLen > 0 && body.length < cdataLen) return null; // wait for full body
  if (cdataLen > 0) body = body.slice(0, cdataLen);

  return {
    method,
    path,
    query,
    body,
    consumed: splitAt + sep.length + body.length + (cdataLen > 0 ? 0 : 0),
  };
}

class HttpAdmsHandler {
  constructor(pushServer, showRaw = false) {
    this.push = pushServer;
    this.showRaw = showRaw;
  }

  reply(res, text = "OK") {
    return `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`;
  }

  feed(session, chunk) {
    session.buffer = Buffer.concat([session.buffer, chunk]);
    const str = session.buffer.toString("latin1");
    const req = parseHttpBuffer(str);
    if (!req) return; // partial HTTP request: wait for more bytes

    try {
      this.handle(req, session);
    } catch (e) {
      logger.err("HTTP", `Handler error: ${e.message}`);
    }
    // Note: for HTTP we don't reuse the socket after reply (Connection: close).
    session.buffer = Buffer.alloc(0);
    // end() gracefully flushes the reply; devices are sensitive to destroy()
    session.socket.end();
    // Slightly delay freeing in case the device needs to read the reply,
    // and mark online-ness (per-SN) instead of per-connection connect/disconnect
    this.touchOnline(req, session);
  }

  touchOnline(req, session) {
    const sn = session.sn;
    if (!sn) return;
    clearTimeout(this._offlineTimer && this._offlineTimer[sn]);
    (this._everSeen = this._everSeen || new Set()).add(sn);
    // Device polls every ~3-10s; disc is OFFLINE only if NO request at all
    // arrives within the window (config.offlineAfterSec, default 300s = 5min).
    const window = this.offlineAfterSec * 1000 || 300000;
    (this._offlineTimer = this._offlineTimer || {})[sn] = setTimeout(() => {
      this.push.devices.delete(sn);
      this.push.handlers.onDevice &&
        this.push.handlers.onDevice("disconnected", sn);
      logger.warn(
        "HTTP",
        `Device ${sn} offline (no request within ${window / 1000}s)`,
      );
      delete this._offlineTimer[sn];
    }, window);
  }

  handle(req, session) {
    const { query, body } = req;
    const sn = query.SN || query.sn || session.sn || "";
    if (sn) session.sn = sn;
    const remote = session.remote || "";

    // ── RAW dump: everything the machine sent, byte-for-byte ──
    if (this.showRaw) {
      logger.log("RAW", `⟵ device ${remote}`);
      logger.log("RAW", `     REQUEST: ${req.method} ${req.path}`);
      const qp = Object.entries(query)
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
      logger.log("RAW", `     QUERY  : ${qp}`);
      if (body.length) {
        logger.log("RAW", `     BODY (${body.length} bytes, latin1)`);
        for (const line of body.toString("latin1").split("\n")) {
          if (line.trim())
            logger.log("RAW", `       │ ${line.replace(/\t/g, " ⇥ ")}`);
        }
        logger.log(
          "RAW",
          `     HEX    : ${body.toString("hex").slice(0, 160)}${body.length > 80 ? "…" : ""}`,
        );
      } else {
        logger.log("RAW", `     BODY   : (empty)`);
      }
    }

    // ── Registration / handshake ──
    if (query.options !== undefined) {
      if (!this.push.devices.has(sn)) {
        this.push.devices.set(sn, session);
        logger.ok(
          "HTTP",
          `Device REGISTERED  SN=${sn}  IP=${remote}  ver=${query.pushver || query.push_version || "HTTP-ADMS"}`,
        );
        // was it previously known & then dropped (true offline)? → reconnected
        const wasKnown =
          (this._everSeen && this._everSeen.has(sn) && !this._offlineTimer) ||
          (this._everSeen && this._everSeen.has(sn));
        if (this._everSeen && this._everSeen.has(sn)) {
          this.push.handlers.onDevice &&
            this.push.handlers.onDevice("reconnected", sn);
        } else {
          (this._everSeen = this._everSeen || new Set()).add(sn);
          this.push.handlers.onDevice &&
            this.push.handlers.onDevice("connected", sn);
        }
      }
      // Acknowledge handshake; device follows up with option/get requests
      session.socket.write(this.reply("OK"));
      return;
    }

    // ── Device data pushes (ATTLOG / OPLOG / USER / fingerprint …) ──
    if (query.table) {
      this.handleTable(query, body, session, sn);
      return;
    }

    // ── Device command polling: GET /iclock/getrequest?SN=... ──
    // LIVE-VERIFIED: your F18 does NOT push scans by itself — it only polls
    // getrequest every ~30s. So the SERVER must answer with a command telling
    // the machine to send its stored attendance log. ADMS 'C:' commands:
    //   C:DATA UPDATE  AttLog\tAll     → machine posts its entire ATTLOG
    //   C:DATA QUERY   AttLog\t...     → query by range
    if (/getrequest/i.test(req.path)) {
      // send periodic log-pull (data freshness): every 6th poll (~3 min)
      this._pollCount = (this._pollCount || 0) + 1;
      let respondBody = "OK";
      if (this._pollCount % 1 === 0 && this.pullCommand) {
        respondBody = this.pullCommand; // e.g. 'C:DATA UPDATE  AttLog\tAll'
      }
      session.socket.write(this.reply(respondBody));
      return;
    }

    if (query.cmd) {
      // device is polling for server commands; reply empty OK
      session.socket.write(this.reply("OK"));
      return;
    }

    logger.warn(
      "HTTP",
      `Unhandled ${req.method} ${req.path}?${JSON.stringify(query).slice(0, 80)} from ${sn || remote}`,
    );
    session.socket.write(this.reply("OK"));
  }

  handleTable(query, body, session, sn) {
    const reqId = query.request || query.RequestID || "";
    const table = String(query.table || "").toUpperCase();
    const text = body.toString("latin1");

    // Machine may interleave its OPLOG rows with scans; harvest every verbatim
    // device clock string it sends so scan rows can use machine-given times.
    // Also REMEMBER it per-SN: scans arriving in LATER bodies (without OPLOG)
    // must still use the machine's own clock, not the broken seconds field.
    const oplogTimes = [];
    for (const line of text.split("\n")) {
      const m = line.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (m) oplogTimes.push(m[1]);
    }
    if (oplogTimes.length && sn) {
      this.push.lastDeviceClocks.set(sn, oplogTimes[oplogTimes.length - 1]);
    }
    const lastDeviceClock =
      (oplogTimes.length && oplogTimes[oplogTimes.length - 1]) ||
      (sn && this.push.lastDeviceClocks.get(sn)) ||
      null;

    if (table === "ATTLOG" || table === "OPLOG") {
      // Registered OPLOG handling: the device (your F18, confirmed by capture)
      // sends OPERLOG rows through the SAME table=ATTLOG endpoint as:
      //   OPLOG <idx>\t<reset s.t.>\t<YYYY-MM-DD HH:MM:SS>\t<oper args>…
      // Plus actual scans as userid\tseconds\tstatus… — handle both.
      const records = parseAttLog(Buffer.from(text, "latin1"), reqId)
        // OPLOG/system rows are internal — not scans; drop them from the feed
        .filter((r) => r.itemType !== "oplog");
      for (const r of records) {
        r.serialNumber = sn;
        r.deviceIp = (session.remote || "").split(":")[0];
        r.eventType = "attendance";
        r.statusLabel = humanStatus(r.status);
        r.verifyModeLabel = humanVerifyMode(r.verifyMode);
        // ── checkinTime: the machine's OWN timestamp, verbatim ──
        // Priority:
        //   1. per-record 24h string the device itself produced (r.device24h)
        //   2. OPLOG clock string in the SAME body (machine's verbatim clock)
        //   3. remembered OPLOG clock from an earlier body of this SN
        //   4. the push header ?stamp= — machine's 24h clock string
        //   5. fallback: seconds decode — but if that clock is INVALID
        //      (pre-2020 → broken RTC), show the honest badge, NEVER year-2000
        if (!r.device24h && lastDeviceClock) r.device24h = lastDeviceClock;
        if (!r.device24h && query.stamp) {
          const m = String(query.stamp).match(
            /(\d{4}-\d{2}-\d{2})[T ]?(\d{2}:\d{2}:\d{2})/,
          );
          if (m) r.device24h = m[1] + " " + m[2]; // machine's own 24h string, verbatim
        }
        if (!r.device24h) {
          r.device24h = r.clockInvalid
            ? "(device clock not set — timestamp invalid)"
            : r.timestamp.slice(0, 19).replace("T", " ");
        }
      }
      if (records.length) {
        logger.data(
          "HTTP",
          `(${records.length}) attendance records from SN=${sn}`,
        );
        this.push.handlers.onAttendance &&
          this.push.handlers.onAttendance(records, sn);
      }
      // (empty polls are the device's normal HTTP keepalive — NOT logged,
      //  so your terminal only shows scans: what you asked for)
      // Standard ADMS ack: "OK" alone signals all records accepted
      session.socket.write(this.reply("OK"));
      return;
    }

    // Other tables (USER/OPLOG/BIODATA/fingerprint templates...)
    if (text.trim()) {
      logger.log(
        "HTTP",
        `DATA table=${table} from ${sn} — ${text.split("\n").length} line(s) received`,
      );
    }
    session.socket.write(this.reply("OK"));
  }
}

module.exports = { PushServer, HttpAdmsHandler };
