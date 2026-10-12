/** Central configuration for the ZKTeco F18 WebSocket bridge. */
module.exports = {
  // ── Device side ────────────────────────────────────────────────────────────
  // Your F18 scanner: IP 192.168.50.33. In PUSH mode the DEVICE connects to us,
  // so this IP is only used to (a) verify incoming connections and (b) help you
  // cross-check the device's own network settings.
  deviceIp: '192.168.50.33',

  // Only accept push connections from these IPs (empty array = accept any device).
  //   '192.168.50.33' → your real F18 scanner
  //   '192.168.50.25' → this PC's own IP (the local simulator connects via this
  //                     interface when the server is bound to bindIp)
  //   '127.0.0.1'     → REMOVE if you never test locally with 0.0.0.0 binding
  allowedDeviceIps: ['192.168.50.33', '192.168.50.25', '127.18.0.1'],

  // TCP port where the F18 device connects to push data (ZKTeco PUSH/ADMS default)
  // This is the SAME "Server Port / Communication Port" value you type into the
  // device's COMM → ADMS/Cloud Server settings.
  pushPort: 4370,

  // Local network interface the push server binds to.
  //   '192.168.50.25' → this PC's IP on the scanner's network (from `hostname -I`)
  //   '0.0.0.0'       → listen on ALL interfaces
  // NOTE: this must be an IP THIS PC owns — never the scanner's IP (.33).
  bindIp: '192.168.50.25',

  // ── API side ──────────────────────────────────────────────────────────────
  // WebSocket port where your API clients (and any dashboard) connect
  wsPort: 8080,

  // How long the DEVICE may stay silent before the bridge calls it
  // "disconnected" (HTTP-ADMS polls every ~3-10s, so normal operation never
  // trips this). Default 300s = 5 minutes.
  offlineAfterSec: 300,

  // Show the complete raw data the machine sends in the terminal
  // (request line, query params, body rows, hex). Turn OFF for clean output.
  showRawData: false,

  acceptUnregisteredDevices: true,

  prettyLog: true,

  // ── HR API integration ───────────────────────────────────────
  // Every accepted scan is forwarded as:
  //   GET {hrApi.url}?finger_id=<EmployeID>&in_out_time=<checkinTime>
  hrApi: {
    enabled: true,
    url: 'https://hr.variationbd.com/api/attendnance',
    timeoutMs: 10000,
  },
};
