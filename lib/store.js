const fs = require("fs");
const path = require("path");
const { analysisRecord } = require("./analyse");
const { normalizeClients, normalizeSteps, normalizeWarmupPlan } = require("./clients");
const { cleanStatusOverrides, mergeGmailStatus } = require("./sheet-status");
const { normalizeConnections } = require("./peer-warmup");

function defaults() {
  return {
    settings: {
      apiBase: "http://127.0.0.1:40000",
      apiToken: "",
      language: "en",
      intervalSeconds: 600,
      betweenAccountSeconds: 10,
      startDelaySeconds: 60,
      scheduleAnchor: "",
      scheduleGapSeconds: 3600,
      defaultLimit: 20,
      mentionAttachment: true,
      useCustomTemplates: false,
      customSubjects: [],
      customBodies: [],
      customReplies: [],
      useCustomReplies: false,
      customFollowups: [],
      useCustomFollowups: false,
      useCustomWarmupIndex: false,
      warmupIndex: "",
      browserSource: "morelogin",
    },
    warmup: {
      email: "",
      company: "",
      clientName: "",
      intervalSeconds: 600,
      peerIntervalSeconds: 600,
      peerPeriods: 1,
      selectedId: "",
      businesses: [],
    },
    followup: {
      body: "Hi,\n\nJust following up on my previous email.\n\nBest regards,\n{sender}",
      intervalSeconds: 600,
      date: "",
    },
    analysis: {
      from: "",
      to: "",
      limit: 40,
      counts: {},
      contacts: [],
      updatedAt: 0,
    },
    contacts: [],
    clients: {},
    history: null,
    sendLog: { warmup: {}, followup: {}, contacts: {} },
    accountPrefs: {},
    cvs: {},
    senderNames: {},
    detectedGmail: {},
    gmailStatus: {},
    gmailStatusOverrides: {},
    gmailConnections: [],
    hiddenProfileIds: [],
    campaign: null,
    campaigns: {},
  };
}

function storedSettings(saved) {
  const settings = { ...defaults().settings, ...(saved || {}) };
  delete settings.sheetUrl;
  delete settings.statusMode;
  delete settings.statusFilePath;
  delete settings.statusFileName;
  const between = Number(settings.betweenAccountSeconds);
  settings.betweenAccountSeconds = between >= 10 && between <= 86400 ? Math.round(between) : 10;
  return settings;
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = defaults();
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.data = {
        ...defaults(),
        ...parsed,
        settings: storedSettings(parsed.settings),
        warmup: warmupRecord(parsed.warmup),
        followup: followupRecord(parsed.followup),
        analysis: analysisRecord(parsed.analysis),
        clients: normalizeClients(parsed.clients),
        sendLog: normalizeSendLog(parsed.sendLog),
        accountPrefs: parsed.accountPrefs || {},
        cvs: storedCvs(parsed),
        senderNames: normalizeSenderNames(parsed.senderNames),
        detectedGmail: parsed.detectedGmail || {},
        gmailStatus: mergeGmailStatus(parsed.gmailStatus, parsed.gmailStatusOverrides),
        gmailStatusOverrides: cleanStatusOverrides(parsed.gmailStatusOverrides),
        gmailConnections: normalizeConnections(parsed.gmailConnections),
        hiddenProfileIds: Array.isArray(parsed.hiddenProfileIds) ? parsed.hiddenProfileIds.map(String) : [],
        campaigns: (() => {
          const bag = parsed.campaigns && typeof parsed.campaigns === "object" ? { ...parsed.campaigns } : {};
          if (parsed.campaign && !bag.campaign) bag.campaign = parsed.campaign;
          return bag;
        })(),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    try {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      fs.copyFileSync(tmp, this.filePath);
      fs.unlinkSync(tmp);
    }
  }
}

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function normalizeSendAt(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return 0;
  return Math.round(time);
}

function localDayKey(now = Date.now()) {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function sentTodayBook(data, now = Date.now()) {
  const day = localDayKey(now);
  const book = data?.sentToday;
  if (!book || book.day !== day || !book.counts || typeof book.counts !== "object") {
    return { day, counts: {} };
  }
  return book;
}

function sentTodayCount(data, accountKey, now = Date.now()) {
  const book = sentTodayBook(data, now);
  if (book.day !== localDayKey(now)) return 0;
  return Math.max(0, Number(book.counts[String(accountKey || "")]) || 0);
}

function recordDailySend(data, accountKey, now = Date.now()) {
  const book = sentTodayBook(data, now);
  const key = String(accountKey || "");
  book.counts[key] = (Number(book.counts[key]) || 0) + 1;
  data.sentToday = book;
  return book.counts[key];
}

const MAX_SEND_LOG_DAYS = 366;

function sendLogKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (isEmailAddress(text)) return text.toLowerCase().slice(0, 320);
  return text.slice(0, 200);
}

