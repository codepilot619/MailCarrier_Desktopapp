const fs = require("fs");
const https = require("https");
const path = require("path");

const STATUS_ORDER = ["Active", "Warming up", "Paused", "Blocked"];
const EMAIL_HEADERS = ["email", "e-mail", "email address"];
const STATUS_HEADERS = ["status"];
const MAX_STATUS_BYTES = 8 * 1024 * 1024;
const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".xls", ".xlsm", ".xlsb", ".ods"]);

function exportUrlFromSheetLink(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch (error) {
    throw new Error("Use a Google Sheets link.");
  }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com") {
    throw new Error("Use a Google Sheets link.");
  }
  const match = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) throw new Error("That link is not a Google Sheet.");
  const hashGid = (url.hash.match(/gid=(\d+)/) || [])[1];
  const gid = url.searchParams.get("gid") || hashGid || "0";
  if (!/^\d+$/.test(gid)) throw new Error("That sheet tab link is not valid.");
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`;
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function headerIndex(header, names) {
  const wanted = new Set(names);
  return header.findIndex((name) => wanted.has(name));
}

function statusesFromTable(rows, missingMessage = "The file needs Email and Status columns.") {
  const list = Array.isArray(rows) ? rows : [];
  const limit = Math.min(list.length, 20);
  let headerRow = -1;
  let emailIndex = -1;
  let statusIndex = -1;
  for (let i = 0; i < limit; i += 1) {
    const header = (list[i] || []).map((cell) => String(cell || "").trim().toLowerCase());
    const email = headerIndex(header, EMAIL_HEADERS);
    const status = headerIndex(header, STATUS_HEADERS);
    if (email >= 0 && status >= 0) {
      headerRow = i;
      emailIndex = email;
      statusIndex = status;
      break;
    }
  }
  if (headerRow < 0) throw new Error(missingMessage);
  const map = {};
  for (const row of list.slice(headerRow + 1)) {
    const email = String(row[emailIndex] || "").trim().toLowerCase();
    if (!isEmailAddress(email)) continue;
    const status = String(row[statusIndex] || "").trim().slice(0, 40);
    if (!status) continue;
    map[email] = status;
  }
  return map;
}

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function statusesFromCsv(text) {
  return statusesFromTable(parseDelimited(text, ","), "The sheet needs Email and Status columns.");
}

function cleanStatusMap(value) {
  const next = {};
  if (!value || typeof value !== "object") return next;
  for (const [email, status] of Object.entries(value)) {
    const key = String(email || "").trim().toLowerCase();
    const label = String(status || "").trim().slice(0, 40);
    if (!isEmailAddress(key) || !label) continue;
    next[key] = label;
  }
  return next;
}

function cleanStatusOverrides(value) {
  const next = {};
  if (!value || typeof value !== "object") return next;
  for (const [email, status] of Object.entries(value)) {
    const key = String(email || "").trim().toLowerCase();
    if (!isEmailAddress(key)) continue;
    next[key] = String(status || "").trim().slice(0, 40);
  }
  return next;
}

function mergeGmailStatus(base, overrides) {
  const next = cleanStatusMap(base);
  for (const [email, status] of Object.entries(cleanStatusOverrides(overrides))) {
    if (status) next[email] = status;
    else delete next[email];
  }
  return next;
}

function statusChoices(map) {
  const found = new Set(Object.values(map || {}).map((status) => String(status || "").trim()).filter(Boolean));
  const ordered = STATUS_ORDER.filter((status) => found.has(status));
  const extra = [...found].filter((status) => !STATUS_ORDER.includes(status)).sort((a, b) => a.localeCompare(b));
  return [...ordered, ...extra];
}

function allowedSheetHost(hostname) {
  return hostname === "docs.google.com"
    || hostname === "drive.google.com"
    || hostname.endsWith(".googleusercontent.com");
}

function fetchSheetText(url, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(new Error("Use a Google Sheets link."));
      return;
    }
    if (parsed.protocol !== "https:" || !allowedSheetHost(parsed.hostname)) {
      reject(new Error("Use a Google Sheets link."));
      return;
    }
    const request = https.get(parsed, { headers: { "User-Agent": "MailCarrier" } }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error("The status sheet redirected too many times."));
          return;
        }
        const next = new URL(response.headers.location, parsed);
        if (next.hostname === "accounts.google.com") {
          reject(new Error("The status sheet is not shared for viewing."));
          return;
        }
        resolve(fetchSheetText(next.toString(), redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`The status sheet returned HTTP ${status}.`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 3 * 1024 * 1024) {
          request.destroy();
          reject(new Error("The status sheet is too large."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.setTimeout(20000, () => {
      request.destroy();
      reject(new Error("The status sheet timed out."));
    });
    request.on("error", () => reject(new Error("Could not reach the status sheet.")));
  });
}

async function loadStatusMap(sheetUrl, fetchText = fetchSheetText) {
  const csv = await fetchText(exportUrlFromSheetLink(sheetUrl));
  if (/^\s*</.test(String(csv || ""))) {
    throw new Error("The status sheet is not shared for viewing.");
  }
  return statusesFromCsv(csv);
}

function workbookSource(source) {
  if (Buffer.isBuffer(source)) return source;
  if (source instanceof Uint8Array) return Buffer.from(source);
  return null;
}

function statusesFromWorkbook(source) {
  const XLSX = require("xlsx");
  let workbook;
  try {
    const buffer = workbookSource(source);
    workbook = buffer ? XLSX.read(buffer, { type: "buffer" }) : XLSX.readFile(source);
  } catch (error) {
    throw new Error("Could not read that spreadsheet.");
  }
  if (!workbook.SheetNames.length) throw new Error("That file has no sheet.");
  let lastError = null;
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      defval: "",
      raw: false,
    });
    try {
      return statusesFromTable(rows);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("The file needs Email and Status columns.");
}

function statusesFromText(text) {
  const source = String(text || "");
  try {
    return statusesFromTable(parseDelimited(source, ","));
  } catch (error) {
    if (source.includes("\t")) return statusesFromTable(parseDelimited(source, "\t"));
    throw error;
  }
}

function statusesFromFile(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) throw new Error("Choose a file.");
  const resolved = path.resolve(raw);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    throw new Error("The status file was not found.");
  }
  if (!stat.isFile()) throw new Error("Choose a file.");
  if (stat.size > MAX_STATUS_BYTES) throw new Error("That file is larger than 8MB.");
  if (stat.size === 0) throw new Error("That file is empty.");
  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".csv" || ext === ".txt" || ext === ".tsv") {
    return statusesFromText(fs.readFileSync(resolved, "utf8"));
  }
  if (SPREADSHEET_EXTENSIONS.has(ext)) return statusesFromWorkbook(resolved);
  try {
    return statusesFromWorkbook(resolved);
  } catch (error) {
    const buffer = fs.readFileSync(resolved);
    if (buffer.includes(0)) throw new Error("Could not read that file. Use a csv, Excel, or other spreadsheet.");
    return statusesFromText(buffer.toString("utf8"));
  }
}

function isGoogleSheetUrl(input) {
  try {
    const url = new URL(String(input || "").trim());
    return url.protocol === "https:" && url.hostname === "docs.google.com" && /\/spreadsheets\/d\//.test(url.pathname);
  } catch (error) {
    return false;
  }
}

function looksLikeHtml(buffer) {
  const start = buffer.slice(0, 80).toString("utf8").trim().toLowerCase();
  return start.startsWith("<!doctype") || start.startsWith("<html") || start.startsWith("<");
}

function looksLikeSpreadsheet(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return true;
  if (buffer.length >= 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) return true;
  return false;
}

function fetchHttpsBytes(url, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(new Error("Enter an https link."));
      return;
    }
    if (parsed.protocol !== "https:" || !parsed.hostname) {
      reject(new Error("Enter an https link."));
      return;
    }
    if (parsed.username || parsed.password) {
      reject(new Error("Enter an https link without a password in it."));
      return;
    }
    const request = https.get(parsed, { headers: { "User-Agent": "MailCarrier" } }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error("That link redirected too many times."));
          return;
        }
        const next = new URL(response.headers.location, parsed);
        if (next.protocol !== "https:") {
          reject(new Error("That link redirected away from https."));
          return;
        }
        resolve(fetchHttpsBytes(next.toString(), redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`That link returned HTTP ${status}.`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_STATUS_BYTES) {
          request.destroy();
          reject(new Error("That file is larger than 8MB."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });
    request.setTimeout(20000, () => {
      request.destroy();
      reject(new Error("That link timed out."));
    });
    request.on("error", () => reject(new Error("Could not reach that link.")));
  });
}

async function loadStatusFromUrl(input, fetchText = fetchSheetText, fetchBytes = fetchHttpsBytes) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Enter a link.");
  if (raw.length > 2000) throw new Error("That link is too long.");
  if (isGoogleSheetUrl(raw)) return loadStatusMap(raw, fetchText);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new Error("Enter an https link.");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) throw new Error("Enter an https link.");
  const body = await fetchBytes(raw);
  const buffer = Buffer.isBuffer(body) || body instanceof Uint8Array
    ? Buffer.from(body)
    : Buffer.from(String(body));
  if (!buffer.length) throw new Error("That link returned an empty file.");
  if (looksLikeHtml(buffer)) {
    throw new Error("That link did not return a spreadsheet.");
  }
  const name = parsed.pathname.toLowerCase();
  if (looksLikeSpreadsheet(buffer) || SPREADSHEET_EXTENSIONS.has(path.extname(name))) {
    return statusesFromWorkbook(buffer);
  }
  return statusesFromText(buffer.toString("utf8"));
}

module.exports = {
  STATUS_ORDER,
  cleanStatusMap,
  cleanStatusOverrides,
  mergeGmailStatus,
  exportUrlFromSheetLink,
  loadStatusFromUrl,
  loadStatusMap,
  fetchSheetText,
  statusChoices,
  statusesFromCsv,
  statusesFromFile,
};
