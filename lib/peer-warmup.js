const fs = require("fs");
const path = require("path");

function emailContentPath() {
  const candidates = [
    path.join(__dirname, "..", "..", "shared", "email-content.js"),
    path.join(__dirname, "..", "shared", "email-content.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

const { customTemplateErrors, formatReplyText, normalizeTemplateList, personalizeEmail } = require(emailContentPath());

const PEER_COMPANY = "Metaroom";
const PEER_PERIOD_RECEIVE_LIMIT = 3;

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function connectionKey(left, right) {
  const a = String(left || "").trim().toLowerCase();
  const b = String(right || "").trim().toLowerCase();
  if (!isEmailAddress(a) || !isEmailAddress(b) || a === b) return "";
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function normalizeConnections(value) {
  const next = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    let key = "";
    if (typeof item === "string") {
      const splitAt = item.indexOf("|");
      if (splitAt > 0) key = connectionKey(item.slice(0, splitAt), item.slice(splitAt + 1));
    }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(key);
  }
  return next;
}

function hasConnection(connections, left, right) {
  const key = connectionKey(left, right);
  return Boolean(key) && normalizeConnections(connections).includes(key);
}

function addConnection(connections, left, right) {
  const key = connectionKey(left, right);
  const next = normalizeConnections(connections);
  if (key && !next.includes(key)) next.push(key);
  return next;
}

function receivedCounts(deliveries) {
  const counts = new Map();
  for (const item of Array.isArray(deliveries) ? deliveries : []) {
    const to = String(item?.toEmail || "").trim().toLowerCase();
    if (!isEmailAddress(to)) continue;
    counts.set(to, (counts.get(to) || 0) + 1);
  }
  return counts;
}

function nextPeer(accounts, senderIndex, connections, options = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const sender = list[senderIndex];
  if (!sender || !isEmailAddress(sender.email)) return null;
  const limit = Number(options.receiveLimit);
  const capped = Number.isFinite(limit);
  const counts = capped ? receivedCounts(options.deliveries) : null;
  const senderEmail = String(sender.email).trim().toLowerCase();
  for (let step = 1; step < list.length; step += 1) {
    const candidate = list[(senderIndex + step) % list.length];
    if (!candidate || !isEmailAddress(candidate.email)) continue;
    const email = String(candidate.email).trim().toLowerCase();
    if (email === senderEmail) continue;
    if (hasConnection(connections, sender.email, candidate.email)) continue;
    if (capped && (counts.get(email) || 0) >= limit) continue;
    return candidate;
  }
  return null;
}

function repliesForMailbox(deliveries, mailboxEmail) {
  const mailbox = String(mailboxEmail || "").trim().toLowerCase();
  return (Array.isArray(deliveries) ? deliveries : []).filter((item) => {
    const to = String(item?.toEmail || "").trim().toLowerCase();
    const from = String(item?.fromEmail || "").trim().toLowerCase();
    return to === mailbox && isEmailAddress(from);
  });
}

const WARMUP_MARKER = "(w-u)";

function warmupMarkerFrom(input) {
  if (input?.useCustomWarmupIndex !== true) return WARMUP_MARKER;
  const text = String(input.warmupIndex ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/"/g, "")
    .trim()
    .slice(0, 40);
  if (!text) return "";
  if (text.startsWith("(") && text.endsWith(")") && text.length > 2) return text;
  return `(${text})`;
}

function warmupSubject(subject, marker = WARMUP_MARKER) {
  const tag = String(marker || WARMUP_MARKER).replace(/\s+/g, " ").trim() || WARMUP_MARKER;
  const text = String(subject || "").replace(/\s+/g, " ").trim();
  if (!text) return tag;
  if (text.toLowerCase().endsWith(tag.toLowerCase())) return text;
  return `${text} ${tag}`;
}

function replierFirstName(senderName) {
  const name = String(senderName || "").replace(/\s+/g, " ").trim();
  if (!name) return "";
  return name.split(" ")[0];
}

function peerIntro(senderName, recipientName, options = {}) {
  const recipient = String(recipientName || "").trim() || "there";
  const sender = String(senderName || "").trim();
  const message = personalizeEmail(options.language || "en", {
    name: recipient,
    company: PEER_COMPANY,
  }, sender, {
    includeAttach: options.includeAttach !== false,
    subjectIndex: options.subjectIndex,
    templateIndex: options.templateIndex,
    useCustom: options.useCustom === true,
    subjects: options.subjects,
    bodies: options.bodies,
  });
  return {
    ...message,
    subject: warmupSubject(message.subject, options.marker),
  };
}

function warmupReplyText(senderName, index) {
  const sender = replierFirstName(senderName);
  const templates = [
    `Thanks for your email. Unfortunately we don't have any job position for you.\n\nBest luck for your search\n${sender}`,
    `There isn't any position for your application. Sorry for this. I will ping you if there is any update on my company.\n\nThanks,\n${sender}`,
    `Thanks for reaching out. Let me keep you on my mind if there is any update for you.\n\nGood luck,\n${sender}`,
    `Thanks. But I'm not interested.\n\nBest regards\n${sender}`,
  ];
  const choice = Number.isInteger(index) ? index : Math.floor(Math.random() * templates.length);
  const slot = ((choice % templates.length) + templates.length) % templates.length;
  return templates[slot];
}

function peerReply(senderName, index, options = {}) {
  const templates = normalizeTemplateList(options.replies, { multiline: true });
  if (templates.length) {
    const choice = Number.isInteger(index) ? index : Math.floor(Math.random() * templates.length);
    const slot = ((choice % templates.length) + templates.length) % templates.length;
    return formatReplyText(templates[slot], senderName, options.contact);
  }
  return warmupReplyText(senderName, index);
}

function validatePeerWarmupInput(input) {
  const errors = [];
  const accounts = Array.isArray(input?.accounts) ? input.accounts : [];
  if (accounts.length < 2) errors.push("Select at least two Gmail accounts.");
  const seen = new Set();
  for (const account of accounts) {
    const label = account?.envName || account?.email || "a Gmail";
    const email = String(account?.email || "").trim().toLowerCase();
    if (!isEmailAddress(email)) errors.push(`Read the Gmail address for ${label} before warming up.`);
    if (!String(account?.senderName || "").trim()) errors.push(`Enter your name for ${label}.`);
    if (email && seen.has(email)) errors.push(`${email} is selected twice.`);
    if (email) seen.add(email);
  }
  const interval = Number(input?.intervalSeconds);
  if (!(interval >= 3) || interval > 86400) errors.push("Interval must be between 3 and 86400 seconds.");
  const periods = Number(input?.periods);
  if (!(periods >= 1) || periods > 30) errors.push("Periods must be between 1 and 30.");
  errors.push(...customTemplateErrors(input));
  if (input?.useCustomReplies === true && !normalizeTemplateList(input.customReplies, { multiline: true }).length) {
    errors.push("Add at least one reply email.");
  }
  if (input?.useCustomWarmupIndex === true && !warmupMarkerFrom(input)) {
    errors.push("Write the index that goes after the subject.");
  }
  return errors;
}

module.exports = {
  addConnection,
  connectionKey,
  hasConnection,
  nextPeer,
  normalizeConnections,
  PEER_COMPANY,
  PEER_PERIOD_RECEIVE_LIMIT,
  receivedCounts,
  WARMUP_MARKER,
  peerIntro,
  repliesForMailbox,
  peerReply,
  warmupMarkerFrom,
  warmupSubject,
  validatePeerWarmupInput,
};
