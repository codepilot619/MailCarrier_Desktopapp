const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const electronPath = require("electron");
const puppeteer = require("puppeteer-core");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-settings-"));
const shotPath = path.join(userData, "settings-modal.png");

const child = spawn(electronPath, ["--user-data-dir=" + userData, "--remote-debugging-port=9333", "."], {
  cwd: path.join(__dirname, ".."),
  env: process.env,
  stdio: "inherit",
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect() {
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError || new Error("Could not attach to the window.");
}

async function ready(page) {
  await page.waitForFunction(() => {
    const text = document.getElementById("connection-status")?.textContent || "";
    const button = document.getElementById("refresh");
    return text && text !== "Not connected yet." && button && !button.disabled;
  }, { timeout: 90000 });
}

(async () => {
  const browser = await connect();
  let page = null;
  for (let attempt = 0; attempt < 40 && !page; attempt += 1) {
    const pages = await browser.pages();
    page = pages.find((candidate) => candidate.url().includes("index.html")) || null;
    if (!page) await delay(250);
  }
  if (!page) throw new Error("No window page.");
  await ready(page);

  await page.screenshot({ path: shotPath });
  const linkMode = await page.evaluate(() => ({
    settingsButton: Boolean(document.getElementById("settings-open")),
    statusLoad: Boolean(document.getElementById("status-load")),
    note: document.getElementById("toolbar-note").textContent,
  }));

  await page.click("#source-chrome");
  await page.waitForFunction(() => document.getElementById("browser-title").textContent === "Chrome profiles", { timeout: 90000 });
  const onChrome = await page.evaluate(() => ({
    title: document.getElementById("browser-title").textContent,
    settingsButton: Boolean(document.getElementById("settings-open")),
    warmup: document.getElementById("warmup-start").textContent,
    start: document.getElementById("start").textContent,
    note: document.getElementById("toolbar-note").textContent.includes("Status comes from Settings"),
    secret: document.body.innerText.includes("secret"),
    options: [...document.getElementById("status-pick").options].map((option) => option.value).filter(Boolean),
  }));
  await page.click("#source-morelogin");
  await page.waitForFunction(() => document.getElementById("browser-title").textContent === "MoreLogin browsers", { timeout: 90000 });

  const report = { linkMode, onChrome, shotPath };
  console.log(`SETTINGS_CHECK ${JSON.stringify(report)}`);
  await browser.disconnect();
  child.kill();
  setTimeout(() => process.exit(0), 500);
})().catch((error) => {
  console.error(error);
  child.kill();
  setTimeout(() => process.exit(1), 500);
});
