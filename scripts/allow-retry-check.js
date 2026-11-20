const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");
const { allowWatcherScript } = require("../lib/chrome-allow");

const file = path.join(os.tmpdir(), "mc-allow-retry.ps1");
fs.writeFileSync(file, allowWatcherScript(25000));
const watcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { windowsHide: true });
watcher.stdout.on("data", (data) => process.stdout.write(`WATCH ${data}`));
watcher.stderr.on("data", (data) => process.stderr.write(`ERR ${data}`));

const raw = fs.readFileSync(path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data", "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
const endpoint = `ws://127.0.0.1:${raw[0]}${raw[1]}`;

function connect() {
  return puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("connecting", endpoint);
  const first = connect().then((browser) => ({ which: "first", browser })).catch((error) => ({ which: "first-fail", error: error.message }));
  let result = await Promise.race([first, wait(8000).then(() => null)]);
  console.log("after-8s", result ? result.which : "still-pending", result && result.error ? result.error : "");
  if (!result || !result.browser) {
    const second = connect().then((browser) => ({ which: "second", browser })).catch((error) => ({ which: "second-fail", error: error.message }));
    result = await Promise.race([second, wait(8000).then(() => null)]);
    console.log("after-second", result ? `${result.which} ${result.error || ""}` : "still-pending");
  }
  if (result && result.browser) {
    console.log("pages", (await result.browser.pages()).length);
    await result.browser.disconnect();
  }
  watcher.kill();
  process.exit(result && result.browser ? 0 : 1);
}

main().catch((error) => {
  console.log("FAIL", error && error.message);
  watcher.kill();
  process.exit(1);
});
