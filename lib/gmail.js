const path = require("path");
const { acquire, releasePort, findTarget, targetIdOf, forgetBrowser, isProtocolTimeout } = require("./browser-session");

const SEND_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pause(ms, isStopped) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    checkStop(isStopped);
    await delay(Math.min(500, end - Date.now()));
  }
}

function fatal(message) {
  const error = new Error(message);
  error.fatal = true;
  return error;
}

function isLoginUrl(url) {
  return /accounts\.google\.com|ServiceLogin|signin\/v2|\/challenge\//i.test(String(url || ""));
}

function firstPersonalName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (!name) return "";
  return name.split(" ")[0].slice(0, 80);
}

function mailboxNameKey(email, name) {
  const mail = String(email || "").trim().toLowerCase();
  const first = firstPersonalName(name);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || !first || /@/.test(first)) return "";
  return `${mail}-${first}`;
}

function looksLikePersonName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) return "";
  if (/@|https?:|\\|\/|\d{3,}/i.test(name)) return "";
  if (!/\p{L}/u.test(name)) return "";
  return name;
}

function pickAccountName(row) {
  if (!Array.isArray(row)) return "";
  const display = looksLikePersonName(row[2]);
  const given = looksLikePersonName(row[10]);
  const family = looksLikePersonName(row[11]);
  const combined = [given, family].filter(Boolean).join(" ");
  if (combined && (!display || (combined.length > display.length && combined.toLowerCase().includes(display.toLowerCase().split(" ")[0])))) {
    return combined.slice(0, 120);
  }
  return display.slice(0, 120);
}

function nameFromAccountLabel(label, email) {
  const text = String(label || "").replace(/\s+/g, " ").trim();
  if (!/google account/i.test(text)) return "";
  if (email && !text.toLowerCase().includes(String(email).toLowerCase())) return "";
  const match = text.match(/google account:\s*(.+?)(?:\s*\(|$)/i);
  return looksLikePersonName(match && match[1]).slice(0, 120);
}

function emailFromText(value) {
  const match = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : "";
}

function emailFromAccountRow(row) {
  if (Array.isArray(row)) {
    const preferred = emailFromText(row[3]);
    if (preferred) return preferred;
    for (const value of row) {
      if (Array.isArray(value)) continue;
      const email = emailFromText(value);
      if (email) return email;
    }
    return "";
  }
  return emailFromText(row);
}

function rowsFromListPayload(data) {
  const rows = [];
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    const nested = value.some((item) => Array.isArray(item));
    const directEmail = !Array.isArray(value[3]) && emailFromText(value[3]);
    if (directEmail || (!nested && emailFromAccountRow(value))) rows.push(value);
    for (const child of value) {
      if (Array.isArray(child)) visit(child);
    }
  };
  visit(data);
  return rows;
}

function accountsFromListRows(listRows) {
  const found = [];
  const seen = new Set();
  for (const row of Array.isArray(listRows) ? listRows : []) {
    const email = emailFromAccountRow(row);
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    found.push({ index: found.length, email });
  }
  return found;
}

function jsonPayloadFromText(value) {
  const cleaned = String(value || "").replace(/^\uFEFF/, "").replace(/^\)\]\}'\s*/, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end <= start) return "";
  return cleaned.slice(start, end + 1);
}

function accountsFromListPayloads(payloads) {
  const groups = [];
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    const text = jsonPayloadFromText(payload);
    if (!text) continue;
    try {
      const accounts = accountsFromListRows(rowsFromListPayload(JSON.parse(text)));
      if (accounts.length) groups.push(accounts);
    } catch (error) {}
  }
  groups.sort((left, right) => right.length - left.length);
  const found = [];
  const seen = new Set();
  for (const group of groups) {
    for (const account of group) {
      const key = String(account.email || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      found.push({ index: found.length, email: account.email });
    }
  }
  return found;
}

function listRowsFromPayloads(payloads) {
  let best = [];
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    const text = jsonPayloadFromText(payload);
    if (!text) continue;
    try {
      const rows = rowsFromListPayload(JSON.parse(text));
      if (rows.length > best.length) best = rows;
    } catch (error) {}
  }
  return best;
}

function mailboxIndexFromHref(rawHref) {
  const raw = String(rawHref || "");
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw, "https://mail.google.com");
  } catch (error) {
    return null;
  }
  const authuser = parsed.searchParams.get("authuser");
  if (/^\d+$/.test(authuser || "")) return Number(authuser);
  if (/mail\.google\.com$/i.test(parsed.hostname)) {
    const mail = parsed.pathname.match(/\/mail\/u\/(\d+)/i);
    if (mail) return Number(mail[1]);
  }
  return null;
}

function mailboxFromHint(hint) {
  const rawHref = String(hint && hint.href || "");
  const href = decodeURIComponentSafe(rawHref);
  const email = emailFromText(hint && hint.email) || emailFromText(href) || emailFromText(hint && hint.label);
  if (!email) return null;
  let index = null;
  if (/^\d+$/.test(String(hint && hint.authuser || ""))) index = Number(hint.authuser);
  if (index === null) index = mailboxIndexFromHref(rawHref);
  return { email, index };
}

function decodeURIComponentSafe(value) {
  const text = String(value || "").replace(/\+/g, " ");
  try {
    return decodeURIComponent(text);
  } catch (error) {
    return text;
  }
}

function mailboxesFromHints(hints) {
  const found = [];
  const seen = new Set();
  for (const hint of Array.isArray(hints) ? hints : []) {
    const mailbox = mailboxFromHint(hint);
    if (!mailbox) continue;
    const key = mailbox.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(mailbox);
  }
  return found;
}

const MAILBOX_PROBE_LIMIT = 30;

function combineDetectedMailboxes(fromProbe, fromSwitcher, fromList) {
  return mergeMailboxAccounts(
    [...(Array.isArray(fromProbe) ? fromProbe : []), ...(Array.isArray(fromSwitcher) ? fromSwitcher : [])],
    Array.isArray(fromList) ? fromList : []
  );
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function atomMailboxFromFeed(head) {
  const text = String(head || "");
  const title = (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
  const author = (text.match(/<author>[\s\S]*?<email>([^<]+)<\/email>/i) || [])[1] || "";
  return emailFromText(decodeXml(title)) || emailFromText(decodeXml(author)) || emailFromText(decodeXml(text));
}

function feedProbeSettled(feeds) {
  if (!Array.isArray(feeds) || !feeds.length) return false;
  const last = feeds[feeds.length - 1];
  const ended = Boolean(last && (last.missing || last.redirected || !last.head));
  const capped = feeds.length >= MAILBOX_PROBE_LIMIT && feeds.every((feed) => feed && feed.head && !feed.missing && !feed.redirected);
  if (!ended && !capped) return false;
  const usable = feeds.filter((feed) => feed && feed.head && !feed.missing && !feed.redirected);
  return usable.length > 0 && mailboxesFromFeeds(feeds).length === usable.length;
}

function mailboxesFromFeeds(feeds) {
  const found = [];
  const seen = new Set();
  for (const feed of Array.isArray(feeds) ? feeds : []) {
    if (!feed || feed.redirected || feed.missing) continue;
    const index = Number(feed.index);
    const email = atomMailboxFromFeed(feed.head || "");
    if (!email || !Number.isInteger(index) || index < 0) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ index, email });
  }
  return found;
}

function signedInMailboxes(feeds, openPages) {
  const rejected = new Set();
  for (const feed of Array.isArray(feeds) ? feeds : []) {
    if (!feed) continue;
    const index = Number(feed.index);
    if (!Number.isInteger(index) || index < 0) continue;
    const signedIn = feed.head && !feed.missing && !feed.redirected;
    if (!signedIn) rejected.add(index);
  }
  const pages = withKnownIndex(openPages).filter((account) => !rejected.has(account.index));
  return mergeMailboxAccounts([...mailboxesFromFeeds(feeds), ...pages], []);
}

function withKnownIndex(accounts) {
  const found = [];
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account || account.index === null || account.index === undefined || account.index === "") continue;
    const index = Number(account.index);
    const email = String(account.email || "").trim();
    if (!email || !Number.isInteger(index) || index < 0) continue;
    found.push({ index, email });
  }
  return found;
}

function mergeMailboxAccounts(preferred, extra) {
  const usedEmails = new Set();
  const usedIndexes = new Set();
  const result = [];
  const add = (index, email) => {
    const clean = String(email || "").trim();
    const key = clean.toLowerCase();
    const at = Number(index);
    if (!clean || !Number.isInteger(at) || at < 0) return false;
    if (usedEmails.has(key) || usedIndexes.has(at)) return false;
    usedEmails.add(key);
    usedIndexes.add(at);
    result.push({ index: at, email: clean });
    return true;
  };
  for (const account of [...(preferred || []), ...(extra || [])]) {
    add(account && account.index, account && account.email);
  }
  for (const account of [...(extra || []), ...(preferred || [])]) {
    const email = String(account && account.email || "").trim();
    if (!email || usedEmails.has(email.toLowerCase())) continue;
    let index = 0;
    while (usedIndexes.has(index)) index += 1;
    add(index, email);
  }
  return result.sort((left, right) => left.index - right.index);
}

function attachAccountNames(accounts, listRows, labels) {
  const rows = Array.isArray(listRows) ? listRows : [];
  const captions = Array.isArray(labels) ? labels : [];
  return (Array.isArray(accounts) ? accounts : []).map((account) => {
    const email = String(account?.email || "");
    const row = rows.find((item) => emailFromAccountRow(item).toLowerCase() === email.toLowerCase());
    const fromRow = row ? pickAccountName(row) : "";
    const fromLabel = captions.map((label) => nameFromAccountLabel(label, email)).find(Boolean) || "";
    const name = fromLabel.length > fromRow.length ? fromLabel : fromRow;
    return {
      index: Number(account.index) || 0,
      email,
      name,
    };
  });
}

function gmailAccountIndex(url) {
  const match = String(url || "").match(/\/mail\/u\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function mailboxMatches(actual, expected) {
  const wanted = String(expected || "").trim().toLowerCase();
  if (!wanted) return true;
  return String(actual || "").trim().toLowerCase() === wanted;
}

async function readOpenMailbox(page, index) {
  const accountIndex = Number(index) || 0;
  return page.evaluate(async (wantedIndex) => {
    try {
      const response = await fetch(`https://mail.google.com/mail/u/${wantedIndex}/feed/atom`, {
        credentials: "include",
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      });
      const finalIndex = (response.url.match(/\/mail\/u\/(\d+)/) || [])[1];
      if (finalIndex !== undefined && Number(finalIndex) !== Number(wantedIndex)) return "";
      if (!response.ok) return "";
      const xml = await response.text();
      const head = xml.split(/<entry[\s>]/i)[0];
      const emailMatch = head.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      return emailMatch ? emailMatch[0] : "";
    } catch (error) {
      return "";
    }
  }, accountIndex);
}

function checkStop(isStopped) {
  if (typeof isStopped === "function" && isStopped()) {
    const error = new Error("Stopped");
    error.code = "STOP";
    throw error;
  }
}

async function pageForTarget(browser, targetId) {
  const wanted = String(targetId || "");
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (typeof browser.pages === "function") {
      let pages = [];
      try {
        pages = await browser.pages();
      } catch (error) {
        pages = [];
      }
      for (const page of pages || []) {
        const target = page && typeof page.target === "function" ? page.target() : null;
        if (target && targetIdOf(target) === wanted) return page;
      }
    }
    const target = findTarget(browser, wanted);
    if (target && typeof target.page === "function") {
      const page = await target.page();
      if (page) return page;
    }
    await delay(250);
  }
  throw new Error("That Chrome profile tab is not available. Click Open and try again.");
}

async function withBrowser(debugPort, fn, options = {}) {
  const browserWSEndpoint = options.browserWSEndpoint || "";
  let browser = await acquire({ debugPort, browserWSEndpoint });
  const run = async (active) => {
    if (!options.targetId) return fn(active);
    const page = await pageForTarget(active, options.targetId);
    const scope = {
      preservePage: true,
      async pages() {
        return page.isClosed() ? [] : [page];
      },
      async newPage() {
        if (page.isClosed()) throw new Error("The Chrome profile tab was closed. Click Open and try again.");
        return page;
      },
    };
    return fn(scope);
  };
  try {
    return await run(browser);
  } catch (error) {
    if (!isProtocolTimeout(error)) throw error;
    forgetBrowser(browser);
    await browser.disconnect().catch(() => {});
    browser = await acquire({ debugPort, browserWSEndpoint, forceNew: true });
    try {
      return await run(browser);
    } catch (retryError) {
      if (isProtocolTimeout(retryError)) {
        forgetBrowser(browser);
        throw fatal(`Browser debugging timed out. Close extra tabs in that profile, then press Resume. ${retryError.message || retryError}`);
      }
      throw retryError;
    }
  } finally {
    await releasePort(browser);
  }
}

function inboxReady(index) {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  const match = location.href.match(/\/mail\/u\/(\d+)/);
  if (!match || Number(match[1]) !== Number(index)) return false;
  const classicButton = document.querySelector('div[role="button"][gh="cm"]');
  if (isVisible(classicButton)) return true;
  const styledButton = document.querySelector('div.T-I.T-I-KE[role="button"]');
  if (isVisible(styledButton)) return true;
  const composeLabels = ["compose", "rédiger", "escribir", "schreiben", "scrivi", "escrever"];
  const buttons = document.querySelectorAll('div[role="button"]');
  for (const button of buttons) {
    const label = (button.getAttribute("aria-label") || button.textContent || "").trim().toLowerCase();
    if (composeLabels.some((text) => label === text || label.startsWith(`${text} `)) && isVisible(button)) return true;
  }
  return false;
}

function clickComposeButtonInPage() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function find() {
    const classicButton = document.querySelector('div[role="button"][gh="cm"]');
    if (isVisible(classicButton)) return classicButton;
    const styledButton = document.querySelector('div.T-I.T-I-KE[role="button"]');
    if (isVisible(styledButton)) return styledButton;
    const composeLabels = ["compose", "rédiger", "escribir", "schreiben", "scrivi", "escrever"];
    const buttons = document.querySelectorAll('div[role="button"]');
    for (const button of buttons) {
      const label = (button.getAttribute("aria-label") || button.textContent || "").trim().toLowerCase();
      if (composeLabels.some((text) => label === text || label.startsWith(`${text} `)) && isVisible(button)) return button;
    }
    return null;
  }

  const button = find();
  if (!button) return false;
  button.scrollIntoView({ block: "center", inline: "nearest" });
  // One activation. element.click() already sends the click sequence; a second
  // synthetic click opens another compose window.
  button.click();
  return true;
}

function composeButtonPointInPage() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function find() {
    const classicButton = document.querySelector('div[role="button"][gh="cm"]');
    if (isVisible(classicButton)) return classicButton;
    const styledButton = document.querySelector('div.T-I.T-I-KE[role="button"]');
    if (isVisible(styledButton)) return styledButton;
    const composeLabels = ["compose", "rédiger", "escribir", "schreiben", "scrivi", "escrever"];
    const buttons = document.querySelectorAll('div[role="button"]');
    for (const button of buttons) {
      const label = (button.getAttribute("aria-label") || button.textContent || "").trim().toLowerCase();
      if (composeLabels.some((text) => label === text || label.startsWith(`${text} `)) && isVisible(button)) return button;
    }
    return null;
  }

  const button = find();
  if (!button) return null;
  button.scrollIntoView({ block: "center", inline: "nearest" });
  const rect = button.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function composeOpenPlan(openCount, clicked) {
  const count = Number(openCount) || 0;
  if (clicked) return count > 1 ? "close-extras" : "wait";
  if (count > 0) return "close-all";
  return "click";
}

function expandCollapsedComposeInPage() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function labelOf(node) {
    return `${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-tooltip") || ""}`
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isCompose(node) {
    if (node.querySelector('input[name="subjectbox"]')) return true;
    return labelOf(node).includes("new message");
  }

  const nodes = [...document.querySelectorAll('div[role="dialog"], div[role="region"]')];
  const matched = nodes.filter((node) => isVisible(node) && isCompose(node));
  const open = matched.filter((node) => !matched.some((other) => other !== node && node.contains(other)));
  if (!open.length) return "missing";

  function collapsed(root) {
    const subject = root.querySelector('input[name="subjectbox"]');
    if (!isVisible(subject)) return true;
    return root.getBoundingClientRect().height < 160;
  }

  if (open.every((root) => !collapsed(root))) return "expanded";

  function pick(buttons, accept) {
    return buttons.find((button) => isVisible(button) && accept(labelOf(button)));
  }

  let clicked = false;
  for (const root of open) {
    if (!collapsed(root)) continue;
    const buttons = [...root.querySelectorAll('[role="button"], button')];
    const target = pick(buttons, (label) => label === "maximize" || label.startsWith("maximize ") || label === "expand" || label.startsWith("expand "))
      || pick(buttons, (label) => label === "new message" || label.startsWith("new message "))
      || pick(buttons, (label) => !label.includes("exit") && (label === "full screen" || label.startsWith("full screen")));
    if (!target) continue;
    target.click();
    clicked = true;
  }
  return clicked ? "clicked" : "collapsed";
}

async function enableCdpInput(page) {
  if (!page || typeof page.createCDPSession !== "function") return null;
  const apply = async (client) => {
    await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    try {
      await client.send("Input.setIgnoreInputEvents", { ignore: false });
    } catch (error) {}
    return client;
  };
  if (page.__mailCarrierInput) {
    try {
      return await apply(page.__mailCarrierInput);
    } catch (error) {
      page.__mailCarrierInput = null;
    }
  }
  try {
    const session = await Promise.race([
      page.createCDPSession(),
      delay(5000).then(() => null),
    ]);
    if (!session) return null;
    page.__mailCarrierInput = session;
    return await apply(session);
  } catch (error) {
    page.__mailCarrierInput = null;
    return null;
  }
}

async function landInput(page) {
  await enableCdpInput(page);
}

async function cdpClick(page, x, y) {
  const px = Math.round(Number(x) || 0);
  const py = Math.round(Number(y) || 0);
  const session = await enableCdpInput(page);
  if (session) {
    try {
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
      await session.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: px,
        y: py,
        button: "left",
        clickCount: 1,
      });
      await delay(40);
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: px,
        y: py,
        button: "left",
        clickCount: 1,
      });
      return;
    } catch (error) {}
  }
  await page.mouse.click(px, py, { delay: 40 });
}

function openComposeRouteInPage() {
  const next = "#inbox?compose=new";
  const hash = String(location.hash || "");
  if (/[?&]compose=new(?:&|$)/i.test(hash)) return "already";
  location.hash = next;
  return "set";
}

async function activateComposeButton(page) {
  const point = await page.evaluate(composeButtonPointInPage);
  if (!point) return false;
  try {
    await landInput(page);
    await cdpClick(page, point.x, point.y);
    return true;
  } catch (error) {
    return page.evaluate(clickComposeButtonInPage);
  }
}

