const http = require("http");
const https = require("https");
const { startAllowWatcher } = require("./chrome-allow");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const held = new Map();
const tails = new Map();

function queueKey(options = {}) {
  if (options.browserWSEndpoint) return `ws:${String(options.browserWSEndpoint)}`;
  if (options.debugPort) return `port:${String(options.debugPort)}`;
  return "default";
}

function enqueue(key, task) {
  const prior = tails.get(key) || Promise.resolve();
  const run = prior.then(task, task);
  tails.set(key, run.then(() => {}, () => {}));
  return run;
}

function usable(browser) {
  return Boolean(browser) && browser.connected !== false;
}

function targetIdOf(target) {
  if (!target) return "";
  if (target._targetId) return String(target._targetId);
  const info = target._targetInfo;
  return info && info.targetId ? String(info.targetId) : "";
}

function eachTarget(browser, visit) {
  const groups = [];
  if (browser && typeof browser.targets === "function") groups.push(browser.targets());
  if (browser && typeof browser.browserContexts === "function") {
    for (const context of browser.browserContexts()) {
      if (context && typeof context.targets === "function") groups.push(context.targets());
    }
  }
  for (const group of groups) {
    for (const target of group || []) visit(target);
  }
}

function pageSummaries(browser) {
  const seen = new Set();
  const pages = [];
  eachTarget(browser, (target) => {
    if (!target || typeof target.type !== "function" || target.type() !== "page") return;
    const id = targetIdOf(target);
    if (!id || seen.has(id)) return;
    seen.add(id);
    let url = "";
    try {
      url = target.url();
    } catch (error) {
      url = "";
    }
    pages.push({ id, type: "page", url });
  });
  return pages;
}

function findTarget(browser, targetId) {
  const wanted = String(targetId || "");
  let found = null;
  eachTarget(browser, (target) => {
    if (!found && targetIdOf(target) === wanted) found = target;
  });
  return found;
}

const PROTOCOL_TIMEOUT_MS = 600000;
// MoreLogin debug-port connects must fail fast. A stuck Network.enable with the
// long warm-up timeout was retried for minutes and blocked Read Gmail / Refresh.
const PORT_PROTOCOL_TIMEOUT_MS = 60000;

function connectOptions(extra = {}) {
  return {
    defaultViewport: null,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
    ...extra,
  };
}

function isProtocolTimeout(error) {
  return /protocolTimeout|Network\.enable timed out|timed out\. Increase the 'protocolTimeout'/i.test(String(error?.message || error || ""));
}

function shouldRetryPortConnect(error, attempt, maxAttempts = 8) {
  if (attempt + 1 >= maxAttempts) return false;
  if (isProtocolTimeout(error)) return false;
  return true;
}

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const lib = target.protocol === "https:" ? https : http;
    const request = lib.get(target, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timed out")));
    request.on("error", reject);
  });
}

// /json/version often reports the first browser's port. The HTTP port that
// answered is the browser we asked for, including the second open browser.
function debuggerSocketUrl(webSocketDebuggerUrl, debugPort) {
  const port = String(debugPort || "").trim();
  const raw = String(webSocketDebuggerUrl || "").trim();
  if (!raw || !port) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    return "";
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return "";
  parsed.hostname = "127.0.0.1";
  parsed.port = port;
  return parsed.toString();
}

function forgetBrowser(browser) {
  for (const [key, heldBrowser] of held.entries()) {
    if (heldBrowser === browser) held.delete(key);
  }
}

