const fs = require("fs");
const path = require("path");
const { acquire } = require("../lib/browser-session");

const raw = fs.readFileSync(path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data", "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
const endpoint = `ws://127.0.0.1:${raw[0]}${raw[1]}`;
const timer = setTimeout(() => {
  console.log("TIMEOUT");
  process.exit(2);
}, 20000);

acquire({ browserWSEndpoint: endpoint }).then(async (browser) => {
  clearTimeout(timer);
  const pages = await browser.pages();
  console.log("CONNECTED", pages.length);
  await browser.disconnect();
  process.exit(0);
}).catch((error) => {
  clearTimeout(timer);
  console.log("FAIL", error && error.message);
  process.exit(1);
});