async function expandCollapsedCompose(page) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let state = "missing";
    try {
      state = await page.evaluate(expandCollapsedComposeInPage);
    } catch (error) {
      return false;
    }
    if (state === "expanded") return true;
    if (state === "clicked") {
      await delay(300);
      continue;
    }
    if (state === "collapsed" && attempt < 4) {
      await delay(300);
      continue;
    }
    return false;
  }
  try {
    return (await page.evaluate(expandCollapsedComposeInPage)) === "expanded";
  } catch (error) {
    return false;
  }
}

function inspectComposeWindows(action) {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function roots() {
    const nodes = [...document.querySelectorAll('div[role="dialog"], div[role="region"]')];
    const matched = nodes.filter((node) => {
      if (!isVisible(node)) return false;
      if (node.querySelector('input[name="subjectbox"]')) return true;
      const label = (node.getAttribute("aria-label") || "").toLowerCase();
      return label.includes("new message");
    });
    if (!matched.length) {
      const subject = [...document.querySelectorAll('input[name="subjectbox"]')].find(isVisible);
      if (subject) matched.push(subject.closest('[role="dialog"], [role="region"], form') || subject.parentElement || subject);
    }
    return matched.filter((node) => !matched.some((other) => other !== node && node.contains(other)));
  }

  function closeButton(root) {
    let host = root;
    let current = root;
    while (current && current !== document.body) {
      const role = (current.getAttribute && current.getAttribute("role")) || "";
      const label = ((current.getAttribute && current.getAttribute("aria-label")) || "").toLowerCase();
      if (role === "dialog" || label.includes("new message")) host = current;
      current = current.parentElement;
    }
    return host.querySelector('[aria-label="Save & close"], [data-tooltip="Save & close"], [aria-label*="Discard draft"], [data-tooltip*="Discard draft"]');
  }

  const open = roots();
  if (action === "close-all" || action === "close-extras") {
    const targets = action === "close-extras" ? open.slice(0, -1) : open;
    const seen = new Set();
    for (const root of targets) {
      const button = closeButton(root);
      if (!button || seen.has(button)) continue;
      seen.add(button);
      button.click();
    }
  }
  return open.length;
}

function recipientAcceptedInPage(expected) {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  const needle = String(expected || "").trim().toLowerCase();
  if (!needle) return false;
  const subjects = [...document.querySelectorAll('input[name="subjectbox"]')].filter(isVisible);
  const roots = [];
  for (const subject of subjects) {
    let node = subject;
    let root = subject.parentElement || subject;
    while (node && node !== document.body) {
      const role = (node.getAttribute && node.getAttribute("role")) || "";
      const label = ((node.getAttribute && node.getAttribute("aria-label")) || "").toLowerCase();
      if (role === "dialog" || label.includes("new message")) root = node;
      node = node.parentElement;
    }
    if (!roots.includes(root)) roots.push(root);
  }
  return roots.some((root) => {
    if ((root.innerText || "").toLowerCase().includes(needle)) return true;
    if ([...root.querySelectorAll("input, textarea")].some((field) => String(field.value || "").toLowerCase().includes(needle))) return true;
    return [...root.querySelectorAll("[email], [data-hovercard-id], [data-name]")].some((node) => {
      const blob = `${node.getAttribute("email") || ""} ${node.getAttribute("data-hovercard-id") || ""} ${node.getAttribute("data-name") || ""}`.toLowerCase();
      return blob.includes(needle);
    });
  });
}

function closeEmptyComposeWindows(expected) {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function hasRecipient(root, needle) {
    if ((root.innerText || "").toLowerCase().includes(needle)) return true;
    return [...root.querySelectorAll("[email], [data-hovercard-id]")].some((node) => {
      const blob = `${node.getAttribute("email") || ""} ${node.getAttribute("data-hovercard-id") || ""}`.toLowerCase();
      return blob.includes(needle);
    });
  }

  function closeButton(root) {
    let host = root;
    let current = root;
    while (current && current !== document.body) {
      const role = (current.getAttribute && current.getAttribute("role")) || "";
      const label = ((current.getAttribute && current.getAttribute("aria-label")) || "").toLowerCase();
      if (role === "dialog" || label.includes("new message")) host = current;
      current = current.parentElement;
    }
    return host.querySelector('[aria-label="Save & close"], [data-tooltip="Save & close"], [aria-label*="Discard draft"], [data-tooltip*="Discard draft"]');
  }

  const needle = String(expected || "").trim().toLowerCase();
  const nodes = [...document.querySelectorAll('div[role="dialog"], div[role="region"]')];
  const matched = nodes.filter((node) => isVisible(node) && node.querySelector('input[name="subjectbox"]'));
  const open = matched.filter((node) => !matched.some((other) => other !== node && node.contains(other)));
  if (open.length <= 1 || !needle) return open.length;
  const filled = open.filter((root) => hasRecipient(root, needle));
  if (!filled.length) return open.length;
  for (const root of open) {
    if (filled.includes(root)) continue;
    const button = closeButton(root);
    if (button) button.click();
  }
  return open.length;
}

function inboxUrlOf(url, index, compose) {
  const accountIndex = Number(index) || 0;
  const text = String(url || "");
  if (/[?&]mailcarrier=/i.test(text)) return false;
  const inbox = gmailAccountIndex(text) === accountIndex && /mail\.google\.com\/mail/i.test(text);
  if (!inbox) return false;
  if (compose && !/compose=new/i.test(text)) return false;
  return true;
}

function inboxNavigationPlan(url, index, navigations) {
  if (inboxUrlOf(url, index, false)) return "ready";
  if (Number(navigations) >= 2) return "wait";
  return "navigate";
}

function blankPageUrl(url) {
  const text = String(url || "").trim();
  return !text || text === "about:blank" || /^chrome:\/\/newtab/i.test(text) || /^chrome:\/\/new-tab-page/i.test(text);
}

function pageTargetId(page) {
  try {
    return targetIdOf(page && page.target && page.target()) || "";
  } catch (error) {
    return "";
  }
}

async function closeExtraGmailPages(browser, keep) {
  if (!browser || browser.preservePage || !keep) return;
  const keepId = pageTargetId(keep);
  const pages = await browserPages(browser);
  for (const candidate of pages) {
    if (!candidate || candidate === keep) continue;
    const id = pageTargetId(candidate);
    if (keepId && id && id === keepId) continue;
    if (!/mail\.google\.com\/mail/i.test(pageUrl(candidate))) continue;
    if (typeof candidate.close !== "function") continue;
    await candidate.close({ runBeforeUnload: false }).catch(() => {});
  }
}

async function goToInbox(page, index, timeout, options = {}) {
  const accountIndex = Number(index) || 0;
  const compose = Boolean(options.compose);
  const target = `https://mail.google.com/mail/u/${accountIndex}/#inbox${compose ? "?compose=new" : ""}`;
  const started = Date.now();
  const limit = Math.max(5000, Number(timeout) || 90000);
  const onDialog = (dialog) => {
    dialog.accept().catch(() => {});
  };
  page.on("dialog", onDialog);
  let navigations = 0;
  try {
    while (Date.now() - started < limit) {
      let current = "";
      try {
        current = String(page.url() || "");
      } catch (error) {
        current = "";
      }
      if (isLoginUrl(current) && Date.now() - started > 12000) {
        throw fatal("Gmail is not signed in. Sign in inside this browser, then press Resume.");
      }
      // Gmail removes compose=new as soon as the compose window opens. Loading it
      // again opens another tab, so the inbox itself is enough after two tries.
      const plan = inboxNavigationPlan(current, accountIndex, navigations);
      if (plan === "ready") return;
      if (plan === "navigate") {
        navigations += 1;
        const remaining = Math.max(1000, limit - (Date.now() - started));
        try {
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: Math.min(20000, remaining) });
        } catch (error) {
          try {
            current = String(page.url() || "");
          } catch (readError) {
            current = "";
          }
          if (inboxNavigationPlan(current, accountIndex, navigations) === "ready") return;
        }
      }
      await delay(400);
    }
    let finalUrl = "";
    try {
      finalUrl = String(page.url() || "");
    } catch (error) {
      finalUrl = "";
    }
    if (isLoginUrl(finalUrl)) {
      throw fatal("Gmail is not signed in. Sign in inside this browser, then press Resume.");
    }
    throw new Error("Gmail inbox did not open.");
  } finally {
    page.off("dialog", onDialog);
  }
}

function pageUrl(page) {
  try {
    return String(page.url() || "");
  } catch (error) {
    return "";
  }
}

async function browserPages(browser) {
  const pages = [];
  const seen = new Set();
  const add = (page) => {
    if (!page) return;
    let id = "";
    try {
      id = targetIdOf(page.target && page.target()) || "";
    } catch (error) {
      id = "";
    }
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    pages.push(page);
  };
  const collect = async (getter) => {
    if (typeof getter !== "function") return;
    try {
      for (const page of await getter()) add(page);
    } catch (error) {}
  };
  if (browser && typeof browser.pages === "function") await collect(() => browser.pages());
  if (browser && typeof browser.browserContexts === "function") {
    for (const context of browser.browserContexts() || []) {
      if (context && typeof context.pages === "function") await collect(() => context.pages());
    }
  }
  return pages;
}

function pickSignedInContext(browser, pages) {
  const gmail = (pages || []).find((page) => pageUrl(page).includes("mail.google.com/mail"));
  const web = gmail || (pages || []).find((page) => /^https?:/i.test(pageUrl(page)) && !isLoginUrl(pageUrl(page)));
  if (web && typeof web.browserContext === "function") {
    const context = web.browserContext();
    if (context) return context;
  }
  if (browser && typeof browser.browserContexts === "function") {
    const contexts = browser.browserContexts() || [];
    if (contexts.length > 1) return contexts[contexts.length - 1];
  }
  return null;
}

async function openGmailPage(browser, gmailIndex, navigateToInbox, options = {}) {
  const pages = await browserPages(browser);
  let exact = null;
  let anyGmail = null;
  for (const candidate of pages) {
    const url = pageUrl(candidate);
    if (!url.includes("mail.google.com/mail")) continue;
    if (!anyGmail) anyGmail = candidate;
    if (gmailAccountIndex(url) === Number(gmailIndex)) {
      exact = candidate;
      break;
    }
  }

  let blank = null;
  if (!exact && !anyGmail) {
    blank = pages.find((candidate) => blankPageUrl(pageUrl(candidate))) || null;
  }
  let page = exact || anyGmail || blank;
  let created = false;
  if (!page) {
    const context = browser.preservePage ? null : pickSignedInContext(browser, pages);
    if (context && typeof context.newPage === "function") page = await context.newPage();
    else page = await browser.newPage();
    created = !browser.preservePage;
  }
  const index = Number(gmailIndex) || 0;
  try {
    if (!options.skipInbox && (navigateToInbox || !pageUrl(page).includes("mail.google.com/mail"))) {
      await goToInbox(page, index, options.timeout || 90000, { compose: options.compose === true });
    }
  } finally {
    await closeExtraGmailPages(browser, page);
  }
  if (options.focus !== false) await page.bringToFront().catch(() => {});
  return { page, created };
}

function signedInEmailInPage() {
  const labels = [...document.querySelectorAll("[aria-label]")]
    .map((node) => node.getAttribute("aria-label") || "");
  const account = labels.find((label) => /google account/i.test(label) && /@/.test(label));
  const source = account || document.title || "";
  const match = String(source).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : "";
}

async function accountDirectoryInPage() {
  const labels = [...document.querySelectorAll("[aria-label]")]
    .map((node) => node.getAttribute("aria-label") || "")
    .filter((label) => /google account/i.test(label));
  const payloads = [];
  const urls = [
    "https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&mo=1&mn=1&json=standard",
    "https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&json=standard",
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, { credentials: "include", cache: "no-store" });
      if (!response.ok) continue;
      payloads.push((await response.text()).replace(/^\)\]\}'\n?/, ""));
    } catch (error) {}
  }
  return { payloads, labels };
}

function collectMailboxHintsInPage() {
  const hints = [];
  document.querySelectorAll("a[href], [data-email], [data-identifier], [data-authuser]").forEach((node) => {
    const href = node.getAttribute("href") || "";
    const email = node.getAttribute("data-email") || node.getAttribute("data-identifier") || "";
    const authuser = node.getAttribute("data-authuser") || "";
    const label = node.getAttribute("aria-label") || "";
    const accountLink = email || authuser || /google account/i.test(label)
      || /accounts\.google\.com|AccountChooser|SignOutOptions|authuser=/i.test(href);
    if (!accountLink) return;
    hints.push({ href, email, authuser, label });
  });
  return hints;
}

async function openProbePage(browser) {
  const pages = await browserPages(browser);
  if (browser.preservePage) {
    return { page: pages[0] || await browser.newPage(), created: false };
  }
  const openGmail = pages.find((page) => {
    const url = pageUrl(page);
    return /mail\.google\.com\/mail/i.test(url) && !isLoginUrl(url);
  });
  if (openGmail) return { page: openGmail, created: false };
  const context = pickSignedInContext(browser, pages);
  try {
    if (context && typeof context.newPage === "function") {
      return { page: await context.newPage(), created: true };
    }
  } catch (error) {}
  return { page: await browser.newPage(), created: true };
}

async function readMailboxAtIndex(page, index) {
  const target = `https://mail.google.com/mail/u/${index}/#inbox`;
  const started = Date.now();
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 8000 });
  } catch (error) {}
  let mismatchSince = 0;
  while (Date.now() - started < 8000) {
    const url = pageUrl(page);
    if (isLoginUrl(url)) {
      if (Date.now() - started > 2500) return { ok: false, signedOut: true };
    } else {
      const landed = gmailAccountIndex(url);
      if (landed === index) {
        mismatchSince = 0;
        const fromPage = await page.evaluate(signedInEmailInPage).catch(() => "");
        if (fromPage) return { ok: true, email: fromPage };
        const fromFeed = await readOpenMailbox(page, index);
        if (fromFeed) return { ok: true, email: fromFeed };
      } else if (landed !== null) {
        if (!mismatchSince) mismatchSince = Date.now();
        else if (Date.now() - mismatchSince > 1200) return { ok: false };
      } else {
        mismatchSince = 0;
      }
    }
    await delay(300);
  }
  return { ok: false };
}

async function probeAllInPage(limit) {
  function cutHead(xml) {
    return String(xml || "").split(/<entry[\s>]/i)[0].slice(0, 8000);
  }

  async function probe(index) {
    try {
      const response = await fetch(`https://mail.google.com/mail/u/${index}/feed/atom`, {
        credentials: "include",
        cache: "no-store",
      });
      const finalUrl = String(response.url || "");
      const finalIndex = (finalUrl.match(/\/mail\/u\/(\d+)/) || [])[1];
      if (finalIndex !== undefined && Number(finalIndex) !== index) return { index, redirected: true };
      if (!response.ok) return { index, missing: true };
      const xml = await response.text();
      if (!xml.includes("<feed")) return { index, missing: true };
      return { index, head: cutHead(xml) };
    } catch (error) {
      return { index, missing: true };
    }
  }

  const count = Math.max(1, Math.min(40, Number(limit) || 30));
  const urls = [
    "https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&mo=1&mn=1&json=standard",
    "https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&listPages=0&json=standard&mo=1",
    "https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&json=standard",
  ];
  const directory = Promise.all(urls.map(async (url) => {
    try {
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) return "";
      return await response.text();
    } catch (error) {
      return "";
    }
  }));
  const feeds = [];
  const batchSize = 6;
  const maxGap = 3;
  let consecutiveMisses = 0;
  let confirmingGap = false;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    const rows = await Promise.all(Array.from({ length: end - start }, (_, offset) => probe(start + offset)));
    for (const row of rows) {
      feeds.push(row);
      const signedIn = row && row.head && !row.missing && !row.redirected;
      consecutiveMisses = signedIn ? 0 : consecutiveMisses + 1;
    }
    if (consecutiveMisses < maxGap) {
      confirmingGap = false;
      continue;
    }
    if (confirmingGap) break;
    confirmingGap = true;
  }
  const payloads = (await directory).filter(Boolean);

  const labels = [...document.querySelectorAll("[aria-label]")]
    .map((node) => node.getAttribute("aria-label") || "")
    .filter((label) => /google account/i.test(label));
  return { feeds, payloads, labels };
}

async function focusGmailInbox(debugPort, targetId, options = {}) {
  const index = Number(options.gmailIndex) || 0;
  return withBrowser(debugPort, async (browser) => {
    await openGmailPage(browser, index, true, {
      timeout: 90000,
      focus: options.focus === true,
      compose: options.compose === true,
    });
  }, { targetId: targetId || "", browserWSEndpoint: options.browserWSEndpoint || "" });
}

async function mailboxHintsFromPage(page) {
  const hints = [];
  const frames = typeof page.frames === "function" ? page.frames() : [];
  const targets = frames.length ? frames : [page];
  for (const frame of targets) {
    try {
      const batch = await frame.evaluate(collectMailboxHintsInPage);
      if (Array.isArray(batch)) hints.push(...batch);
    } catch (error) {}
  }
  return hints;
}

async function readSwitcherAccounts(page) {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("[aria-label]")]
      .find((node) => /google account/i.test(node.getAttribute("aria-label") || ""));
    if (button) button.click();
  }).catch(() => {});
  let hints = [];
  let lastCount = -1;
  let stable = 0;
  const started = Date.now();
  while (Date.now() - started < 4000) {
    hints = await mailboxHintsFromPage(page);
    const count = mailboxesFromHints(hints).length;
    if (count > 0 && count === lastCount) {
      stable += 1;
      if (stable >= 2) break;
    } else {
      stable = 0;
    }
    lastCount = count;
    await delay(300);
  }
  await page.keyboard.press("Escape").catch(() => {});
  return mailboxesFromHints(hints);
}

async function readListAccountPayloads(page) {
  const payloads = [];
  try {
    const text = await page.evaluate(() => (document.body && (document.body.innerText || document.body.textContent)) || "");
    if (text && text.includes("@")) payloads.push(text);
  } catch (error) {}
  try {
    const fetched = await page.evaluate(async () => {
      const urls = [
        "https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&mo=1&mn=1&json=standard",
        "https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&listPages=0&json=standard&mo=1",
        "https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&json=standard",
      ];
      const found = [];
      for (const url of urls) {
        try {
          const response = await fetch(url, { credentials: "include", cache: "no-store" });
          if (!response.ok) continue;
          found.push(await response.text());
        } catch (error) {}
      }
      return found;
    });
    if (Array.isArray(fetched)) payloads.push(...fetched);
  } catch (error) {}
  return payloads;
}

async function readChooserMailboxes(page) {
  const urls = [
    "https://accounts.google.com/SignOutOptions?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&hl=en",
    "https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&hl=en",
  ];
  const hints = [];
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForSelector("[data-email], [data-identifier], a[href*='Email='], a[href*='authuser=']", { timeout: 5000 }).catch(() => {});
      hints.push(...await mailboxHintsFromPage(page));
    } catch (error) {}
    if (mailboxesFromHints(hints).length > 1) break;
  }
  return mailboxesFromHints(hints);
}

