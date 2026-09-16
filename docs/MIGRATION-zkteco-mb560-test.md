# Migration: zkteco-mb560-test → mess-local-gateway

The source project was **not deleted** and was not modified. Only production Face and QR runtime files were copied/refactored into the gateway.

## Import tree (inspected before migration)

`server.js` required:

- `express`
- `net` (Node built-in)

`qr.js` required:

- `net` (Node built-in)
- `readline` (Node built-in)

Neither file imported `printer.js`, `node-zklib`, or `usb`.

Working printer in both production services: Zebra ZPL TCP `192.168.1.186:9100`.

## Source file → target file

```text
server.js
→ src/hardware/face/zk-adms.js
→ src/hardware/face/face-service.js
→ Production Face / ZKTeco ADMS service (protocol preserved)
→ Printer calls extracted to src/hardware/printer/printer-service.js

qr.js
→ src/hardware/qr/qr-service.js
→ Production QR scanner service (HID stdin preserved)
→ Printer calls extracted to src/hardware/printer/printer-service.js

printer.js
→ NOT MIGRATED
→ Unused by server.js / qr.js
→ Different printer (ESC/POS 192.168.1.2:6101), ESM module, test-era helper

server-usb.js
→ NOT MIGRATED
→ USB/CUPS ADMS variant (port 8081), diagnostic / previous printer path

test-usb-direct.js
→ NOT MIGRATED
→ Diagnostic/test-only USB printer experiment

test-single-print.js
→ NOT MIGRATED
→ Diagnostic/test-only CUPS/lp print script

test-printer.js
→ NOT MIGRATED
→ Diagnostic/test-only Zebra TCP probe

test-printer-1.js
→ NOT MIGRATED
→ Diagnostic/test-only, imports unused printer.js

ZKTeco-test.js
→ NOT MIGRATED
→ Diagnostic/test-only node-zklib connection / realtime logs

device-test.js
→ NOT MIGRATED
→ Diagnostic/test-only node-zklib user map + realtime attendance

zkt-test.js
→ NOT MIGRATED
→ Diagnostic/test-only node-zklib getUsers
```

## Shared helpers created in the gateway

These did not exist as imported modules in the source project. They were extracted from the two production files:

```text
src/hardware/printer/printer-service.js
→ Shared Zebra ZPL implementation used by Face and QR
→ Exact attendance / QR / test ZPL templates preserved

src/config/index.js
→ Environment loader (working IPs/ports moved out of source files)

src/logger.js
→ Prefixed subsystem logging ([FACE], [QR], [PRINTER], [ZKTECO ERROR], ...)
```

## Dependencies

From `zkteco-mb560-test/package.json`:

| Package | Migrated? | Reason |
|---|---|---|
| `express` | No new add | Already in mess-local-gateway, used by ADMS + API |
| `node-zklib` | No new add | Not used by production `server.js` / `qr.js`. Already present in gateway for later direct-device work |
| `usb` | **Not added** | Used only by `test-usb-direct.js` |

No hardware library versions were upgraded for this migration.

## Ports

| Before | After |
|---|---|
| Face ADMS `8080` | Face ADMS `8080` (same Node process, dedicated listener) |
| QR: no HTTP port | QR still stdin in the same process |
| Gateway API `4000` | Gateway API `5050` |

## Intentionally unchanged hardware behavior

- ADMS request/response strings
- Immediate `OK` before print
- Face 10s duplicate window
- QR 3s duplicate window
- Zebra IP/port, timeout, ZPL, sanitization
- QR HID CR-suffix stdin reader
- Print retry allowed if the printer job fails
