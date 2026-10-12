# Setup & Testing Guide — ZKTeco F18 Real-time WebSocket Bridge

## What you have

```
[ F18 scanner 192.168.50.33 ] ──push──► [ Your PC bridge ] ──ws──► [ API → database (later) ]
              port 4370                                   port 8080
```

---

## STEP 1 — Find your PC's LAN IP

```bash
hostname -I
```
Take the address that starts with `192.168.50.` — e.g. `192.168.50.77`.
If nothing starts with `192.168.50.`, your PC is on a different network than the
scanner — connect your PC to the same router/LAN first.

## STEP 2 — Configure the scanner

On the F18 device menu (or web UI at **http://192.168.50.33**, default login
usually admin/123456 or admin/admin):

```
Menu → COMM → Cloud Server (ADMS)
   Server Address : <YOUR-PC-IP from step 1>   e.g. 192.168.50.77
   Server Port    : 4370
   Enable         : ✔
```

> ⚠️ The Server Address is your PC's IP — NOT 192.168.50.33 (that's the scanner itself).

## STEP 3 — Start the bridge

```bash
cd ~/Github/websoc
npm start
```

Healthy startup looks like:

```
[WS]     ✅ WebSocket server listening on ws://0.0.0.0:8080
[PUSH]   ✅ Listening on 0.0.0.0:4370 (waiting for F18 to connect)
[BRIDGE] Scanner (F18) expected at: 192.168.50.33 → pushing to this PC port 4370
[BRIDGE] API clients should connect to: ws://<this-pc-ip>:8080
```

If you ever see `EADDRINUSE / port already in use`:
```bash
sudo lsof -t -i :4370 -i :8080 | xargs -r kill     # free both ports, then npm start again
```

## STEP 4 — Confirm the scanner connected

Within ~1 minute the terminal shows:

```
[PUSH]   Device connected from 192.168.50.33:xxxxx
[PUSH]   ✅ Device REGISTERED  SN=CJT33227610247  IP=192.168.50.33:xxxxx
[BRIDGE] 🔌 Scanner connected — SN=CJT33227610247
```

👋 **Leave it running** — it now keeps listening forever.

## STEP 5 — Scan your fingerprint

Go to the scanner and press your finger. The sensor prompts like normal; the
event is pushed instantly to your PC:

```
[PUSH]   📦 (1) attendance records from CJT33227610247
[BRIDGE] 📦 uid=5 check-in   verify=fingerprint   @ 2026-10-12T01:55:00.000Z
```

That is the "received data" from your scan — uid = your user number on the
device, status = check-in/check-out, timestamp = the clock time of the scan.

## STEP 6 (later) — API & database

Your API connects as a WebSocket client to `ws://<pc-ip>:8080` and receives each
scan as JSON:

```json
{ "type": "attendance", "data": [{ "userId": "5", "timestamp": "...", "statusLabel": "check-in", "serialNumber": "CJT33227610247", ... }] }
```

---

# Testing without the scanner

**Terminal 1:** `npm start`
**Terminal 2:** `npm test` (simulated scanner pushes 3 punches)
**Terminal 3 (optional):** `node tests/ws-client.js` (shows the JSON API clients receive)

Expected in Terminal 1:

```
[BRIDGE] 🔌 Scanner connected — SN=CJT33227610247
[BRIDGE] 📦 uid=1 check-in  verify=fingerprint ...
[BRIDGE] 📦 uid=2 check-in  verify=fingerprint+pin ...
[BRIDGE] 📦 uid=1 check-out verify=fingerprint ...
```

---

# Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| Nothing connects | device can't reach PC | check PC IP on same subnet, port 4370 open (`sudo ufw allow 4370`) |
| `Rejected connection from 192.168.50.33` | whitelist mismatch | confirm `config.js → allowedDeviceIps` contains `192.168.50.33` |
| Connects, then nothing on scan | no PUSH-time option sync or firmware variant | paste the log lines here — some firmwares need extra commands, I'll extend |
| `EADDRINUSE` | old process still running | kill via the lsof command above |
| `Unknown cmd` warnings | firmware-specific packet | harmless unless attendance missing — share and I'll add support |
