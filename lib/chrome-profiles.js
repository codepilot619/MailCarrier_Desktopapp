const { execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { acquire, findTarget, pageSummaries } = require("./browser-session");

const CHROME_PREFIX = "chrome:";
const CHROME_GROUP = "Chrome";

class ChromeDebugError extends Error {
  constructor(message) {
    super(message || "Remote debugging did not start. Mail Carrier did not sign you out of Gmail.");
    this.name = "ChromeDebugError";
    this.code = "CHROME_DEBUG";
    this.fatal = true;
  }
}

function isSafeProfileDirectory(value) {
  return /^(Default|Profile \d+)$/.test(String(value || ""));
}

function chromeEnvId(directory) {
  if (!isSafeProfileDirectory(directory)) throw new Error("That Chrome profile is not valid.");
  return `${CHROME_PREFIX}${directory}`;
}

function directoryFromChromeId(envId) {
  const text = String(envId || "");
  if (!text.startsWith(CHROME_PREFIX)) return "";
  const directory = text.slice(CHROME_PREFIX.length);
  return isSafeProfileDirectory(directory) ? directory : "";
}

function isChromeEnvId(envId) {
  return Boolean(directoryFromChromeId(envId));
}

function profileLabel(info) {
  const name = String(info?.name || "").replace(/\s+/g, " ").trim();
  const given = String(info?.gaia_given_name || "").replace(/\s+/g, " ").trim();
  if (given && name && given.toLowerCase() !== name.toLowerCase()) return `${given} (${name})`.slice(0, 120);
  return (name || given || "Chrome profile").slice(0, 120);
}

function readJsonFile(filePath, readFile) {
  const text = readFile(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function accountsFromPreferences(profileDir, readFile, exists) {
  const filePath = path.join(profileDir, "Preferences");
  if (!exists(filePath)) return [];
  try {
    if (fs.statSync(filePath).size > 20 * 1024 * 1024) return [];
  } catch (error) {
    return [];
  }
  try {
    const data = readJsonFile(filePath, readFile);
    const rows = Array.isArray(data.account_info) ? data.account_info : [];
    return rows
      .filter((row) => row && /@/.test(String(row.email || "")))
      .map((row, index) => ({
        index,
        email: String(row.email).trim(),
        name: String(row.full_name || row.given_name || "").replace(/\s+/g, " ").trim().slice(0, 120),
      }));
  } catch (error) {
    return [];
  }
}

function readChromeProfiles(userDataDir, io = fs) {
  const root = String(userDataDir || "");
  const statePath = path.join(root, "Local State");
  if (!root || !io.existsSync(statePath)) return [];
  let state;
  try {
    state = readJsonFile(statePath, io.readFileSync.bind(io));
  } catch (error) {
    throw new Error("Could not read Chrome profiles.");
  }
  const cache = state?.profile?.info_cache || {};
  const profiles = [];
  for (const [directory, info] of Object.entries(cache)) {
    if (!isSafeProfileDirectory(directory)) continue;
    if (info?.is_ephemeral) continue;
    const profileDir = path.join(root, directory);
    if (!io.existsSync(profileDir)) continue;
    const saved = accountsFromPreferences(profileDir, io.readFileSync.bind(io), io.existsSync.bind(io));
    const hintAccounts = saved.length
      ? saved
      : (/@/.test(String(info?.user_name || ""))
        ? [{
          index: 0,
          email: String(info.user_name).trim(),
          name: String(info.gaia_name || info.gaia_given_name || "").replace(/\s+/g, " ").trim().slice(0, 120),
        }]
        : []);
    profiles.push({
      envId: chromeEnvId(directory),
      envName: profileLabel(info),
      uniqueId: null,
      groupName: CHROME_GROUP,
      profileDirectory: directory,
      source: "chrome",
      hintAccounts,
    });
  }
  profiles.sort((a, b) => a.envName.localeCompare(b.envName));
  return profiles;
}

function defaultLocations() {
  const local = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  return {
    executables: [
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ],
    userDataDir: path.join(local, "Google", "Chrome", "User Data"),
    linkPath: path.join(local, "MailCarrierChromeLink"),
  };
}

function findChromePath(candidates, exists) {
  return (candidates || []).find((candidate) => candidate && exists(candidate)) || "";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 20000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout || stderr || ""));
      }
    );
  });
}