async function mailboxesFromOpenPages(browser) {
  const pages = await browserPages(browser);
  const found = [];
  for (const openPage of pages) {
    const url = pageUrl(openPage);
    const index = gmailAccountIndex(url);
    if (index === null || !/mail\.google\.com\/mail/i.test(url)) continue;
    let title = "";
    try {
      title = await openPage.title();
    } catch (error) {
      title = "";
    }
    const email = emailFromText(title);
    if (!email) continue;
    found.push({ index, email });
  }
  return found;
}

async function classifyMailbox(page, index) {
  const accountIndex = Number(index) || 0;
  return page.evaluate(async (wantedIndex) => {
    try {
      const response = await fetch(`https://mail.google.com/mail/u/${wantedIndex}/feed/atom`, {
        credentials: "include",
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      });
      const finalUrl = String(response.url || "");
      const finalIndex = (finalUrl.match(/\/mail\/u\/(\d+)/) || [])[1];
      if (finalIndex !== undefined && Number(finalIndex) !== Number(wantedIndex)) return { signedOut: true };
      const xml = await response.text();
      if (!response.ok || !String(xml || "").includes("<feed")) return { signedOut: true };
      const head = String(xml).split(/<entry[\s>]/i)[0];
      const emailMatch = head.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      return emailMatch ? { email: emailMatch[0] } : { signedOut: true };
    } catch (error) {
      return { unknown: true };
    }
  }, accountIndex);
}

async function fillMailboxIndexes(page, accounts, limit) {
  const found = mergeMailboxAccounts(withKnownIndex(accounts), []);
  const deadline = Date.now() + 45000;
  const seen = () => new Set(found.map((account) => String(account.email || "").toLowerCase()));
  let complete = false;
  let misses = 0;
  let sawLogin = false;
  const maxGap = 6;
  for (let index = 0; index < limit; index += 1) {
    if (Date.now() > deadline) break;
    if (found.some((account) => account.index === index)) {
      misses = 0;
      continue;
    }
    const classified = await classifyMailbox(page, index);
    const quick = String(classified && classified.email || "").trim();
    if (quick && !seen().has(quick.toLowerCase())) {
      found.push({ index, email: quick });
      misses = 0;
      continue;
    }
    if (classified && classified.signedOut) {
      misses += 1;
      if (misses >= maxGap) {
        complete = true;
        break;
      }
      continue;
    }
    const walked = await readMailboxAtIndex(page, index);
    if (walked.signedOut || walked.needsLogin) sawLogin = true;
    const email = String(walked.email || "").trim();
    if (!walked.ok || !email || seen().has(email.toLowerCase())) {
      misses += 1;
      if (misses >= maxGap) {
        complete = true;
        break;
      }
      continue;
    }
    misses = 0;
    found.push({ index, email });
  }
  if (found.length >= limit) complete = true;
  if (!found.length && sawLogin) return { needsLogin: true, accounts: [], complete: true };
  return { needsLogin: false, accounts: mergeMailboxAccounts(found, []), complete };
}

async function detectGmailAccounts(debugPort, options = {}) {
  return withBrowser(debugPort, async (browser) => {
    const fromPages = await mailboxesFromOpenPages(browser);
    const probe = await openProbePage(browser);
    const page = probe.page;
    const home = pageUrl(page);
    try {
      if (!/mail\.google\.com\/mail/i.test(pageUrl(page))) {
        await page.goto("https://mail.google.com/mail/u/0/feed/atom", { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
      }
      const openedOnLogin = isLoginUrl(pageUrl(page));
      let probed = null;
      try {
        probed = await page.evaluate(probeAllInPage, MAILBOX_PROBE_LIMIT);
      } catch (error) {}
      const payloads = [];
      let labels = [];
      if (probed && Array.isArray(probed.payloads)) payloads.push(...probed.payloads);
      if (probed && Array.isArray(probed.labels)) labels = probed.labels.slice();
      const earlyRows = listRowsFromPayloads(payloads);
      const signedIn = signedInMailboxes(probed && probed.feeds, fromPages);
      if (feedProbeSettled(probed && probed.feeds) && signedIn.length) {
        return {
          accounts: attachAccountNames(signedIn, earlyRows, labels),
          needsLogin: false,
        };
      }
      if (!payloads.length) {
        try {
          const raw = await page.evaluate(accountDirectoryInPage);
          if (raw && Array.isArray(raw.payloads)) payloads.push(...raw.payloads);
          if (raw && Array.isArray(raw.labels)) labels.push(...raw.labels);
        } catch (error) {}
      }
      const listRows = listRowsFromPayloads(payloads);
      const filled = await fillMailboxIndexes(page, signedIn, MAILBOX_PROBE_LIMIT);
      let found = filled.accounts;
      if (!found.length && (filled.needsLogin || openedOnLogin || isLoginUrl(pageUrl(page)))) return { accounts: [], needsLogin: true };
      return {
        accounts: attachAccountNames(found, listRows, labels),
        needsLogin: false,
      };
    } finally {
      if (!probe.created && home && pageUrl(page) !== home) {
        await page.goto(home, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
      }
      if (probe.created) await page.close().catch(() => {});
    }
  }, { targetId: options.targetId || "", browserWSEndpoint: options.browserWSEndpoint || "" });
}

async function dismissGmailChrome(page) {
  const overlay = await page.evaluate(() => {
    document.querySelectorAll('div[role="button"][aria-label*="Discard draft"]').forEach((button) => {
      button.click();
    });
    document.querySelectorAll('div[role="alertdialog"] button, div[role="alertdialog"] [role="button"]').forEach((button) => {
      const text = (button.innerText || button.getAttribute("aria-label") || "").trim().toLowerCase();
      if (text === "ok" || button.getAttribute("data-mdc-dialog-action") === "ok") button.click();
    });
    document.querySelectorAll('[aria-modal="true"] [aria-label="Close"], [role="dialog"] [aria-label="Close"]').forEach((button) => {
      button.click();
    });
    const frame = [...document.querySelectorAll("iframe")].find((item) => {
      const src = item.getAttribute("src") || "";
      if (!/accounts\.google\.com|AccountChooser/i.test(src)) return false;
      const rect = item.getBoundingClientRect();
      return rect.width > 80 && rect.height > 80;
    });
    const dialog = document.querySelector('[aria-modal="true"], div[role="dialog"], div[role="alertdialog"]');
    return Boolean(frame || dialog);
  });
  if (overlay) await page.keyboard.press("Escape").catch(() => {});
  await delay(300);
}

function recipientFieldReady() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }
  const regions = [...document.querySelectorAll('div[role="region"], div[role="dialog"]')].filter(isVisible);
  const subject = [...document.querySelectorAll('input[name="subjectbox"]')].find(isVisible);
  const region = regions.find((item) => isVisible(item.querySelector('input[name="subjectbox"]')))
    || (subject && (subject.closest('[role="dialog"], [role="region"], form') || document.body));
  if (!region) return false;
  const field = region.querySelector('input[aria-label="To recipients"]')
    || region.querySelector('input[aria-label="To"]')
    || region.querySelector('textarea[name="to"]')
    || region.querySelector('input[name="to"]')
    || region.querySelector("input[peoplekit-id]")
    || region.querySelector('[role="combobox"] input');
  return isVisible(field);
}

async function focusRecipient(page) {
  const point = await page.evaluate(() => {
    function isVisible(node) {
      if (!node || node.nodeType !== 1) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return false;
      const style = window.getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    }
    const regions = [...document.querySelectorAll('div[role="region"], div[role="dialog"]')].filter(isVisible);
    const subject = [...document.querySelectorAll('input[name="subjectbox"]')].find(isVisible);
    const region = regions.find((item) => isVisible(item.querySelector('input[name="subjectbox"]')))
      || (subject && (subject.closest('[role="dialog"], [role="region"], form') || document.body));
    const field = region && (
      region.querySelector('input[aria-label="To recipients"]')
      || region.querySelector('input[aria-label="To"]')
      || region.querySelector('textarea[name="to"]')
      || region.querySelector('input[name="to"]')
      || region.querySelector("input[peoplekit-id]")
      || region.querySelector('[role="combobox"] input')
    );
    if (!field || !isVisible(field)) return null;
    field.scrollIntoView({ block: "center", inline: "nearest" });
    field.focus();
    field.click();
    const rect = field.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  if (!point) return false;
  await cdpClick(page, point.x, point.y);
  return true;
}

function focusInspectedFieldInPage(kind) {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }
  const subjectField = [...document.querySelectorAll('input[name="subjectbox"]')].find(isVisible);
  const toField = [...document.querySelectorAll('input[aria-label="To recipients"]')].find(isVisible)
    || [...document.querySelectorAll('input[peoplekit-id][role="combobox"]')].find(isVisible);
  const bodyField = [...document.querySelectorAll('div[aria-label="Message Body"][contenteditable="true"]')].find(isVisible)
    || [...document.querySelectorAll('div[g_editable="true"][role="textbox"]')].find(isVisible);
  const field = kind === "to" ? toField : kind === "subject" ? subjectField : bodyField;
  if (!field || !isVisible(field)) return false;
  field.focus();
  try {
    if (typeof field.select === "function") field.select();
    else if (window.getSelection && document.createRange) {
      const range = document.createRange();
      range.selectNodeContents(field);
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  } catch (error) {}
  return true;
}

function readInspectedComposeInPage(email, subjectText, needle) {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }
  const subjectFields = [...document.querySelectorAll('input[name="subjectbox"]')];
  const subjectField = subjectFields.find(isVisible)
    || subjectFields.find((field) => String(field.value || "").trim())
    || subjectFields[0];
  if (!subjectField) return { to: false, subject: false, body: false };
  function hasComposeParts(node) {
    if (!node || typeof node.querySelector !== "function") return false;
    const hasBody = node.querySelector('div[aria-label="Message Body"], div[g_editable="true"][role="textbox"]');
    const hasTo = node.querySelector('input[aria-label="To recipients"], input[aria-label="To"], input[peoplekit-id], textarea[name="to"], input[name="to"]');
    const hasSend = node.querySelector('[aria-label="Send"], [data-tooltip="Send"], [aria-label^="Send "]');
    return Boolean(hasBody || hasTo || hasSend);
  }
  let root = subjectField.parentElement || subjectField;
  let current = subjectField.parentElement;
  while (current && current !== document.body) {
    if (hasComposeParts(current)) {
      root = current;
      break;
    }
    current = current.parentElement;
  }
  const scope = root && root !== subjectField && typeof root.querySelectorAll === "function" ? [root] : [document];
  function nodes(selector) {
    const found = [];
    scope.forEach((item) => {
      if (item && typeof item.querySelectorAll === "function") found.push(...item.querySelectorAll(selector));
    });
    return found;
  }
  const needleEmail = String(email || "").trim().toLowerCase();
  const chip = nodes("[email], [data-hovercard-id], [data-name], [peoplekit-id]").some((node) => {
    const blob = `${node.textContent || ""} ${node.getAttribute("email") || ""} ${node.getAttribute("data-hovercard-id") || ""} ${node.getAttribute("data-name") || ""}`.toLowerCase();
    return needleEmail && blob.includes(needleEmail);
  });
  const toValue = nodes('input[aria-label="To recipients"], input[aria-label="To"], input[peoplekit-id], textarea[name="to"], input[name="to"]').some((field) => {
    return String(field.value || "").toLowerCase().includes(needleEmail);
  });
  const composeText = String((root && root !== subjectField && (root.innerText || root.textContent)) || "").replace(/\s+/g, " ").toLowerCase();
  const textHasEmail = Boolean(needleEmail && composeText.includes(needleEmail));
  const subjectOk = String(subjectField.value || "").replace(/\s+/g, " ").trim() === String(subjectText || "").replace(/\s+/g, " ").trim();
  const bodies = nodes('div[aria-label="Message Body"], div[g_editable="true"][role="textbox"], div[role="textbox"]');
  const bodyField = bodies.find(isVisible) || bodies[0];
  const visible = String((bodyField && (bodyField.innerText || bodyField.textContent)) || "").replace(/\s+/g, " ").trim();
  const wantedBody = String(needle || "").replace(/\s+/g, " ").trim();
  return {
    to: Boolean(needleEmail && (chip || toValue || textHasEmail)),
    toField: Boolean(needleEmail && toValue && !chip && !textHasEmail),
    subject: Boolean(subjectOk),
    body: !wantedBody || visible.includes(wantedBody) || composeText.includes(wantedBody),
  };
}

function writeInspectedComposeInPage(email, subjectText, plain) {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }
  const subjectField = [...document.querySelectorAll('input[name="subjectbox"]')].find(isVisible);
  const toField = [...document.querySelectorAll('input[aria-label="To recipients"]')].find(isVisible)
    || [...document.querySelectorAll('input[peoplekit-id][role="combobox"]')].find(isVisible);
  const bodyField = [...document.querySelectorAll('div[aria-label="Message Body"][contenteditable="true"]')].find(isVisible)
    || [...document.querySelectorAll('div[g_editable="true"][role="textbox"]')].find(isVisible);
  if (!subjectField && !toField && !bodyField) return { ok: false, error: "Subject field not found." };

  function setInputValue(field, value) {
    const prototype = Object.getPrototypeOf(field);
    const inputPrototype = window.HTMLInputElement && window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
      || (inputPrototype && Object.getOwnPropertyDescriptor(inputPrototype, "value"));
    if (descriptor && descriptor.set) descriptor.set.call(field, value);
    else field.value = value;
    try {
      field.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value,
      }));
    } catch (error) {
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  if (toField) {
    toField.focus();
    setInputValue(toField, String(email || ""));
  }
  if (subjectField) {
    subjectField.focus();
    setInputValue(subjectField, String(subjectText || ""));
  }
  if (bodyField) {
    bodyField.focus();
    const lines = String(plain || "").split("\n");
    if (typeof bodyField.replaceChildren === "function") bodyField.replaceChildren();
    else bodyField.textContent = "";
    lines.forEach((line, index) => {
      if (index > 0) bodyField.appendChild(document.createElement("br"));
      if (line) bodyField.appendChild(document.createTextNode(line));
    });
    try {
      bodyField.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: String(plain || ""),
      }));
    } catch (error) {
      bodyField.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  const needleEmail = String(email || "").trim().toLowerCase();
  const sample = String(plain || "").replace(/\s+/g, " ").trim().slice(0, 24);
  const bodyText = String((bodyField && bodyField.innerText) || "").replace(/\s+/g, " ").trim();
  const toOk = Boolean(toField && needleEmail && String(toField.value || "").toLowerCase().includes(needleEmail));
  const subjectOk = Boolean(subjectField && String(subjectField.value || "").trim() === String(subjectText || "").trim());
  const bodyOk = Boolean(bodyField && (!sample || bodyText.includes(sample)));
  return {
    ok: toOk && subjectOk && bodyOk,
    to: toOk,
    subject: subjectOk,
    body: bodyOk,
    error: subjectField ? "" : "Subject field not found.",
  };
}

async function insertIntoInspectedField(page, kind, text) {
  const session = await enableCdpInput(page);
  if (!session) return false;
  const focused = await page.evaluate(focusInspectedFieldInPage, kind);
  if (!focused) return false;
  try {
    await session.send("Input.insertText", { text: String(text || "") });
    return true;
  } catch (error) {
    return false;
  }
}

async function pressEnterKey(page) {
  const session = await enableCdpInput(page);
  if (!session) return false;
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  try {
    await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
    await session.send("Input.dispatchKeyEvent", { type: "char", ...key, text: "\r" });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    return true;
  } catch (error) {
    return false;
  }
}

async function composeFieldsReady(page, email, subject, plain) {
  const sample = String(plain || "").replace(/\s+/g, " ").trim().slice(0, 24);
  const state = await page.evaluate(readInspectedComposeInPage, email, subject, sample).catch(() => null);
  return Boolean(state && state.to && state.subject && state.body);
}

async function fillChromeCompose(page, email, subject, plain, onTyped, isStopped) {
  const announce = () => {
    if (typeof onTyped === "function") onTyped("Typed in the compose window: address, subject, and message.");
  };
  const sample = String(plain || "").replace(/\s+/g, " ").trim().slice(0, 24);
  const read = () => page.evaluate(readInspectedComposeInPage, email, subject, sample).catch(() => null);
  const ready = (state) => Boolean(state && state.to && state.subject && state.body);
  let committed = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    checkStop(isStopped);
    await expandCollapsedCompose(page).catch(() => {});
    let state = await read();
    if (ready(state) && (committed || !state.toField)) {
      announce();
      return true;
    }
    await enableCdpInput(page);
    if (!state || !state.subject || !state.body || !state.to) {
      await page.evaluate(writeInspectedComposeInPage, email, subject, plain).catch(() => null);
      state = await read();
    }
    if (!state || !state.to) await insertIntoInspectedField(page, "to", email);
    if (!committed) {
      const focusedTo = await page.evaluate(focusInspectedFieldInPage, "to").catch(() => false);
      if (focusedTo) {
        await pressEnterKey(page);
        committed = true;
      } else if (state && state.to && !state.toField) {
        committed = true;
      }
    }
    state = await read();
    if (!state || !state.subject) await insertIntoInspectedField(page, "subject", subject);
    if (!state || !state.body) await insertIntoInspectedField(page, "body", plain);
    await delay(700);
  }
  const state = await read();
  if (ready(state)) {
    announce();
    return true;
  }
  return false;
}

async function fillRecipient(page, email) {
  await landInput(page);
  await expandCollapsedCompose(page);
  try {
    await page.waitForFunction(recipientFieldReady, { timeout: 20000 });
  } catch (error) {
    throw new Error("The compose window did not open for this Gmail.");
  }

  const focused = await focusRecipient(page);
  if (!focused) throw new Error("Recipient field not found. Set Gmail's display language to English.");

  await enableCdpInput(page);
  await page.keyboard.type(email, { delay: 15 });
  await delay(250);
  await page.keyboard.press("Enter");
  await delay(400);

  const accepted = () => page.evaluate(recipientAcceptedInPage, email);
  if (await accepted()) return;

  await page.keyboard.press("Enter");
  await delay(400);
  if (await accepted()) return;

  await page.evaluate((expected) => {
    function isVisible(node) {
      if (!node || node.nodeType !== 1) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return false;
      const style = window.getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    }
    const regions = [...document.querySelectorAll('div[role="region"], div[role="dialog"]')].filter(isVisible);
    const region = regions.find((item) => isVisible(item.querySelector('input[name="subjectbox"]')));
    const field = region && (
      region.querySelector('input[aria-label="To recipients"]')
      || region.querySelector('input[aria-label="To"]')
      || region.querySelector('textarea[name="to"]')
      || region.querySelector('input[name="to"]')
      || region.querySelector("input[peoplekit-id]")
      || region.querySelector('[role="combobox"] input')
    );
    if (!field) return;
    field.focus();
    field.value = expected;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }, email);
  await page.keyboard.press("Enter");
  await delay(400);
  if (!(await accepted())) throw new Error("Gmail did not accept the recipient.");
}

function plainFromHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

