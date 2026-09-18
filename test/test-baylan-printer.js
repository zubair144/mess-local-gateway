const net = require("net");

const HOST = process.env.BAYLAN_PRINTER_IP || "192.168.1.87";
const PORT = Number(process.env.BAYLAN_PRINTER_PORT || 9100);

const ESC = "\x1B";
const GS = "\x1D";

const receipt = Buffer.from(
  ESC + "@"+                    // Initialize printer
  ESC + "a" + "\x01" +         // Center align
  "MESS MANAGEMENT\n" +
  "Baylan Printer Test\n" +
  "==============================\n" +
  ESC + "a" + "\x00" +         // Left align
  "Printer: Baylan LAN\n" +
  `IP: ${HOST}\n` +
  "Status: TCP test successful\n" +
  "Date: " + new Date().toLocaleString() + "\n" +
  "==============================\n\n\n" +
  GS + "V" + "\x00",           // Cut
  "binary"
);

const client = new net.Socket();

client.setTimeout(5000);

client.connect(PORT, HOST, () => {
  console.log(`[BAYLAN] Connected to ${HOST}:${PORT}`);

  client.write(receipt, (err) => {
    if (err) {
      console.error("[BAYLAN] Print error:", err.message);
      client.destroy();
      return;
    }

    console.log("[BAYLAN] Print data sent successfully");
    client.end();
  });
});

client.on("error", (err) => {
  console.error("[BAYLAN] Connection error:", err.message);
});

client.on("timeout", () => {
  console.error("[BAYLAN] Connection timeout");
  client.destroy();
});

client.on("close", () => {
  console.log("[BAYLAN] Connection closed");
});