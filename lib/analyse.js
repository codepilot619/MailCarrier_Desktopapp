const { nextCalendarDay, normalizeFollowupDay } = require("./followup");

const TYPE_LABELS = {
  address: "Address not found",
  full: "Mailbox full",
  blocked: "Blocked",
  domain: "Domain not found",
  large: "Message too large",
  temporary: "Temporary problem",
  other: "Other delivery problem",
};

const GENERIC_NAMES = new Set([
  "info", "sales", "admin", "contact", "hello", "support", "office", "team",
  "mail", "email", "noreply", "no-reply", "newsletter", "billing", "accounts",
]);

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function gmailToken(day) {
  const key = normalizeFollowupDay(day);
  if (!key) return "";
  const [year, month, date] = key.split("-").map((part) => Number(part));
  return `${year}/${month}/${date}`;
}

function analyseSentQuery(from, to) {
  const start = normalizeFollowupDay(from);
  const end = normalizeFollowupDay(to) || start;
  if (!start || !end || end < start) return "";
  const before = gmailToken(nextCalendarDay(end));
  const after = gmailToken(start);
  if (!after || !before) return "";
  return `in:sent after:${after} before:${before}`;
}

function cleanName(value) {
  const text = String(value || "").replace(/["']/g, "").replace(/\s+/g, " ").trim();
  if (!text || text.includes("@")) return "";
  if (/mail delivery|mailer-daemon|postmaster/i.test(text)) return "";
  return text.slice(0, 80);
}

function firstWord(value) {
  const cleaned = cleanName(value);
  if (!cleaned) return "";
  const word = cleaned.split(" ")[0];
  if (!/^[\p{L}][\p{L}'’-]{1,40}$/u.test(word)) return "";
  if (GENERIC_NAMES.has(word.toLowerCase())) return "";
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function nameFromLocalPart(email) {
  const local = String(email || "").split("@")[0] || "";
  const piece = local.split(/[._+-]/).find((part) => /^[\p{L}]{2,}$/u.test(part)) || "";
  return firstWord(piece);
}

function firstNameFrom(text, displayName, email) {
  const shown = firstWord(displayName);
  if (shown) return shown;
  const greet = String(text || "").match(/(?:^|[.!?\n]\s*|\b)(?:hi|hello|dear|hey)\s+([\p{L}][\p{L}'’-]{1,40})\b/iu);
  if (greet) {
    const greeted = firstWord(greet[1]);
    if (greeted) return greeted;
  }
  return nameFromLocalPart(email);
}

function skipAddress(email) {
  return /^(mailer-daemon|postmaster|noreply|no-reply)@/i.test(String(email || ""));
}

function recipientFrom(text) {
  const source = String(text || "");
  const patterns = [
    /wasn['’]t delivered to\s+(?:([^<\n]{1,80}?)\s*)?<([^>\s]+@[^>\s]+)>/i,
    /wasn['’]t delivered to\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i,
    /delivering your message to\s+(?:([^<\n]{1,80}?)\s*)?<([^>\s]+@[^>\s]+)>/i,
    /delivering your message to\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i,
    /your message to\s+(?:([^<\n]{1,80}?)\s*)?<([^>\s]+@[^>\s]+)>/i,
    /your message to\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i,
    /message to\s+<([^>\s]+@[^>\s]+)>/i,
    /final-recipient:\s*rfc822;\s*<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i,
    /original-recipient:\s*rfc822;\s*<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i,
    /([A-Z][\p{L}'’.-]{1,40}(?:\s+[A-Z][\p{L}'’.-]{1,40})?)\s*<([^>\s]+@[^>\s]+)>/u,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const groups = match.slice(1).map((part) => String(part || "").replace(/[<>]/g, "").trim());
    const email = groups.find((part) => part.includes("@"));
    const name = groups.find((part) => part && !part.includes("@"));
    const normalized = String(email || "").trim().toLowerCase();
    if (!isEmailAddress(normalized) || skipAddress(normalized)) continue;
    return { email: normalized, name: cleanName(name) };
  }
  return { email: "", name: "" };
}

function deliveryType(text) {
  const body = String(text || "");
  if (/5\.2\.2|over quota|mailbox full|quota exceeded|out of storage/i.test(body)) return "full";
  if (/5\.2\.3|message (?:is )?too large|size limit|exceeds (?:the )?maximum/i.test(body)) return "large";
  if (/5\.7\.\d|message blocked|blocked|rejected as spam|spam detected|local policy|content rejected/i.test(body)) return "blocked";
  if (/5\.1\.2|domain (?:not found|does not exist)|no such domain|unrouteable|host or domain name not found/i.test(body)) return "domain";
  if (/5\.1\.1|user unknown|does not exist|address not found|couldn['’]t be found|unable to receive|recipient address rejected|bad destination/i.test(body)) return "address";
  if (/\b4\.\d\.\d\b|temporary|try again later|delivery incomplete|timed out|resources temporarily unavailable/i.test(body)) return "temporary";
  return "other";
}

function isDeliveryReport(body, senderEmail, senderName) {
  const who = `${senderEmail || ""} ${senderName || ""}`;
  if (/mailer-daemon|mail delivery subsystem/i.test(who)) return true;
  return /address not found|wasn['’]t delivered|was not delivered|undeliverable|delivery status notification|mailbox full|delivery incomplete|message blocked|final-recipient|user unknown|\b[45]\.\d\.\d\b/i.test(String(body || ""));
}

function parseDeliveryReport(body, sender = {}) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  const senderEmail = String(sender.email || sender.senderEmail || "").trim();
  const senderName = String(sender.name || sender.senderName || "").trim();
  if (!isDeliveryReport(text, senderEmail, senderName)) return null;
  const type = deliveryType(text);
  const recipient = recipientFrom(text);
  return {
    type,
    label: TYPE_LABELS[type] || TYPE_LABELS.other,
    email: recipient.email,
    firstName: firstNameFrom(text, recipient.name, recipient.email),
  };
}

function countDeliveryTypes(findings) {
  const counts = {};
  for (const item of findings || []) {
    const label = TYPE_LABELS[item?.type] || item?.label || TYPE_LABELS.other;
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

function mergeSavedAnalysis(previous, incoming) {
  const prior = previous && typeof previous === "object" ? previous : {};
  const nextContacts = new Map();
  for (const item of Array.isArray(prior.contacts) ? prior.contacts : []) {
    const email = String(item?.email || "").trim().toLowerCase();
    if (!isEmailAddress(email)) continue;
    nextContacts.set(email, {
      email,
      firstName: firstWord(item.firstName) || "",
      type: TYPE_LABELS[item.type] ? item.type : "other",
      label: TYPE_LABELS[item.type] || item.label || TYPE_LABELS.other,
      gmail: String(item.gmail || "").trim().toLowerCase(),
    });
  }
  for (const item of Array.isArray(incoming?.contacts) ? incoming.contacts : []) {
    const email = String(item?.email || "").trim().toLowerCase();
    if (!isEmailAddress(email) || skipAddress(email)) continue;
    const type = TYPE_LABELS[item.type] ? item.type : "other";
    const saved = nextContacts.get(email) || {
      email,
      firstName: "",
      type,
      label: TYPE_LABELS[type],
      gmail: "",
    };
    const firstName = firstWord(item.firstName) || saved.firstName;
    nextContacts.set(email, {
      email,
      firstName,
      type,
      label: TYPE_LABELS[type],
      gmail: String(item.gmail || saved.gmail || "").trim().toLowerCase(),
    });
  }
  const counts = incoming?.counts && typeof incoming.counts === "object" ? { ...incoming.counts } : {};
  return {
    from: normalizeFollowupDay(incoming?.from) || normalizeFollowupDay(prior.from),
    to: normalizeFollowupDay(incoming?.to) || normalizeFollowupDay(prior.to),
    limit: clampLimit(incoming?.limit ?? prior.limit),
    counts,
    contacts: [...nextContacts.values()].slice(0, 500),
    updatedAt: Date.now(),
  };
}

function clampLimit(value) {
  const limit = Math.round(Number(value));
  if (!(limit >= 1)) return 40;
  return Math.min(200, limit);
}

function analysisRecord(raw) {
  const saved = mergeSavedAnalysis({}, raw || {});
  saved.counts = raw?.counts && typeof raw.counts === "object" ? { ...raw.counts } : {};
  saved.updatedAt = Number(raw?.updatedAt) > 0 ? Math.round(Number(raw.updatedAt)) : 0;
  return saved;
}

function validateAnalyseInput(input) {
  const errors = [];
  const accounts = Array.isArray(input?.accounts) ? input.accounts : [];
  if (!accounts.length) errors.push("Select at least one Gmail account.");
  const from = normalizeFollowupDay(input?.from);
  const to = normalizeFollowupDay(input?.to) || from;
  if (!from) errors.push("Choose the start date.");
  if (from && to && to < from) errors.push("The end date must be on or after the start date.");
  const limit = Number(input?.limit);
  if (!(limit >= 1) || limit > 200) errors.push("Emails to open must be between 1 and 200.");
  const seen = new Set();
  for (const account of accounts) {
    const label = account?.envName || account?.email || "a Gmail";
    const email = String(account?.email || "").trim().toLowerCase();
    if (!isEmailAddress(email)) errors.push(`Read the Gmail address for ${label} before analysing.`);
    if (email && seen.has(email)) errors.push(`${email} is selected twice.`);
    if (email) seen.add(email);
  }
  return errors;
}

module.exports = {
  TYPE_LABELS,
  analyseSentQuery,
  analysisRecord,
  countDeliveryTypes,
  mergeSavedAnalysis,
  parseDeliveryReport,
  validateAnalyseInput,
};
