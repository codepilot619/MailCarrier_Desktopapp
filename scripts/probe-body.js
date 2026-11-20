const fs = require("fs");
const puppeteer = require("puppeteer-core");
const { MoreLoginClient } = require("../lib/morelogin");

const state = JSON.parse(fs.readFileSync(`${process.env.APPDATA}/Mail Carrier/mail-carrier-state.json`, "utf8"));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const client = new MoreLoginClient({ baseUrl: state.settings.apiBase, token: state.settings.apiToken });
  const open = await client.listOpenBrowsers();
  const target = open.find((item) => item.envName === "13");
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${target.debugPort}`,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  const page = pages.find((item) => item.url().includes("mail.google.com/mail"));
  await page.bringToFront();
  const opened = await page.evaluate(() => {
    const button = document.querySelector('div[role="button"][gh="cm"]')
      || document.querySelector('div.T-I.T-I-KE[role="button"]');
    if (!button) return false;
    button.click();
    return true;
  });
  console.log("opened", opened);
  await page.waitForSelector('div[role="region"] div[role="textbox"][aria-label="Message Body"]', { timeout: 20000 });
  const before = await page.evaluate(() => {
    const body = document.querySelector('div[role="region"] div[role="textbox"][aria-label="Message Body"]');
    return {
      editable: body.getAttribute("contenteditable"),
      text: (body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
    };
  });
  console.log("before", JSON.stringify(before));

  const afterHtml = await page.evaluate(() => {
    const body = document.querySelector('div[role="region"] div[role="textbox"][aria-label="Message Body"]');
    const policy = window.__mailCarrierPolicy || (window.__mailCarrierPolicy = trustedTypes.createPolicy("mailCarrierHtml", {
      createHTML: (value) => value,
    }));
    const wrap = document.createElement("div");
    wrap.innerHTML = policy.createHTML("Hello Jane,<br><br>PROBE_HTML_BODY");
    body.insertBefore(wrap, body.firstChild);
    body.dispatchEvent(new Event("input", { bubbles: true }));
    return (body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 180);
  });
  console.log("afterHtml", afterHtml);
  await sleep(600);
  const still = await page.evaluate(() => {
    const body = document.querySelector('div[role="region"] div[role="textbox"][aria-label="Message Body"]');
    return (body && body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 180);
  });
  console.log("still", still);

  await page.evaluate(() => {
    document.querySelectorAll('div[role="button"][aria-label*="Discard draft"]').forEach((button) => button.click());
  });
  await sleep(500);
  await page.evaluate(() => {
    document.querySelectorAll('div[role="alertdialog"] [role="button"], div[role="alertdialog"] button').forEach((button) => {
      const label = (button.getAttribute("aria-label") || button.textContent || "").trim().toLowerCase();
      if (label === "ok" || label === "discard") button.click();
    });
  });
  console.log("discarded");
  await browser.disconnect();
})().catch((error) => {
  console.error("FAIL", error.stack || error.message);
  process.exit(1);
});
