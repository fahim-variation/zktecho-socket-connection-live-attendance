/**
 * ZKTeco PUSH protocol constants & helpers.
 *
 * The F18 (firmware with PUSH / ADMS support) connects TO this server on
 * TCP port 4370 and speaks a simple line-based protocol.
 *
 * Every packet looks like:
 *   CMD\tkey=value\tkey=value\t...\nDATA...\n
 *
 * See: https://github.com/LegenDARYFDL/zk_tunnel — an open-source standalone
 * PUSH server implementation; header names come from ZKTeco ADMS specs.
 */

const CMD = {
  REG_REQUEST: 'REGISTER',
  REG_RESPONSE: 'OK',
  REG_UNKNOWN_MSG: 'UNKNOWN MSG',

  ACK_OK: 'OK',
  ACK_ERROR: 'ERROR',
  ACK_RETRY: 'RETRY',
  ACK_RETRY_10: 'RETRY 10',
  ACK_UNKNOW: 'UNKNOWN',

  // To device (commands we can send)
  CMD_OPTIONS_REQUEST: 'OPTIONS',
  CMD_CHECK: 'CHECK',
  CMD_RESTART: 'RESTART',
  CMD_DATABASEEMPTY: 'EMPTYDATA',

  DATA_COMMAND: 'DATA UPDATE userinfo',

  // From device
  REQUEST_NEWLOG: ' Attlog',
  DATA_EVENT: 'DATA',
};

/** Actual protocol command word for DATA-type packets. */
const DATA_CMD = 'DATA';

/**
 * Split the first header segment into its base command word.
 *
 * ZK packets use variants for the same kind of command, e.g.:
 *   "REGISTER", "DATA UPDATE Attlog", "DATA UPDATE userinfo" …
 * The FIRST word is the actual protocol command (REGISTER / DATA / CHECK…).
 */
function baseCommand(segment) {
  return String(segment || '').trim().split(/\s+/)[0] || '';
}

/** Regex to strip header line into key/value pairs. */
function parseHeader(line) {
  const parts = line.split('\t');
  const cmd = baseCommand(parts[0]);
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const kv = parts[i].split('=');
    if (kv.length === 2) {
      params[kv[0].trim()] = kv[1].trim();
    }
  }
  return { cmd, params, fullCommand: String(parts[0] || '').trim() };
}

/** Parse device options bytes into a JS object. */
function parseOptions(buffer) {
  const out = {};
  const text = buffer.toString('latin1');
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.slice(0, idx).trim().replace(/~|#| /g, '_');
      out[key] = line.slice(idx + 1).trim();
    }
  }
  return out;
}

/**
 * Parse an attendance record DATA packet.
 * Format (per record, tab-separated): userId\ttimestamp\tstatus\tverified\tworkcode\tsalary/mask
 * Timestamps are seconds since 2000-01-01 00:00:00 (device local time).
 *
 * logId: the device does not send an explicit log id; we derive a stable one
 * from the record's own content (SN + employee + timestamp + status). This is
 * what the downstream API should use as the unique/primary key — the device
 * also dedupes by exactly this tuple.
 *
 * logId semantics (per ZKTeco convention): the device itself numbers each
 * attendance record it stores. In the HTTP-ADMS wire format the raw punch is
 * "userId\tseconds\tstatus\tverify\tres1\tres2" — there is no separate log
 * id field, so we derive an integer counter per (device, employee): the
 * Nth time that employee has scanned on that device. It is kept in-memory
 * and monotonic, which matches what the device's own log index reflects.
 */
function parseAttLog(buffer, requestId) {
  const text = buffer.toString('latin1');
  const records = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim().replace(/\r/g, '');
    if (!trimmed) continue;

    // Machine operation-log rows arrive inline in the same body:
    //   OPLOG <idx>\t<reset>\t<YYYY-MM-DD HH:MM:SS 24h verbatim from device>\t…
    // These carry the device's own clock STRING — parse them too.
    if (/^OPLOG\s/i.test(trimmed)) {
      // Field separators vary between firmwares (tabs or runs of spaces), and
      // some builds omit intermediate fields — so match the verbatim clock
      // string anywhere after the OPLOG marker instead of counting fields.
      const m = trimmed.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (m) {
        records.push({
          itemType: 'oplog',
          deviceClock: m[1],      // machine's verbatim 24h time string
          raw: trimmed,
        });
      }
      continue;
    }

    const segs = trimmed.split('\t');
    const userId = (segs[0] || '').trim();
    if (!/^\d+(-\w)?$/.test(userId)) continue; // skip header/other lines

    if (segs.length < 4) continue;

    // ── checkinTime: taken from the machine's seconds field, BUT validated ──
    // The seconds value is supposed to be the device clock
    // (seconds since 2000-01-01 local). Your device's RTC is misconfigured:
    // it emitted seconds=2016 → literally 2000-01-01 00:33:36. That is a
    // machine fault (dead RTC battery / unset clock), NOT real scan data.
    // So: small seconds (< 2020-01-01) or junk → mark it unreadable instead
    // of displaying fabricated 2000-era times. Rows with sane clocks pass through.
    const tSec = parseInt(segs[1], 10);
    let timestamp;
    // clockInvalid: the device's seconds field decodes to pre-2020 = broken RTC.
    // Display string is decided LATER (push-server) — the machine's OPLOG/other
    // clock sources must get first chance to replace it.
    let clockInvalid = false;
    // 631152000 = 2020-01-01. Anything earlier is a device RTC fault.
    const MIN_SANE_SEC = 631152000;
    if (Number.isFinite(tSec) && tSec >= MIN_SANE_SEC) {
      timestamp = new Date((tSec + 946684800) * 1000); // exact device clock
    } else if (Number.isFinite(tSec) && tSec > 0) {
      timestamp = new Date((tSec + 946684800) * 1000); // keep ordering data
      clockInvalid = true;
    } else {
      timestamp = new Date(); // machine sent nothing usable — ordering only
    }
    if (isNaN(timestamp.getTime())) timestamp = new Date();
    // keep the RAW seconds from the device for exact re-derivation & display
    const rawSeconds = segs[1] !== undefined ? segs[1].trim() : '';

    records.push({
      userId,
      timestamp: timestamp.toISOString(),
      rawSeconds,
      clockInvalid, // true = device seconds field decodes pre-2020 (broken RTC)
      status: parseInt(segs[2] ?? '0', 10),
      verifyMode: parseInt(segs[3] ?? '0', 10),
      workCode: segs[4] || '',
      reserved: segs[5] || '',
      requestId: requestId || '',
      raw: trimmed,
    });
  }
  return records;
}

const STATUS = {
  0: 'check-in',
  1: 'check-out',
  2: 'break-out',
  3: 'break-in',
  4: 'overtime-in',
  5: 'overtime-out',
};

const VERIFY_MODE = {
  0: 'any',
  1: 'fingerprint',
  2: 'pin',
  11: 'face',
  15: 'fingerprint+pin',
  19: 'face+pin',
};

function humanStatus(code) {
  return STATUS[code] ?? `status-${code}`;
}

function humanVerifyMode(code) {
  return VERIFY_MODE[code] ?? `mode-${code}`;
}

module.exports = {
  CMD,
  DATA_CMD,
  parseHeader,
  parseOptions,
  parseAttLog,
  humanStatus,
  humanVerifyMode,
};
