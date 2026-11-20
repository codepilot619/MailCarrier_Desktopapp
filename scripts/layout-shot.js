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

(async () => {
  const browser = await connect();
  let page = null;
  for (let attempt = 0; attempt < 40 && !page; attempt += 1) {
    const pages = await browser.pages();
    page = pages.find((candidate) => candidate.url().includes("index.html")) || null;
    if (!page) await delay(250);
  }
  if (!page) throw new Error(`No window page. Saw: ${(await browser.pages()).map((item) => item.url()).join(" | ")}`);

  await page.waitForFunction(() => {
    const text = document.getElementById("connection-status")?.textContent || "";
    return text.startsWith("Connected") || text.includes("Cannot reach") || text.includes("returned");
  }, { timeout: 20000 });
  await delay(400);

  const shotPath = path.join(__dirname, "..", "layout-shot.png");
  await page.screenshot({ path: shotPath });
  const text = await page.evaluate(() => ({
    connection: document.getElementById("connection-status").textContent,
    count: document.getElementById("profile-count").textContent,
    cards: document.querySelectorAll(".profile-card").length,
    openPills: document.querySelectorAll(".pill.open").length,
    closedPills: [...document.querySelectorAll(".pill")].filter((node) => node.textContent === "Closed").length,
    startDisabled: document.getElementById("start").disabled,
    hasApi: Boolean(window.mailCarrier),
    firstTitle: document.querySelector(".profile-title")?.textContent || "",
  }));
  console.log(`LAYOUT ${JSON.stringify(text)}`);
  console.log(`SHOT ${shotPath}`);
  await browser.disconnect();
  child.kill();
  setTimeout(() => process.exit(0), 500);
})().catch((error) => {
  console.error(error);
  child.kill();
  process.exit(1);
});
