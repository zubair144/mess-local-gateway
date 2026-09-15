# Hardware integration

Face, QR, and printer were migrated from the working `zkteco-mb560-test` production services. Protocol, ZPL templates, duplicate windows, and printer addressing were preserved.

## How the combined process starts

`npm start` runs `src/server.js`:

1. Load `.env` / config
2. Initialize SQLite (`data/mess-local.db`)
3. Start Gateway API (`5050`)
4. Start ZKTeco ADMS Face listener (`8080`)
5. Start QR scanner (stdin / USB HID)
6. Probe printer TCP `192.168.1.17:9100` (connect only, no print job)
7. Start cloud sync workers (pull / push / heartbeat). Cloud failure does not block startup.

On `SIGINT` / `SIGTERM`:

- stop sync workers
- stop QR readline
- close ADMS listener
- close Gateway API
- close SQLite

## Face / ZKTeco

Source: `zkteco-mb560-test/server.js`

Target:

- `src/hardware/face/zk-adms.js` — ADMS HTTP protocol
- `src/hardware/face/face-service.js` — attendance handling, duplicate window, meal hook, print

The MB560-VL pushes attendance to this machine. It must be configured as:

```text
Server Mode    : ADMS
Server Address : 192.168.1.4     # GATEWAY_HOST_IP
Server Port    : 8080            # ZK_ADMS_PORT
Domain Name    : OFF
Proxy Server   : OFF
```

Do **not** point the device at `localhost` or `127.0.0.1`.

ADMS endpoints (unchanged):

- `GET /iclock/cdata`
- `POST /iclock/cdata` (`table=ATTLOG`)
- `GET /iclock/getrequest`
- `POST /iclock/devicecmd`
- `GET /iclock/ping`

Immediate `OK` acknowledgement is still sent before receipt printing.

Duplicate print window: `FACE_DUPLICATE_WINDOW_MS` (default 10000). If printing fails, the event is unmarked so it can retry.

### Test Face

1. Confirm gateway banner shows `ZKTeco ADMS : Listening on 8080`
2. `curl http://localhost:8080/` → `ZKTeco ADMS server is running`
3. Enroll a face on the MB560-VL and present it
4. Terminal should log `[FACE] Event received` and `[FACE] Employee ID: ...`
5. On success, one **meal receipt** should print (employee, meal, balance, source, TXN id)
6. On decline (`EMPLOYEE_NOT_FOUND`, `MEAL_ALREADY_TAKEN`, etc.) **no receipt** is printed
6. A second event for the same user/timestamp inside 10s is ignored

API simulation (prints unless `"print": false`):

```bash
curl -X POST http://localhost:5050/api/meal/face \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"1","print":false}'
```

## QR scanner

Source: `zkteco-mb560-test/qr.js`

Target: `src/hardware/qr/qr-service.js`

The BC-8000G is a USB HID keyboard. It must send CR/Enter after each scan. The Node process **must be started in a real terminal** (TTY) so keystrokes reach stdin. If the process has no TTY, QR still works through `POST /api/meal/qr`.

Duplicate window: `QR_DUPLICATE_WINDOW_MS` (default 3000).

### Test QR

1. Confirm banner shows `QR Scanner : Ready`
2. Focus the gateway terminal
3. Scan a QR code (or type a value and press Enter)
4. Terminal should log `[QR] Code scanned: ...`
5. On success, one **meal receipt** should print
6. Declined scans do not print
6. Repeating the same value within 3s is ignored

API simulation:

```bash
curl -X POST http://localhost:5050/api/meal/qr \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"QR-EMP001","print":false}'
```

## Printer

Working production implementation is **Zebra ZPL over TCP**, not USB/CUPS/ESC-POS.

- IP: `192.168.1.17`
- Port: `9100`

Face and QR share `src/hardware/printer/printer-service.js`.

After a successful SQLite transaction commit, hardware handlers call `printMealReceipt()` with employee/meal/balance data (no raw QR strings or debug payloads on the slip).

Methods:

- `printMealReceipt(data)` — production meal receipt for Face/QR success
- `printTestReceipt()` — dashboard/API test button
- `printAttendanceReceipt(data)` / `printQrReceipt(qrData)` — legacy templates retained, not used by the meal engine
- `getPrinterStatus()` — TCP connect probe, no ZPL sent

Startup probing only opens/closes a TCP socket. It does not send cut/feed commands.

### Test printer

```bash
curl -X POST http://localhost:5050/api/printer/test
```

Expect one short “Zebra Printer Test” receipt. There must be no blank looping jobs.

## Environment variables

See `.env.example`. Working values currently in use:

```env
GATEWAY_PORT=5050
ZK_ADMS_PORT=8080
GATEWAY_HOST_IP=192.168.1.4
ZK_DEVICE_IP=192.168.1.16
ZK_DEVICE_PORT=4370
PRINTER_IP=192.168.1.17
PRINTER_PORT=9100
SQLITE_PATH=./data/mess-local.db
```

`ZK_DEVICE_IP` / `ZK_DEVICE_PORT` / `ZK_COMM_KEY` are recorded for the LAN device. Production Face uses ADMS push, not `node-zklib` polling.

Populate employees with `npm run seed:demo` or your cloud→local sync (next phase).

## Known hardware requirements

- Mac and MB560-VL on the same LAN
- Device ADMS port `8080` reachable (allow Node in macOS firewall)
- Zebra printer at `192.168.1.17:9100`
- BC-8000G USB scanner in HID keyboard mode with CR suffix
- Gateway terminal focused for QR stdin
- Do not run the old `zkteco-mb560-test/server.js` at the same time (port 8080 clash)