async function fillSubjectAndBody(page, subject, bodyHtml, bodyText) {
  await landInput(page);
  const sample = String(bodyText || plainFromHtml(bodyHtml)).replace(/\s+/g, " ").trim().slice(0, 24);
  const result = await page.evaluate((subjectText, html, plain, needle) => {
    function isVisible(node) {
      if (!node || node.nodeType !== 1) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return false;
      const style = window.getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    }
    const regions = [...document.querySelectorAll('div[role="region"], div[role="dialog"]')].filter(isVisible);
    const subjectNode = [...document.querySelectorAll('input[name="subjectbox"]')].find(isVisible);
    const region = regions.find((item) => isVisible(item.querySelector('input[name="subjectbox"]')))
      || (subjectNode && (subjectNode.closest('[role="dialog"], [role="region"], form') || document.body));
    if (!region) return { ok: false, error: "Compose window not found." };
    const subjectField = region.querySelector('input[name="subjectbox"]');
    if (!subjectField) return { ok: false, error: "Subject field not found." };
    subjectField.focus();
    subjectField.value = subjectText;
    subjectField.dispatchEvent(new Event("input", { bubbles: true }));

    const boxes = Array.from(region.querySelectorAll('div[role="textbox"]'));
    const bodyField = region.querySelector('div[role="textbox"][aria-label="Message Body"]')
      || region.querySelector('div[role="textbox"][g_editable="true"]')
      || boxes[boxes.length - 1];
    if (!bodyField) {
      return { ok: false, error: "Message body not found. Set Gmail's display language to English." };
    }

    function trusted(value) {
      try {
        if (!window.trustedTypes) return String(value);
        if (!window.__mailCarrierPolicy) {
          window.__mailCarrierPolicy = trustedTypes.createPolicy("mailCarrierHtml", {
            createHTML: (input) => String(input),
          });
        }
        return window.__mailCarrierPolicy.createHTML(String(value));
      } catch (error) {
        return null;
      }
    }

    bodyField.focus();
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, String(plain || ""));
    } catch (error) {
      inserted = false;
    }
    if (!inserted) {
      const htmlValue = trusted(html);
      if (htmlValue != null) {
        const wrap = document.createElement("div");
        wrap.innerHTML = htmlValue;
        bodyField.insertBefore(wrap, bodyField.firstChild);
      } else {
        const lines = String(plain || "").split("\n");
        const fragment = document.createDocumentFragment();
        lines.forEach((line, index) => {
          if (index > 0) fragment.appendChild(document.createElement("br"));
          if (line) fragment.appendChild(document.createTextNode(line));
        });
        bodyField.insertBefore(fragment, bodyField.firstChild);
      }
    }
    try {
      bodyField.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(plain || "") }));
    } catch (error) {
      bodyField.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const visible = (bodyField.innerText || "").replace(/\s+/g, " ");
    if (needle && !visible.includes(needle)) {
      return { ok: false, error: "Gmail did not keep the message body." };
    }
    return { ok: true };
  }, subject, bodyHtml, bodyText, sample);
  if (!result || !result.ok) throw new Error((result && result.error) || "Gmail did not keep the message body.");
}

async function attachFile(page, cvPath) {
  const handle = await page.evaluateHandle(() => {
    function isVisible(node) {
      if (!node || node.nodeType !== 1) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return false;
      const style = window.getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    }
    const regions = [...document.querySelectorAll('div[role="region"]')].filter(isVisible);
    const region = regions.find((item) => isVisible(item.querySelector('input[name="subjectbox"]')));
    if (!region) return null;
    return region.querySelector('input[type="file"], input[name="Filedata"]');
  });
  const element = handle.asElement();
  if (!element) {
    await handle.dispose().catch(() => {});
    throw new Error("Attachment field not found.");
  }
  try {
    await element.uploadFile(cvPath);
  } finally {
    await element.dispose().catch(() => {});
  }
  const marker = path.basename(cvPath).slice(0, 40);
  await page.waitForFunction((needle) => {
    function isVisible(node) {
      if (!node || node.nodeType !== 1) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return false;
      const style = window.getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    }
    const regions = [...document.querySelectorAll('div[role="region"]')].filter(isVisible);
    const region = regions.find((item) => isVisible(item.querySelector('input[name="subjectbox"]')));
    if (!region) return false;
    const text = region.innerText || "";
    return text.includes(needle)
      || Boolean(region.querySelector('[aria-label*="Remove attachment"], [data-tooltip*="Remove attachment"]'));
  }, { timeout: 30000 }, marker);
  await page.waitForFunction(() => {
    function isVisible(node) {
      if (!node || node.nodeType !== 1) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return false;
      const style = window.getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    }
    const regions = [...document.querySelectorAll('div[role="region"]')].filter(isVisible);
    const region = regions.find((item) => isVisible(item.querySelector('input[name="subjectbox"]')));
    return Boolean(region && !region.querySelector('[role="progressbar"]'));
  }, { timeout: 60000 }).catch(() => {});
  await delay(2000);
}

async function pressSendShortcut(page) {
  await enableCdpInput(page);
  await page.keyboard.down(SEND_MODIFIER);
  try {
    await page.keyboard.press("Enter");
  } finally {
    await page.keyboard.up(SEND_MODIFIER);
  }
}

async function focusComposeBody(page) {
  const point = await page.evaluate(() => {
    function isVisible(node) {
      if (!node || node.nodeType !== 1) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return false;
      const style = window.getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    }
    const regions = [...document.querySelectorAll('div[role="region"], div[role="dialog"]')].filter(isVisible);
    const region = regions.find((item) => isVisible(item.querySelector('input[name="subjectbox"]')));
    const boxes = region
      ? Array.from(region.querySelectorAll('div[role="textbox"]'))
      : [...document.querySelectorAll('div[role="textbox"]')].filter(isVisible);
    const body = (region && region.querySelector('div[role="textbox"][aria-label="Message Body"]'))
      || (region && region.querySelector('div[role="textbox"][g_editable="true"]'))
      || boxes.find((box) => String(box.getAttribute("aria-label") || "").toLowerCase().includes("message body"))
      || boxes.find((box) => box.getAttribute("g_editable") === "true")
      || boxes[boxes.length - 1];
    if (!body || !isVisible(body)) return null;
    body.focus();
    const rect = body.getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width / 2, 40), y: rect.top + Math.min(rect.height / 2, 24) };
  });
  if (!point) return false;
  await cdpClick(page, point.x, point.y);
  return true;
}

function replyComposeOpenInPage() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }
  return [...document.querySelectorAll('div[role="textbox"]')].some((box) => {
    if (!isVisible(box)) return false;
    const label = String(box.getAttribute("aria-label") || "").toLowerCase();
    return label.includes("message body") || box.getAttribute("g_editable") === "true";
  });
}

function replySendPointInPage() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }
  function labelOf(node) {
    return `${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-tooltip") || ""} ${node.innerText || node.textContent || ""}`
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }
  function isExactSend(node) {
    if (!node || node.nodeType !== 1 || !isVisible(node)) return false;
    const label = labelOf(node);
    if (!/^send\b/.test(label)) return false;
    if (/more send|feedback|schedule/.test(label)) return false;
    const nested = typeof node.querySelectorAll === "function"
      ? [...node.querySelectorAll('[role="button"], button')]
      : [];
    if (nested.some((child) => child !== node && /send/.test(labelOf(child)))) return false;
    return true;
  }
  const bodies = [...document.querySelectorAll('div[role="textbox"]')].filter((box) => {
    if (!isVisible(box)) return false;
    const label = String(box.getAttribute("aria-label") || "").toLowerCase();
    return label.includes("message body") || box.getAttribute("g_editable") === "true";
  });
  const body = bodies[bodies.length - 1];
  if (!body) return null;
  const seen = new Set();
  const found = [];
  let node = body;
  while (node && node !== document.body) {
    const candidates = typeof node.querySelectorAll === "function"
      ? [...node.querySelectorAll('[role="button"], button, [data-tooltip="Send"], [aria-label="Send"]')]
      : [];
    for (const candidate of candidates) {
      if (seen.has(candidate) || !isExactSend(candidate)) continue;
      seen.add(candidate);
      found.push(candidate);
    }
    if (found.length) break;
    node = node.parentElement;
  }
  if (!found.length) {
    for (const candidate of document.querySelectorAll('[role="button"], button, [data-tooltip="Send"], [aria-label="Send"]')) {
      if (!seen.has(candidate) && isExactSend(candidate)) found.push(candidate);
    }
  }
  if (!found.length) return null;
  const bodyRect = body.getBoundingClientRect();
  found.sort((left, right) => {
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    const leftDistance = Math.abs(leftRect.top - bodyRect.bottom) + Math.abs(leftRect.left - bodyRect.left);
    const rightDistance = Math.abs(rightRect.top - bodyRect.bottom) + Math.abs(rightRect.left - bodyRect.left);
    return leftDistance - rightDistance;
  });
  const button = found[0];
  if (typeof button.scrollIntoView === "function") button.scrollIntoView({ block: "center", inline: "nearest" });
  const rect = button.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  };
}

async function clickSend(page, email) {
  await landInput(page);
  const point = await page.evaluate((expected) => {
    function isVisible(node) {
      if (!node || node.nodeType !== 1) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return false;
      const style = window.getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    }
    function isSend(node) {
      if (!isVisible(node)) return false;
      const label = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-tooltip") || ""} ${node.innerText || ""}`
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (!label.startsWith("send")) return false;
      if (label.includes("feedback") || label.includes("schedule") || label.includes("more send")) return false;
      return true;
    }
    const needle = String(expected || "").trim().toLowerCase();
    const subjects = [...document.querySelectorAll('input[name="subjectbox"]')].filter(isVisible);
    const roots = [];
    for (const subject of subjects) {
      let node = subject;
      let root = subject.parentElement || subject;
      while (node && node !== document.body) {
        const role = (node.getAttribute && node.getAttribute("role")) || "";
        const label = ((node.getAttribute && node.getAttribute("aria-label")) || "").toLowerCase();
        if (role === "dialog" || label.includes("new message")) root = node;
        node = node.parentElement;
      }
      if (!roots.includes(root)) roots.push(root);
    }
    roots.sort((left, right) => {
      const score = (root) => (needle && (root.innerText || "").toLowerCase().includes(needle) ? 1 : 0);
      return score(right) - score(left);
    });
    for (const root of roots) {
      const known = [...root.querySelectorAll('div.aoO[role="button"], div[role="button"].aoO, div[role="button"], button')];
      const button = known.find(isSend);
      if (!button) continue;
      button.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return null;
  }, email);
  if (point) {
    await cdpClick(page, point.x, point.y);
    await delay(2000);
    const state = await readComposeState(page);
    if (state.state !== "open") return;
    await focusComposeBody(page);
    await pressSendShortcut(page);
    return;
  }
  await page.evaluate(replySendPointInPage).catch(() => null);
  await delay(120);
  const replyPoint = await page.evaluate(replySendPointInPage).catch(() => null);
  if (replyPoint) {
    await cdpClick(page, replyPoint.x, replyPoint.y);
    await delay(1500);
    const stillOpen = await page.evaluate(replyComposeOpenInPage).catch(() => false);
    if (!stillOpen) return;
    const again = await page.evaluate(replySendPointInPage).catch(() => null);
    if (again) {
      await cdpClick(page, again.x, again.y);
      await delay(1200);
      const openAfter = await page.evaluate(replyComposeOpenInPage).catch(() => false);
      if (!openAfter) return;
    }
  }
  await focusComposeBody(page);
  await pressSendShortcut(page);
}

async function readComposeState(page) {
  return page.evaluate(() => {
    const alert = document.querySelector('div[role="alertdialog"]');
    if (alert) return { state: "alert", text: (alert.innerText || "").trim().slice(0, 300) };
    function isVisible(node) {
      if (!node || node.nodeType !== 1) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return false;
      const style = window.getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    }
    const subjects = [...document.querySelectorAll('input[name="subjectbox"]')].filter(isVisible);
    return subjects.length ? { state: "open" } : { state: "sent" };
  });
}

async function waitForInbox(page, index) {
  try {
    await page.waitForFunction(inboxReady, { timeout: 45000 }, index);
    await delay(700);
    await page.waitForFunction(inboxReady, { timeout: 15000 }, index);
  } catch (error) {
    if (isLoginUrl(page.url())) {
      throw fatal("Gmail is not signed in. Sign in inside this browser, then press Resume.");
    }
    throw new Error("Compose button not found. Open the Gmail inbox. Gmail's display language should be English.");
  }
}

async function waitForComposeWindows(page, accept, timeout, isStopped) {
  const started = Date.now();
  let count = 0;
  try {
    count = await page.evaluate(inspectComposeWindows);
  } catch (error) {
    count = 0;
  }
  while (!accept(count) && Date.now() - started < timeout) {
    checkStop(isStopped);
    await delay(300);
    try {
      count = await page.evaluate(inspectComposeWindows);
    } catch (error) {
      count = 0;
    }
  }
  return count;
}

async function openComposeByAddress(page) {
  await page.evaluate(openComposeRouteInPage);
}

async function openCompose(page, index, isStopped, options = {}) {
  await waitForInbox(page, index);
  checkStop(isStopped);
  let count = 0;
  try {
    count = await page.evaluate(inspectComposeWindows);
  } catch (error) {
    count = 0;
  }
  if (count < 1) {
    let opened = false;
    if (options.byUrl) {
      await openComposeByAddress(page);
      opened = true;
    } else {
      opened = await activateComposeButton(page);
    }
    if (!opened) throw new Error("Compose button not found. Open the Gmail inbox. Gmail's display language should be English.");
    count = await waitForComposeWindows(page, (openCount) => openCount >= 1, 8000, isStopped);
    if (count < 1) {
      await enableCdpInput(page);
      await page.keyboard.press("c").catch(() => {});
      count = await waitForComposeWindows(page, (openCount) => openCount >= 1, 8000, isStopped);
    }
  }
  if (count > 1) {
    await page.evaluate(inspectComposeWindows, "close-extras");
    count = await waitForComposeWindows(page, (openCount) => openCount <= 1, 8000, isStopped);
  }
  if (count !== 1) {
    const hasSubject = await page.evaluate(() => Boolean(document.querySelector('input[name="subjectbox"]'))).catch(() => false);
    if (!hasSubject) throw new Error("The compose window did not open for this Gmail.");
  }

  await expandCollapsedCompose(page);
  try {
    await page.waitForFunction(recipientFieldReady, { timeout: 15000 });
  } catch (error) {
    await expandCollapsedCompose(page);
    try {
      await page.waitForFunction(recipientFieldReady, { timeout: 15000 });
    } catch (again) {
      const hasSubject = await page.evaluate(() => Boolean(document.querySelector('input[name="subjectbox"]'))).catch(() => false);
      if (!hasSubject) throw new Error("The compose window did not open for this Gmail.");
    }
  }
  await delay(500);
  count = await page.evaluate(inspectComposeWindows);
  if (count > 1) {
    await page.evaluate(inspectComposeWindows, "close-extras");
    count = await waitForComposeWindows(page, (openCount) => openCount <= 1, 8000, isStopped);
  }
  if (count !== 1) {
    const hasSubject = await page.evaluate(() => Boolean(document.querySelector('input[name="subjectbox"]'))).catch(() => false);
    if (!hasSubject) throw new Error("The compose window did not open for this Gmail.");
  }
}

async function confirmSent(page, email) {
  const started = Date.now();
  let shortcutUsed = false;
  while (Date.now() - started < 25000) {
    const state = await readComposeState(page);
    if (state.state === "sent") return;
    if (state.state === "alert") {
      if (/at least one recipient/i.test(state.text || "")) {
        await page.evaluate(() => {
          document.querySelectorAll('div[role="alertdialog"] button, div[role="alertdialog"] [role="button"]').forEach((button) => {
            const text = (button.innerText || button.getAttribute("aria-label") || "").trim().toLowerCase();
            if (text === "ok" || button.getAttribute("data-mdc-dialog-action") === "ok") button.click();
          });
        });
        throw new Error("Gmail did not accept the recipient.");
      }
      throw new Error(state.text || "Gmail asked for confirmation before sending.");
    }
    if (!shortcutUsed && Date.now() - started > 8000) {
      shortcutUsed = true;
      await clickSend(page, email);
    }
    await delay(300);
  }
  throw new Error("Gmail did not confirm the send. Check the compose window, then press Resume.");
}

async function sendGmail({ debugPort, browserWSEndpoint, targetId, gmailIndex, contact, subject, bodyHtml, bodyText, cvPath, fromEmail, isStopped, onTyped }) {
  checkStop(isStopped);
  const messageText = bodyText || plainFromHtml(bodyHtml);
  const selectedEmail = String(fromEmail || "").trim();
  return withBrowser(debugPort, async (browser) => {
    const index = Number(gmailIndex) || 0;
    const { page } = await openGmailPage(browser, index, true, { focus: false, compose: Boolean(targetId) });
    if (isLoginUrl(page.url())) {
      throw fatal("Gmail is not signed in. Sign in inside this browser, then press Resume.");
    }
    if (selectedEmail) {
      let openEmail = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        openEmail = await Promise.race([
          readOpenMailbox(page, index),
          delay(5000).then(() => ""),
        ]);
        if (openEmail) break;
        checkStop(isStopped);
        await delay(400);
      }
      if (openEmail && !mailboxMatches(openEmail, selectedEmail)) {
        throw fatal(`This window is signed in as ${openEmail}. Mail Carrier only sends from the selected Gmail ${selectedEmail}.`);
      }
    }
    checkStop(isStopped);
    await openCompose(page, index, isStopped, { byUrl: Boolean(targetId) });
    if (targetId) {
      const typed = await fillChromeCompose(page, contact.email, subject, messageText, onTyped, isStopped);
      if (!typed) throw new Error("The compose window is still empty.");
    } else {
      await landInput(page);
      await fillRecipient(page, contact.email);
      await fillSubjectAndBody(page, subject, bodyHtml || "", messageText);
    }
    if (cvPath) await attachFile(page, cvPath);
    else await delay(600);
    checkStop(isStopped);
    await clickSend(page, contact.email);
    await confirmSent(page, contact.email);
    await closeExtraGmailPages(browser, page);
  }, { targetId: targetId || "", browserWSEndpoint: browserWSEndpoint || "" });
}

function exactReplyQuery(content) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (text.length <= 180) return text;
  const cut = text.slice(0, 180);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
}