function countOf(value) {
  const number = Math.round(Number(value) || 0);
  if (number < 1) return 0;
  return Math.min(100000, number);
}

function dayKey(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function normalizeDayCounts(raw) {
  const days = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return days;
  const entries = Object.entries(raw)
    .filter(([day, count]) => dayKey(day) && countOf(count))
    .map(([day, count]) => [day, countOf(count)])
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, MAX_SEND_LOG_DAYS);
  for (const [day, count] of entries) days[day] = count;
  return days;
}

function dayMapTotal(raw) {
  return Object.values(normalizeDayCounts(raw)).reduce((sum, count) => sum + count, 0);
}

function normalizeWarmupTotals(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (Object.prototype.hasOwnProperty.call(raw, "sent") || Object.prototype.hasOwnProperty.call(raw, "replies")) {
    const sent = countOf(raw.sent);
    const replies = countOf(raw.replies);
    return sent || replies ? { sent, replies } : null;
  }
  const sent = dayMapTotal(raw);
  return sent ? { sent, replies: 0 } : null;
}

function normalizeFollowupRows(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const keys = Object.keys(raw);
  const legacyDays = keys.length > 0 && keys.every((key) => dayKey(key));
  const source = {};
  if (legacyDays) {
    for (const [day, count] of Object.entries(raw)) source[`|${day}`] = count;
  } else {
    Object.assign(source, raw);
  }
  const rows = {};
  const entries = Object.entries(source)
    .map(([id, count]) => {
      const parts = String(id).split("|");
      if (parts.length !== 2) return null;
      const selected = dayKey(parts[0]);
      const sent = dayKey(parts[1]);
      const amount = countOf(count);
      if (!sent || !amount) return null;
      return [`${selected}|${sent}`, amount, sent, selected];
    })
    .filter(Boolean)
    .sort((a, b) => (a[2] < b[2] ? 1 : a[2] > b[2] ? -1 : (a[3] < b[3] ? 1 : -1)))
    .slice(0, MAX_SEND_LOG_DAYS);
  for (const [id, amount] of entries) rows[id] = amount;
  return rows;
}

function addWarmup(target, key, totals) {
  if (!key || !totals) return;
  const current = target[key] || { sent: 0, replies: 0 };
  const sent = current.sent + totals.sent;
  const replies = current.replies + totals.replies;
  if (sent || replies) target[key] = { sent, replies };
}

function normalizeSendLog(raw) {
  const next = { warmup: {}, followup: {}, contacts: {} };
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const warmupRows = source.warmup && typeof source.warmup === "object" && !Array.isArray(source.warmup) ? source.warmup : {};
  const peerRows = source.peer && typeof source.peer === "object" && !Array.isArray(source.peer) ? source.peer : {};
  for (const [rawKey, value] of Object.entries(warmupRows)) {
    addWarmup(next.warmup, sendLogKey(rawKey), normalizeWarmupTotals(value));
  }
  for (const [rawKey, value] of Object.entries(peerRows)) {
    const key = sendLogKey(rawKey);
    const sent = dayMapTotal(value);
    if (key && sent) addWarmup(next.warmup, key, { sent, replies: 0 });
  }
  const followupRows = source.followup && typeof source.followup === "object" && !Array.isArray(source.followup) ? source.followup : {};
  for (const [rawKey, value] of Object.entries(followupRows)) {
    const key = sendLogKey(rawKey);
    const rows = normalizeFollowupRows(value);
    if (key && Object.keys(rows).length) next.followup[key] = rows;
  }
  const contactRows = source.contacts && typeof source.contacts === "object" && !Array.isArray(source.contacts) ? source.contacts : {};
  for (const [rawKey, value] of Object.entries(contactRows)) {
    const key = sendLogKey(rawKey);
    const days = normalizeDayCounts(value);
    if (key && Object.keys(days).length) next.contacts[key] = days;
  }
  return next;
}

