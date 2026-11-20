function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function firstPersonalName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (!name) return "";
  return name.split(" ")[0].slice(0, 80);
}

function normalizeFollowupDay(value) {
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

function followupDayParts(day) {
  const key = normalizeFollowupDay(day);
  if (!key) return null;
  const [year, month, date] = key.split("-").map((part) => Number(part));
  return { year, month, date };
}

function gmailDayToken({ year, month, date }) {
  return `${year}/${month}/${date}`;
}

function nextCalendarDay(day) {
  const parts = followupDayParts(day);
  if (!parts) return "";
  const date = new Date(parts.year, parts.month - 1, parts.date + 1);
  return normalizeFollowupDay([
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-"));
}

function followupSentQuery(day) {
  const start = followupDayParts(day);
  const endKey = nextCalendarDay(day);
  const end = followupDayParts(endKey);
  if (!start || !end) return "";
  return `in:sent after:${gmailDayToken(start)} before:${gmailDayToken(end)}`;
}

function applyFollowupTemplate(body, senderName) {
  const first = firstPersonalName(senderName);
  return String(body || "").replace(/\{sender\}/gi, first);
}

function validateFollowupInput(input) {
  const errors = [];
  const accounts = Array.isArray(input?.accounts) ? input.accounts : [];
  if (!accounts.length) errors.push("Select at least one Gmail account.");
  const globalDate = normalizeFollowupDay(input?.date);
  const seen = new Set();
  let missingDate = false;
  for (const account of accounts) {
    const label = account?.envName || account?.email || "a Gmail";
    const email = String(account?.email || "").trim().toLowerCase();
    if (!isEmailAddress(email)) errors.push(`Read the Gmail address for ${label} before following up.`);
    if (!String(account?.senderName || "").trim()) errors.push(`Enter your name for ${label}.`);
    const day = normalizeFollowupDay(account?.followupDate) || globalDate;
    if (!day) missingDate = true;
    const limit = Number(account?.limit);
    if (!(limit >= 1) || limit > 500) errors.push(`Follow-up count for ${label} must be between 1 and 500.`);
    if (email && seen.has(email)) errors.push(`${email} is selected twice.`);
    if (email) seen.add(email);
  }
  if (missingDate) {
    errors.push(globalDate ? "Choose a sent date for each selected Gmail." : "Choose the sent date.");
  }
  const interval = Number(input?.intervalSeconds);
  if (!(interval >= 10) || interval > 86400) errors.push("Seconds between Gmail accounts must be between 10 and 86400.");
  const body = String(input?.body || "");
  const followups = Array.isArray(input?.customFollowups) ? input.customFollowups : [];
  const useFollowups = input?.useCustomFollowups === true;
  const hasFollowup = followups.some((item) => String(item || "").trim());
  if (useFollowups && !hasFollowup) errors.push("Add at least one follow-up email.");
  if (!useFollowups && !body.trim()) errors.push("Write the follow-up email.");
  if (body.length > 20000) errors.push("Follow-up email is too long.");
  return errors;
}

module.exports = {
  applyFollowupTemplate,
  firstPersonalName,
  followupSentQuery,
  normalizeFollowupDay,
  nextCalendarDay,
  validateFollowupInput,
};