function searchHasResultInPage(fromEmail, subject, searchAddress) {
  function plain(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function queryVisible() {
    const from = String(fromEmail || "").trim().toLowerCase();
    const typed = String(searchAddress || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!from || !plain(subject) || !typed) return false;
    const box = document.querySelector('input[name="q"], input[aria-label="Search mail"]');
    const query = String((box && box.value) || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!query || !query.includes(typed)) return false;
    const rest = query.replace(typed, " ").replace(/\s+/g, " ").trim();
    if (!rest) return true;
    const parts = rest.split(" ");
    const tokens = [];
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i] === "in:" && parts[i + 1]) {
        tokens.push(`in:${parts[i + 1]}`);
        i += 1;
      } else {
        tokens.push(parts[i]);
      }
    }
    return tokens.every((part) => part === "in:spam" || part === "in:inbox");
  }
  function rowMatches(row) {
    const wanted = plain(subject);
    const subjectNode = row.querySelector(".bog, .bqe");
    const text = plain(subjectNode ? subjectNode.textContent : "");
    if (!wanted || text !== wanted) return false;
    const addressNode = row.querySelector("[email]");
    const address = String((addressNode && addressNode.getAttribute("email")) || "").trim().toLowerCase();
    const from = String(fromEmail || "").trim().toLowerCase();
    return !address || address === from;
  }
  if (!queryVisible()) return "";
  const text = (document.body && document.body.innerText) || "";
  if (/No messages matched your search/i.test(text)) return "empty";
  const match = [...document.querySelectorAll("tr.zA")].some((row) => rowMatches(row));
  return match ? "row" : "";
}

function folderReadyInPage(folder) {
  const name = String(folder || "").trim().toLowerCase();
  let hash = "";
  try {
    hash = decodeURIComponent(String(location.hash || "")).toLowerCase();
  } catch (error) {
    hash = String(location.hash || "").toLowerCase();
  }
  return Boolean(name) && hash.includes(`#${name}`);
}

function searchInputPointInPage() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }
  const box = [...document.querySelectorAll('input[name="q"], input[aria-label="Search mail"]')].find(isVisible);
  if (!box) return null;
  box.focus();
  const rect = box.getBoundingClientRect();
  return { x: Math.round(rect.left + Math.min(48, rect.width / 2)), y: Math.round(rect.top + rect.height / 2) };
}

function exactThreadPointInPage(fromEmail, subject) {
  function plain(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function rowMatches(row) {
    const wanted = plain(subject);
    const subjectNode = row.querySelector(".bog, .bqe");
    const text = plain(subjectNode ? subjectNode.textContent : "");
    if (!wanted || text !== wanted) return false;
    const addressNode = row.querySelector("[email]");
    const address = String((addressNode && addressNode.getAttribute("email")) || "").trim().toLowerCase();
    const from = String(fromEmail || "").trim().toLowerCase();
    return !address || address === from;
  }
  const rows = [...document.querySelectorAll("tr.zA")].filter((row) => {
    const rect = row.getBoundingClientRect();
    return rect.width >= 20 && rect.height >= 8 && rowMatches(row);
  });
  if (!rows.length) return null;
  let chosen = null;
  let chosenTime = Number.NEGATIVE_INFINITY;
  rows.forEach((row) => {
    const stamp = row.querySelector("td.xW [title]") || row.querySelector("[title]");
    const parsed = Date.parse(stamp ? stamp.getAttribute("title") || "" : "");
    if (!Number.isFinite(parsed) || parsed <= chosenTime) return;
    chosen = row;
    chosenTime = parsed;
  });
  const row = chosen || rows[0];
  const rect = row.getBoundingClientRect();
  return { x: Math.round(rect.left + Math.min(80, rect.width / 3)), y: Math.round(rect.top + rect.height / 2) };
}

function openedSubjectMatchesInPage(subject) {
  const wanted = String(subject || "").replace(/\s+/g, " ").trim().toLowerCase();
  const heading = document.querySelector("h2.hP");
  const text = String(heading ? heading.textContent : "").replace(/\s+/g, " ").trim().toLowerCase();
  return Boolean(wanted) && text === wanted;
}

function reportNotSpamPointInPage() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }
  function labelOf(button) {
    return `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-tooltip") || ""} ${button.innerText || button.textContent || ""}`
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }
  function textOf(button) {
    return String(button.innerText || button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function isReportNotSpam(button) {
    const label = labelOf(button);
    const text = textOf(button);
    const exact = text === "report not spam" || text === "not spam" || label === "report not spam" || label === "not spam";
    if (exact) return true;
    if (label.includes("report spam") && !label.includes("not spam")) return false;
    return label.includes("report not spam") || (label.includes("not spam") && !label.includes("report spam"));
  }
  const buttons = [...document.querySelectorAll('[role="button"], button, [role="link"], span, div, a')]
    .filter(isVisible)
    .filter(isReportNotSpam);
  buttons.sort((left, right) => {
    const leftText = textOf(left);
    const rightText = textOf(right);
    const leftExact = leftText === "report not spam" || leftText === "not spam";
    const rightExact = rightText === "report not spam" || rightText === "not spam";
    if (leftExact !== rightExact) return leftExact ? -1 : 1;
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    return (leftRect.width * leftRect.height) - (rightRect.width * rightRect.height);
  });
  const button = buttons[0];
  if (!button) return null;
  if (typeof button.scrollIntoView === "function") button.scrollIntoView({ block: "center", inline: "nearest" });
  const rect = button.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
}

function notSpamClearedInPage() {
  const text = (document.body && document.body.innerText) || "";
  if (/unmarked as spam/i.test(text)) return true;
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }
  function labelOf(button) {
    return `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-tooltip") || ""} ${button.innerText || ""}`
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }
  const stillThere = [...document.querySelectorAll('[role="button"], button, [role="link"]')].some((button) => {
    if (!isVisible(button)) return false;
    const label = labelOf(button);
    return label.includes("report not spam") || (label.includes("not spam") && !label.includes("report spam"));
  });
  return !stillThere;
}

function replyButtonPointInPage() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }
  const buttons = [...document.querySelectorAll('[role="button"], button')].filter(isVisible);
  const matches = buttons.filter((button) => {
    const label = `${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`.trim().toLowerCase();
    return label.startsWith("reply") && !label.includes("all");
  });
  const button = matches[matches.length - 1];
  if (!button) return null;
  button.scrollIntoView({ block: "center", inline: "nearest" });
  const rect = button.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
}

function replyBodyReadyInPage() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none";
  }
  const boxes = [...document.querySelectorAll('div[role="textbox"]')].filter(isVisible);
  return boxes.some((box) => {
    const label = (box.getAttribute("aria-label") || "").toLowerCase();
    return label.includes("message body") || box.getAttribute("g_editable") === "true";
  });
}

async function fillReplyBody(page, bodyText) {
  await landInput(page);
  const ready = await page.waitForFunction(replyBodyReadyInPage, { timeout: 20000 }).then(() => true).catch(() => false);
  if (!ready) throw new Error("Reply box did not open. Set Gmail's display language to English.");
  const wrote = await page.evaluate((plain) => {
    function isVisible(node) {
      if (!node || node.nodeType !== 1) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return false;
      const style = window.getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    }
    const boxes = [...document.querySelectorAll('div[role="textbox"]')].filter(isVisible);
    const bodyField = boxes.find((box) => (box.getAttribute("aria-label") || "").toLowerCase().includes("message body"))
      || boxes[boxes.length - 1];
    if (!bodyField) return false;
    bodyField.focus();
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, String(plain || ""));
    } catch (error) {
      inserted = false;
    }
    if (!inserted) {
      const lines = String(plain || "").split("\n");
      bodyField.replaceChildren();
      lines.forEach((line, index) => {
        if (index > 0) bodyField.appendChild(document.createElement("br"));
        if (line) bodyField.appendChild(document.createTextNode(line));
      });
    }
    bodyField.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, bodyText);
  if (!wrote) throw new Error("Reply box did not open. Set Gmail's display language to English.");
}

async function confirmReplySent(page) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const state = await page.evaluate(() => {
      const text = (document.body && document.body.innerText) || "";
      if (/Message sent/i.test(text)) return "sent";
      function isVisible(node) {
        if (!node || node.nodeType !== 1) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return false;
        const style = window.getComputedStyle(node);
        return style.visibility !== "hidden" && style.display !== "none";
      }
      const open = [...document.querySelectorAll('div[role="textbox"]')].some((box) => {
        const label = (box.getAttribute("aria-label") || "").toLowerCase();
        return isVisible(box) && (label.includes("message body") || box.getAttribute("g_editable") === "true");
      });
      return open ? "open" : "closed";
    });
    if (state === "sent" || state === "closed") return;
    await delay(300);
  }
  throw new Error("Gmail did not confirm the reply. Check the message, then press Resume.");
}

async function reportNotSpam(page, subject, isStopped) {
  await pause(800, isStopped);
  let point = null;
  const started = Date.now();
  while (!point && Date.now() - started < 15000) {
    checkStop(isStopped);
    const onThread = await page.evaluate((wanted) => {
      const heading = document.querySelector("h2.hP");
      const text = String(heading ? heading.textContent : "").replace(/\s+/g, " ").trim().toLowerCase();
      const needle = String(wanted || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!text || !needle) return true;
      return text === needle || text.includes(needle) || needle.includes(text);
    }, subject).catch(() => true);
    point = onThread ? await page.evaluate(reportNotSpamPointInPage) : null;
    if (!point) await delay(400);
  }
  if (!point) {
    const error = new Error("Report not spam did not appear. The reply was sent.");
    error.replied = true;
    throw error;
  }
  checkStop(isStopped);
  const fresh = await page.evaluate(reportNotSpamPointInPage).catch(() => null);
  const target = fresh || point;
  await landInput(page);
  await cdpClick(page, target.x, target.y);
  const confirmed = Date.now();
  while (Date.now() - confirmed < 15000) {
    checkStop(isStopped);
    if (await page.evaluate(notSpamClearedInPage)) return;
    await delay(400);
  }
  const error = new Error("Gmail did not confirm Report not spam. The reply was sent.");
  error.replied = true;
  throw error;
}

async function waitForGmailFolder(page, index, folder, isStopped) {
  const listUrl = `https://mail.google.com/mail/u/${index}/#${folder}`;
  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  const openedFolder = Date.now();
  let folderReady = false;
  while (!folderReady && Date.now() - openedFolder < 15000) {
    checkStop(isStopped);
    folderReady = await page.evaluate(folderReadyInPage, folder);
    if (!folderReady) {
      await page.evaluate((name) => {
        const next = `#${name}`;
        if (!String(location.hash || "").toLowerCase().includes(next)) location.hash = next;
      }, folder).catch(() => {});
      await delay(500);
    }
  }
  await pause(3000, isStopped);
  return folderReady;
}

async function submitExactSearch(page, query, isStopped) {
  const point = await page.evaluate(searchInputPointInPage);
  if (!point) throw new Error("Gmail search box did not open. Set Gmail's display language to English.");
  checkStop(isStopped);
  await landInput(page);
  await cdpClick(page, point.x, point.y);
  await enableCdpInput(page);
  await delay(150);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(query, { delay: 12 });
  checkStop(isStopped);
  await page.keyboard.press("Enter");
}

function gmailSearchUrl(index, query) {
  const encoded = encodeURIComponent(String(query || ""))
    .replace(/%20/g, "+")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  return `https://mail.google.com/mail/u/${Number(index) || 0}/#search/${encoded}`;
}

function warmupSearchToken(marker) {
  const tag = String(marker || "(w-u)").replace(/\s+/g, " ").trim() || "(w-u)";
  const bare = tag.replace(/[()"]/g, "").trim();
  return bare || "w-u";
}

function warmupSearchQuery(_folder, marker) {
  // Quote the marker. Gmail treats an unquoted hyphen as "exclude", so `w-u` does not find every "(w-u)" email.
  return `in:anywhere "${warmupSearchToken(marker)}"`;
}

function searchScopeReadyInPage(marker, folder) {
  const needle = String(marker || "").replace(/\s+/g, " ").trim().toLowerCase();
  const wanted = String(folder || "").trim().toLowerCase() || "anywhere";
  const box = document.querySelector('input[name="q"], input[aria-label="Search mail"]');
  const query = String((box && box.value) || "").replace(/\s+/g, " ").trim().toLowerCase();
  let hash = "";
  try {
    hash = decodeURIComponent(String(location.hash || "")).toLowerCase();
  } catch (error) {
    hash = String(location.hash || "").toLowerCase();
  }
  const source = `${query} ${hash}`.replace(/\s+/g, " ");
  if (!needle || (!query.includes(needle) && !hash.includes(needle))) return false;
  return source.includes(`in:${wanted}`) || source.includes(`in: ${wanted}`);
}

function warmupSearchBoxReadyInPage(token) {
  const needle = String(token || "w-u").replace(/\s+/g, " ").trim().toLowerCase() || "w-u";
  const box = document.querySelector('input[name="q"], input[aria-label="Search mail"]');
  const query = String((box && box.value) || "").replace(/\s+/g, " ").trim().toLowerCase();
  return query.includes("in:anywhere") && query.includes(needle);
}

async function openWarmupSearch(page, index, folder, marker, isStopped) {
  const query = warmupSearchQuery(folder, marker);
  const token = warmupSearchToken(marker);
  const url = gmailSearchUrl(index, query);
  const hash = url.slice(url.indexOf("#"));
  const beforeUrl = pageUrl(page);
  const alreadyOnSearch = followupResultsAlreadyOpen(beforeUrl, query);
  const before = alreadyOnSearch
    ? null
    : await page.evaluate(followupSearchSnapshotInPage).catch(() => null);
  await showFollowupHash(page, index, hash, isStopped);
  const started = Date.now();
  let boxReady = false;
  while (!boxReady && Date.now() - started < 20000) {
    checkStop(isStopped);
    boxReady = await page.evaluate(warmupSearchBoxReadyInPage, token).catch(() => false);
    if (!boxReady) {
      await page.evaluate((nextHash) => {
        if (location.hash !== nextHash) location.hash = nextHash;
      }, hash).catch(() => {});
      await delay(400);
    }
  }
  let settled = "";
  if (boxReady || alreadyOnSearch) {
    settled = await waitForFollowupSearchResults(page, isStopped, 20000, {
      query,
      previousSignature: before && before.count ? String(before.signature || "") : "",
      alreadyOnSearch: alreadyOnSearch && boxReady,
    });
  }
  if (!settled) {
    await showFollowupHash(page, index, hash, isStopped, { forceLoad: true });
    const reloaded = Date.now();
    while (!boxReady && Date.now() - reloaded < 20000) {
      checkStop(isStopped);
      boxReady = await page.evaluate(warmupSearchBoxReadyInPage, token).catch(() => false);
      if (!boxReady) await delay(400);
    }
    settled = await waitForFollowupSearchResults(page, isStopped, 20000, {
      query,
      previousSignature: "",
      alreadyOnSearch: false,
    });
  }
  await page.evaluate(searchScopeReadyInPage, token, "anywhere").catch(() => false);
  await page.evaluate(() => {
    const scroller = document.querySelector(".Tm.aeJ") || document.querySelector("div.aeF");
    if (scroller) scroller.scrollTop = 0;
  }).catch(() => {});
  return { query, ready: Boolean(boxReady || settled) };
}

async function scrollThreadList(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector(".Tm.aeJ") || document.querySelector("div.aeF");
    if (!scroller) return false;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + Math.max(240, Math.round(scroller.clientHeight * 0.8));
    return scroller.scrollTop > before + 8;
  }).catch(() => false);
}