function recordKindSend(data, kind, emailOrKey, now = Date.now(), detail = {}) {
  const key = sendLogKey(emailOrKey);
  if (!data || !key) return 0;
  const log = normalizeSendLog(data.sendLog);
  const day = localDayKey(now);
  if (kind === "warmup" || kind === "peer" || kind === "peer-warmup") {
    const current = log.warmup[key] || { sent: 0, replies: 0 };
    if (detail && detail.reply) current.replies += 1;
    else current.sent += 1;
    log.warmup[key] = current;
    data.sendLog = log;
    return detail && detail.reply ? current.replies : current.sent;
  }
  if (kind === "followup") {
    const selected = dayKey(detail && detail.selectedDate);
    const id = `${selected}|${day}`;
    const rows = { ...(log.followup[key] || {}) };
    rows[id] = (Number(rows[id]) || 0) + 1;
    log.followup[key] = normalizeFollowupRows(rows);
    data.sendLog = log;
    return log.followup[key][id] || 0;
  }
  if (kind === "campaign" || kind === "contacts") {
    const days = { ...(log.contacts[key] || {}) };
    days[day] = (Number(days[day]) || 0) + 1;
    log.contacts[key] = normalizeDayCounts(days);
    data.sendLog = log;
    return log.contacts[key][day] || 0;
  }
  return 0;
}

const LIMIT_TABS = ["warmup", "contacts", "followup", "analyse"];

function positiveInt(value) {
  const number = Number.parseInt(value, 10);
  return number >= 1 ? number : 0;
}

function limitRecord(account, prior, fallbackLimit = 20) {
  const previous = prior && typeof prior === "object" ? prior : {};
  const saved = previous.limitByTab && typeof previous.limitByTab === "object" ? previous.limitByTab : null;
  const incoming = account?.limitByTab && typeof account.limitByTab === "object" ? account.limitByTab : null;
  const base = positiveInt(previous.limit) || positiveInt(fallbackLimit) || 20;
  const single = positiveInt(account?.limit);
  const tab = String(account?.limitTab || "");
  const next = {};
  for (const name of LIMIT_TABS) {
    const fromIncoming = incoming ? positiveInt(incoming[name]) : 0;
    const fromSaved = saved ? positiveInt(saved[name]) : 0;
    next[name] = fromIncoming || fromSaved || base;
  }
  if (LIMIT_TABS.includes(tab) && single) next[tab] = single;
  else if (!incoming && !saved && single) {
    for (const name of LIMIT_TABS) next[name] = single;
  }
  return next;
}

function selectionRecord(account, prior) {
  const previous = prior && typeof prior === "object" ? prior : {};
  const fallback = Object.prototype.hasOwnProperty.call(account || {}, "selected")
    ? Boolean(account.selected)
    : Boolean(previous.selected);
  const incoming = account?.selectedByTab;
  const saved = previous.selectedByTab;
  const pick = (tab) => {
    if (incoming && typeof incoming === "object" && Object.prototype.hasOwnProperty.call(incoming, tab)) {
      return Boolean(incoming[tab]);
    }
    if (saved && typeof saved === "object" && Object.prototype.hasOwnProperty.call(saved, tab)) {
      return Boolean(saved[tab]);
    }
    return fallback;
  };
  return {
    warmup: pick("warmup"),
    peer: pick("peer"),
    contacts: pick("contacts"),
    followup: pick("followup"),
    analyse: pick("analyse"),
  };
}

function normalizeFollowupDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const [year, month, day] = text.split("-").map((part) => Number(part));
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return "";
  return text;
}

function mergeAccountPref(previous, account, fallbackLimit = 20) {
  const prior = previous && typeof previous === "object" ? previous : {};
  const limits = limitRecord(account, prior, fallbackLimit);
  const next = {
    selected: Boolean(account?.selected),
    selectedByTab: selectionRecord(account, prior),
    senderName: String(account?.senderName || ""),
    limit: limits.contacts,
    limitByTab: limits,
    cvPath: String(account?.cvPath || ""),
    cvName: String(account?.cvName || ""),
    email: String(account?.email || ""),
    contacts: Array.isArray(prior.contacts) ? prior.contacts : [],
    contactFileName: String(prior.contactFileName || ""),
    sendAt: Object.prototype.hasOwnProperty.call(account || {}, "sendAt")
      ? normalizeSendAt(account.sendAt)
      : normalizeSendAt(prior.sendAt),
    scheduleSend: Object.prototype.hasOwnProperty.call(account || {}, "scheduleSend")
      ? Boolean(account.scheduleSend)
      : (Object.prototype.hasOwnProperty.call(prior, "scheduleSend") ? Boolean(prior.scheduleSend) : normalizeSendAt(prior.sendAt) > 0),
    followupDate: Object.prototype.hasOwnProperty.call(account || {}, "followupDate")
      ? normalizeFollowupDate(account.followupDate)
      : normalizeFollowupDate(prior.followupDate),
    hidden: Object.prototype.hasOwnProperty.call(account || {}, "hidden")
      ? Boolean(account.hidden)
      : Boolean(prior.hidden),
  };
  if (typeof account?.mentionAttachment === "boolean") next.mentionAttachment = account.mentionAttachment;
  else if (typeof prior.mentionAttachment === "boolean") next.mentionAttachment = prior.mentionAttachment;
  return next;
}