function defaultChromeIsRunning(chromePath) {
  if (!chromePath || process.platform !== "win32") return Promise.resolve(false);
  const script = `
    $needle = ${quotePowerShell(chromePath)}
    $hit = $false
    Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | ForEach-Object {
      if ($_.ExecutablePath -and ($_.ExecutablePath -ieq $needle)) { $hit = $true }
    }
    if ($hit) { 'yes' } else { 'no' }
  `;
  return runPowerShell(script).then((output) => output.includes("yes")).catch(() => false);
}

function defaultSpawn(chromePath, args) {
  const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function chromeProcessesScript(chromePath, body) {
  return `
    $needle = ${quotePowerShell(chromePath)}
    Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | ForEach-Object {
      if ($_.ExecutablePath -and ($_.ExecutablePath -ieq $needle)) {
        ${body}
      }
    }
  `;
}

function defaultRequestChromeQuit(chromePath) {
  if (!chromePath || process.platform !== "win32") return Promise.resolve();
  const script = chromeProcessesScript(chromePath, `
    $proc = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($proc) { [void]$proc.CloseMainWindow() }
  `);
  return runPowerShell(script).catch(() => {});
}

function defaultForceChromeQuit(chromePath) {
  if (!chromePath || process.platform !== "win32") return Promise.resolve();
  const script = chromeProcessesScript(chromePath, `
    & taskkill.exe /PID $_.ProcessId /T /F | Out-Null
  `);
  return runPowerShell(script).catch(() => {});
}

// Approval-mode debugging is the Chrome 144+ switch on the real profile.
// It is not --remote-debugging-port, which Chrome refuses on this profile and
// which signs Google accounts out.
function writeDebuggingPref(userDataDir, io = fs) {
  const filePath = path.join(String(userDataDir || ""), "Local State");
  let stat;
  try {
    stat = io.statSync(filePath);
  } catch (error) {
    throw new Error("Chrome settings could not be read.");
  }
  if (stat.size > 20 * 1024 * 1024) throw new Error("Chrome settings are too large to update.");
  let data;
  try {
    data = JSON.parse(io.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error("Chrome settings could not be read.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Chrome settings could not be read.");
  }
  if (!data.devtools || typeof data.devtools !== "object" || Array.isArray(data.devtools)) data.devtools = {};
  const remote = data.devtools.remote_debugging;
  if (!remote || typeof remote !== "object" || Array.isArray(remote)) data.devtools.remote_debugging = {};
  if (data.devtools.remote_debugging["user-enabled"] === true) return false;
  data.devtools.remote_debugging["user-enabled"] = true;
  const tempPath = `${filePath}.mailcarrier-tmp`;
  io.writeFileSync(tempPath, JSON.stringify(data));
  io.copyFileSync(tempPath, filePath);
  io.rmSync(tempPath, { force: true });
  return true;
}

function samePath(left, right) {
  const a = path.resolve(String(left || ""));
  const b = path.resolve(String(right || ""));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function readDebugEndpoint(userDataDir, readFile = fs.readFileSync) {
  const root = String(userDataDir || "");
  if (!root) return null;
  let text = "";
  try {
    text = readFile(path.join(root, "DevToolsActivePort"), "utf8");
  } catch (error) {
    return null;
  }
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const port = Number(lines[0]);
  const wsPath = lines[1] || "";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^\/devtools\/browser(?:\/[A-Za-z0-9-]+)?$/.test(wsPath)) return null;
  return {
    port: String(port),
    browserWSEndpoint: `ws://127.0.0.1:${port}${wsPath}`,
  };
}

function listDebugPages(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/json/list`, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!Array.isArray(body)) {
            resolve([]);
            return;
          }
          resolve(body.filter((item) => item && item.type === "page" && item.id).map((item) => ({
            id: String(item.id),
            type: "page",
            url: String(item.url || ""),
            title: String(item.title || ""),
          })));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(800, () => request.destroy(new Error("timed out")));
    request.on("error", reject);
  });
}

function tcpOpen(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(port) });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function defaultJunctionInUse(linkPath) {
  if (!linkPath || process.platform !== "win32") return Promise.resolve(false);
  const script = `
    $needle = ${quotePowerShell(linkPath)}
    $hit = $false
    Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | ForEach-Object {
      if ($_.CommandLine -and ($_.CommandLine -like ('*' + $needle + '*'))) { $hit = $true }
    }
    if ($hit) { 'yes' } else { 'no' }
  `;
  return runPowerShell(script).then((output) => output.includes("yes")).catch(() => false);
}

// The old launcher created this junction so Chrome would accept a debug port
// on the real profile. That launch signs Gmail out. Remove the link only.
async function removeUnusedJunction(linkPath, userDataDir, inUse = defaultJunctionInUse) {
  if (!linkPath || !userDataDir || !fs.existsSync(linkPath)) return false;
  let stat;
  try {
    stat = fs.lstatSync(linkPath);
  } catch (error) {
    return false;
  }
  if (!stat.isSymbolicLink()) return false;
  let current = "";
  try {
    current = fs.readlinkSync(linkPath);
  } catch (error) {
    return false;
  }
  if (!samePath(current, userDataDir)) return false;
  if (await inUse(linkPath)) return false;
  fs.rmdirSync(linkPath);
  return true;
}

class ChromeProfiles {
  constructor(options = {}) {
    const locations = defaultLocations();
    this.userDataDir = options.userDataDir || locations.userDataDir;
    this.linkPath = options.linkPath || locations.linkPath;
    this.chromePath = options.chromePath || findChromePath(locations.executables, fs.existsSync);
    this.spawnChrome = options.spawnChrome || ((args) => defaultSpawn(this.chromePath, args));
    this.chromeIsRunning = options.chromeIsRunning || (() => defaultChromeIsRunning(this.chromePath));
    this.requestChromeQuit = options.requestChromeQuit || (() => defaultRequestChromeQuit(this.chromePath));
    this.forceChromeQuit = options.forceChromeQuit || (() => defaultForceChromeQuit(this.chromePath));
    this.quitChrome = options.quitChrome || (() => this.defaultQuitChrome());
    this.writeDebuggingPref = options.writeDebuggingPref || (() => writeDebuggingPref(this.userDataDir));
    this.junctionChromeIsRunning = options.junctionChromeIsRunning || (() => defaultJunctionInUse(this.linkPath));
    this.readEndpoint = options.readEndpoint || (() => readDebugEndpoint(this.userDataDir));
    this.endpointOpen = options.endpointOpen || ((endpoint) => tcpOpen(endpoint.port));
    this.listPages = options.listPages || (() => this.defaultListPages());
    this.listHttpPages = options.listHttpPages || ((port) => listDebugPages(port));
    this.closePage = options.closePage || ((targetId) => this.defaultClosePage(targetId));
    this.retireLink = options.retireLink || (() => removeUnusedJunction(this.linkPath, this.userDataDir, this.junctionChromeIsRunning));
    this.delay = options.delay || delay;
    this.debugWaitMs = options.debugWaitMs == null ? 20000 : options.debugWaitMs;
    this.pageWaitMs = options.pageWaitMs == null ? 90000 : options.pageWaitMs;
    this.showInbox = options.showInbox || (async () => {});
    this.onStatus = options.onStatus || (() => {});
    this.readProfiles = options.readProfiles || (() => readChromeProfiles(this.userDataDir));
    this.targets = new Map();
    this.openedTabs = new Map();
    this.activeEndpoint = "";
    this.tail = Promise.resolve();
    this.junctionClear = false;
    this.allowNoted = false;
  }

  async defaultQuitChrome() {
    if (!(await this.chromeIsRunning())) return;
    await this.requestChromeQuit();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!(await this.chromeIsRunning())) return;
      await this.delay(300);
    }
    await this.forceChromeQuit();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!(await this.chromeIsRunning())) return;
      await this.delay(300);
    }
    throw new ChromeDebugError("Chrome stayed open, so remote debugging could not be turned on. Close Chrome yourself and try again. Your Gmail accounts stay signed in.");
  }

  session(targetId, endpoint) {
    return {
      debugPort: String(endpoint.port),
      browserWSEndpoint: String(endpoint.browserWSEndpoint),
      targetId: String(targetId),
    };
  }

  async debugEndpoint() {
    let endpoint = null;
    try {
      endpoint = await this.readEndpoint();
    } catch (error) {
      return null;
    }
    if (!endpoint || !endpoint.port || !endpoint.browserWSEndpoint) return null;
    if (!/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser(?:\/[A-Za-z0-9-]+)?$/.test(endpoint.browserWSEndpoint)) return null;
    if (!(await this.endpointOpen(endpoint))) return null;
    return endpoint;
  }

  async defaultListPages() {
    const endpoint = await this.debugEndpoint();
    if (!endpoint) return [];
    const browser = await acquire({ browserWSEndpoint: endpoint.browserWSEndpoint });
    return pageSummaries(browser);
  }

  async defaultClosePage(targetId) {
    const endpoint = await this.debugEndpoint();
    if (!endpoint) return;
    const browser = await acquire({ browserWSEndpoint: endpoint.browserWSEndpoint });
    const target = findTarget(browser, targetId);
    if (!target || typeof target.page !== "function") return;
    const page = await target.page();
    if (!page || (typeof page.isClosed === "function" && page.isClosed())) return;
    await page.close({ runBeforeUnload: false });
  }

  closeOwned(directory) {
    const names = directory ? [String(directory)] : [...this.targets.keys()];
    return this.enqueue(async () => {
      let closed = false;
      for (const name of names) {
        if (!isSafeProfileDirectory(name) || !this.targets.has(name)) continue;
        const targetId = this.targets.get(name);
        this.targets.delete(name);
        try {
          await this.closePage(targetId);
          closed = true;
        } catch (error) {
          // The window can already be gone. Chrome itself stays as it was.
        }
      }
      return closed;
    });
  }

  rememberEndpoint(endpoint) {
    const key = endpoint ? endpoint.browserWSEndpoint : "";
    if (key !== this.activeEndpoint) {
      this.targets.clear();
      this.openedTabs.clear();
      this.activeEndpoint = key;
    }
  }

  async closeOlderOpened(directory, keepId) {
    const key = String(directory || "");
    const keep = String(keepId || "");
    const set = this.openedTabs.get(key) || new Set();
    for (const id of [...set]) {
      if (!id || id === keep) continue;
      set.delete(id);
      try {
        await this.closePage(id);
      } catch (error) {
        // The extra tab can already be gone.
      }
    }
    if (keep) set.add(keep);
    this.openedTabs.set(key, set);
  }

  async list() {
    let profiles = [];
    try {
      profiles = this.readProfiles();
    } catch (error) {
      return { profiles: [], sessionOpen: false, error: error.message };
    }
    const endpoint = profiles.length ? await this.debugEndpoint() : null;
    this.rememberEndpoint(endpoint);
    let pages = [];
    if (endpoint) {
      try {
        pages = await this.listHttpPages(endpoint.port);
      } catch (error) {
        pages = [];
      }
    }
    const openPageIds = new Set((pages || []).map((page) => page && page.id).filter(Boolean));
    const sessionOpen = Boolean(endpoint);
    return {
      profiles: profiles.map((profile) => {
        let targetId = this.targets.get(profile.profileDirectory) || "";
        if (endpoint && targetId && openPageIds.size && !openPageIds.has(targetId)) {
          this.targets.delete(profile.profileDirectory);
          targetId = "";
        }
        if (endpoint && !targetId) {
          targetId = this.matchingOpenPage(profile.profileDirectory, pages);
          if (targetId) this.targets.set(profile.profileDirectory, targetId);
        }
        const attached = Boolean(endpoint && targetId);
        return {
          ...profile,
          running: attached,
          debugPort: attached ? String(endpoint.port) : "",
          browserWSEndpoint: attached ? endpoint.browserWSEndpoint : "",
          targetId: attached ? targetId : "",
        };
      }),
      sessionOpen,
      error: "",
    };
  }

  enqueue(task) {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => {}, () => {});
    return run;
  }

  ensureProfile(directory, gmailIndex = 0) {
    const name = String(directory || "");
    if (!isSafeProfileDirectory(name)) return Promise.reject(new Error("That Chrome profile is not valid."));
    const index = Number.isInteger(Number(gmailIndex)) && Number(gmailIndex) >= 0 ? Number(gmailIndex) : 0;
    return this.enqueue(() => this._ensureProfile(name, index));
  }

  profileArgs(directory, url) {
    return [
      `--profile-directory=${directory}`,
      "--no-first-run",
      "--no-default-browser-check",
      url,
    ];
  }

  noteAllow() {
    if (this.allowNoted) return;
    this.allowNoted = true;
    this.onStatus("Mail Carrier presses Allow in the background if Chrome asks. The desktop you are using stays put, and Gmail stays signed in.");
  }

  async visiblePages() {
    try {
      return await this.listPages();
    } catch (error) {
      if (/did not allow debugging/i.test(String(error && error.message))) {
        throw new ChromeDebugError("Mail Carrier could not press Allow in Chrome. Press Resume to try again. Gmail stays signed in.");
      }
      throw error;
    }
  }

  async waitForEndpoint(timeoutMs) {
    const started = Date.now();
    while (true) {
      const endpoint = await this.debugEndpoint();
      if (endpoint) return endpoint;
      if (Date.now() - started >= timeoutMs) return null;
      await this.delay(400);
    }
  }

  async assertRealProfile() {
    if (this.junctionClear) return;
    if (await this.junctionChromeIsRunning()) {
      throw new Error("Close the Chrome window Mail Carrier opened earlier, then open Chrome normally and try again. Mail Carrier will not force-close Chrome.");
    }
    this.junctionClear = true;
    try {
      await this.retireLink();
    } catch (error) {
      // Opening the real Chrome profile does not depend on deleting the old link.
    }
  }

  isInboxUrl(url, index) {
    const text = String(url || "");
    if (!/mail\.google\.com\/mail/i.test(text)) return false;
    const match = text.match(/\/mail\/u\/(\d+)/);
    return Boolean(match) && Number(match[1]) === Number(index);
  }

  pickMailbox(pages, index, blockedIds) {
    const blocked = blockedIds || new Set();
    const list = Array.isArray(pages) ? pages : [];
    const inbox = list.filter((page) => page && page.id && !blocked.has(page.id) && this.isInboxUrl(page.url, index));
    return inbox.length ? inbox[inbox.length - 1] : null;
  }

  profileEmails(directory) {
    try {
      const profiles = this.readProfiles();
      const profile = (profiles || []).find((item) => item.profileDirectory === directory);
      return (profile?.hintAccounts || [])
        .map((account) => String(account.email || "").trim().toLowerCase())
        .filter((email) => email.includes("@"));
    } catch (error) {
      return [];
    }
  }

  matchingOpenPage(directory, httpPages) {
    if (!httpPages || !httpPages.length) return "";
    const emails = this.profileEmails(directory);
    if (!emails.length) return "";
    for (const page of httpPages || []) {
      const text = `${page.title || ""} ${page.url || ""}`.toLowerCase();
      if (emails.some((email) => text.includes(email))) return String(page.id || "");
    }
    return "";
  }

  async revealInbox(session, index) {
    this.onStatus("The selected Gmail inbox is open. Sending starts now.");
    try {
      await this.showInbox(session, index);
    } catch (error) {
      if (error && (error.code === "CHROME_DEBUG" || error.fatal)) throw error;
    }
  }

  async _ensureProfile(directory, gmailIndex) {
    if (!this.chromePath) throw new Error("Google Chrome is not installed.");
    await this.assertRealProfile();
    const index = Number(gmailIndex) || 0;
    let endpoint = await this.debugEndpoint();
    this.rememberEndpoint(endpoint);
    if (endpoint) {
      const cached = this.targets.get(directory);
      if (cached) {
        try {
          const openPages = await this.visiblePages();
          if (openPages.some((page) => page.id === cached)) {
            const session = this.session(cached, endpoint);
            await this.revealInbox(session, index);
            await this.closeOlderOpened(directory, cached);
            return session;
          }
        } catch (error) {
          if (error instanceof ChromeDebugError) throw error;
          // A failed tab list used to open another tab. Keep the one already tracked.
          try {
            const session = this.session(cached, endpoint);
            await this.revealInbox(session, index);
            return session;
          } catch (revealError) {
            if (revealError instanceof ChromeDebugError) throw revealError;
            this.targets.delete(directory);
          }
        }
      }
    }

    const inboxUrl = `https://mail.google.com/mail/u/${index}/#inbox?compose=new`;
    const blocked = new Set();
    for (const [dir, id] of this.targets) {
      if (dir !== directory) blocked.add(id);
    }
    if (endpoint) {
      let httpPages = [];
      try {
        httpPages = await this.listHttpPages(endpoint.port);
      } catch (error) {
        httpPages = [];
      }
      const matched = this.matchingOpenPage(directory, httpPages);
      if (matched && !blocked.has(matched)) {
        this.targets.set(directory, matched);
        const session = this.session(matched, endpoint);
        await this.revealInbox(session, index);
        await this.closeOlderOpened(directory, matched);
        return session;
      }
      const remembered = this.openedTabs.get(directory) || new Set();
      const alive = httpPages.find((page) => page && page.id && remembered.has(page.id) && !blocked.has(page.id));
      if (alive) {
        this.targets.set(directory, alive.id);
        const session = this.session(alive.id, endpoint);
        await this.revealInbox(session, index);
        await this.closeOlderOpened(directory, alive.id);
        return session;
      }
      for (const page of httpPages) {
        if (page && page.id) blocked.add(page.id);
      }
    }
    if (!endpoint) {
      this.onStatus("Remote debugging is off. Mail Carrier is turning it on in this Chrome. Gmail stays signed in.");
      await this.quitChrome();
      try {
        await this.writeDebuggingPref();
      } catch (error) {
        throw new ChromeDebugError(`Could not turn on remote debugging. ${error.message}`);
      }
    }
    this.spawnChrome(this.profileArgs(directory, inboxUrl));
    if (!endpoint) {
      endpoint = await this.waitForEndpoint(this.debugWaitMs);
      this.rememberEndpoint(endpoint);
      if (!endpoint) throw new ChromeDebugError();
    }
    this.noteAllow();
    const created = await this.waitForPage((page, pages) => {
      const chosen = this.pickMailbox(pages, index, blocked);
      return Boolean(chosen) && chosen.id === page.id;
    }, this.pageWaitMs);
    if (!created) throw new Error("Chrome did not open this Gmail inbox.");
    this.targets.set(directory, created.id);
    await this.closeOlderOpened(directory, created.id);
    const session = this.session(created.id, endpoint);
    await this.revealInbox(session, index);
    return session;
  }

  async waitForPage(accept, timeoutMs) {
    const started = Date.now();
    let lastDebugError = null;
    while (Date.now() - started < timeoutMs) {
      try {
        const pages = await this.visiblePages();
        const match = pages.find((page) => accept(page, pages));
        if (match) return match;
        lastDebugError = null;
      } catch (error) {
        if (!(error instanceof ChromeDebugError)) throw error;
        lastDebugError = error;
      }
      await this.delay(250);
    }
    if (lastDebugError) throw lastDebugError;
    return null;
  }
}

module.exports = {
  ChromeProfiles,
  ChromeDebugError,
  chromeEnvId,
  directoryFromChromeId,
  isChromeEnvId,
  isSafeProfileDirectory,
  profileLabel,
  readChromeProfiles,
  readDebugEndpoint,
  removeUnusedJunction,
  writeDebuggingPref,
  CHROME_GROUP,
};
