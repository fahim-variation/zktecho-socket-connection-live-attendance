/**
 * HR API forwarder.
 *
 * Sends every accepted scan to the HR attendance endpoint as a GET query:
 *   GET https://hr.variationbd.com/api/attendnance?finger_id=<userId>&in_out_time=<YYYY-MM-DD HH:MM:SS>
 *
 * Notes:
 *  • Data source rule unchanged: the values forwarded are the ones shown on
 *    the dashboard (EmployeID = userId, checkinTime = device's own 24h string
 *    when the machine gave one — never a fabricated year-2000 value).
 *  • If checkinTime is the "invalid clock" badge, we send the record's raw
 *    seconds-epoch decode IS NOT sent either — we send the PC receive time
 *    strictly labeled in the logs, so the HR row isn't silently wrong.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('./logger');

class ApiForwarder {
  /**
   * @param {{enabled?: boolean, url?: string, timeoutMs?: number}} opts
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.baseUrl = opts.url || 'https://hr.variationbd.com/api/attendnance';
    this.timeoutMs = opts.timeoutMs || 10000;
    this.stats = { sent: 0, failed: 0 };
  }

  /**
   * Forward one scan record.
   * @param {{userId:string, device24h?:string, clockInvalid?:boolean,
   *          statusLabel?:string, serialNumber?:string, timestamp:string}} rec
   */
  send(rec) {
    if (!this.enabled) return;

    // ── finger_id = EmployeID ──
    const fingerId = encodeURIComponent(rec.userId || '');

    // ── in_out_time = checkinTime ──
    // Prefer the machine's own verbatim 24h string (same one on the webpage).
    // If the device clock was invalid, fall back to PC receive time so the
    // API still receives a real timestamp — logged CLEARLY as PC-substituted.
    let inOutTime;
    let note = '';
    if (rec.device24h && !rec.device24h.startsWith('(device clock')) {
      inOutTime = rec.device24h;
    } else if (rec.device24h && rec.device24h.includes('timestamp invalid')) {
      inOutTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
      note = ' (PC-substituted — device clock invalid)';
    } else if (rec.device24h && rec.device24h.includes('no timestamp')) {
      inOutTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
      note = ' (PC-substituted — device sent none)';
    } else {
      // ISO from the seconds field (only reached when clock is sane)
      inOutTime = rec.timestamp ? rec.timestamp.slice(0, 19).replace('T', ' ') : '';
      note = ' (from seconds field)';
    }

    const url = new URL(this.baseUrl);
    url.searchParams.set('finger_id', fingerId);
    url.searchParams.set('in_out_time', inOutTime);

    this._request(url)
      .then((body) => {
        this.stats.sent++;
        logger.ok('API', `→ HR ${rec.userId} @ ${inOutTime}${note}  resp=${body.slice(0, 80)}`);
      })
      .catch((e) => {
        this.stats.failed++;
        logger.err('API', `FAILED for ${rec.userId}: ${e.message}  (will NOT retry — check network/API)`);
      });
  }

  _request(url) {
    return new Promise((resolve, reject) => {
      const isHttps = url.protocol === 'https:';
      const mod = isHttps ? https : http;
      const req = mod.get(url, { timeout: this.timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
          else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 120)}`));
        });
      });
      req.on('timeout', () => req.destroy(new Error(`timeout after ${this.timeoutMs}ms`)));
      req.on('error', reject);
    });
  }
}

module.exports = { ApiForwarder };