function followupRecord(raw) {
  const defaultsFollowup = defaults().followup;
  const followup = { ...defaultsFollowup, ...(raw || {}) };
  const interval = Number(followup.intervalSeconds);
  if (interval >= 10 && interval <= 86400) followup.intervalSeconds = Math.round(interval);
  else if (interval > 0 && interval < 10) followup.intervalSeconds = 10;
  else followup.intervalSeconds = defaultsFollowup.intervalSeconds;
  const body = String(followup.body || "");
  followup.body = body.trim() ? body.slice(0, 20000) : defaultsFollowup.body;
  followup.date = normalizeFollowupDate(followup.date);
  followup.steps = normalizeSteps(raw?.steps);
  return followup;
}

function normalizeBusiness(row, index) {
  const email = String(row?.email || "").trim().slice(0, 320);
  const firstName = String(row?.firstName ?? row?.clientName ?? row?.name ?? "").trim().slice(0, 120);
  const company = String(row?.company || "").trim().slice(0, 200);
  const id = String(row?.id || "").trim().slice(0, 80) || `biz-${index + 1}`;
  return { id, email, firstName, company };
}

function warmupRecord(raw) {
  const warmup = { ...defaults().warmup, ...(raw || {}) };
  const interval = Number(warmup.intervalSeconds);
  warmup.intervalSeconds = interval >= 3 && interval <= 86400 ? Math.round(interval) : 600;
  const peerSource = raw && raw.peerIntervalSeconds != null && raw.peerIntervalSeconds !== ""
    ? raw.peerIntervalSeconds
    : warmup.intervalSeconds;
  const peerInterval = Number(peerSource);
  warmup.peerIntervalSeconds = peerInterval >= 3 && peerInterval <= 86400 ? Math.round(peerInterval) : 600;
  const peerPeriods = Number(raw && raw.peerPeriods != null && raw.peerPeriods !== "" ? raw.peerPeriods : warmup.peerPeriods);
  warmup.peerPeriods = peerPeriods >= 1 && peerPeriods <= 30 ? Math.round(peerPeriods) : 1;
  if (Array.isArray(raw?.businesses)) {
    warmup.businesses = raw.businesses
      .map((row, index) => normalizeBusiness(row, index))
      .filter((row) => row.email || row.firstName || row.company);
  } else if (String(warmup.email || "").trim() || String(warmup.company || "").trim() || String(warmup.clientName || "").trim()) {
    warmup.businesses = [normalizeBusiness({
      id: "legacy",
      email: warmup.email,
      firstName: warmup.clientName,
      company: warmup.company,
    }, 0)];
  } else {
    warmup.businesses = [];
  }
  warmup.plan = normalizeWarmupPlan(raw?.plan);
  return applySelectedBusiness(warmup);
}

function applySelectedBusiness(warmup) {
  const businesses = warmup.businesses || [];
  const requested = String(warmup.selectedId || "").trim();
  const match = businesses.find((row) => row.id === requested);
  warmup.selectedId = match ? match.id : (businesses.length === 1 ? businesses[0].id : "");
  const chosen = businesses.find((row) => row.id === warmup.selectedId);
  if (chosen) {
    warmup.email = chosen.email;
    warmup.company = chosen.company;
    warmup.clientName = chosen.firstName;
  }
  return warmup;
}

function cvEmailKey(email) {
  const mail = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) ? mail : "";
}

function normalizeCvs(raw) {
  const next = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return next;
  for (const [key, value] of Object.entries(raw)) {
    const email = cvEmailKey(key);
    if (!email || !value || typeof value !== "object") continue;
    const cvPath = String(value.cvPath || "").trim();
    if (!cvPath) continue;
    next[email] = {
      cvPath,
      cvName: String(value.cvName || "").trim() || path.basename(cvPath),
    };
  }
  return next;
}

function rememberCv(book, email, cvPath, cvName) {
  const next = normalizeCvs(book);
  const key = cvEmailKey(email);
  if (!key) return next;
  const file = String(cvPath || "").trim();
  if (!file) {
    delete next[key];
    return next;
  }
  next[key] = {
    cvPath: file,
    cvName: String(cvName || "").trim() || path.basename(file),
  };
  return next;
}

