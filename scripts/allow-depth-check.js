const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

const ws = new WebSocket(process.argv[2]);
ws.on("open", () => console.log("OPEN"));
ws.on("error", (error) => console.log("ERR", error.message));
setTimeout(() => {
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "allow-click-debug.ps1")],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout.on("data", (chunk) => process.stdout.write(String(chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
  child.on("exit", () => {
    console.log("state", ws.readyState);
    try { ws.terminate(); } catch (error) {}
    process.exit(0);
  });
}, 1500);
