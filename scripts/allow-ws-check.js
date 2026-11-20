const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const raw = fs.readFileSync(path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data", "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
const endpoint = `ws://127.0.0.1:${raw[0]}${raw[1]}`;
console.log("connecting", endpoint);
const ws = new WebSocket(endpoint, [], {
  followRedirects: true,
  perMessageDeflate: false,
  allowSynchronousEvents: false,
  maxPayload: 256 * 1024 * 1024,
  headers: { "User-Agent": "Puppeteer test" },
});
ws.on("open", () => console.log("OPEN"));
ws.on("close", (code, reason) => console.log("CLOSE", code, String(reason)));
ws.on("error", (error) => console.log("ERROR", error.message));
ws.on("unexpected-response", (_request, response) => console.log("HTTP", response.statusCode));
setTimeout(() => {
  console.log("done-waiting");
  try { ws.close(); } catch (error) {}
  process.exit(0);
}, 12000);