async function connectPort(debugPort) {
  const puppeteer = require("puppeteer-core");
  const browserURL = `http://127.0.0.1:${debugPort}`;
  let lastError = null;
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const version = await fetchJson(`${browserURL}/json/version`, 5000);
      const reported = version && version.webSocketDebuggerUrl;
      const corrected = debuggerSocketUrl(reported, debugPort);
      if (!corrected) throw new Error("The browser did not return a debugging socket.");
      try {
        return await puppeteer.connect(connectOptions({
          browserWSEndpoint: corrected,
          protocolTimeout: PORT_PROTOCOL_TIMEOUT_MS,
        }));
      } catch (error) {
        if (!reported || corrected === reported || isProtocolTimeout(error)) throw error;
        return await puppeteer.connect(connectOptions({
          browserWSEndpoint: reported,
          protocolTimeout: PORT_PROTOCOL_TIMEOUT_MS,
        }));
      }
    } catch (error) {
      lastError = error;
      if (!shouldRetryPortConnect(error, attempt, maxAttempts)) break;
      await delay(1000);
    }
  }
  if (isProtocolTimeout(lastError)) {
    throw new Error(`Browser debugging timed out on port ${debugPort}. Close extra tabs in that MoreLogin profile, then click Refresh or Read Gmail again.`);
  }
  throw new Error(`Could not connect to the browser on port ${debugPort}. ${lastError ? lastError.message : ""}`.trim());
}

function connectBrowser(puppeteer, browserWSEndpoint) {
  return puppeteer.connect(connectOptions({ browserWSEndpoint }));
}

function releaseLater(pending, keep) {
  if (!pending || typeof pending.then !== "function") return;
  pending.then((browser) => {
    if (browser && browser !== keep) browser.disconnect().catch(() => {});
  }).catch(() => {});
}

// Chrome shows one Allow dialog per WebSocket. A second socket while the
// first is still open leaves that dialog on screen after Allow is pressed.
function openAnotherSocket(attemptState, clicked, now, retryAt) {
  if (attemptState === "open") return false;
  return attemptState === "failed" && Boolean(clicked) && now >= retryAt;
}

async function connectWebSocket(browserWSEndpoint) {
  const puppeteer = require("puppeteer-core");
  const started = Date.now();
  let lastError = null;
  const allowWatcher = startAllowWatcher(90000);
  let attempt = connectBrowser(puppeteer, browserWSEndpoint);
  let attemptState = "open";
  let retryAt = 0;
  const track = (promise) => promise.then((browser) => ({ browser })).catch((error) => {
    lastError = error;
    return { failed: true };
  });
  let tracked = track(attempt);
  try {
    while (Date.now() - started < 90000) {
      const ready = await Promise.race([
        tracked,
        delay(400).then(() => null),
      ]);
      if (ready && ready.browser) return ready.browser;
      if (ready && ready.failed) attemptState = "failed";
      if (openAnotherSocket(attemptState, allowWatcher.clicked(), Date.now(), retryAt)) {
        attempt = connectBrowser(puppeteer, browserWSEndpoint);
        tracked = track(attempt);
        attemptState = "open";
        retryAt = Date.now() + 3000;
      }
      await delay(200);
    }
    releaseLater(attempt, null);
    throw new Error(`Chrome did not allow debugging. Mail Carrier tried to press Allow. Gmail stays signed in. ${lastError ? lastError.message : ""}`.trim());
  } finally {
    allowWatcher.stop();
  }
}

async function acquireInner({ debugPort, browserWSEndpoint, forceNew }) {
  if (browserWSEndpoint) {
    const key = String(browserWSEndpoint);
    const existing = held.get(key);
    if (!forceNew && usable(existing)) return existing;
    if (forceNew && existing) {
      held.delete(key);
      await existing.disconnect().catch(() => {});
    }
    const browser = await connectWebSocket(browserWSEndpoint);
    held.set(key, browser);
    browser.on("disconnected", () => {
      if (held.get(key) === browser) held.delete(key);
    });
    return browser;
  }
  return connectPort(debugPort);
}

function acquire(options) {
  const opts = options || {};
  return enqueue(queueKey(opts), () => acquireInner(opts));
}

async function releasePort(browser) {
  if (!browser) return;
  for (const heldBrowser of held.values()) {
    if (heldBrowser === browser) return;
  }
  await browser.disconnect().catch(() => {});
}

module.exports = {
  acquire,
  releasePort,
  forgetBrowser,
  isProtocolTimeout,
  shouldRetryPortConnect,
  queueKey,
  debuggerSocketUrl,
  PROTOCOL_TIMEOUT_MS,
  PORT_PROTOCOL_TIMEOUT_MS,
  pageSummaries,
  findTarget,
  targetIdOf,
  openAnotherSocket,
};