function warmupThreadListInPage(marker, mailbox) {
  const needle = String(marker || "(w-u)")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const own = String(mailbox || "").replace(/\s+/g, " ").trim().toLowerCase();
  function plain(value) {
    return String(value || "")
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  }
  function attr(node, name) {
    if (!node || typeof node.getAttribute !== "function") return "";
    return String(node.getAttribute(name) || "");
  }
  function messageCount(label) {
    const words = String(label || "").match(/(\d+)\s+messages?/i);
    if (!words) return 0;
    const count = Number(words[1]);
    return count > 1 ? count : 1;
  }
  function threadCount(row) {
    const badge = row.querySelector(".bx0");
    if (badge) {
      const fromLabel = messageCount(`${attr(badge, "aria-label")} ${badge.textContent || ""}`);
      if (fromLabel > 1) return fromLabel;
      const digits = String(badge.textContent || "").replace(/\s+/g, " ").trim().match(/^(\d+)$/);
      if (digits && Number(digits[1]) > 1) return Number(digits[1]);
    }
    const labeled = row.querySelector("[aria-label*='message'], [aria-label*='Message']");
    const fromAria = messageCount(`${attr(labeled, "aria-label")} ${labeled ? labeled.textContent : ""}`);
    return fromAria > 1 ? fromAria : 1;
  }
  function threadId(row) {
    const direct = plain(attr(row, "data-legacy-thread-id") || attr(row, "data-thread-id")).replace(/^#/, "");
    if (direct) return direct;
    const nested = row.querySelector("[data-legacy-thread-id], [data-thread-id]");
    const nestedId = plain(attr(nested, "data-legacy-thread-id") || attr(nested, "data-thread-id")).replace(/^#/, "");
    if (nestedId) return nestedId;
    const box = row.querySelector("input[type='checkbox'][value], input[name='t'][value]");
    return plain(attr(box, "value")).replace(/^#/, "");
  }
  function isSentRow(row) {
    const who = row.querySelector(".yW");
    const label = plain(who ? who.innerText || who.textContent : "").toLowerCase();
    return label.startsWith("to:") || label.startsWith("to :");
  }
  if (!needle) return [];
  const listed = [...document.querySelectorAll("tr.zA")];
  const source = listed.length ? listed : [...document.querySelectorAll('[role="main"] [role="row"]')];
  return source.map((row, index) => {
    const rect = row.getBoundingClientRect();
    const subjectNode = row.querySelector(".bog") || row.querySelector(".bqe") || row.querySelector(".y6");
    const subject = plain(subjectNode ? subjectNode.textContent : "");
    const subjectTitle = plain(attr(subjectNode, "title"));
    const snippetNode = row.querySelector(".y2") || row.querySelector(".xT .y2");
    const snippet = plain(snippetNode ? snippetNode.textContent : "");
    const rowText = plain(row.innerText || row.textContent || "");
    const rowLabel = plain(attr(row, "aria-label"));
    const addressNode = row.querySelector("[email]")
      || row.querySelector(".yW [email]")
      || row.querySelector("[data-hovercard-id]");
    const email = String(
      (addressNode && (attr(addressNode, "email") || attr(addressNode, "data-hovercard-id"))) || ""
    ).trim();
    const who = row.querySelector(".yW");
    const name = plain(who ? who.innerText || who.textContent : "").replace(/^to\s*:\s*/i, "");
    return {
      subject,
      subjectTitle,
      snippet,
      email,
      name,
      threadId: threadId(row),
      listIndex: index,
      sent: isSentRow(row),
      count: threadCount(row),
      x: Math.round(rect.left + Math.min(80, rect.width / 3)),
      y: Math.round(rect.top + rect.height / 2),
      rowText,
      rowLabel,
      visible: rect.width >= 20 && rect.height >= 8,
    };
  }).filter((row) => {
    if (!row.visible || row.sent || row.count !== 1) return false;
    if (own && row.email.toLowerCase() === own) return false;
    const blob = `${row.subject} ${row.subjectTitle} ${row.snippet} ${row.rowLabel} ${row.rowText}`.toLowerCase();
    return blob.includes(needle);
  }).map((row) => {
    const copy = { ...row };
    delete copy.rowText;
    delete copy.rowLabel;
    delete copy.subjectTitle;
    return copy;
  });
}

function openedFromAddressInPage() {
  const node = document.querySelector("span.gD[email]") || document.querySelector(".gE span[email]");
  return String((node && node.getAttribute("email")) || "").trim();
}

function openedSubjectHasMarkerInPage(marker) {
  const wanted = String(marker || "")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const heading = document.querySelector("h2.hP");
  const text = String(heading ? heading.textContent : "")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return Boolean(wanted) && text.includes(wanted);
}

function openedTextHasMarkerInPage(marker) {
  const wanted = String(marker || "")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!wanted) return false;
  const heading = document.querySelector("h2.hP");
  const subject = String(heading ? heading.textContent : "")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (subject.includes(wanted)) return true;
  const bodies = [...document.querySelectorAll("div.a3s, div.adn")];
  const text = bodies.map((node) => node.innerText || node.textContent || "").join("\n")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .toLowerCase();
  return text.includes(wanted);
}

function openedMessageCountInPage() {
  function shown(node) {
    if (!node) return false;
    if (node.nodeType && node.nodeType !== 1) return false;
    if (typeof node.getBoundingClientRect !== "function") return true;
    try {
      const rect = node.getBoundingClientRect();
      if (rect && rect.width < 2 && rect.height < 2) return false;
    } catch (error) {
      return true;
    }
    return true;
  }
  const nodes = [...document.querySelectorAll("div.adn")].filter(shown);
  if (nodes.length) return nodes.length;
  const ids = [...document.querySelectorAll("[data-message-id], [data-legacy-message-id]")].filter(shown);
  if (ids.length) return ids.length;
  return 1;
}

async function replyToSender({ debugPort, browserWSEndpoint, targetId, gmailIndex, fromEmail, subject, bodyText, content, mailboxEmail, isStopped }) {
  checkStop(isStopped);
  const index = Number(gmailIndex) || 0;
  const sender = String(fromEmail || "").trim();
  const title = String(subject || "").trim();
  return withBrowser(debugPort, async (browser) => {
    const { page } = await openGmailPage(browser, index, true, { focus: false });
    if (isLoginUrl(page.url())) {
      throw fatal("Gmail is not signed in. Sign in inside this browser, then press Resume.");
    }
    if (mailboxEmail) {
      const openEmail = await Promise.race([
        readOpenMailbox(page, index),
        delay(5000).then(() => ""),
      ]);
      if (openEmail && !mailboxMatches(openEmail, mailboxEmail)) {
        throw fatal(`This window is signed in as ${openEmail}. Mail Carrier only opens the selected Gmail ${mailboxEmail}.`);
      }
    }
    checkStop(isStopped);
    const receiver = String(mailboxEmail || "").trim();
    const query = exactReplyQuery(content) || exactReplyQuery(title);
    if (!query || !title || !receiver) return { found: false };
    await page.keyboard.press("Escape").catch(() => {});
    let found = "";
    let foundFolder = "";
    for (const folder of ["inbox", "spam"]) {
      checkStop(isStopped);
      await waitForGmailFolder(page, index, folder, isStopped);
      const typedQuery = folder === "spam" ? `${query} in:spam` : query;
      await submitExactSearch(page, typedQuery, isStopped);
      await pause(4000, isStopped);
      found = "";
      const started = Date.now();
      while (Date.now() - started < 20000) {
        checkStop(isStopped);
        found = await page.evaluate(searchHasResultInPage, sender, title, query);
        if (found === "row") break;
        await delay(700);
      }
      if (found !== "row") {
        const listed = await page.evaluate(exactThreadPointInPage, sender, title);
        if (listed) found = "row";
      }
      if (found !== "row" && folder === "spam") {
        await waitForGmailFolder(page, index, "spam", isStopped);
        const listed = await page.evaluate(exactThreadPointInPage, sender, title);
        if (listed) found = "row";
      }
      if (found === "row") {
        foundFolder = folder;
        break;
      }
    }
    if (found !== "row") return { found: false };
    const point = await page.evaluate(exactThreadPointInPage, sender, title);
    if (!point) return { found: false };
    await landInput(page);
    await cdpClick(page, point.x, point.y);
    let openedExact = false;
    const opened = Date.now();
    while (!openedExact && Date.now() - opened < 20000) {
      checkStop(isStopped);
      openedExact = await page.evaluate(openedSubjectMatchesInPage, title);
      if (!openedExact) await delay(400);
    }
    if (!openedExact) return { found: false };
    const stillExact = await page.evaluate(openedSubjectMatchesInPage, title);
    if (!stillExact) return { found: false };
    let replyPoint = null;
    const replyStarted = Date.now();
    while (!replyPoint && Date.now() - replyStarted < 20000) {
      checkStop(isStopped);
      if (!(await page.evaluate(openedSubjectMatchesInPage, title))) return { found: false };
      replyPoint = await page.evaluate(replyButtonPointInPage);
      if (!replyPoint) await delay(400);
    }
    if (!replyPoint) return { found: false };
    if (!(await page.evaluate(openedSubjectMatchesInPage, title))) return { found: false };
    await landInput(page);
    await cdpClick(page, replyPoint.x, replyPoint.y);
    await delay(500);
    checkStop(isStopped);
    await fillReplyBody(page, bodyText);
    await clickSend(page, fromEmail);
    await confirmReplySent(page);
    if (foundFolder === "spam") await reportNotSpam(page, title, isStopped);
    return { found: true, folder: foundFolder };
  }, { targetId: targetId || "", browserWSEndpoint: browserWSEndpoint || "" });
}

function warmupDeliveryMatches(row, wanted) {
  const from = String(row?.fromEmail || row?.email || "").trim().toLowerCase();
  const subject = String(row?.subject || "").replace(/\s+/g, " ").trim().toLowerCase();
  const wantedFrom = String(wanted?.fromEmail || wanted?.email || "").trim().toLowerCase();
  const wantedSubject = String(wanted?.subject || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!wantedFrom && !wantedSubject) return false;
  if (wantedFrom && from !== wantedFrom) return false;
  if (!wantedSubject) return true;
  if (!subject) return false;
  return subject === wantedSubject || subject.includes(wantedSubject) || wantedSubject.includes(subject);
}

function warmupListKey(row) {
  const id = String(row?.threadId || "").trim().replace(/^#/, "");
  if (id) return `id:${id}`;
  const email = String(row?.email || "").trim().toLowerCase();
  const named = mailboxNameKey(email, row?.name) || email;
  const subject = String(row?.subject || "").trim().toLowerCase();
  const snippet = String(row?.snippet || "").trim().toLowerCase();
  if (!named && !subject && !snippet) return "";
  return `row:${named}|${subject}|${snippet}`;
}

function warmupRowPointInPage(threadId, email, subject, name) {
  function plain(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function attr(node, name) {
    if (!node || typeof node.getAttribute !== "function") return "";
    return String(node.getAttribute(name) || "");
  }
  const wantedId = plain(threadId).replace(/^#/, "");
  const wantedEmail = plain(email);
  const wantedSubject = plain(subject);
  const wantedFirst = plain(String(name || "").split(" ")[0] || "");
  const listed = [...document.querySelectorAll("tr.zA")];
  const rows = listed.length ? listed : [...document.querySelectorAll('[role="main"] [role="row"]')];
  const row = rows.find((item) => {
    const nested = item.querySelector("[data-legacy-thread-id], [data-thread-id]");
    const id = plain(
      attr(item, "data-legacy-thread-id")
      || attr(item, "data-thread-id")
      || attr(nested, "data-legacy-thread-id")
      || attr(nested, "data-thread-id")
    ).replace(/^#/, "");
    if (wantedId && id && id === wantedId) return true;
    if (!wantedEmail && !wantedSubject) return false;
    const addressNode = item.querySelector("[email]") || item.querySelector("[data-hovercard-id]");
    const rowEmail = plain(attr(addressNode, "email") || attr(addressNode, "data-hovercard-id"));
    const who = item.querySelector(".yW");
    const rowFirst = plain(who ? who.textContent : "").replace(/^to\s*:\s*/i, "").split(" ")[0] || "";
    const subjectNode = item.querySelector(".bog") || item.querySelector(".bqe") || item.querySelector(".y6");
    const rowSubject = plain(subjectNode ? subjectNode.textContent : "");
    const emailOk = !wantedEmail || rowEmail === wantedEmail;
    const nameOk = !wantedFirst || rowFirst === wantedFirst;
    const subjectOk = !wantedSubject || rowSubject === wantedSubject || rowSubject.includes(wantedSubject);
    if (wantedEmail && !rowEmail && wantedFirst) return nameOk && subjectOk;
    return emailOk && nameOk && subjectOk;
  });
  if (!row) return null;
  const target = row.querySelector(".bog") || row.querySelector(".y6") || row;
  if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center", inline: "nearest" });
  const rect = target.getBoundingClientRect();
  if (!rect || rect.width < 4 || rect.height < 4) return null;
  return {
    x: Math.round(rect.left + Math.min(80, rect.width / 2)),
    y: Math.round(rect.top + rect.height / 2),
  };
}

async function openOlderWarmupPage(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll("[aria-label], [data-tooltip]")];
    const next = nodes.find((node) => {
      const label = String(node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
      const tip = String(node.getAttribute("data-tooltip") || "").replace(/\s+/g, " ").trim().toLowerCase();
      return label === "older" || tip === "older";
    });
    if (!next || typeof next.click !== "function") return false;
    next.click();
    return true;
  }).catch(() => false);
}

async function collectWarmupThreads(page, token, mailbox, isStopped) {
  const found = new Map();
  let idle = 0;
  let staleMoves = 0;
  let pages = 0;
  for (let step = 0; step < 200 && found.size < 500; step += 1) {
    checkStop(isStopped);
    const before = found.size;
    const rows = await page.evaluate(warmupThreadListInPage, token, mailbox || "").catch(() => []);
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = warmupListKey(row);
      if (!key || found.has(key)) continue;
      found.set(key, row);
    }
    if (!found.size && step < 6) {
      idle = 0;
      staleMoves = 0;
      await delay(120);
      continue;
    }
    const moved = await scrollThreadList(page);
    if (found.size !== before) {
      idle = 0;
      staleMoves = 0;
      await delay(moved ? 80 : 40);
      continue;
    }
    if (moved) {
      staleMoves += 1;
      if (staleMoves < 3) {
        await delay(80);
        continue;
      }
    } else {
      idle += 1;
      if (idle < 2) {
        await delay(80);
        continue;
      }
    }
    // Gmail shows one page at a time. Four extra pages stop around 50 threads, so a 60-email search was cut off.
    if (pages >= 40 || !(await openOlderWarmupPage(page))) break;
    pages += 1;
    idle = 0;
    staleMoves = 0;
    await delay(180);
  }
  return [...found.values()];
}

async function openOneWarmupThread(page, index, row, token, tag, isStopped) {
  const waitForMarker = async (timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      checkStop(isStopped);
      const open = await page.evaluate((wanted) => {
        const heading = document.querySelector("h2.hP");
        const text = String(heading ? heading.textContent : "").replace(/\s+/g, " ").trim().toLowerCase();
        const needle = String(wanted || "").replace(/\s+/g, " ").trim().toLowerCase();
        return Boolean(needle) && Boolean(text) && (text === needle || text.includes(needle) || needle.includes(text));
      }, subject || token).catch(() => false);
      if (open) return true;
      await delay(80);
    }
    return false;
  };
  const threadId = String(row?.threadId || "").trim().replace(/^#/, "");
  const email = String(row?.email || "");
  const subject = String(row?.subject || "");
  const name = String(row?.name || "");
  const clickListedRow = async () => {
    const point = await page.evaluate(warmupRowPointInPage, threadId, email, subject, name).catch(() => null);
    if (!point) return false;
    await landInput(page);
    await cdpClick(page, point.x, point.y);
    return waitForMarker(1200);
  };
  if (/^[a-zA-Z0-9_-]{10,}$/.test(threadId)) {
    const openedHash = await page.evaluate(openFollowupThreadHashInPage, threadId).catch(() => "");
    if (openedHash && await waitForMarker(1200)) return true;
  }
  if (await clickListedRow()) return true;
  const query = warmupSearchQuery("anywhere", tag);
  const searchUrl = gmailSearchUrl(index, query);
  const hash = searchUrl.slice(searchUrl.indexOf("#"));
  await showFollowupHash(page, index, hash, isStopped);
  const started = Date.now();
  while (Date.now() - started < 1800) {
    checkStop(isStopped);
    if (await clickListedRow()) return true;
    await delay(80);
  }
  return false;
}

async function replyAllWarmupThreads({ debugPort, browserWSEndpoint, targetId, gmailIndex, mailboxEmail, marker, threads, pickBody, isStopped }) {
  checkStop(isStopped);
  const index = Number(gmailIndex) || 0;
  const tag = String(marker || "(w-u)").trim() || "(w-u)";
  const token = warmupSearchToken(tag);
  const expected = Array.isArray(threads) ? threads : [];
  return withBrowser(debugPort, async (browser) => {
    const { page } = await openGmailPage(browser, index, true, { focus: false });
    if (isLoginUrl(page.url())) {
      throw fatal("Gmail is not signed in. Sign in inside this browser, then press Resume.");
    }
    if (mailboxEmail) {
      const openEmail = await Promise.race([
        readOpenMailbox(page, index),
        delay(5000).then(() => ""),
      ]);
      if (openEmail && !mailboxMatches(openEmail, mailboxEmail)) {
        throw fatal(`This window is signed in as ${openEmail}. Mail Carrier only opens the selected Gmail ${mailboxEmail}.`);
      }
    }
    const replied = [];
    const answerRows = async (queued) => {
      for (const next of queued) {
        checkStop(isStopped);
        if (Number(next.count) !== 1 || next.sent) continue;
        let fromEmail = String(next.email || "").trim();
        let inSpam = false;
        let sentThis = false;
        try {
          await page.keyboard.press("Escape").catch(() => {});
          const opened = await openOneWarmupThread(page, index, next, token, tag, isStopped);
          if (!opened) continue;
          let messages = 0;
          const counted = Date.now();
          while (Date.now() - counted < 700) {
            checkStop(isStopped);
            const count = Number(await page.evaluate(openedMessageCountInPage)) || 0;
            if (count === 1) {
              messages = 1;
              break;
            }
            if (count > 1) messages = count;
            await delay(80);
          }
          if (messages > 1) continue;
          const fromAddress = await page.evaluate(openedFromAddressInPage).catch(() => "");
          fromEmail = String(fromAddress || next.email || "").trim();
          if (fromEmail && mailboxEmail && mailboxMatches(fromEmail, mailboxEmail)) continue;
          let replyPoint = null;
          const replyStarted = Date.now();
          while (!replyPoint && Date.now() - replyStarted < 20000) {
            checkStop(isStopped);
            if (!(await page.evaluate(openedTextHasMarkerInPage, token))) break;
            if (await page.evaluate(reportNotSpamPointInPage).catch(() => null)) inSpam = true;
            replyPoint = await page.evaluate(replyButtonPointInPage);
            if (!replyPoint) await delay(120);
          }
          if (!replyPoint) continue;
          if (!inSpam && await page.evaluate(reportNotSpamPointInPage).catch(() => null)) inSpam = true;
          const bodyText = typeof pickBody === "function" ? pickBody({ fromEmail: fromEmail || next.email, subject: next.subject }) : "";
          await landInput(page);
          await cdpClick(page, replyPoint.x, replyPoint.y);
          await delay(150);
          checkStop(isStopped);
          await fillReplyBody(page, bodyText);
          await clickSend(page, fromEmail || next.email);
          sentThis = true;
          await confirmReplySent(page);
          const openedSubject = await page.evaluate(() => {
            const heading = document.querySelector("h2.hP");
            return String(heading ? heading.textContent : "").replace(/\s+/g, " ").trim();
          }).catch(() => "");
          if (!inSpam && await page.evaluate(reportNotSpamPointInPage).catch(() => null)) inSpam = true;
          if (inSpam) {
            try {
              await reportNotSpam(page, openedSubject || next.subject, isStopped);
            } catch (error) {
              if (error && (error.code === "STOP" || error.fatal)) throw error;
            }
          }
          replied.push({
            fromEmail: fromEmail || next.email,
            subject: openedSubject || next.subject,
            folder: inSpam ? "spam" : "inbox",
          });
        } catch (error) {
          if (error && (error.code === "STOP" || error.fatal)) throw error;
          if (sentThis || (error && error.replied)) {
            replied.push({
              fromEmail: fromEmail || next.email,
              subject: String(next.subject || "").trim(),
              folder: inSpam ? "spam" : "inbox",
            });
          }
        }
      }
    };
    const missingDeliveries = () => expected.filter((item) => !replied.some((hit) => warmupDeliveryMatches(hit, item)));
    checkStop(isStopped);
    await openWarmupSearch(page, index, "anywhere", tag, isStopped);
    await answerRows(await collectWarmupThreads(page, token, mailboxEmail || "", isStopped));
    if (missingDeliveries().length) {
      await delay(300);
      checkStop(isStopped);
      await openWarmupSearch(page, index, "anywhere", tag, isStopped);
      const again = await collectWarmupThreads(page, token, mailboxEmail || "", isStopped);
      const still = missingDeliveries();
      await answerRows(again.filter((row) => still.some((item) => warmupDeliveryMatches(row, item))));
    }
    await closeExtraGmailPages(browser, page);
    return { replied, missed: missingDeliveries() };
  }, { targetId: targetId || "", browserWSEndpoint: browserWSEndpoint || "" });
}

function followupRowIdentity(row) {
  const threadId = String(row?.threadId || "").trim();
  if (threadId) return `id:${threadId}`;
  const email = String(row?.email || "").trim().toLowerCase();
  const toLabel = String(row?.toLabel || "").trim().toLowerCase();
  const subject = String(row?.subject || "").trim().toLowerCase();
  const snippet = String(row?.snippet || "").trim().toLowerCase();
  const key = `${email}|${toLabel}|${subject}|${snippet}`;
  if (!key.replace(/\|/g, "")) return "";
  return `row:${key}`;
}

function followupThreadListInPage() {
  function plain(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  function threadCount(row) {
    function attr(node, name) {
      if (!node || typeof node.getAttribute !== "function") return "";
      return String(node.getAttribute(name) || "");
    }
    function messageCount(label) {
      const words = String(label || "").match(/(\d+)\s+messages?/i);
      if (!words) return 0;
      const count = Number(words[1]);
      return count > 1 ? count : 1;
    }
    const badge = row.querySelector(".bx0");
    if (badge) {
      const fromLabel = messageCount(`${attr(badge, "aria-label")} ${badge.textContent || ""}`);
      if (fromLabel > 1) return fromLabel;
      const digits = String(badge.textContent || "").replace(/\s+/g, " ").trim().match(/^(\d+)$/);
      if (digits && Number(digits[1]) > 1) return Number(digits[1]);
    }
    const labeled = row.querySelector("[aria-label*='message'], [aria-label*='Message']");
    const fromAria = messageCount(`${attr(labeled, "aria-label")} ${labeled ? labeled.textContent : ""}`);
    return fromAria > 1 ? fromAria : 1;
  }
  function threadId(row) {
    const direct = plain(
      row.getAttribute("data-legacy-thread-id")
      || row.getAttribute("data-thread-id")
      || ""
    ).replace(/^#/, "");
    if (direct) return direct;
    const nested = row.querySelector("[data-legacy-thread-id], [data-thread-id]");
    const nestedId = plain(
      (nested && (nested.getAttribute("data-legacy-thread-id") || nested.getAttribute("data-thread-id"))) || ""
    ).replace(/^#/, "");
    if (nestedId) return nestedId;
    const box = row.querySelector("input[type='checkbox'][value], input[name='t'][value]");
    return plain((box && box.value) || "");
  }
  function isSentRow(row) {
    const who = row.querySelector(".yW");
    const label = plain(who ? who.innerText || who.textContent : "").toLowerCase();
    return label.startsWith("to:") || label === "me" || label.startsWith("me,") || label.includes(" to ");
  }
  // in:sent already limits to mail you sent; only one-message threads get a follow-up.
  const nodes = [...document.querySelectorAll("tr.zA")];
  const source = nodes.length ? nodes : [...document.querySelectorAll('[role="main"] [role="row"]')];
  return source.map((row, index) => {
    const rect = row.getBoundingClientRect();
    const subjectNode = row.querySelector(".bog") || row.querySelector(".bqe") || row.querySelector(".y6");
    const subject = plain(subjectNode ? subjectNode.textContent : "");
    const subjectRect = subjectNode && typeof subjectNode.getBoundingClientRect === "function"
      ? subjectNode.getBoundingClientRect()
      : null;
    const addressNode = row.querySelector(".yW [email]") || row.querySelector("[email]");
    const email = String((addressNode && addressNode.getAttribute("email")) || "").trim();
    const who = row.querySelector(".yW");
    const toLabel = plain(who ? who.innerText || who.textContent : "");
    const snippetNode = row.querySelector(".y2") || row.querySelector(".xT .y2");
    const snippet = plain(snippetNode ? snippetNode.textContent : "");
    const count = threadCount(row);
    const sent = isSentRow(row);
    const id = threadId(row);
    return {
      subject,
      email,
      toLabel,
      snippet,
      threadId: id,
      listIndex: index,
      sent,
      count,
      x: Math.round((subjectRect && subjectRect.width >= 4 ? subjectRect.left + subjectRect.width / 2 : rect.left + Math.min(rect.width * 0.62, Math.max(rect.width - 24, 0)))),
      y: Math.round((subjectRect && subjectRect.width >= 4 ? subjectRect.top + subjectRect.height / 2 : rect.top + rect.height / 2)),
      visible: rect.width >= 20 && rect.height >= 8,
    };
  }).filter((row) => row.visible && row.count === 1);
}

function openedMessagesFromMailboxInPage(mailbox) {
  const own = String(mailbox || "").trim().toLowerCase();
  function senderInfo(node) {
    const mark = node.querySelector("span.gD[email]")
      || node.querySelector("span.gD")
      || node.querySelector("[email]");
    const email = String((mark && mark.getAttribute("email")) || "").trim().toLowerCase();
    const name = String((mark && (mark.getAttribute("name") || mark.textContent)) || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return { email, name };
  }
  function isMine(info) {
    if (!own) return Boolean(info.email || info.name);
    if (info.email && info.email === own) return true;
    if (info.name === "me" || info.name.startsWith("me ")) return true;
    return false;
  }
  function isShown(node) {
    if (!node) return false;
    if (node.nodeType && node.nodeType !== 1) return false;
    if (typeof node.getBoundingClientRect !== "function") return true;
    try {
      const rect = node.getBoundingClientRect();
      if (rect && rect.width < 2 && rect.height < 2) return false;
    } catch (error) {
      return true;
    }
    return true;
  }
  function messageIsDraft(node) {
    if (!node || typeof node.querySelector !== "function") return false;
    const discard = node.querySelector('[aria-label*="Discard draft"], [data-tooltip*="Discard draft"]');
    if (discard && typeof discard.getAttribute === "function") {
      const label = `${discard.getAttribute("aria-label") || ""} ${discard.getAttribute("data-tooltip") || ""}`;
      if (/discard draft/i.test(label)) return true;
    }
    if (typeof node.querySelectorAll !== "function") return false;
    return [...node.querySelectorAll(".bA4, .bAq")].some((chip) => (
      /^draft$/i.test(String(chip.textContent || "").replace(/\s+/g, " ").trim())
    ));
  }
  const nodes = [...document.querySelectorAll("div.adn")].filter(isShown);
  const messages = nodes.filter((node) => !messageIsDraft(node));
  if (!nodes.length) {
    const heading = document.querySelector("span.gD[email]") || document.querySelector(".gE span[email]") || document.querySelector("span.gD");
    const info = {
      email: String((heading && heading.getAttribute("email")) || "").trim().toLowerCase(),
      name: String((heading && (heading.getAttribute("name") || heading.textContent)) || "").replace(/\s+/g, " ").trim().toLowerCase(),
    };
    const known = Boolean(info.email || info.name);
    return {
      count: known ? 1 : 0,
      allMine: known && isMine(info),
      ready: known,
      emails: info.email ? [info.email] : [],
    };
  }
  if (!messages.length) {
    return { count: 0, drafts: nodes.length, allMine: false, ready: true, emails: [] };
  }
  const infos = messages.map(senderInfo);
  const known = infos.filter((info) => info.email || info.name);
  const emails = infos.map((info) => info.email).filter(Boolean);
  const ready = known.length === messages.length;
  const allMine = ready && infos.every((info) => isMine(info));
  return { count: messages.length, drafts: nodes.length - messages.length, allMine, ready, emails };
}

function threadHasDraftInPage() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    if (typeof node.getBoundingClientRect === "function") {
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width < 8 || rect.height < 8) return false;
    }
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const style = window.getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none") return false;
    }
    return true;
  }
  const discard = [...document.querySelectorAll('[aria-label*="Discard draft"], [data-tooltip*="Discard draft"]')].some(isVisible);
  if (discard) return true;
  return [...document.querySelectorAll(".bA4, .bAq, [aria-label='Draft'], [data-tooltip='Draft']")].some((node) => {
    if (!isVisible(node)) return false;
    const parts = [
      node.getAttribute("aria-label") || "",
      node.getAttribute("data-tooltip") || "",
      node.textContent || "",
    ];
    return parts.some((part) => /^draft$/i.test(String(part).replace(/\s+/g, " ").trim()));
  });
}

function discardOpenDraftInPage() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    if (typeof node.getBoundingClientRect === "function") {
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width < 8 || rect.height < 8) return false;
    }
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const style = window.getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none") return false;
    }
    return true;
  }
  const buttons = [...document.querySelectorAll('[aria-label*="Discard draft"], [data-tooltip*="Discard draft"]')].filter(isVisible);
  const button = buttons.find((item) => {
    const host = typeof item.closest === "function" ? item.closest('[role="dialog"]') : null;
    const label = String((host && host.getAttribute("aria-label")) || "").toLowerCase();
    return !label.includes("new message");
  }) || buttons[0];
  if (!button || typeof button.click !== "function") return false;
  button.click();
  return true;
}

