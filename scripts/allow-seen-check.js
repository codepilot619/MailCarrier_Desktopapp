const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const { allowWatcherScript } = require("../lib/chrome-allow");

const endpoint = process.argv[2];
const ws = new WebSocket(endpoint);
ws.on("open", () => console.log("OPEN"));
ws.on("unexpected-response", (request, response) => console.log("HTTP", response.statusCode));
ws.on("error", (error) => console.log("ERR", error.message));

const file = path.join(os.tmpdir(), "mc-allow-seen.ps1");
const script = allowWatcherScript(10000).replace(
  "$dialogs = [MailCarrierAllowClick]::FindDialogs()",
  "$dialogs = [MailCarrierAllowClick]::FindDialogs()\r\nif ($dialogs.Count -gt 0 -and -not $script:saw) { \"seen $($dialogs.Count)\"; $script:saw = $true }"
);
fs.writeFileSync(file, script);
setTimeout(() => {
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`OUT ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`ERR ${chunk}`));
  child.on("exit", () => {
    console.log("watcher-done state", ws.readyState);
    try { ws.terminate(); } catch (error) {}
    process.exit(0);
  });
}, 1500);