function cvForEmail(book, email) {
  const key = cvEmailKey(email);
  if (!key) return null;
  return normalizeCvs(book)[key] || null;
}

function cvsFromPrefs(prefs) {
  let next = {};
  for (const pref of Object.values(prefs || {})) {
    if (!pref || typeof pref !== "object") continue;
    next = rememberCv(next, pref.email, pref.cvPath, pref.cvName);
  }
  return next;
}

function storedCvs(parsed) {
  if (parsed && typeof parsed.cvs === "object" && !Array.isArray(parsed.cvs)) return normalizeCvs(parsed.cvs);
  return cvsFromPrefs(parsed?.accountPrefs);
}

function syncCvs(book, prefs, accounts) {
  const byEmail = new Map();
  for (const account of accounts || []) {
    const email = cvEmailKey(account?.email);
    if (!email) continue;
    const cvPath = String(account?.cvPath || "").trim();
    const cvName = String(account?.cvName || "").trim();
    const current = byEmail.get(email) || { cvPath: "", cvName: "" };
    if (cvPath) {
      current.cvPath = cvPath;
      current.cvName = cvName;
    }
    byEmail.set(email, current);
  }
  let cvs = normalizeCvs(book);
  for (const [email, info] of byEmail) {
    const cvPath = info.cvPath || "";
    cvs = rememberCv(cvs, email, cvPath, info.cvName);
    for (const pref of Object.values(prefs || {})) {
      if (!pref || typeof pref !== "object" || cvEmailKey(pref.email) !== email) continue;
      pref.cvPath = cvPath;
      pref.cvName = cvPath ? (info.cvName || "") : "";
    }
  }
  return cvs;
}

function senderNameKey(email, name) {
  const mail = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return "";
  const first = String(name || "").replace(/\s+/g, " ").trim().split(" ")[0].slice(0, 80);
  if (!first || /@/.test(first)) return "";
  return `${mail}-${first}`;
}

function normalizeSenderNames(raw) {
  const next = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return next;
  for (const [key, value] of Object.entries(raw)) {
    const match = String(key || "").trim().match(/^([^\s@]+@[^\s@]+\.[a-z]{2,})-(.+)$/i);
    if (!match) continue;
    const first = String(value || match[2] || "").replace(/\s+/g, " ").trim().split(" ")[0].slice(0, 80);
    const normalized = senderNameKey(match[1], first);
    if (!normalized || !first) continue;
    next[normalized] = first;
  }
  return next;
}

function rememberSenderName(book, email, name) {
  const next = normalizeSenderNames(book);
  const first = String(name || "").replace(/\s+/g, " ").trim().split(" ")[0].slice(0, 80);
  const key = senderNameKey(email, first);
  if (!key) return next;
  const prefix = `${String(email || "").trim().toLowerCase()}-`;
  for (const item of Object.keys(next)) {
    if (item.startsWith(prefix)) delete next[item];
  }
  next[key] = first;
  return next;
}

function senderNameFor(book, email, detectedName) {
  const names = normalizeSenderNames(book);
  const exact = names[senderNameKey(email, detectedName)];
  if (exact) return exact;
  const mail = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return "";
  const matches = Object.entries(names).filter(([key]) => key.startsWith(`${mail}-`));
  return matches.length === 1 ? matches[0][1] : "";
}

function businessesFromInput(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const businesses = [];
  for (const row of rows) {
    const business = normalizeBusiness(row, businesses.length);
    if (!business.email && !business.firstName && !business.company) continue;
    if (!isEmailAddress(business.email)) throw new Error("Enter the business email.");
    if (!business.firstName) throw new Error("Enter the first name.");
    if (!business.company) throw new Error("Enter the company name.");
    const key = business.email.toLowerCase();
    if (seen.has(key)) throw new Error("That business email is already in the list.");
    seen.add(key);
    businesses.push(business);
  }
  return businesses;
}

module.exports = {
  Store,
  warmupRecord,
  followupRecord,
  businessesFromInput,
  mergeAccountPref,
  cvForEmail,
  cvsFromPrefs,
  rememberCv,
  syncCvs,
  rememberSenderName,
  senderNameFor,
  senderNameKey,
  selectionRecord,
  limitRecord,
  normalizeSendAt,
  normalizeFollowupDate,
  localDayKey,
  sentTodayCount,
  recordDailySend,
  recordKindSend,
  normalizeSendLog,
};
