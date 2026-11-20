const BLOCKING_BOUNCE = new Set(["address", "full", "blocked", "domain"]);

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function clientKey(email) {
  const text = String(email || "").trim().toLowerCase();
  return isEmailAddress(text) ? text : "";
}

function localDayKey(now = Date.now()) {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayNumber(key) {
  const [year, month, day] = String(key || "").split("-").map((part) => Number(part));
  if (!year || !month || !day) return 0;
  return Math.round(Date.UTC(year, month - 1, day) / 86400000);
}

function daysBetween(start, end) {
  if (!start || !end) return 0;
  return Math.max(0, dayNumber(end) - dayNumber(start));
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function blankRecord(email) {
  return {
    email,
    name: "",
    company: "",
    gmail: "",
    sentAt: 0,
    followups: 0,
    lastFollowupAt: 0,
    bouncedAt: 0,
    bounceType: "",
    bounceLabel: "",
    repliedAt: 0,
    replySubject: "",
  };
}

function normalizeClients(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const book = {};
  for (const value of Object.values(source)) {
    const email = clientKey(value?.email);
    if (!email) continue;
    const record = blankRecord(email);
    record.name = String(value?.name || "").replace(/\s+/g, " ").trim().slice(0, 120);
    record.company = String(value?.company || "").replace(/\s+/g, " ").trim().slice(0, 200);
    record.gmail = clientKey(value?.gmail);
    record.sentAt = Math.max(0, Math.round(Number(value?.sentAt) || 0));
    record.followups = Math.max(0, Math.round(Number(value?.followups) || 0));
    record.lastFollowupAt = Math.max(0, Math.round(Number(value?.lastFollowupAt) || 0));
    record.bouncedAt = Math.max(0, Math.round(Number(value?.bouncedAt) || 0));
    record.bounceType = String(value?.bounceType || "").slice(0, 40);
    record.bounceLabel = String(value?.bounceLabel || "").slice(0, 80);
    record.repliedAt = Math.max(0, Math.round(Number(value?.repliedAt) || 0));
    record.replySubject = String(value?.replySubject || "").replace(/\s+/g, " ").trim().slice(0, 180);
    book[email] = record;
  }
  return book;
}

function remember(book, email, patch) {
  const key = clientKey(email);
  const next = normalizeClients(book);
  if (!key) return next;
  const current = next[key] || blankRecord(key);
  next[key] = { ...current, ...patch, email: key };
  return next;
}

function rememberSend(book, item, now = Date.now()) {
  const email = clientKey(item?.email);
  if (!email) return normalizeClients(book);
  const current = normalizeClients(book)[email];
  return remember(book, email, {
    name: String(item?.name || current?.name || "").trim(),
    company: String(item?.company || current?.company || "").trim(),
    gmail: clientKey(item?.gmail) || current?.gmail || "",
    sentAt: current?.sentAt || now,
  });
}

function rememberFollowup(book, item, now = Date.now()) {
  const email = clientKey(item?.email || item?.toEmail);
  if (!email) return normalizeClients(book);
  const current = normalizeClients(book)[email] || blankRecord(email);
  return remember(book, email, {
    gmail: clientKey(item?.gmail) || current.gmail,
    followups: current.followups + 1,
    lastFollowupAt: now,
  });
}

function rememberBounce(book, item, now = Date.now()) {
  const email = clientKey(item?.email);
  if (!email) return normalizeClients(book);
  const type = String(item?.type || "");
  const patch = {
    name: String(item?.name || item?.firstName || "").trim(),
    gmail: clientKey(item?.gmail) || normalizeClients(book)[email]?.gmail || "",
    bounceType: type,
    bounceLabel: String(item?.label || "").slice(0, 80),
  };
  if (BLOCKING_BOUNCE.has(type)) patch.bouncedAt = now;
  return remember(book, email, patch);
}

function rememberReply(book, item, now = Date.now()) {
  const email = clientKey(item?.email);
  if (!email) return normalizeClients(book);
  const current = normalizeClients(book)[email];
  return remember(book, email, {
    gmail: clientKey(item?.gmail) || current?.gmail || "",
    repliedAt: current?.repliedAt || now,
    replySubject: String(item?.subject || current?.replySubject || "").slice(0, 180),
  });
}

function isLeftOff(record) {
  return Boolean(record && record.bouncedAt && BLOCKING_BOUNCE.has(record.bounceType));
}

function leftOffEmails(book) {
  const emails = [];
  for (const record of Object.values(normalizeClients(book))) {
    if (isLeftOff(record) || record.repliedAt) emails.push(record.email);
  }
  return emails;
}

function withoutLeftOff(contacts, book) {
  const skip = new Set(leftOffEmails(book));
  const kept = [];
  let dropped = 0;
  for (const contact of contacts || []) {
    const email = clientKey(contact?.email);
    if (email && skip.has(email) && isLeftOff(normalizeClients(book)[email])) {
      dropped += 1;
      continue;
    }
    kept.push(contact);
  }
  return { contacts: kept, dropped };
}

function normalizeSteps(raw) {
  const source = Array.isArray(raw) ? raw : [{ days: 3, body: "" }, { days: 7, body: "" }];
  return [0, 1].map((index) => {
    const step = source[index] || {};
    const days = Number(step.days);
    return {
      days: days >= 1 && days <= 365 ? Math.round(days) : 0,
      body: String(step.body || "").slice(0, 20000),
    };
  });
}

function dueSequence(book, steps, now = Date.now()) {
  const active = normalizeSteps(steps);
  const due = [];
  for (const record of Object.values(normalizeClients(book))) {
    if (!record.sentAt || record.bouncedAt || record.repliedAt || !record.gmail) continue;
    const step = active[record.followups];
    if (!step || step.days < 1) continue;
    if (now < record.sentAt + step.days * 86400000) continue;
    due.push({
      email: record.email,
      name: record.name,
      company: record.company,
      gmail: record.gmail,
      step: record.followups + 1,
      body: step.body,
    });
  }
  return due;
}

function sequenceAccounts(accounts, book, steps, now = Date.now()) {
  const due = dueSequence(book, steps, now);
  const chosen = new Map();
  for (const item of due) {
    const current = chosen.get(item.gmail);
    if (!current || item.step < current.step) {
      chosen.set(item.gmail, { step: item.step, body: item.body, emails: [item.email] });
    } else if (item.step === current.step) {
      current.emails.push(item.email);
    }
  }
  const next = [];
  for (const account of accounts || []) {
    const gmail = clientKey(account?.email);
    const work = chosen.get(gmail);
    if (!work) continue;
    const emails = work.emails.slice(0, 30);
    const query = `in:sent (${emails.map((email) => `to:${email}`).join(" OR ")})`;
    const booked = Number.parseInt(account?.limitByTab?.followup, 10);
    const cap = booked >= 1 ? booked : (Number(account.limit) || emails.length);
    next.push({
      ...account,
      followupQuery: query,
      followupBody: work.body,
      limit: Math.min(cap, emails.length),
    });
  }
  return next;
}

function normalizeWarmupPlan(raw) {
  const startLimit = clampInt(raw?.startLimit, 1, 500, 5);
  const dailyStep = clampInt(raw?.dailyStep, 0, 500, 5);
  const cap = Math.max(startLimit, clampInt(raw?.cap, 1, 500, 20));
  const startedAt = /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.startedAt || "")) ? String(raw.startedAt) : "";
  const lastRunDay = /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.lastRunDay || "")) ? String(raw.lastRunDay) : "";
  return { startLimit, dailyStep, cap, startedAt, lastRunDay };
}

function todayWarmupLimit(plan, now = Date.now()) {
  const normalized = normalizeWarmupPlan(plan);
  const today = localDayKey(now);
  const days = daysBetween(normalized.startedAt || today, today);
  return Math.min(normalized.cap, normalized.startLimit + days * normalized.dailyStep);
}

function clientSummary(book) {
  const rows = Object.values(normalizeClients(book));
  return {
    sent: rows.filter((row) => row.sentAt).length,
    bounced: rows.filter((row) => row.bouncedAt).length,
    replied: rows.filter((row) => row.repliedAt).length,
    followed: rows.filter((row) => row.followups > 0).length,
  };
}

function clientRows(book) {
  return Object.values(normalizeClients(book)).sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
}

module.exports = {
  BLOCKING_BOUNCE,
  clientKey,
  clientRows,
  clientSummary,
  dueSequence,
  leftOffEmails,
  localDayKey,
  normalizeClients,
  normalizeSteps,
  normalizeWarmupPlan,
  rememberBounce,
  rememberFollowup,
  rememberReply,
  rememberSend,
  sequenceAccounts,
  todayWarmupLimit,
  withoutLeftOff,
};
