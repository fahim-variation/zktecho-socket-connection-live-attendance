# ZKTeco F18 — Real-time WebSocket Bridge

Node.js service that receives real-time fingerprint scan events **pushed** from a
ZKTeco F18 (PUSH/ADMS protocol — supports both **legacy raw-TCP** and **HTTP-ADMS**
firmware) and broadcasts them as JSON over **WebSocket** for an API → database layer.

```
[F18 scanner 192.168.50.33] ──push──► [this PC bridge] ──ws──► [API → database]
                port 4370                                port 8080
```

---

# Setup Guide (full, tested)

## 1. Find your PC's LAN IP and set it in `config.js`

```bash
hostname -I        # e.g. → 192.168.50.25
```

Edit `config.js`:

```js
deviceIp: '192.168.50.33',    // the SCANNER's own IP (informational + whitelist)
allowedDeviceIps: ['192.168.50.33', '192.168.50.25', '127.0.0.1'],
pushPort: 4370,
bindIp: '192.168.50.25',      // ← your PC's IP (must be an IP THIS PC owns)
wsPort: 8080,
```

> ⚠️ `bindIp` can NEVER be the scanner's IP (`.33`) — a machine can only listen on
> its own addresses. Use your PC's IP or `0.0.0.0`.

## 2. Open port 4370 (and 8080) in the firewall — **critical for new firmware**

This system uses **UFW with default-deny** (`DEFAULT_INPUT_POLICY="DROP"`), so
without a rule the device's connections are silently dropped and the bridge
never sees them.

```bash
sudo ufw allow 4370/tcp     # scanner → bridge (PUSH/ADMS)
sudo ufw allow 8080/tcp     # API clients ← bridge (WebSocket)
sudo ufw status numbered    # verify: both ports show "ALLOW IN"
```

## 3. Configure the scanner

On the device (menu or web UI at http://192.168.50.33):

```
Menu → COMM → Cloud Server (ADMS)
   Server Address : 192.168.50.25    ← your PC's IP (step 1)
   Server Port    : 4370
   Enable         : ✔
```

## 4. Start the bridge

```bash
npm install      # first time only
npm start
```

Healthy startup:

```
[WS]     ✅ WebSocket server listening on ws://0.0.0.0:8080
[PUSH]   ✅ Listening on 192.168.50.25:4370 (waiting for F18 to connect)
[BRIDGE] Scanner (F18) expected at: 192.168.50.33 → push server bound to 192.168.50.25:4370
```

Then (within ~10–60s of enabling ADMS on the device):

```
[PUSH]   Device connected from 192.168.50.33:xxxxx
[PUSH]   ✅ Device <ip> speaks HTTP-ADMS push (newer firmware)   ← or "raw line PUSH protocol"
[HTTP]   ✅ Device REGISTERED  SN=<your-serial>  IP=192.168.50.33:xxxxx  ver=2.2.16
[BRIDGE] 🔌 Scanner connected — SN=<your-serial>
```

The bridge now **stays running** — leave it open.

## 5. Scan your fingerprint

Every scan appears instantly in the terminal:

```
[HTTP]   📦 (1) attendance records from SN=<serial>
[BRIDGE] 📦 uid=5 check-in      verify=fingerprint  @ 2026-10-12T02:30:00.000Z
```

- `uid` = the user number assigned on the device
- `status` = check-in / check-out / break-in …
- `verify` = fingerprint / pin / face / card
- `@` = timestamp of the scan (device clock)

## 6. Consume from your API (later step)

Any WebSocket client connecting to `ws://<pc-ip>:8080` receives:

```json
{ "type": "attendance", "data": [{ "userId": "5", "timestamp": "...", "statusLabel": "check-in",
  "verifyModeLabel": "fingerprint", "serialNumber": "CJT33227610247", "deviceIp": "192.168.50.33" }] }
{ "type": "device", "data": { "event": "connected", "serialNumber": "CJT33227610247" } }
```

---

# Testing without the scanner

```bash
npm start                    # terminal 1
npm test                     # terminal 2 — simulated scanner pushes 3 punches
node tests/ws-client.js      # terminal 3 — shows the JSON API clients receive
```

HTTP-mode test (simulates your firmware's HTTP-ADMS): handled automatically by
the bridge — both modes are detected per connection.

---

# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Device "connected" but no `📦` lines, bridge restart didn't help | UFW dropping device's push packets | `sudo ufw allow 4370/tcp` |
| `EADDRINUSE` on start | old process / another service on the port | `sudo lsof -t -i :4370 -i :8080 \| xargs -r kill` |
| `Cannot bind to <ip>` | `bindIp` isn't an IP this PC owns | `hostname -I`, use one of those or `0.0.0.0` |
| `Rejected connection from 192.168.50.33` | whitelist mismatch | add the device IP to `allowedDeviceIps` |
| Connects then disconnects repeatedly | device firmware expects `OK` ack format it didn't get | check log — parser handles both line + HTTP modes |
| `Unknown cmd "GET"` warnings | device speaks **HTTP-ADMS** | fixed — bridge auto-detects HTTP mode now |

---

# Project structure

```
config.js               # device IP, whitelist, bind IP, ports
src/index.js            # entry point + startup banner + health watchdog
src/push-server.js      # TCP listener, auto-detects raw-line or HTTP-ADMS device
src/protocol.js         # packet/record parsing (ATTLOG, options)
src/ws-hub.js           # WebSocket broadcaster
tests/simulate-device.js  # raw-line-mode fake device
tests/ws-client.js      # demo WS consumer
Protocol reference: https://github.com/LegenDARYFDL/zk_tunnel
```
