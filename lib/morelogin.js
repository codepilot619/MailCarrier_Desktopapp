const http = require("http");
const https = require("https");

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error("Enter a MoreLogin API address such as http://127.0.0.1:40000");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The MoreLogin API address must start with http:// or https://");
  }
  return parsed.origin;
}

// MoreLogin ids are 64-bit integers. Parsing them as JSON numbers would round them.
function parseMoreLoginJson(text) {
  const cleaned = String(text || "").replace(/^\uFEFF/, "");
  const safe = cleaned.replace(/([:\[,]\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(safe);
}

function postJson(url, headers, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }

    const lib = target.protocol === "https:" ? https : http;
    const payload = JSON.stringify(body ?? {});
    const request = lib.request(
      {
        method: "POST",
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(Object.assign(new Error("MoreLogin request timed out"), { code: "ETIMEDOUT" }));
    });
    request.on("error", (error) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND" || error.code === "ECONNRESET") {
        reject(new Error("Cannot reach MoreLogin. Open the MoreLogin app, sign in, and check the API port (default 40000)."));
        return;
      }
      reject(error);
    });
    request.write(payload);
    request.end();
  });
}

function asId(value) {
  if (value == null || value === "") return "";
  return String(value);
}

function asOptionalNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeProfile(raw) {
  return {
    envId: asId(raw.id ?? raw.envId),
    envName: raw.envName || raw.name || "Untitled profile",
    uniqueId: asOptionalNumber(raw.uniqueId ?? raw.serialNumber),
    groupName: raw.groupName || "",
  };
}

function normalizeOpenBrowser(raw) {
  return {
    envId: asId(raw.envId ?? raw.id),
    envName: raw.envName || raw.name || "",
    uniqueId: asOptionalNumber(raw.uniqueId),
    debugPort: raw.debugPort ? String(raw.debugPort) : "",
  };
}

function compareProfiles(a, b) {
  if (Boolean(a.running) !== Boolean(b.running)) return a.running ? -1 : 1;
  const au = a.uniqueId == null ? Number.MAX_SAFE_INTEGER : Number(a.uniqueId);
  const bu = b.uniqueId == null ? Number.MAX_SAFE_INTEGER : Number(b.uniqueId);
  if (au !== bu) return au - bu;
  return String(a.envName).localeCompare(String(b.envName));
}

function mergeProfileLists(profiles, openBrowsers) {
  const byId = new Map();
  for (const profile of profiles) {
    if (!profile.envId) continue;
    byId.set(profile.envId, {
      envId: profile.envId,
      envName: profile.envName || "Untitled profile",
      uniqueId: profile.uniqueId ?? null,
      groupName: profile.groupName || "",
      running: false,
      debugPort: "",
    });
  }

  for (const open of openBrowsers) {
    const envId = asId(open.envId);
    if (!envId) continue;
    const current = byId.get(envId) || {
      envId,
      envName: open.envName || "Open browser",
      uniqueId: open.uniqueId ?? null,
      groupName: "",
      running: false,
      debugPort: "",
    };
    current.running = Boolean(open.debugPort);
    current.debugPort = open.debugPort ? String(open.debugPort) : "";
    if (open.envName && (!current.envName || current.envName === "Untitled profile" || current.envName === "Open browser")) {
      current.envName = open.envName;
    }
    if (current.uniqueId == null && open.uniqueId != null) current.uniqueId = open.uniqueId;
    byId.set(envId, current);
  }

  return [...byId.values()].sort(compareProfiles);
}

function asList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.dataList)) return data.dataList;
  if (Array.isArray(data?.list)) return data.list;
  return [];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evasionRejected(error) {
  return /cdpEvasion|parameter|not support|unsupported|invalid|unrecognized|unknown/i.test(String(error && error.message || ""));
}