function confirmDiscardDraftInPage() {
  const dialogs = [...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')];
  for (const dialog of dialogs) {
    const text = String(dialog.innerText || dialog.textContent || "").toLowerCase();
    if (!text.includes("discard")) continue;
    const button = [...dialog.querySelectorAll("button, [role='button']")].find((node) => {
      const label = String(node.innerText || node.textContent || node.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      return label === "discard" || label === "ok" || label === "delete";
    });
    if (!button || typeof button.click !== "function") continue;
    button.click();
    return true;
  }
  return false;
}

function expandCollapsedDraftInPage() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    if (typeof node.getBoundingClientRect === "function") {
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width < 8 || rect.height < 8) return false;
    }
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const style = window.getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none") return false;
    }
    return true;
  }
  const chips = [...document.querySelectorAll(".bA4, .bAq, [aria-label='Draft'], [data-tooltip='Draft']")];
  const chip = chips.find((node) => {
    if (!isVisible(node)) return false;
    const parts = [
      node.getAttribute("aria-label") || "",
      node.getAttribute("data-tooltip") || "",
      node.textContent || "",
    ];
    return parts.some((part) => /^draft$/i.test(String(part).replace(/\s+/g, " ").trim()));
  });
  if (!chip) return false;
  const target = (typeof chip.closest === "function" && chip.closest("[role='button'], .adn, .kv")) || chip;
  if (typeof target.click !== "function") return false;
  target.click();
  return true;
}

async function discardFollowupDraft(page, isStopped) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    checkStop(isStopped);
    const hasDraft = await page.evaluate(threadHasDraftInPage).catch(() => false);
    if (!hasDraft) return true;
    const discarded = await page.evaluate(discardOpenDraftInPage).catch(() => false);
    if (!discarded) {
      const expanded = await page.evaluate(expandCollapsedDraftInPage).catch(() => false);
      if (!expanded) return false;
      await delay(400);
      continue;
    }
    await delay(350);
    await page.evaluate(confirmDiscardDraftInPage).catch(() => false);
    await delay(450);
  }
  return !(await page.evaluate(threadHasDraftInPage).catch(() => false));
}

function followupSearchSettledInPage() {
  const snap = followupSearchSnapshotInPage();
  return snap.state;
}

