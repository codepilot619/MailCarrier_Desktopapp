const { spawn } = require("child_process");
const path = require("path");
const electronPath = require("electron");
const puppeteer = require("puppeteer-core");

const child = spawn(electronPath, ["--remote-debugging-port=9333", "."], {
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
      return await puppeteer.connect({
        browserURL: "http://127.0.0.1:9333",
        defaultViewport: null,
      });
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError || new Error("Could not attach to the window.");
}

async function waitFor(page, predicate, timeout = 60000) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeout) {
    last = await page.evaluate(predicate);
    if (last) return last;
    await delay(300);
  }
  const text = await page.evaluate(() => document.getElementById("connection-status")?.textContent || "(missing)");
  throw new Error(`Timed out. Last: ${last} Status: ${text}`);
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

  await waitFor(page, () => {
    const text = document.getElementById("connection-status")?.textContent || "";
    return text.startsWith("Connected") || text.includes("Cannot reach") || text.includes("returned") ? text : "";
  });

  const morelogin = await page.evaluate(() => ({
    title: document.getElementById("browser-title").textContent,
    tagline: document.getElementById("brand-tagline").textContent,
    apiHidden: document.getElementById("morelogin-fields").hidden,
    chromeSelected: document.getElementById("source-chrome").getAttribute("aria-selected"),
    moreloginSelected: document.getElementById("source-morelogin").getAttribute("aria-selected"),
    warmup: document.getElementById("warmup-start").textContent,
    chromeName: [...document.querySelectorAll(".profile-title")].some((node) => node.textContent.includes("David (Ron)")),
    note: document.getElementById("toolbar-note").textContent.slice(0, 40),
  }));
  console.log(`MORELOGIN ${JSON.stringify(morelogin)}`);

  await page.click("#source-chrome");
  await waitFor(page, () => {
    const text = document.getElementById("connection-status")?.textContent || "";
    return /Chrome profile|No Chrome profiles|Could not read Chrome/.test(text) ? text : "";
  });
  const chrome = await page.evaluate(() => ({
    title: document.getElementById("browser-title").textContent,
    tagline: document.getElementById("brand-tagline").textContent,
    apiHidden: document.getElementById("morelogin-fields").hidden,
    chromeSelected: document.getElementById("source-chrome").getAttribute("aria-selected"),
    connection: document.getElementById("connection-status").textContent,
    warmup: document.getElementById("warmup-start").textContent,
    start: document.getElementById("start").textContent,
    david: [...document.querySelectorAll(".profile-title")].some((node) => node.textContent.includes("David (Ron)")),
    groups: document.querySelectorAll(".tree-group:not(.hidden-group)").length,
    note: document.getElementById("toolbar-note").textContent.includes("Chrome profiles on this computer"),
  }));
  console.log(`CHROME ${JSON.stringify(chrome)}`);
  await page.screenshot({ path: path.join(__dirname, "..", "chrome-source.png") });

  await page.click("#source-morelogin");
  await waitFor(page, () => {
    const text = document.getElementById("connection-status")?.textContent || "";
    return text.startsWith("Connected") || text.includes("Cannot reach") || text.includes("returned") ? text : "";
  });
  const back = await page.evaluate(() => ({
    title: document.getElementById("browser-title").textContent,
    apiHidden: document.getElementById("morelogin-fields").hidden,
    moreloginSelected: document.getElementById("source-morelogin").getAttribute("aria-selected"),
  }));
  console.log(`BACK ${JSON.stringify(back)}`);

  await browser.disconnect();
  child.kill();
  setTimeout(() => process.exit(0), 500);
})().catch((error) => {
  console.error(error);
  child.kill();
  process.exit(1);
});