class MoreLoginClient {
  constructor({ baseUrl, token, request, onStatus, delay: wait } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl || "http://127.0.0.1:40000");
    this.token = String(token || "").trim();
    this.request = request || postJson;
    this.onStatus = onStatus || (() => {});
    this.delay = wait || delay;
    this.stable = new Set();
    this.tails = new Map();
  }

  headers() {
    const headers = {};
    if (this.token) headers.Authorization = this.token;
    return headers;
  }

  async post(pathname, body, timeoutMs) {
    const response = await this.request(`${this.baseUrl}${pathname}`, this.headers(), body ?? {}, timeoutMs);
    if (!response || response.status < 200 || response.status >= 300) {
      throw new Error(`MoreLogin returned HTTP ${response?.status || "error"}.`);
    }

    let payload;
    try {
      payload = parseMoreLoginJson(response.text);
    } catch (error) {
      throw new Error("MoreLogin returned a response that was not JSON.");
    }
    if (payload.code !== 0) {
      const failure = new Error(payload.msg || `MoreLogin error ${payload.code}`);
      failure.code = payload.code;
      throw failure;
    }
    return payload;
  }

  async listOpenBrowsers() {
    const payload = await this.post("/api/env/getAllDebugInfo", {});
    return asList(payload.data).map(normalizeOpenBrowser).filter((item) => item.envId);
  }

  async listProfiles() {
    const pageSize = 50;
    const profiles = [];
    const seen = new Set();

    for (let pageNo = 1; pageNo <= 200; pageNo += 1) {
      const payload = await this.post("/api/env/page", { pageNo, pageSize });
      const data = payload.data || {};
      const rows = asList(data);
      if (!rows.length) break;

      let added = 0;
      for (const raw of rows) {
        const profile = normalizeProfile(raw);
        if (!profile.envId || seen.has(profile.envId)) continue;
        seen.add(profile.envId);
        profiles.push(profile);
        added += 1;
      }
      if (!added) break;

      const total = Number(data.total ?? data.totalCount);
      const knowTotal = Number.isFinite(total) && total >= 0;
      if (knowTotal && profiles.length >= total) break;
      if (rows.length < pageSize && !(knowTotal && profiles.length < total)) break;
    }

    let open = [];
    let openError = "";
    try {
      open = await this.listOpenBrowsers();
    } catch (error) {
      openError = error.message;
    }
    return { profiles: mergeProfileLists(profiles, open), openError };
  }

  async profileStatus(envId) {
    const payload = await this.post("/api/env/status", { envId: String(envId) });
    const data = payload.data || {};
    return {
      envId: asId(data.envId || envId),
      status: data.status || "",
      localStatus: data.localStatus || "",
      debugPort: data.debugPort ? String(data.debugPort) : "",
    };
  }

  async startProfile(envId, options = {}) {
    const body = { envId: String(envId) };
    if (options.cdpEvasion) body.cdpEvasion = true;
    const payload = await this.post("/api/env/start", body, 120000);
    const data = payload.data || {};
    return {
      envId: asId(data.envId || envId),
      debugPort: data.debugPort ? String(data.debugPort) : "",
    };
  }

  // MoreLogin's CDP evasion flag is applied when the profile process starts.
  // It hides the debugger from the page so Google does not drop the Gmail session.
  async startKeepingSignIn(envId) {
    try {
      return await this.startProfile(envId, { cdpEvasion: true });
    } catch (error) {
      if (!evasionRejected(error)) throw error;
      return await this.startProfile(envId);
    }
  }

  async openPort(envId) {
    const open = await this.listOpenBrowsers().catch(() => []);
    const existing = open.find((item) => item.envId === envId && item.debugPort);
    return existing ? existing.debugPort : "";
  }

  ensureDebugPort(envId) {
    const id = String(envId);
    const prior = this.tails.get(id) || Promise.resolve();
    const run = prior.then(() => this.prepareDebugPort(id), () => this.prepareDebugPort(id));
    this.tails.set(id, run.then(() => {}, () => {}));
    return run;
  }

  async prepareDebugPort(envId) {
    const id = String(envId);
    const existing = await this.openPort(id);
    if (existing) {
      this.stable.add(id);
      return existing;
    }

    try {
      const started = await this.startKeepingSignIn(id);
      if (started.debugPort) {
        this.stable.add(id);
        return started.debugPort;
      }
    } catch (error) {
      const status = await this.profileStatus(id).catch(() => null);
      if (status?.debugPort) {
        this.stable.add(id);
        return status.debugPort;
      }
      throw error;
    }

    const status = await this.profileStatus(id).catch(() => null);
    if (status?.debugPort) {
      this.stable.add(id);
      return status.debugPort;
    }
    throw new Error("MoreLogin did not return a debug port for this profile.");
  }
}

module.exports = {
  MoreLoginClient,
  normalizeBaseUrl,
  parseMoreLoginJson,
  normalizeProfile,
  mergeProfileLists,
  postJson,
};