function followupSearchSnapshotInPage() {
  function isVisible(node) {
    if (!node || node.nodeType !== 1) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = window.getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }
  const listed = document.querySelectorAll("tr.zA");
  const rows = listed && listed.length ? [...listed] : [];
  const signature = rows.slice(0, 5).map((row) => {
    const id = String(row.getAttribute("data-legacy-thread-id") || row.getAttribute("data-thread-id") || "").replace(/^#/, "");
    const subjectNode = row.querySelector(".bog") || row.querySelector(".bqe") || row.querySelector(".y6");
    const subject = String(subjectNode ? subjectNode.textContent : "").replace(/\s+/g, " ").trim().toLowerCase();
    return `${id}:${subject}`;
  }).join("|");
  const busy = [...document.querySelectorAll('[role="progressbar"], [aria-busy="true"]')]
    .some((node) => isVisible(node));
  const box = document.querySelector('input[name="q"], input[aria-label="Search mail"]');
  const queryText = String((box && box.value) || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (rows.length) return { state: "rows", signature, count: rows.length, busy, queryText };
  if (busy) return { state: "loading", signature, count: 0, busy: true, queryText };
  const main = document.querySelector('[role="main"]');
  const sampleSource = (main && (main.innerText || main.textContent))
    || (document.body && (document.body.innerText || document.body.textContent))
    || "";
  const text = String(sampleSource).slice(0, 500);
  if (/No messages matched your search/i.test(text)) return { state: "empty", signature, count: 0, busy: false, queryText };
  if (/Loading|Searching|Still working|Getting messages|Loading the conversation/i.test(text)) {
    return { state: "loading", signature, count: 0, busy: true, queryText };
  }
  return { state: "waiting", signature, count: 0, busy: false, queryText };
}

function followupResultsAlreadyOpen(url, query) {
  const needle = String(query || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) return false;
  const raw = String(url || "");
  const hash = raw.includes("#") ? raw.slice(raw.indexOf("#") + 1) : "";
  let decoded = hash;
  try {
    decoded = decodeURIComponent(hash);
  } catch (error) {
    decoded = hash;
  }
  const text = decoded.replace(/\+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return text === `search/${needle}`;
}

async function showFollowupHash(page, index, hash, isStopped, options = {}) {
  const account = Number(index) || 0;
  const nextHash = String(hash || "");
  const current = pageUrl(page);
  const onAccount = !options.forceLoad
    && current.includes("mail.google.com/mail")
    && gmailAccountIndex(current) === account
    && !isLoginUrl(current);
  if (onAccount) {
    checkStop(isStopped);
    await page.evaluate((wanted) => {
      if (location.hash !== wanted) location.hash = wanted;
    }, nextHash).catch(() => {});
    return;
  }
  const url = `https://mail.google.com/mail/u/${account}/${nextHash}`;
  const onDialog = (dialog) => {
    dialog.accept().catch(() => {});
  };
  if (typeof page.on === "function") page.on("dialog", onDialog);
  try {
    checkStop(isStopped);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  } finally {
    if (typeof page.off === "function") page.off("dialog", onDialog);
  }
}

async function waitForFollowupQuery(page, hash, query, isStopped, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    checkStop(isStopped);
    if (followupResultsAlreadyOpen(pageUrl(page), query)) return true;
    const ready = await page.evaluate((wanted) => {
      const needle = String(wanted || "").replace(/\s+/g, " ").trim().toLowerCase();
      const box = document.querySelector('input[name="q"], input[aria-label="Search mail"]');
      const queryText = String((box && box.value) || "").replace(/\s+/g, " ").trim().toLowerCase();
      let hashText = "";
      try {
        hashText = decodeURIComponent(String(location.hash || "")).replace(/\+/g, " ").toLowerCase();
      } catch (error) {
        hashText = String(location.hash || "").replace(/\+/g, " ").toLowerCase();
      }
      const source = `${queryText} ${hashText}`.replace(/\s+/g, " ");
      return Boolean(needle) && (queryText.includes("in:sent") || source.includes("in:sent"))
        && (queryText.includes(needle) || hashText.includes(`search/${needle}`) || source.includes(needle));
    }, query).catch(() => false);
    if (ready) return true;
    await page.evaluate((nextHash) => {
      if (location.hash !== nextHash) location.hash = nextHash;
    }, hash).catch(() => {});
    await delay(200);
  }
  return false;
}

async function waitForFollowupSearchResults(page, isStopped, timeoutMs = 60000, options = {}) {
  const needle = String(options.query || "").replace(/\s+/g, " ").trim().toLowerCase();
  const previousSignature = String(options.previousSignature || "");
  const alreadyOnSearch = Boolean(options.alreadyOnSearch);
  const started = Date.now();
  let stableKey = "";
  let stableAt = 0;
  let emptyPolls = 0;
  let cleared = false;
  let sawBusy = false;
  let staleSignature = "";
  while (Date.now() - started < timeoutMs) {
    checkStop(isStopped);
    const snap = await page.evaluate(followupSearchSnapshotInPage).catch(() => null);
    const state = snap && snap.state ? snap.state : "loading";
    const signature = snap ? String(snap.signature || "") : "";
    const count = snap ? Number(snap.count) || 0 : 0;
    const queryText = snap ? String(snap.queryText || "") : "";
    const boxReady = Boolean(needle) && queryText.includes(needle);
    if (snap && snap.busy) sawBusy = true;
    if (!boxReady && signature && !staleSignature) staleSignature = signature;
    if (!count) emptyPolls += 1;
    else emptyPolls = 0;
    // One empty paint can be the old list redrawing. Two polls means the list actually cleared.
    if (emptyPolls >= 2) cleared = true;
    const signatureChanged = Boolean(previousSignature) && Boolean(signature) && signature !== previousSignature;
    const refreshed = sawBusy && !(snap && snap.busy);
    const notStale = !staleSignature || signature !== staleSignature;
    const confirmed = alreadyOnSearch
      || signatureChanged
      || (boxReady && refreshed && notStale)
      || (boxReady && cleared && count > 0 && notStale)
      || (boxReady && state === "empty" && (cleared || refreshed));
    // Use the first exact rows once this search has replaced the previous list.
    if ((state === "rows" || state === "empty") && confirmed) {
      const key = `${state}:${signature}`;
      const hold = state === "rows" ? 250 : 2000;
      if (key === stableKey) {
        if (Date.now() - stableAt >= hold) return state;
      } else {
        stableKey = key;
        stableAt = Date.now();
      }
    } else {
      stableKey = "";
      stableAt = 0;
    }
    await delay(200);
  }
  return "";
}

async function openFollowupSearch(page, index, query, isStopped) {
  const url = gmailSearchUrl(index, query);
  const hash = url.slice(url.indexOf("#"));
  const beforeUrl = pageUrl(page);
  const alreadyOnSearch = followupResultsAlreadyOpen(beforeUrl, query);
  const before = alreadyOnSearch
    ? null
    : await page.evaluate(followupSearchSnapshotInPage).catch(() => null);
  await showFollowupHash(page, index, hash, isStopped);
  if (isLoginUrl(pageUrl(page))) {
    throw fatal("Gmail is not signed in. Sign in inside this browser, then press Resume.");
  }
  let ready = await waitForFollowupQuery(page, hash, query, isStopped, 8000);
  if (!ready) {
    await showFollowupHash(page, index, hash, isStopped, { forceLoad: true });
    if (isLoginUrl(pageUrl(page))) {
      throw fatal("Gmail is not signed in. Sign in inside this browser, then press Resume.");
    }
    ready = await waitForFollowupQuery(page, hash, query, isStopped, 15000);
  }
  if (!ready) return { query, ready: false, settled: "" };
  const settled = await waitForFollowupSearchResults(page, isStopped, 60000, {
    query,
    previousSignature: before && before.count ? String(before.signature || "") : "",
    alreadyOnSearch,
  });
  return { query, ready: true, settled };
}

function followupOpenPointInPage(threadId, listIndex) {
  function plain(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  const listed = [...document.querySelectorAll("tr.zA")];
  const rows = listed.length ? listed : [...document.querySelectorAll('[role="main"] [role="row"]')];
  const wanted = plain(threadId).replace(/^#/, "");
  let row = null;
  if (wanted) {
    row = rows.find((item) => {
      const own = plain(item.getAttribute("data-legacy-thread-id") || item.getAttribute("data-thread-id") || "").replace(/^#/, "");
      if (own && own === wanted) return true;
      const nested = item.querySelector("[data-legacy-thread-id], [data-thread-id]");
      const nestedId = plain((nested && (nested.getAttribute("data-legacy-thread-id") || nested.getAttribute("data-thread-id"))) || "").replace(/^#/, "");
      return Boolean(nestedId) && nestedId === wanted;
    }) || null;
  }
  if (!row && rows[Number(listIndex)]) row = rows[Number(listIndex)];
  if (!row) return null;
  const subject = row.querySelector(".bog") || row.querySelector(".bqe") || row.querySelector(".y6");
  const target = subject || row;
  if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center", inline: "nearest" });
  const rect = target.getBoundingClientRect();
  if (!rect || rect.width < 4 || rect.height < 4) return null;
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  };
}

function openFollowupThreadHashInPage(threadId) {
  const id = String(threadId || "").trim().replace(/^#/, "");
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(id)) return "";
  const raw = String(location.hash || "");
  const search = raw.match(/^#search\/([^/]+)/i);
  const next = search ? `#search/${search[1]}/${id}` : `#sent/${id}`;
  if (location.hash !== next) location.hash = next;
  return next;
}

async function followupThreadIsOpen(page) {
  return page.evaluate(() => {
    const node = document.querySelector("h2.hP");
    return Boolean(String(node ? node.textContent : "").replace(/\s+/g, " ").trim());
  }).catch(() => false);
}

async function waitForFollowupThread(page, isStopped, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    checkStop(isStopped);
    if (await followupThreadIsOpen(page)) return true;
    await delay(400);
  }
  return false;
}

async function openListedFollowupThread(page, index, row, isStopped) {
  const threadId = String(row?.threadId || "").trim();
  const listIndex = Number(row?.listIndex);
  const point = await page.evaluate(followupOpenPointInPage, threadId, listIndex).catch(() => null);
  if (point) {
    await landInput(page);
    await cdpClick(page, point.x, point.y);
    if (await waitForFollowupThread(page, isStopped, 5000)) return true;
  }
  await page.keyboard.press("Escape").catch(() => {});
  const openedHash = await page.evaluate(openFollowupThreadHashInPage, threadId).catch(() => "");
  if (openedHash && await waitForFollowupThread(page, isStopped, 12000)) return true;
  const id = threadId.replace(/^#/, "");
  if (/^[a-zA-Z0-9_-]{10,}$/.test(id)) {
    await page.goto(`https://mail.google.com/mail/u/${Number(index) || 0}/#sent/${id}`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    }).catch(() => {});
    if (await waitForFollowupThread(page, isStopped, 12000)) return true;
  }
  return false;
}

const followupThreadQueue = new Map();

async function openFollowupThreadDirect(page, index, query, threadId, isStopped) {
  const id = String(threadId || "").trim().replace(/^#/, "");
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(id)) return false;
  const url = gmailSearchUrl(index, query);
  const hash = `${url.slice(url.indexOf("#"))}/${id}`;
  await showFollowupHash(page, index, hash, isStopped);
  if (await waitForFollowupThread(page, isStopped, 8000)) return true;
  await page.goto(`https://mail.google.com/mail/u/${Number(index) || 0}/#sent/${id}`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  }).catch(() => {});
  return waitForFollowupThread(page, isStopped, 8000);
}

async function replyFollowupThreads({
  debugPort,
  browserWSEndpoint,
  targetId,
  gmailIndex,
  mailboxEmail,
  query,
  limit,
  bodyText,
  skipEmails = [],
  checkReplies = true,
  isStopped,
}) {
  checkStop(isStopped);
  const index = Number(gmailIndex) || 0;
  const max = Math.max(0, Math.min(500, Math.round(Number(limit) || 0)));
  const search = String(query || "").replace(/\s+/g, " ").trim();
  if (!search || !max) return { replied: [] };
  return withBrowser(debugPort, async (browser) => {
    const { page } = await openGmailPage(browser, index, false, { focus: false, skipInbox: true });
    if (isLoginUrl(page.url())) {
      throw fatal("Gmail is not signed in. Sign in inside this browser, then press Resume.");
    }
    if (mailboxEmail && pageUrl(page).includes("mail.google.com/mail")) {
      const openEmail = await Promise.race([
        readOpenMailbox(page, index),
        delay(2500).then(() => ""),
      ]);
      if (openEmail && !mailboxMatches(openEmail, mailboxEmail)) {
        throw fatal(`This window is signed in as ${openEmail}. Mail Carrier only opens the selected Gmail ${mailboxEmail}.`);
      }
    }
    const replied = [];
    const replies = [];
    const skipped = [];
    const handled = new Set();
    const skip = new Set(
      (Array.isArray(skipEmails) ? skipEmails : [])
        .map((email) => String(email || "").trim().toLowerCase())
        .filter((email) => email.includes("@"))
    );
    const queueKey = `${String(mailboxEmail || "").trim().toLowerCase()}|${search.toLowerCase()}`;
    let queued = followupThreadQueue.get(queueKey);
    if (!Array.isArray(queued)) {
      queued = [];
      followupThreadQueue.set(queueKey, queued);
    }
    const rememberRows = (rows) => {
      const list = Array.isArray(rows) ? rows : [];
      const oneMessage = list.filter((row) => Number(row.count) === 1);
      const sentRows = oneMessage.filter((row) => row.sent);
      const source = sentRows.length ? sentRows : oneMessage;
      const seen = new Set(queued);
      for (const row of source) {
        const id = String(row.threadId || "").trim().replace(/^#/, "");
        if (!/^[a-zA-Z0-9_-]{10,}$/.test(id) || handled.has(`id:${id}`) || seen.has(id)) continue;
        seen.add(id);
        queued.push(id);
      }
    };
    const takeQueued = () => {
      while (queued.length) {
        const id = String(queued.shift() || "").trim().replace(/^#/, "");
        if (!/^[a-zA-Z0-9_-]{10,}$/.test(id) || handled.has(`id:${id}`)) continue;
        handled.add(`id:${id}`);
        return id;
      }
      return "";
    };
    const returnToList = async () => {
      const listed = await openFollowupSearch(page, index, search, isStopped);
      if (!listed.settled) throw new Error("Gmail search did not show sent mail for that day.");
      return listed.settled === "rows";
    };
    let resultsOpen = false;
    if (!queued.length) {
      if (!(await returnToList())) return { replied, skipped };
      resultsOpen = true;
    }
    let guard = 0;
    let stalled = 0;
    let emptyPasses = 0;
    const reopenResults = async () => {
      if (queued.length) return true;
      const listed = await returnToList();
      resultsOpen = listed;
      return listed;
    };
    while (guard < 80 && replied.length < max) {
      guard += 1;
      checkStop(isStopped);
      const queuedId = takeQueued();
      let next = null;
      if (queuedId) {
        const openedQueued = await openFollowupThreadDirect(page, index, search, queuedId, isStopped);
        if (!openedQueued) continue;
        resultsOpen = false;
        next = { threadId: queuedId, subject: "", email: "" };
      } else {
        if (!resultsOpen) {
          if (!(await returnToList())) break;
          resultsOpen = true;
        }
        const rows = await page.evaluate(followupThreadListInPage).catch(() => []);
        rememberRows(rows);
        const pending = (Array.isArray(rows) ? rows : []).filter((row) => {
          if (Number(row.count) !== 1) return false;
          const identity = followupRowIdentity(row);
          return Boolean(identity) && !handled.has(identity);
        });
        next = pending.find((row) => row.sent) || pending[0];
        if (!next) {
          // List can lag right after a reply; wait once before scrolling or giving up.
          if (emptyPasses < 2) {
            emptyPasses += 1;
            await delay(400);
            const again = await page.evaluate(followupThreadListInPage).catch(() => []);
            rememberRows(again);
            if ((Array.isArray(again) ? again : []).some((row) => {
              if (Number(row.count) !== 1) return false;
              const identity = followupRowIdentity(row);
              return Boolean(identity) && !handled.has(identity);
            })) {
              continue;
            }
          }
          const moved = await scrollThreadList(page);
          if (moved && stalled < 8) {
            stalled += 1;
            emptyPasses = 0;
            await delay(350);
            continue;
          }
          break;
        }
        stalled = 0;
        emptyPasses = 0;
        const listedIdentity = followupRowIdentity(next);
        handled.add(listedIdentity);
        let opened = false;
        const listedId = String(next.threadId || "").trim().replace(/^#/, "");
        if (/^[a-zA-Z0-9_-]{10,}$/.test(listedId)) {
          handled.add(`id:${listedId}`);
          const listedAt = queued.indexOf(listedId);
          if (listedAt >= 0) queued.splice(listedAt, 1);
          opened = await openFollowupThreadDirect(page, index, search, listedId, isStopped);
        }
        if (!opened) opened = await openListedFollowupThread(page, index, next, isStopped);
        if (!opened) {
          skipped.push({ subject: next.subject, reason: "could-not-open" });
          if (!(await reopenResults())) break;
          continue;
        }
      }
      const identity = followupRowIdentity(next);
      handled.add(identity);
      const openedThreadId = await page.evaluate(() => {
        try {
          const hash = decodeURIComponent(String(location.hash || ""));
          const match = hash.match(/\/([a-zA-Z0-9]+)(?:\?|$)/);
          return match ? String(match[1] || "").trim() : "";
        } catch (error) {
          return "";
        }
      }).catch(() => "");
      if (openedThreadId) handled.add(`id:${openedThreadId}`);
      let info = { count: 0, allMine: false, ready: false };
      const counted = Date.now();
      while (Date.now() - counted < 20000) {
        checkStop(isStopped);
        info = await page.evaluate(openedMessagesFromMailboxInPage, mailboxEmail || "").catch(() => info);
        if (info.ready && info.count >= 1) break;
        await delay(500);
      }
      if (!info.ready) {
        skipped.push({ subject: next.subject, reason: "messages-not-ready", messageCount: info.count });
        if (!(await reopenResults())) break;
        continue;
      }
      if (info.count !== 1) {
        skipped.push({ subject: next.subject, reason: "not-one-message", messageCount: info.count });
        if (!(await reopenResults())) break;
        continue;
      }
      const foreignSender = Boolean(mailboxEmail) && Array.isArray(info.emails)
        && info.emails.some((email) => email && !mailboxMatches(email, mailboxEmail));
      if (foreignSender) {
        skipped.push({ subject: next.subject, reason: "not-from-me", messageCount: info.count });
        if (!(await reopenResults())) break;
        continue;
      }
      const recipient = String(next.email || "").trim().toLowerCase();
      if (recipient && skip.has(recipient)) {
        skipped.push({ subject: next.subject, email: recipient, reason: "bounced" });
        if (!(await reopenResults())) break;
        continue;
      }
      const draftCleared = await discardFollowupDraft(page, isStopped);
      if (!draftCleared) {
        skipped.push({ subject: next.subject, reason: "draft-not-deleted", messageCount: info.count });
        if (!(await reopenResults())) break;
        continue;
      }
      // A sent thread with one message has not been answered. Stay on it and reply.
      let replyPoint = null;
      const replyStarted = Date.now();
      while (!replyPoint && Date.now() - replyStarted < 30000) {
        checkStop(isStopped);
        replyPoint = await page.evaluate(replyButtonPointInPage);
        if (!replyPoint) await delay(500);
      }
      if (!replyPoint) {
        skipped.push({ subject: next.subject, reason: "no-reply-button", messageCount: info.count });
        if (!(await reopenResults())) break;
        continue;
      }
      await landInput(page);
      await cdpClick(page, replyPoint.x, replyPoint.y);
      await delay(800);
      checkStop(isStopped);
      await fillReplyBody(page, bodyText);
      await clickSend(page, next.email || mailboxEmail || "");
      await confirmReplySent(page);
      const openedSubject = await page.evaluate(() => {
        const heading = document.querySelector("h2.hP");
        return String(heading ? heading.textContent : "").replace(/\s+/g, " ").trim();
      }).catch(() => "");
      const finalSubject = openedSubject || next.subject;
      handled.add(identity);
      if (openedThreadId) handled.add(`id:${openedThreadId}`);
      if (next.threadId) {
        const sentId = String(next.threadId).trim().replace(/^#/, "");
        const sentAt = queued.indexOf(sentId);
        if (sentAt >= 0) queued.splice(sentAt, 1);
      }
      replied.push({
        toEmail: next.email || "",
        subject: finalSubject,
        messageCount: 1,
        threadId: next.threadId || openedThreadId || "",
      });
      if (replied.length >= max) break;
      if (!(await reopenResults())) break;
    }
    return { replied, skipped, replies };
  }, { targetId: targetId || "", browserWSEndpoint: browserWSEndpoint || "" });
}

function sentThreadListInPage() {
  function plain(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  function threadId(row) {
    const direct = plain(
      row.getAttribute("data-legacy-thread-id")
      || row.getAttribute("data-thread-id")
      || ""
    ).replace(/^#/, "");
    if (direct) return direct;
    const nested = row.querySelector("[data-legacy-thread-id], [data-thread-id]");
    const nestedId = plain(
      (nested && (nested.getAttribute("data-legacy-thread-id") || nested.getAttribute("data-thread-id"))) || ""
    ).replace(/^#/, "");
    if (nestedId) return nestedId;
    const box = row.querySelector("input[type='checkbox'][value], input[name='t'][value]");
    return plain((box && box.value) || "");
  }
  const nodes = [...document.querySelectorAll("tr.zA")];
  const source = nodes.length ? nodes : [...document.querySelectorAll('[role="main"] [role="row"]')];
  return source.map((row, index) => {
    const rect = row.getBoundingClientRect();
    const subjectNode = row.querySelector(".bog") || row.querySelector(".bqe") || row.querySelector(".y6");
    const subject = plain(subjectNode ? subjectNode.textContent : "");
    return {
      subject,
      threadId: threadId(row),
      listIndex: index,
      visible: rect.width >= 20 && rect.height >= 8,
    };
  }).filter((row) => row.visible && row.threadId);
}

function expandDeliveryThreadInPage() {
  const clicks = [
    ...document.querySelectorAll(".ajR, [data-tooltip='Show trimmed content'], [aria-label='Show trimmed content']"),
    ...document.querySelectorAll("div.kv, .adf.ads, .iA.g6"),
  ].slice(0, 12);
  clicks.forEach((node) => {
    if (typeof node.click === "function") node.click();
  });
  return clicks.length;
}

function deliveryReportsInPage() {
  function plain(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  return [...document.querySelectorAll("div.adn")].map((node) => {
    const mark = node.querySelector("span.gD[email]") || node.querySelector("[email]");
    const email = String((mark && mark.getAttribute("email")) || "").trim();
    const name = plain((mark && (mark.getAttribute("name") || mark.textContent)) || "");
    const bodyNode = node.querySelector(".a3s");
    const body = plain(bodyNode ? (bodyNode.innerText || bodyNode.textContent) : (node.innerText || "")).slice(0, 8000);
    return { email, name, body };
  }).filter((item) => item.body || item.email);
}

async function analyseSentThreads({
  debugPort,
  browserWSEndpoint,
  targetId,
  gmailIndex,
  mailboxEmail,
  query,
  limit,
  seenIds,
  isStopped,
}) {
  checkStop(isStopped);
  const index = Number(gmailIndex) || 0;
  const max = Math.max(0, Math.min(200, Math.round(Number(limit) || 0)));
  const search = String(query || "").replace(/\s+/g, " ").trim();
  if (!search || !max) return { opened: [], reports: [], exhausted: true, seen: [] };
  return withBrowser(debugPort, async (browser) => {
    const { page } = await openGmailPage(browser, index, false, { focus: false, skipInbox: true });
    if (isLoginUrl(page.url())) {
      throw fatal("Gmail is not signed in. Sign in inside this browser, then press Resume.");
    }
    if (mailboxEmail && pageUrl(page).includes("mail.google.com/mail")) {
      const openEmail = await Promise.race([
        readOpenMailbox(page, index),
        delay(2500).then(() => ""),
      ]);
      if (openEmail && !mailboxMatches(openEmail, mailboxEmail)) {
        throw fatal(`This window is signed in as ${openEmail}. Mail Carrier only opens the selected Gmail ${mailboxEmail}.`);
      }
    }
    const handled = new Set((seenIds || []).map((id) => String(id || "").trim().replace(/^#/, "")).filter(Boolean));
    const queued = [];
    const opened = [];
    const reports = [];
    const listed = await openFollowupSearch(page, index, search, isStopped);
    if (!listed.settled) throw new Error("Gmail search did not show sent mail for that period.");
    if (listed.settled === "empty") {
      return { opened, reports, exhausted: true, seen: [...handled] };
    }
    const collect = async () => {
      const rows = await page.evaluate(sentThreadListInPage).catch(() => []);
      let added = 0;
      const waiting = new Set(queued.map((row) => row.threadId));
      for (const row of Array.isArray(rows) ? rows : []) {
        const id = String(row.threadId || "").trim().replace(/^#/, "");
        if (!/^[a-zA-Z0-9_-]{10,}$/.test(id) || handled.has(id) || waiting.has(id)) continue;
        waiting.add(id);
        queued.push({ threadId: id, subject: row.subject || "", listIndex: row.listIndex });
        added += 1;
      }
      return added;
    };
    await collect();
    let stalled = 0;
    while (opened.length < max) {
      checkStop(isStopped);
      if (!queued.length) {
        const moved = await scrollThreadList(page);
        await delay(500);
        const added = await collect();
        if (added) {
          stalled = 0;
          continue;
        }
        stalled += 1;
        if (!moved || stalled >= 3) break;
        continue;
      }
      const row = queued.shift();
      handled.add(row.threadId);
      let open = await openFollowupThreadDirect(page, index, search, row.threadId, isStopped);
      if (!open) {
        await openFollowupSearch(page, index, search, isStopped);
        open = await openListedFollowupThread(page, index, row, isStopped);
      }
      if (!open) continue;
      await page.evaluate(expandDeliveryThreadInPage).catch(() => 0);
      await delay(400);
      const raw = await page.evaluate(deliveryReportsInPage).catch(() => []);
      opened.push(row.threadId);
      for (const item of Array.isArray(raw) ? raw : []) {
        reports.push({
          email: item.email || "",
          name: item.name || "",
          body: item.body || "",
          subject: row.subject || "",
          threadId: row.threadId,
        });
      }
      stalled = 0;
    }
    return {
      opened,
      reports,
      exhausted: opened.length < max && queued.length === 0,
      seen: [...handled],
    };
  }, { targetId: targetId || "", browserWSEndpoint: browserWSEndpoint || "" });
}

module.exports = {
  detectGmailAccounts,
  focusGmailInbox,
  sendGmail,
  replyToSender,
  replyAllWarmupThreads,
  replyFollowupThreads,
  analyseSentThreads,
  followupRowIdentity,
  followupThreadListInPage,
  followupOpenPointInPage,
  openFollowupThreadHashInPage,
  followupSearchSettledInPage,
  followupSearchSnapshotInPage,
  followupResultsAlreadyOpen,
  openedMessagesFromMailboxInPage,
  threadHasDraftInPage,
  discardOpenDraftInPage,
  confirmDiscardDraftInPage,
  expandCollapsedDraftInPage,
  warmupThreadListInPage,
  openedFromAddressInPage,
  openedSubjectHasMarkerInPage,
  openedMessageCountInPage,
  exactReplyQuery,
  exactThreadPointInPage,
  openedSubjectMatchesInPage,
  reportNotSpamPointInPage,
  replySendPointInPage,
  notSpamClearedInPage,
  searchHasResultInPage,
  searchScopeReadyInPage,
  gmailSearchUrl,
  warmupSearchQuery,
  warmupSearchToken,
  attachAccountNames,
  accountsFromListRows,
  accountsFromListPayloads,
  atomMailboxFromFeed,
  mailboxesFromFeeds,
  probeAllInPage,
  signedInMailboxes,
  withKnownIndex,
  mailboxesFromHints,
  MAILBOX_PROBE_LIMIT,
  feedProbeSettled,
  combineDetectedMailboxes,
  mergeMailboxAccounts,
  firstPersonalName,
  mailboxNameKey,
  isLoginUrl,
  gmailAccountIndex,
  mailboxMatches,
  inboxNavigationPlan,
  inboxReady,
  clickComposeButtonInPage,
  composeButtonPointInPage,
  composeOpenPlan,
  openComposeRouteInPage,
  focusInspectedFieldInPage,
  insertIntoInspectedField,
  readInspectedComposeInPage,
  writeInspectedComposeInPage,
  expandCollapsedComposeInPage,
  nameFromAccountLabel,
  pickAccountName,
  plainFromHtml,
};
