const fs = require("fs");
const { leftOffEmails, rememberBounce, rememberFollowup, rememberReply, rememberSend } = require("./clients");
const { recordDailySend, recordKindSend } = require("./store");
const { addConnection, nextPeer, normalizeConnections, PEER_COMPANY, PEER_PERIOD_RECEIVE_LIMIT, WARMUP_MARKER, peerIntro, peerReply, repliesForMailbox, warmupMarkerFrom } = require("./peer-warmup");
const { followupSentQuery, normalizeFollowupDay, validateFollowupInput } = require("./followup");
const { mergeGmailStatus } = require("./sheet-status");
const { analyseSentQuery, countDeliveryTypes, mergeSavedAnalysis, parseDeliveryReport, validateAnalyseInput } = require("./analyse");
const path = require("path");

function emailContentPath() {
  const candidates = [
    path.join(__dirname, "..", "..", "shared", "email-content.js"),
    path.join(__dirname, "..", "shared", "email-content.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

const { customTemplateErrors, formatReplyText, normalizeTemplateList, personalizeEmail } = require(emailContentPath());

const LANGUAGES = ["en", "zh", "hi", "de"];
const MAX_CONSECUTIVE_FAILURES = 5;

function normalizeLanguage(language) {
  return LANGUAGES.includes(language) ? language : "en";
}

function activeJobProfiles(campaign) {
  if (!campaign) return [];
  const status = String(campaign.status || "");
  if (!["running", "scheduled", "paused", "error"].includes(status)) return [];
  const ids = [];
  const seen = new Set();
  for (const account of campaign.accounts || []) {
    const id = String(account?.envId || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function profilesBusyExcept(campaigns, exceptKind) {
  const ids = [];
  const seen = new Set();
  for (const [kind, campaign] of Object.entries(campaigns || {})) {
    if (kind === exceptKind) continue;
    for (const id of activeJobProfiles(campaign)) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function nextAccountCursor(accounts, currentCursor) {
  if (!accounts?.length) return -1;
  for (let step = 1; step <= accounts.length; step += 1) {
    const index = (currentCursor + step) % accounts.length;
    const account = accounts[index];
    if ((Number(account.sent) || 0) < (Number(account.limit) || 0)) return index;
  }
  return -1;
}

function accountKey(account) {
  return `${account.envId}:${Number(account.gmailIndex) || 0}`;
}

function splitAccountKey(key) {
  const text = String(key || "");
  const indexSep = text.lastIndexOf(":");
  if (indexSep <= 0) return { envId: text, gmailIndex: 0 };
  return {
    envId: text.slice(0, indexSep),
    gmailIndex: Number(text.slice(indexSep + 1)) || 0,
  };
}

function hasOwnList(account) {
  return Array.isArray(account?.contacts) && account.contacts.length > 0;
}

function jobLimit(account, tab) {
  const book = account?.limitByTab;
  if (book && typeof book === "object" && tab) {
    const value = Number.parseInt(book[tab], 10);
    if (value >= 1) return value;
  }
  const limit = Number.parseInt(account?.limit, 10);
  return limit >= 1 ? limit : 1;
}

function usesAccountSchedule(input) {
  return (input?.accounts || []).some((account) => Array.isArray(account.contacts) || Number(account.sendAt) > 0);
}

function accountsForWarmup(accounts) {
  return (accounts || []).map((account) => {
    const copy = { ...account };
    delete copy.contacts;
    delete copy.sendAt;
    delete copy.scheduleSend;
    delete copy.cvPath;
    delete copy.cvName;
    copy.mentionAttachment = false;
    return copy;
  });
}

function accountFinished(account, campaign) {
  const sent = Number(account?.sent) || 0;
  const limit = Number(account?.limit) || 0;
  if (limit >= 1 && sent >= limit) return true;
  if (hasOwnList(account)) return (Number(account.contactIndex) || 0) >= account.contacts.length;
  if (!campaign) return false;
  return (Number(campaign.contactIndex) || 0) >= (campaign.contacts?.length || 0);
}

function nextDueIndex(accounts, campaign) {
  let best = -1;
  let bestTime = Infinity;
  (accounts || []).forEach((account, index) => {
    if (accountFinished(account, campaign)) return;
    const when = Number(account.nextSendAt);
    const time = Number.isFinite(when) ? when : 0;
    if (time < bestTime) {
      best = index;
      bestTime = time;
    }
  });
  return best;
}

function pacedDue(account, campaign) {
  const ownDue = Number(account?.nextSendAt) || 0;
  const paceUntil = Number(campaign?.paceUntil) || 0;
  const lastKey = String(campaign?.lastSentKey || "");
  if (!lastKey || paceUntil <= ownDue) return ownDue;
  const key = account?.key || accountKey(account);
  return lastKey !== key ? paceUntil : ownDue;
}

function scheduledTotal(campaign) {
  const accounts = campaign?.accounts || [];
  const own = accounts.filter(hasOwnList).reduce((sum, account) => {
    return sum + Math.min(Number(account.limit) || 0, account.contacts.length);
  }, 0);
  const sharedSlots = accounts.filter((account) => !hasOwnList(account)).reduce((sum, account) => {
    return sum + (Number(account.limit) || 0);
  }, 0);
  return own + Math.min((campaign?.contacts || []).length, sharedSlots);
}

function sendTimesFromAnchor(anchorMs, gapSeconds, count) {
  const start = Math.round(Number(anchorMs));
  const gapMs = Math.round(Number(gapSeconds) * 1000);
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const times = [];
  for (let index = 0; index < total; index += 1) times.push(start + index * gapMs);
  return times;
}

function copyContacts(contacts) {
  return (contacts || []).map((contact) => ({
    name: contact.name || "",
    email: contact.email,
    company: contact.company || "",
  }));
}

function browserSession(opened) {
  if (opened && typeof opened === "object") {
    return {
      debugPort: String(opened.debugPort || ""),
      browserWSEndpoint: String(opened.browserWSEndpoint || ""),
      targetId: String(opened.targetId || ""),
    };
  }
  return { debugPort: String(opened || ""), browserWSEndpoint: "", targetId: "" };
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function gmailGapWaitMs(selectedMs, random = Math.random) {
  const selected = Math.max(0, Math.round(Number(selectedMs) || 0));
  if (selected < 10000) return selected;
  const low = selected - 5000;
  const choices = 11;
  const roll = Number(typeof random === "function" ? random() : Math.random());
  const index = Math.min(choices - 1, Math.max(0, Math.floor(roll * choices)));
  return low + index * 1000;
}

function includeResumeSentence(account, campaign) {
  if (campaign?.kind === "warmup" || campaign?.kind === "peer-warmup") return false;
  if (typeof account?.mentionAttachment === "boolean") return account.mentionAttachment;
  return campaign?.includeAttach !== false;
}

function validateCampaignInput(input) {
  const errors = [];
  const schedule = usesAccountSchedule(input);
  const contacts = input?.contacts || [];
  const accounts = input?.accounts || [];
  if (!schedule && !contacts.length) errors.push("Import contacts first.");
  if (schedule && !contacts.length && accounts.some((account) => !hasOwnList(account))) {
    errors.push("Import a shared contact list, or add a contact list on every selected Gmail.");
  }
  if (!accounts.length) errors.push("Select at least one Gmail account.");

  const interval = Number(input?.intervalSeconds);
  if (!(interval >= 3) || interval > 86400) errors.push("Interval must be between 3 and 86400 seconds.");
  if (input?.betweenAccountSeconds != null && input.betweenAccountSeconds !== "") {
    const between = Number(input.betweenAccountSeconds);
    if (!(between >= 10) || between > 86400) {
      errors.push("Seconds between Gmail accounts must be between 10 and 86400.");
    }
  }
  const delay = Number(input?.startDelaySeconds);
  if (!(delay >= 0) || delay > 86400) errors.push("Start delay must be between 0 and 86400 seconds.");

  const seen = new Set();
  for (const account of accounts) {
    const label = account.envName || account.email || "a profile";
    if (!account.envId) errors.push("A selected profile is missing its id.");
    if (!String(account.senderName || "").trim()) errors.push(`Enter your name for ${label}.`);
    if (!(Number(account.limit) >= 1)) errors.push(`Max emails for ${label} must be at least 1.`);
    const key = accountKey(account);
    if (seen.has(key)) errors.push(`${label} is selected twice.`);
    seen.add(key);
    if (account.scheduleSend && !(Number(account.sendAt) > 0)) errors.push(`Choose a send time for ${label}.`);

    const cvPath = String(account.cvPath || "").trim();
    if (account.mentionAttachment === true && !cvPath) {
      errors.push(`Attach a CV for ${label}. The resume sentence is on.`);
      continue;
    }
    if (!cvPath) continue;
    let stat = null;
    try {
      stat = fs.statSync(cvPath);
    } catch (error) {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      errors.push(`CV file was not found for ${label}.`);
    } else if (stat.size > 24 * 1024 * 1024) {
      errors.push(`CV for ${label} is larger than 24MB.`);
    }
  }
  errors.push(...customTemplateErrors(input));
  return errors;
}

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function validateWarmupInput(input) {
  const errors = [];
  if (Array.isArray(input?.businesses)) {
    if (!input.businesses.length) errors.push("Add a business email.");
    const seen = new Set();
    for (const row of input.businesses) {
      const email = String(row?.email || "").trim();
      if (!isEmailAddress(email)) errors.push("Enter the business email.");
      if (!String(row?.company || "").trim()) errors.push("Enter the company name.");
      if (!String(row?.firstName || row?.clientName || row?.name || "").trim()) errors.push("Enter the first name.");
      const key = email.toLowerCase();
      if (key && seen.has(key)) errors.push("That business email is already in the list.");
      if (key) seen.add(key);
    }
    if (input.businesses.length && !selectedWarmupBusiness(input)) errors.push("Select a business email.");
  } else {
    if (!isEmailAddress(input?.email)) errors.push("Enter the business email.");
    if (!String(input?.company || "").trim()) errors.push("Enter the company name.");
    if (!String(input?.clientName || "").trim()) errors.push("Enter the client's name.");
  }
  if (!input?.accounts?.length) errors.push("Select at least one Gmail account.");
  const shared = validateCampaignInput({
    contacts: [{ name: "Client", email: "client@example.com", company: "Company" }],
    accounts: accountsForWarmup(input?.accounts),
    intervalSeconds: input?.intervalSeconds,
    startDelaySeconds: input?.startDelaySeconds ?? 0,
    useCustomTemplates: input?.useCustomTemplates,
    customSubjects: input?.customSubjects,
    customBodies: input?.customBodies,
  });
  for (const error of shared) {
    if (/^Import contacts/.test(error) || /^Select at least one/.test(error)) continue;
    errors.push(error);
  }
  return errors;
}

function warmupTarget(input) {
  return {
    name: String(input?.firstName || input?.clientName || input?.name || "").trim().slice(0, 120),
    email: String(input?.email || "").trim().slice(0, 320),
    company: String(input?.company || "").trim().slice(0, 200),
  };
}

function selectedWarmupBusiness(input) {
  const businesses = Array.isArray(input?.businesses) ? input.businesses : [];
  if (!businesses.length) return null;
  const id = String(input?.selectedId || "").trim();
  if (id) {
    const match = businesses.find((row) => String(row?.id || "") === id);
    if (match) return match;
  }
  return businesses.length === 1 ? businesses[0] : null;
}

function warmupTargetsFromInput(input) {
  if (Array.isArray(input?.businesses)) {
    const selected = selectedWarmupBusiness(input);
    return selected ? [warmupTarget(selected)] : [];
  }
  return [warmupTarget(input)];
}

function warmupTargetsOf(campaign) {
  if (Array.isArray(campaign?.targets) && campaign.targets.length) return campaign.targets;
  if (campaign?.target?.email) return [campaign.target];
  return (campaign?.contacts || []).filter((contact) => contact?.email);
}

function isCampaignComplete(campaign) {
  if (!campaign) return true;
  if (campaign.kind === "peer-warmup") {
    const accounts = campaign.accounts || [];
    const period = Math.max(1, Math.round(Number(campaign.period) || 1));
    const periods = Math.max(1, Math.round(Number(campaign.periods) || 1));
    return period >= periods && campaign.stage === "replying" && campaign.accountCursor >= accounts.length;
  }
  if (campaign.kind === "warmup" || campaign.kind === "followup" || campaign.kind === "analyse") {
    const accounts = campaign.accounts || [];
    return accounts.length > 0 && accounts.every((account) => (account.sent || 0) >= (Number(account.limit) || 0));
  }
  if (campaign.mode === "scheduled") {
    const accounts = campaign.accounts || [];
    return accounts.length > 0 && accounts.every((account) => accountFinished(account));
  }
  return (campaign.contactIndex || 0) >= (campaign.contacts?.length || 0);
}

function recipientFor(campaign) {
  if (campaign.kind === "warmup") {
    const targets = warmupTargetsOf(campaign);
    const account = campaign.accounts?.[campaign.accountCursor];
    const index = Number(account?.sent) || 0;
    const target = targets[index] || null;
    if (!target?.email) throw new Error("Warm-up is missing the business email.");
    return target;
  }
  if (campaign.mode === "scheduled") {
    const account = campaign.accounts?.[campaign.accountCursor];
    const contact = hasOwnList(account)
      ? account.contacts[Number(account.contactIndex) || 0]
      : campaign.contacts?.[campaign.contactIndex];
    if (!contact?.email) throw new Error("That Gmail has no contact left to send.");
    return contact;
  }
  return campaign.contacts[campaign.contactIndex];
}

function templateFields(input) {
  return {
    useCustomTemplates: input?.useCustomTemplates === true,
    customSubjects: normalizeTemplateList(input?.customSubjects),
    customBodies: normalizeTemplateList(input?.customBodies, { multiline: true }),
  };
}

function messageOptions(campaign, includeAttach) {
  return {
    includeAttach,
    useCustom: campaign?.useCustomTemplates === true,
    subjects: campaign?.customSubjects,
    bodies: campaign?.customBodies,
  };
}

function followupBodyText(campaign, account) {
  const specific = String(account?.followupBody || "").trim();
  const shared = String(campaign?.body || "").trim();
  const contact = {
    name: String(account?.followupRecipient || "").trim(),
    company: String(account?.followupCompany || "").trim(),
  };
  const ownStep = Boolean(specific) && specific !== shared;
  const followups = !ownStep && campaign?.useCustomFollowups === true
    ? normalizeTemplateList(campaign?.customFollowups, { multiline: true })
    : [];
  const chosen = followups.length
    ? followups[Math.floor(Math.random() * followups.length)]
    : (specific || shared);
  return formatReplyText(chosen, account?.senderName, contact);
}

function createCampaign(input, now = Date.now()) {
  const scheduled = usesAccountSchedule(input);
  const startDelayMs = scheduled ? 0 : Math.max(0, Number(input.startDelaySeconds) || 0) * 1000;
  const startAt = now + startDelayMs;
  const accounts = input.accounts.map((account) => {
    const mapped = {
      key: accountKey(account),
      envId: String(account.envId),
      envName: account.envName || "Profile",
      gmailIndex: Number(account.gmailIndex) || 0,
      email: account.email || "",
      senderName: String(account.senderName || "").trim(),
      limit: Math.max(1, jobLimit(account, "contacts")),
      sent: 0,
      cvPath: String(account.cvPath || "").trim(),
      cvName: account.cvName || "",
      ...(typeof account.mentionAttachment === "boolean" ? { mentionAttachment: account.mentionAttachment } : {}),
    };
    if (scheduled) {
      mapped.contacts = hasOwnList(account) ? copyContacts(account.contacts) : [];
      mapped.contactIndex = 0;
      mapped.sendAt = Math.round(Number(account.sendAt) || 0);
      mapped.nextSendAt = mapped.sendAt > now ? mapped.sendAt : now;
    }
    return mapped;
  });
  let status = startDelayMs > 0 ? "scheduled" : "running";
  let phase = startDelayMs > 0 ? "scheduled" : "sending";
  let waitUntil = startDelayMs > 0 ? startAt : 0;
  let accountCursor = 0;
  let startTime = startAt;
  if (scheduled) {
    const earliest = nextDueIndex(accounts);
    accountCursor = earliest < 0 ? 0 : earliest;
    startTime = accounts[accountCursor]?.nextSendAt || now;
    const waiting = startTime > now;
    status = "running";
    phase = waiting ? "waiting" : "sending";
    waitUntil = waiting ? startTime : 0;
  }
  return {
    id: nextCampaignId(now),
    kind: "campaign",
    mode: scheduled ? "scheduled" : "shared",
    status,
    phase,
    language: normalizeLanguage(input.language),
    includeAttach: input.includeAttach !== false,
    ...templateFields(input),
    intervalMs: Math.round(Number(input.intervalSeconds) * 1000),
    betweenAccountMs: Math.round(Math.max(0, Number(input.betweenAccountSeconds) || 0) * 1000),
    paceFrom: 0,
    paceUntil: 0,
    lastSentKey: "",
    startTime,
    waitUntil,
    contacts: copyContacts(input.contacts),
    contactIndex: 0,
    sentTotal: 0,
    accountCursor,
    accounts,
    lastError: "",
    updatedAt: now,
  };
}

function createWarmupCampaign(input, now = Date.now()) {
  const targets = warmupTargetsFromInput(input);
  const campaign = createCampaign({
    ...input,
    accounts: accountsForWarmup(input.accounts),
    contacts: targets,
    startDelaySeconds: 0,
    includeAttach: false,
  }, now);
  campaign.kind = "warmup";
  campaign.targets = targets;
  campaign.target = targets[0];
  for (const account of campaign.accounts) account.limit = Math.max(1, targets.length);
  return campaign;
}

function createPeerWarmupCampaign(input, now = Date.now()) {
  const accounts = (input.accounts || []).map((account) => ({
    key: accountKey(account),
    envId: String(account.envId),
    envName: account.envName || "Profile",
    gmailIndex: Number(account.gmailIndex) || 0,
    email: String(account.email || "").trim(),
    senderName: String(account.senderName || "").trim(),
    cvPath: "",
    cvName: "",
    mentionAttachment: false,
    sent: 0,
  }));
  return {
    id: nextCampaignId(now),
    kind: "peer-warmup",
    mode: "peer",
    status: "running",
    phase: "sending",
    stage: "sending",
    language: normalizeLanguage(input.language),
    includeAttach: false,
    ...templateFields(input),
    intervalMs: Math.round(Number(input.intervalSeconds) * 1000),
    periods: Math.min(30, Math.max(1, Math.round(Number(input.periods) || 1))),
    period: Math.max(1, Math.round(Number(input.period) || 1)),
    startTime: now,
    waitUntil: 0,
    accountCursor: 0,
    replyIndex: 0,
    customReplies: normalizeTemplateList(input?.customReplies, { multiline: true }),
    useCustomReplies: input?.useCustomReplies === true,
    warmupMarker: warmupMarkerFrom(input) || WARMUP_MARKER,
    connections: normalizeConnections(input.connections),
    deliveries: [],
    sentTotal: 0,
    replyTotal: 0,
    accounts,
    lastError: "",
    updatedAt: now,
    currentRecipient: "",
  };
}

function createFollowupCampaign(input, now = Date.now()) {
  const globalDate = normalizeFollowupDay(input.date);
  const accounts = (input.accounts || []).map((account) => ({
    key: accountKey(account),
    envId: String(account.envId),
    envName: account.envName || "Profile",
    gmailIndex: Number(account.gmailIndex) || 0,
    email: String(account.email || "").trim(),
    senderName: String(account.senderName || "").trim(),
    followupDate: normalizeFollowupDay(account.followupDate) || globalDate,
    followupQuery: String(account.followupQuery || "").trim(),
    followupBody: String(account.followupBody || ""),
    limit: Math.max(1, Math.min(500, jobLimit(account, "followup"))),
    sent: 0,
  }));
  return {
    id: nextCampaignId(now),
    kind: "followup",
    mode: "followup",
    status: "running",
    phase: "sending",
    body: String(input.body || ""),
    useCustomFollowups: input?.useCustomFollowups === true,
    customFollowups: normalizeTemplateList(input?.customFollowups, { multiline: true }),
    date: globalDate,
    intervalMs: Math.round(Number(input.intervalSeconds) * 1000),
    startTime: now,
    waitUntil: 0,
    accountCursor: 0,
    sentTotal: 0,
    accounts,
    lastError: "",
    updatedAt: now,
    currentRecipient: "",
  };
}

function createAnalyseCampaign(input, now = Date.now()) {
  const from = normalizeFollowupDay(input.from);
  const to = normalizeFollowupDay(input.to) || from;
  const openLimit = Math.max(1, Math.min(200, Math.round(Number(input.limit) || 40)));
  const accounts = (input.accounts || []).map((account) => ({
    key: accountKey(account),
    envId: String(account.envId),
    envName: account.envName || "Profile",
    gmailIndex: Number(account.gmailIndex) || 0,
    email: String(account.email || "").trim(),
    senderName: String(account.senderName || "").trim(),
    limit: openLimit,
    sent: 0,
    seenThreadIds: [],
  }));
  return {
    id: nextCampaignId(now),
    kind: "analyse",
    mode: "analyse",
    status: "running",
    phase: "sending",
    from,
    to,
    openLimit,
    startTime: now,
    waitUntil: 0,
    accountCursor: 0,
    sentTotal: 0,
    findings: [],
    counts: {},
    accounts,
    lastError: "",
    updatedAt: now,
    currentRecipient: "",
  };
}

function campaignView(campaign) {
  if (!campaign) return null;
  const warmup = campaign.kind === "warmup";
  const peer = campaign.kind === "peer-warmup";
  const followup = campaign.kind === "followup";
  const analyse = campaign.kind === "analyse";
  let current = null;
  if (warmup) {
    try {
      current = recipientFor(campaign);
    } catch (error) {
      current = campaign.target || null;
    }
  } else if (followup || analyse) {
    current = null;
  } else if (campaign.mode === "scheduled") {
    const account = campaign.accounts?.[campaign.accountCursor];
    current = hasOwnList(account)
      ? account.contacts?.[Number(account.contactIndex) || 0] || null
      : campaign.contacts?.[campaign.contactIndex] || null;
  } else {
    current = campaign.contacts?.[campaign.contactIndex];
  }
  const total = peer
    ? (campaign.accounts || []).length
    : followup || warmup || analyse
      ? (campaign.accounts || []).reduce((sum, account) => sum + (Number(account.limit) || 0), 0)
      : campaign.mode === "scheduled"
        ? scheduledTotal(campaign)
        : (campaign.contacts?.length || 0);
  return {
    id: campaign.id,
    kind: peer ? "peer-warmup" : followup ? "followup" : analyse ? "analyse" : warmup ? "warmup" : "campaign",
    foundTotal: analyse ? (campaign.findings || []).length : 0,
    counts: analyse ? (campaign.counts || {}) : undefined,
    mode: campaign.mode || "shared",
    status: campaign.status,
    phase: campaign.phase,
    stage: campaign.stage || "",
    contactIndex: campaign.contactIndex || 0,
    sentTotal: campaign.sentTotal || 0,
    replyTotal: campaign.replyTotal || 0,
    total,
    accountCursor: campaign.accountCursor || 0,
    lastError: campaign.lastError || "",
    waitUntil: campaign.waitUntil || 0,
    intervalMs: Math.max(0, Math.round(Number(campaign.intervalMs) || 0)),
    betweenAccountMs: Math.max(0, Math.round(Number(campaign.betweenAccountMs) || 0)),
    startTime: campaign.startTime || 0,
    currentRecipient: current?.email || campaign.currentRecipient || "",
    connections: peer ? normalizeConnections(campaign.connections) : undefined,
    accounts: (campaign.accounts || []).map((account, index) => {
      const own = hasOwnList(account);
      return {
        key: account.key,
        envId: account.envId,
        envName: account.envName,
        gmailIndex: account.gmailIndex,
        email: account.email,
        senderName: account.senderName,
        limit: peer
          ? undefined
          : (own ? Math.min(Number(account.limit) || 0, account.contacts.length) : account.limit),
        sent: account.sent || 0,
        sendAt: account.sendAt || 0,
        followupDate: account.followupDate || "",
        cvName: account.cvName || "",
        active: (campaign.status === "running" || campaign.status === "scheduled") && index === campaign.accountCursor,
        done: peer
          ? campaign.status === "done"
          : campaign.mode === "scheduled"
            ? accountFinished(account, campaign)
            : (account.sent || 0) >= (Number(account.limit) || 0),
      };
    }),
  };
}

function interruptibleSleep(ms, shouldStop, deadlineAt) {
  const stop = typeof shouldStop === "function" ? shouldStop : () => false;
  if (ms <= 0 && typeof deadlineAt !== "function") return Promise.resolve(!stop());
  return new Promise((resolve) => {
    const started = Date.now();
    const fallbackEnd = started + Math.max(0, Number(ms) || 0);
    const timer = setInterval(() => {
      if (stop()) {
        clearInterval(timer);
        resolve(false);
        return;
      }
      const end = typeof deadlineAt === "function" ? deadlineAt() : fallbackEnd;
      if (Date.now() >= end) {
        clearInterval(timer);
        resolve(true);
      }
    }, 100);
  });
}

function applyBetweenAccountGap(campaign, seconds, random = Math.random) {
  const between = Math.round(Number(seconds));
  if (!(between >= 10) || between > 86400) {
    throw new Error("Seconds between Gmail accounts must be between 10 and 86400.");
  }
  const ms = between * 1000;
  const oldMs = Number(campaign.betweenAccountMs) || 0;
  campaign.betweenAccountMs = ms;
  const paceUntil = Number(campaign.paceUntil) || 0;
  let from = Number(campaign.paceFrom) || 0;
  if (!from && paceUntil > 0) from = paceUntil - oldMs;
  if (from > 0) {
    const waitMs = gmailGapWaitMs(ms, random);
    campaign.paceFrom = from;
    campaign.paceUntil = from + waitMs;
    if (campaign.phase === "waiting") {
      const account = campaign.accounts?.[campaign.accountCursor];
      campaign.waitUntil = pacedDue(account, campaign);
    }
  }
  return between;
}

function startIntervalWait(campaign, now = Date.now()) {
  const ms = Math.max(0, Number(campaign.intervalMs) || 0);
  campaign.phase = "waiting";
  campaign.waitFrom = now;
  campaign.waitUntil = now + ms;
  return ms;
}

function intervalWaitDeadline(campaign) {
  return () => Number(campaign.waitUntil) || 0;
}

function applyJobInterval(campaign, seconds, random = Math.random) {
  const interval = Math.round(Number(seconds));
  const followupGap = campaign?.kind === "followup";
  const minimum = followupGap ? 10 : 3;
  if (!(interval >= minimum) || interval > 86400) {
    throw new Error(followupGap
      ? "Seconds between Gmail accounts must be between 10 and 86400."
      : "Seconds must be between 3 and 86400.");
  }
  const ms = interval * 1000;
  campaign.intervalMs = ms;
  const from = Number(campaign.waitFrom) || 0;
  if (from > 0 && campaign.phase === "waiting" && campaign.mode !== "scheduled") {
    const waitMs = followupGap ? gmailGapWaitMs(ms, random) : ms;
    campaign.waitUntil = from + waitMs;
  }
  for (const account of campaign.accounts || []) {
    const started = Number(account.intervalFrom) || 0;
    if (started > 0) account.nextSendAt = started + ms;
  }
  if (campaign.mode === "scheduled" && campaign.phase === "waiting") {
    const account = campaign.accounts?.[campaign.accountCursor];
    if (account) campaign.waitUntil = pacedDue(account, campaign);
  }
  return interval;
}

function markNextInterval(account, campaign, now = Date.now()) {
  account.intervalFrom = now;
  account.nextSendAt = now + (Number(campaign.intervalMs) || 0);
}

const CAMPAIGN_KINDS = ["campaign", "warmup", "peer-warmup", "followup", "analyse"];

function normalizeCampaignKind(kind) {
  if (kind === "warmup" || kind === "peer-warmup" || kind === "followup" || kind === "analyse") return kind;
  return "campaign";
}

function storedCampaign(store, kind) {
  const key = normalizeCampaignKind(kind);
  const bag = store?.data?.campaigns;
  if (bag && bag[key]) return bag[key];
  if (key === "campaign") return store?.data?.campaign || null;
  const legacy = store?.data?.campaign;
  if (legacy && normalizeCampaignKind(legacy.kind) === key) return legacy;
  return null;
}

function storedJobById(store, id) {
  if (!id) return null;
  const jobs = store?.data?.campaigns?.jobs;
  if (!jobs || typeof jobs !== "object") return null;
  return jobs[String(id)] || Object.values(jobs).find((campaign) => campaign && String(campaign.id) === String(id)) || null;
}

function storedJobs(store, kind) {
  const key = kind ? normalizeCampaignKind(kind) : "";
  const bag = store?.data?.campaigns?.jobs;
  const fromBag = bag && typeof bag === "object"
    ? Object.values(bag).filter((campaign) => campaign && (!key || normalizeCampaignKind(campaign.kind || key) === key))
    : [];
  if (fromBag.length) return fromBag;
  if (!key) return [];
  const single = storedCampaign(store, key);
  return single ? [single] : [];
}

function pickPrimaryCampaign(list) {
  const rank = (campaign) => {
    if (!campaign) return 0;
    if (campaign.status === "running" || campaign.status === "scheduled") return 4;
    if (campaign.status === "paused" || campaign.status === "error") return 3;
    if (campaign.status === "done" || campaign.status === "stopped") return 1;
    return 0;
  };
  const items = (list || []).filter(Boolean);
  items.sort((a, b) => rank(b) - rank(a) || (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  return items[0] || null;
}

function pruneStoredJobs(jobs) {
  const live = [];
  const finished = [];
  for (const campaign of Object.values(jobs || {})) {
    if (!campaign?.id) continue;
    if (campaign.status === "done" || campaign.status === "stopped") finished.push(campaign);
    else live.push(campaign);
  }
  finished.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  const keep = new Set([...live, ...finished.slice(0, 6)].map((campaign) => String(campaign.id)));
  for (const id of Object.keys(jobs || {})) {
    const campaign = jobs[id];
    if (!keep.has(String(campaign?.id || id))) delete jobs[id];
  }
}

let campaignSerial = 0;
function nextCampaignId(now = Date.now()) {
  campaignSerial += 1;
  return `${now}-${campaignSerial}`;
}

class CampaignRunner {
  constructor({ getMorelogin, gmail, store, onLog, onUpdate, sleep, kind, random }) {
    this.getMorelogin = getMorelogin;
    this.gmail = gmail;
    this.store = store;
    this.onLog = onLog;
    this.onUpdate = onUpdate;
    this.sleep = sleep || interruptibleSleep;
    this.random = typeof random === "function" ? random : Math.random;
    this.kind = kind ? normalizeCampaignKind(kind) : null;
    this.campaign = null;
    this.loopPromise = null;
    this.stopRequested = false;
    this.pauseRequested = false;
  }

  isActive() {
    return Boolean(this.loopPromise);
  }

  shouldHalt() {
    return Boolean(this.stopRequested || this.pauseRequested);
  }

  finishHalt() {
    // Pause only when Pause was clicked. Stop, or an interrupted wait, ends focus fully.
    return this.finish(this.pauseRequested && !this.stopRequested ? "paused" : "stopped");
  }

  log(level, message) {
    if (this.onLog) this.onLog(level, message);
  }

  setGmailStatus(email, status) {
    if (!this.store?.data) return false;
    const key = String(email || "").trim().toLowerCase();
    const label = String(status || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) return false;
    if (label !== "Warming up" && label !== "Active") return false;
    if (String(this.store.data.gmailStatus?.[key] || "") === label) return false;
    const overrides = { ...(this.store.data.gmailStatusOverrides || {}) };
    overrides[key] = label;
    this.store.data.gmailStatusOverrides = overrides;
    this.store.data.gmailStatus = mergeGmailStatus(this.store.data.gmailStatus, overrides);
    return true;
  }

  noteSentToday(account, detail = {}) {
    if (!this.store?.data || !account) return;
    const key = account.key || accountKey(account);
    recordDailySend(this.store.data, key);
    const kind = this.campaign?.kind;
    const who = account.email || key;
    if (kind === "followup") {
      recordKindSend(this.store.data, kind, who, Date.now(), { selectedDate: account.followupDate || "" });
    } else if (kind === "warmup" || kind === "peer-warmup") {
      recordKindSend(this.store.data, kind, who, Date.now(), { reply: detail.reply === true });
    } else if (kind === "campaign") {
      recordKindSend(this.store.data, "campaign", who);
    }
  }

  noteClientSend(account, contact) {
    if (!this.store?.data || this.campaign?.kind !== "campaign" || !contact?.email) return;
    this.store.data.clients = rememberSend(this.store.data.clients, {
      email: contact.email,
      name: contact.name,
      company: contact.company,
      gmail: account?.email,
    });
  }

  noteClientFollowup(account, item) {
    if (!this.store?.data || !item) return;
    this.store.data.clients = rememberFollowup(this.store.data.clients, {
      email: item.toEmail || item.email,
      gmail: account?.email,
    });
  }

  noteClientReply(account, item) {
    if (!this.store?.data || !item) return;
    this.store.data.clients = rememberReply(this.store.data.clients, {
      email: item.email || item.toEmail,
      gmail: account?.email,
      subject: item.subject,
    });
  }

  noteClientBounce(account, finding) {
    if (!this.store?.data || !finding?.email) return;
    this.store.data.clients = rememberBounce(this.store.data.clients, {
      email: finding.email,
      name: finding.firstName,
      gmail: account?.email,
      type: finding.type,
      label: finding.label,
    });
  }

  persist() {
    if (!this.campaign || !this.store) return;
    this.campaign.updatedAt = Date.now();
    const kind = normalizeCampaignKind(this.campaign.kind || this.kind);
    if (!this.store.data.campaigns || typeof this.store.data.campaigns !== "object") {
      this.store.data.campaigns = {};
    }
    if (!this.store.data.campaigns.jobs || typeof this.store.data.campaigns.jobs !== "object") {
      this.store.data.campaigns.jobs = {};
    }
    this.store.data.campaigns.jobs[String(this.campaign.id)] = this.campaign;
    pruneStoredJobs(this.store.data.campaigns.jobs);
    this.store.data.campaigns[kind] = this.campaign;
    if (kind === "campaign") this.store.data.campaign = this.campaign;
    if (this.campaign.kind === "analyse") {
      this.store.data.analysis = mergeSavedAnalysis(this.store.data.analysis, {
        from: this.campaign.from,
        to: this.campaign.to,
        limit: this.campaign.openLimit,
        counts: this.campaign.counts || {},
        contacts: this.campaign.findings || [],
      });
    }
    if (this.campaign.kind !== "warmup" && this.campaign.kind !== "peer-warmup" && this.campaign.kind !== "followup" && this.campaign.kind !== "analyse") {
      const hasSharedList = this.campaign.mode !== "scheduled" || (this.campaign.contacts || []).length > 0;
      const others = storedJobs(this.store, "campaign").filter((campaign) => (
        campaign
        && String(campaign.id) !== String(this.campaign.id)
        && ["running", "scheduled", "paused", "error"].includes(campaign.status)
      ));
      if (hasSharedList && !others.length) {
        this.store.data.contacts = this.campaign.contacts.slice(this.campaign.contactIndex);
      }
    }
    if (this.campaign.kind === "peer-warmup") {
      this.store.data.gmailConnections = normalizeConnections([
        ...(this.store.data.gmailConnections || []),
        ...(this.campaign.connections || []),
      ]);
      this.campaign.connections = this.store.data.gmailConnections;
    }
    if (this.campaign.kind !== "analyse" && (this.campaign.sentTotal || 0) > 0) {
      this.store.data.history = {
        date: new Date().toLocaleString(),
        sent: this.campaign.sentTotal,
      };
    }
    this.store.save();
    if (this.onUpdate) this.onUpdate(campaignView(this.campaign), kind);
  }

  start(campaign) {
    if (this.loopPromise) throw new Error("This operation is already running.");
    this.stopRequested = false;
    this.pauseRequested = false;
    this.campaign = campaign;
    if (!this.campaign.kind) this.campaign.kind = this.kind || "campaign";
    this.kind = normalizeCampaignKind(this.campaign.kind);
    this.persist();
    this.loopPromise = this.loop().finally(() => {
      this.loopPromise = null;
    });
    return campaignView(this.campaign);
  }

  resume(campaignId) {
    if (this.loopPromise) throw new Error("This operation is already running.");
    const kind = normalizeCampaignKind(this.kind || this.campaign?.kind);
    const wanted = campaignId || this.campaign?.id;
    let campaign = null;
    if (this.campaign && (!wanted || String(this.campaign.id) === String(wanted))) campaign = this.campaign;
    if (!campaign && wanted) campaign = storedJobById(this.store, wanted);
    if (!campaign) campaign = storedCampaign(this.store, kind);
    if (!campaign || (campaign.status !== "error" && campaign.status !== "paused")) {
      throw new Error("There is no paused campaign to resume.");
    }
    if (isCampaignComplete(campaign)) {
      throw new Error(
        campaign.kind === "warmup" || campaign.kind === "peer-warmup"
          ? "This warm-up already finished."
          : campaign.kind === "followup"
            ? "This follow-up already finished."
            : campaign.kind === "analyse"
              ? "This analysis already finished."
              : "There are no remaining contacts to send."
      );
    }
    campaign.status = "running";
    if (campaign.kind === "peer-warmup") campaign.phase = campaign.stage === "replying" ? "replying" : "sending";
    else campaign.phase = "sending";
    campaign.lastError = "";
    campaign.waitUntil = 0;
    this.stopRequested = false;
    this.pauseRequested = false;
    this.campaign = campaign;
    this.kind = normalizeCampaignKind(campaign.kind || kind);
    this.persist();
    this.log("info", "Resuming.");
    const run = this.campaign.kind === "peer-warmup"
      ? this.sendPeerWarmupLoop()
      : this.campaign.kind === "followup"
        ? this.sendFollowupLoop()
        : this.campaign.kind === "analyse"
          ? this.sendAnalyseLoop()
          : this.campaign.mode === "scheduled"
          ? this.sendScheduledLoop()
          : this.sendLoop();
    this.loopPromise = run
      .catch((error) => {
        if (error.code === "STOP" || this.shouldHalt()) return this.finishHalt();
        return this.fail(error.message || String(error));
      })
      .finally(() => {
        this.loopPromise = null;
      });
    return campaignView(this.campaign);
  }

  pause() {
    if (!this.loopPromise) return;
    this.pauseRequested = true;
    this.log("info", "Pausing after the current step. Progress will be saved.");
  }

  stop() {
    this.pauseRequested = false;
    this.stopRequested = true;
    this.log("info", "Stopping.");
    // If already paused (loop finished), end it fully so it cannot keep focus or resume.
    if (!this.loopPromise) {
      const campaign = this.campaign || this.store?.data?.campaign;
      if (campaign && (campaign.status === "paused" || campaign.status === "error" || campaign.status === "running" || campaign.status === "scheduled")) {
        this.campaign = campaign;
        this.campaign.status = "stopped";
        this.campaign.phase = "stopped";
        this.campaign.waitUntil = 0;
        this.campaign.lastError = "";
        this.log("info", `Stopped. Sent ${this.campaign.sentTotal || 0} emails.`);
        this.persist();
      }
    }
  }

  async waitInterval() {
    const campaign = this.campaign;
    let waitMs;
    if (campaign?.kind === "followup") {
      const now = Date.now();
      waitMs = gmailGapWaitMs(campaign.intervalMs, this.random);
      campaign.phase = "waiting";
      campaign.waitFrom = now;
      campaign.waitUntil = now + waitMs;
    } else {
      waitMs = startIntervalWait(campaign);
    }
    this.persist();
    return this.sleep(waitMs, () => this.shouldHalt(), intervalWaitDeadline(campaign));
  }

  async loop() {
    try {
      if (this.campaign.kind === "peer-warmup") {
        await this.sendPeerWarmupLoop();
        return;
      }
      if (this.campaign.kind === "followup") {
        await this.sendFollowupLoop();
        return;
      }
      if (this.campaign.kind === "analyse") {
        await this.sendAnalyseLoop();
        return;
      }
      if (this.campaign.mode === "scheduled") {
        await this.sendScheduledLoop();
        return;
      }
      if (this.campaign.phase === "scheduled") {
        const remaining = (this.campaign.waitUntil || 0) - Date.now();
        if (remaining > 0) {
          const ok = await this.sleep(remaining, () => this.shouldHalt());
          if (this.shouldHalt() || !ok) {
            await this.finishHalt();
            return;
          }
        }
        if (this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        this.campaign.status = "running";
        this.campaign.phase = "sending";
        this.campaign.waitUntil = 0;
        this.persist();
      }
      await this.sendLoop();
    } catch (error) {
      if (error.code === "STOP" || this.shouldHalt()) {
        await this.finishHalt();
        return;
      }
      await this.fail(error.message || String(error));
    }
  }

  async sendLoop() {
    let consecutiveFailures = 0;
    while (!this.shouldHalt()) {
      const campaign = this.campaign;
      if (isCampaignComplete(campaign)) {
        await this.finish("done");
        return;
      }

      const account = campaign.accounts[campaign.accountCursor];
      if (!account || account.sent >= account.limit) {
        const next = nextAccountCursor(campaign.accounts, campaign.accountCursor);
        if (next < 0) {
          await this.finish("done");
          return;
        }
        campaign.accountCursor = next;
        this.persist();
        continue;
      }

      const contact = recipientFor(campaign);
      try {
        const session = browserSession(await this.getMorelogin().ensureDebugPort(account.envId, account.gmailIndex));
        if (this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        const personalized = personalizeEmail(
          campaign.language,
          contact,
          account.senderName,
          messageOptions(campaign, includeResumeSentence(account, campaign))
        );
        const from = account.email || `Gmail ${account.gmailIndex}`;
        const prefix = campaign.kind === "warmup" ? "Warm-up: " : "";
        this.log(
          "info",
          `${prefix}Sending "${oneLine(personalized.subject)}" to ${oneLine(contact.email)} from ${oneLine(account.envName)} (${oneLine(from)}).`
        );
        campaign.phase = "sending";
        this.persist();
        await this.gmail.sendGmail({
          debugPort: session.debugPort,
          browserWSEndpoint: session.browserWSEndpoint,
          targetId: session.targetId,
          gmailIndex: account.gmailIndex,
          contact,
          subject: personalized.subject,
          bodyHtml: personalized.bodyHtml,
          bodyText: personalized.bodyText,
          cvPath: account.cvPath || "",
          fromEmail: account.email || "",
          isStopped: () => this.shouldHalt(),
          onTyped: (message) => this.log("info", message),
        });
        consecutiveFailures = 0;
        account.sent += 1;
        this.noteSentToday(account);
        if (campaign.kind === "warmup") campaign.sentTotal = (campaign.sentTotal || 0) + 1;
        else {
          campaign.contactIndex += 1;
          campaign.sentTotal = (campaign.sentTotal || 0) + 1;
        }
        this.log("info", `Sent to ${oneLine(contact.email)}.`);
        this.noteClientSend(account, contact);

        if (isCampaignComplete(campaign)) {
          await this.finish("done");
          return;
        }
        const next = nextAccountCursor(campaign.accounts, campaign.accountCursor);
        if (next < 0) {
          await this.finish("done");
          return;
        }
        const nextAccount = campaign.accounts[next];
        if (!nextAccount || nextAccount.envId !== account.envId) await this.parkChrome(account.envId);
        campaign.accountCursor = next;
        const ok = await this.waitInterval();
        if (!ok || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        campaign.phase = "sending";
        campaign.waitUntil = 0;
        this.persist();
      } catch (error) {
        if (error.code === "STOP" || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        const message = `${account.envName}: ${error.message || error}`;
        consecutiveFailures += 1;
        this.log("error", message);
        if (error.fatal || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          if (campaign.kind === "warmup") {
            await this.fail(message);
            return;
          }
          this.log("info", `Skipped ${oneLine(contact?.email)} and continued sending.`);
          consecutiveFailures = 0;
          campaign.contactIndex += 1;
          if (isCampaignComplete(campaign)) {
            await this.finish("done");
            return;
          }
          const next = nextAccountCursor(campaign.accounts, campaign.accountCursor);
          if (next < 0) {
            await this.finish("done");
            return;
          }
          const nextAccount = campaign.accounts[next];
          if (!nextAccount || nextAccount.envId !== account.envId) await this.parkChrome(account.envId);
          campaign.accountCursor = next;
          const ok = await this.waitInterval();
          if (!ok || this.shouldHalt()) {
            await this.finishHalt();
            return;
          }
          campaign.phase = "sending";
          campaign.waitUntil = 0;
          this.persist();
          continue;
        }
        const ok = await this.sleep(5000, () => this.shouldHalt());
        if (!ok || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
      }
    }
    await this.finishHalt();
  }

  async sendScheduledLoop() {
    let consecutiveFailures = 0;
    while (!this.shouldHalt()) {
      const campaign = this.campaign;
      const index = nextDueIndex(campaign.accounts, campaign);
      if (index < 0) {
        await this.finish("done");
        return;
      }
      campaign.accountCursor = index;
      const account = campaign.accounts[index];
      const ownDue = Number(account.nextSendAt) || 0;
      const due = pacedDue(account, campaign);
      const waitMs = due - Date.now();
      if (waitMs > 0) {
        campaign.status = "running";
        campaign.phase = "waiting";
        campaign.waitUntil = due;
        this.persist();
        const from = account.email || `Gmail ${account.gmailIndex}`;
        if (due > ownDue && waitMs > 1000) {
          this.log("info", `Waiting ${Math.round(waitMs / 1000)} seconds before ${oneLine(from)} sends.`);
        } else if ((account.contactIndex || 0) === 0 && (account.sent || 0) === 0 && waitMs > 1000) {
          this.log("info", `${oneLine(account.envName)} (${oneLine(from)}) sends at ${new Date(due).toLocaleString()}.`);
        }
        const ok = await this.sleep(waitMs, () => this.shouldHalt(), () => pacedDue(account, campaign));
        if (!ok || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
      }
      const contact = hasOwnList(account)
        ? account.contacts[account.contactIndex]
        : campaign.contacts?.[campaign.contactIndex];
      if (!contact?.email) {
        if (hasOwnList(account)) account.contactIndex = account.contacts.length;
        else campaign.contactIndex = (campaign.contacts || []).length;
        continue;
      }
      try {
        const session = browserSession(await this.getMorelogin().ensureDebugPort(account.envId, account.gmailIndex));
        if (this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        const personalized = personalizeEmail(
          campaign.language,
          contact,
          account.senderName,
          messageOptions(campaign, includeResumeSentence(account, campaign))
        );
        const from = account.email || `Gmail ${account.gmailIndex}`;
        this.log(
          "info",
          `Sending "${oneLine(personalized.subject)}" to ${oneLine(contact.email)} from ${oneLine(account.envName)} (${oneLine(from)}).`
        );
        campaign.phase = "sending";
        campaign.waitUntil = 0;
        this.persist();
        await this.gmail.sendGmail({
          debugPort: session.debugPort,
          browserWSEndpoint: session.browserWSEndpoint,
          targetId: session.targetId,
          gmailIndex: account.gmailIndex,
          contact,
          subject: personalized.subject,
          bodyHtml: personalized.bodyHtml,
          bodyText: personalized.bodyText,
          cvPath: account.cvPath || "",
          fromEmail: account.email || "",
          isStopped: () => this.shouldHalt(),
          onTyped: (message) => this.log("info", message),
        });
        consecutiveFailures = 0;
        account.sent += 1;
        this.noteSentToday(account);
        if (hasOwnList(account)) account.contactIndex += 1;
        else campaign.contactIndex += 1;
        campaign.sentTotal = (campaign.sentTotal || 0) + 1;
        this.log("info", `Sent to ${oneLine(contact.email)}.`);
        this.noteClientSend(account, contact);
        if (!accountFinished(account, campaign)) markNextInterval(account, campaign);
        campaign.lastSentKey = account.key;
        const betweenMs = gmailGapWaitMs(campaign.betweenAccountMs, this.random);
        campaign.paceFrom = Date.now();
        campaign.paceUntil = betweenMs > 0 ? campaign.paceFrom + betweenMs : 0;
        const nextIndex = nextDueIndex(campaign.accounts, campaign);
        if (nextIndex < 0) {
          await this.finish("done");
          return;
        }
        const nextAccount = campaign.accounts[nextIndex];
        if (!nextAccount || nextAccount.envId !== account.envId) await this.parkChrome(account.envId);
        campaign.accountCursor = nextIndex;
        campaign.phase = "sending";
        campaign.waitUntil = 0;
        this.persist();
      } catch (error) {
        if (error.code === "STOP" || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        const message = `${account.envName}: ${error.message || error}`;
        consecutiveFailures += 1;
        this.log("error", message);
        if (error.fatal || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.log("info", `Skipped ${oneLine(contact?.email)} and continued sending.`);
          consecutiveFailures = 0;
          if (hasOwnList(account)) account.contactIndex += 1;
          else campaign.contactIndex += 1;
          if (!accountFinished(account, campaign)) markNextInterval(account, campaign);
          const nextIndex = nextDueIndex(campaign.accounts, campaign);
          if (nextIndex < 0) {
            await this.finish("done");
            return;
          }
          const nextAccount = campaign.accounts[nextIndex];
          if (!nextAccount || nextAccount.envId !== account.envId) await this.parkChrome(account.envId);
          campaign.accountCursor = nextIndex;
          campaign.phase = "sending";
          campaign.waitUntil = 0;
          this.persist();
          continue;
        }
        const ok = await this.sleep(5000, () => this.shouldHalt());
        if (!ok || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
      }
    }
    await this.finishHalt();
  }

  async sendPeerWarmupLoop() {
    const campaign = this.campaign;
    campaign.period = Math.max(1, Math.round(Number(campaign.period) || 1));
    campaign.periods = Math.max(1, Math.round(Number(campaign.periods) || 1));
    this.log("info", `Period ${campaign.period} of ${campaign.periods}.`);
    let sendErrors = false;
    while (!this.shouldHalt()) {
    while (!this.shouldHalt() && campaign.stage !== "replying") {
      if (campaign.accountCursor >= campaign.accounts.length) {
        if (!campaign.deliveries.length) {
          this.log("info", sendErrors
            ? "No warm-up email was sent this period."
            : "Every selected Gmail is already connected. Remaining periods were skipped.");
          await this.finish("done");
          return;
        }
        campaign.stage = "replying";
        campaign.phase = "waiting";
        campaign.accountCursor = 0;
        campaign.replyIndex = 0;
        campaign.currentRecipient = "";
        campaign.waitUntil = Date.now() + 15000;
        this.persist();
        this.log("info", "Sending is finished. Waiting 15 seconds before replies.");
        const ready = await this.sleep(15000, () => this.shouldHalt());
        if (!ready || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        campaign.phase = "replying";
        campaign.waitUntil = 0;
        this.persist();
        break;
      }
      const account = campaign.accounts[campaign.accountCursor];
      if (!Array.isArray(campaign.periodBaseline)) {
        campaign.periodBaseline = normalizeConnections(campaign.connections);
      }
      const peer = nextPeer(campaign.accounts, campaign.accountCursor, campaign.periodBaseline, {
        receiveLimit: PEER_PERIOD_RECEIVE_LIMIT,
        deliveries: campaign.deliveries,
      });
      if (!peer) {
        const openPeer = nextPeer(campaign.accounts, campaign.accountCursor, campaign.periodBaseline);
        this.log("info", openPeer
          ? `${oneLine(account.senderName || account.email)} was skipped. Every Gmail it can still email already has ${PEER_PERIOD_RECEIVE_LIMIT} warm-up emails this period.`
          : `${oneLine(account.senderName || account.email)} is already connected to the other selected Gmail accounts. Skipped.`);
        campaign.accountCursor += 1;
        this.persist();
        continue;
      }
      const message = peerIntro(account.senderName, peer.senderName, {
        language: campaign.language,
        includeAttach: false,
        marker: campaign.warmupMarker || WARMUP_MARKER,
        useCustom: campaign.useCustomTemplates === true,
        subjects: campaign.customSubjects,
        bodies: campaign.customBodies,
      });
      campaign.currentRecipient = peer.email;
      campaign.phase = "sending";
      campaign.waitUntil = 0;
      this.persist();
      try {
        const session = browserSession(await this.getMorelogin().ensureDebugPort(account.envId, account.gmailIndex));
        if (this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        this.log("info", `Warm-up: sending "${oneLine(message.subject)}" from ${oneLine(account.email)} to ${oneLine(peer.email)}.`);
        await this.gmail.sendGmail({
          debugPort: session.debugPort,
          browserWSEndpoint: session.browserWSEndpoint,
          targetId: session.targetId,
          gmailIndex: account.gmailIndex,
          contact: { name: peer.senderName, email: peer.email, company: PEER_COMPANY },
          subject: message.subject,
          bodyHtml: message.bodyHtml,
          bodyText: message.bodyText,
          cvPath: "",
          fromEmail: account.email || "",
          isStopped: () => this.shouldHalt(),
          onTyped: (message) => this.log("info", message),
        });
      } catch (error) {
        if (error.code === "STOP" || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        const message = `${account.envName}: ${error.message || error}`;
        this.log("error", message);
        sendErrors = true;
        this.log("info", `Skipped ${oneLine(account.email)} and continued Gmail warm-up.`);
        const nextAccount = campaign.accounts[campaign.accountCursor + 1];
        campaign.accountCursor += 1;
        campaign.currentRecipient = "";
        if (!nextAccount || nextAccount.envId !== account.envId) await this.parkChrome(account.envId);
        if (nextAccount) {
          const ok = await this.waitInterval();
          if (!ok || this.shouldHalt()) {
            await this.finishHalt();
            return;
          }
        } else {
          this.persist();
        }
        continue;
      }
      campaign.connections = addConnection(campaign.connections, account.email, peer.email);
      campaign.deliveries.push({
        fromEmail: account.email,
        toEmail: peer.email,
        fromName: account.senderName,
        toName: peer.senderName,
        subject: message.subject,
        content: message.subject,
      });
      account.sent += 1;
      campaign.sentTotal = (campaign.sentTotal || 0) + 1;
      this.noteSentToday(account);
      this.log("info", `Connected ${oneLine(account.email)} and ${oneLine(peer.email)}.`);
      const nextAccount = campaign.accounts[campaign.accountCursor + 1];
      campaign.accountCursor += 1;
      if (!nextAccount || nextAccount.envId !== account.envId) await this.parkChrome(account.envId);
      if (nextAccount) {
        const ok = await this.waitInterval();
        if (!ok || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
      }
    }
    if (this.shouldHalt()) {
      await this.finishHalt();
      return;
    }
    while (!this.shouldHalt() && campaign.stage === "replying") {
      if (campaign.accountCursor >= campaign.accounts.length) {
        if (campaign.period >= campaign.periods || !campaign.deliveries.length) {
          if (!campaign.deliveries.length && campaign.period < campaign.periods) {
            this.log("info", "Every selected Gmail is already connected. Remaining periods were skipped.");
          }
          await this.finish("done");
          return;
        }
        const finishedPeriod = campaign.period;
        campaign.period += 1;
        campaign.stage = "sending";
        campaign.phase = "waiting";
        campaign.accountCursor = 0;
        campaign.replyIndex = 0;
        campaign.currentRecipient = "";
        campaign.deliveries = [];
        campaign.periodBaseline = null;
        sendErrors = false;
        this.persist();
        this.log("info", `Period ${finishedPeriod} is finished. Starting period ${campaign.period} of ${campaign.periods}.`);
        const between = await this.waitInterval();
        if (!between || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        break;
      }
      const account = campaign.accounts[campaign.accountCursor];
      const pending = repliesForMailbox(campaign.deliveries, account.email);
      campaign.phase = "replying";
      campaign.waitUntil = 0;
      campaign.currentRecipient = "";
      this.persist();
      let result = { replied: [] };
      let replyFailed = false;
      try {
        const session = browserSession(await this.getMorelogin().ensureDebugPort(account.envId, account.gmailIndex));
        if (this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        const marker = campaign.warmupMarker || WARMUP_MARKER;
        this.log("info", `Searching in:anywhere "${marker}" in ${oneLine(account.email)} for every email that includes ${marker}.`);
        result = await this.gmail.replyAllWarmupThreads({
          debugPort: session.debugPort,
          browserWSEndpoint: session.browserWSEndpoint,
          targetId: session.targetId,
          gmailIndex: account.gmailIndex,
          mailboxEmail: account.email || "",
          marker,
          threads: pending,
          pickBody: (thread) => {
            const fromEmail = String(thread?.fromEmail || "").trim().toLowerCase();
            const delivery = (campaign.deliveries || []).find((item) => String(item.fromEmail || "").trim().toLowerCase() === fromEmail);
            const recipient = String(delivery?.fromName || "").replace(/\s+/g, " ").trim().split(" ")[0] || "";
            return peerReply(account.senderName, undefined, {
              replies: campaign.useCustomReplies ? campaign.customReplies : [],
              contact: { name: recipient, company: PEER_COMPANY },
            });
          },
          isStopped: () => this.shouldHalt(),
        });
      } catch (error) {
        if (error.code === "STOP" || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        if (error.replied) {
          campaign.replyTotal = (campaign.replyTotal || 0) + 1;
          this.noteSentToday(account, { reply: true });
          this.log("info", `Replied from ${oneLine(account.email)}.`);
          this.persist();
        }
        const message = `${account.envName}: ${error.message || error}`;
        this.log("error", message);
        this.log("info", `Skipped replies in ${oneLine(account.email)} and continued Gmail warm-up.`);
        replyFailed = true;
      }
      const replied = replyFailed ? [] : (Array.isArray(result?.replied) ? result.replied : []);
      if (!replyFailed && !replied.length) {
        this.log("info", `No one-message w-u email in ${oneLine(account.email)}. Skipped.`);
      }
      const senderSpam = new Map();
      for (const item of replied) {
        campaign.replyTotal = (campaign.replyTotal || 0) + 1;
        this.noteSentToday(account, { reply: true });
        this.log("info", `Replied to ${oneLine(item.fromEmail || item.subject)} from ${oneLine(account.email)}.`);
        const sender = String(item.fromEmail || "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) continue;
        const inSpam = item.folder === "spam";
        if (inSpam) {
          this.log("info", `Clicked Report not spam on the email from ${oneLine(sender)}.`);
          senderSpam.set(sender, true);
        } else if (!senderSpam.has(sender)) {
          senderSpam.set(sender, false);
        }
      }
      if (!this.spamSenders) this.spamSenders = new Set();
      for (const [sender, inSpam] of senderSpam) {
        if (inSpam) this.spamSenders.add(sender);
        const status = inSpam || this.spamSenders.has(sender) ? "Warming up" : "Active";
        if (this.setGmailStatus(sender, status)) {
          this.log("info", status === "Warming up"
            ? `Set ${oneLine(sender)} to Warming up. A warm-up email from that Gmail was in Spam.`
            : `Set ${oneLine(sender)} to Active. The warm-up email from that Gmail was not in Spam.`);
        }
      }
      const missed = Array.isArray(result?.missed) ? result.missed : [];
      if (missed.length) {
        this.log("info", `Left ${missed.length} warm-up ${missed.length === 1 ? "email" : "emails"} in ${oneLine(account.email)} without a reply.`);
      }
      campaign.replyIndex = pending.length;
      this.persist();
      const nextAccount = campaign.accounts[campaign.accountCursor + 1];
      campaign.accountCursor += 1;
      campaign.replyIndex = 0;
      if (!nextAccount || nextAccount.envId !== account.envId) await this.parkChrome(account.envId);
      if (campaign.accountCursor < campaign.accounts.length) {
        const ok = await this.waitInterval();
        if (!ok || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
      }
    }
    if (this.shouldHalt()) {
      await this.finishHalt();
      return;
    }
    }
    if (this.shouldHalt()) await this.finishHalt();
  }

  async sendFollowupLoop() {
    const campaign = this.campaign;
    while (!this.shouldHalt()) {
      const account = campaign.accounts[campaign.accountCursor];
      if (!account || (Number(account.sent) || 0) >= (Number(account.limit) || 0)) {
        const next = nextAccountCursor(campaign.accounts, campaign.accountCursor);
        if (next < 0) {
          await this.finish("done");
          return;
        }
        campaign.accountCursor = next;
        this.persist();
        continue;
      }
      const query = account.followupQuery || followupSentQuery(account.followupDate);
      const bodyText = followupBodyText(campaign, account);
      campaign.phase = "sending";
      campaign.waitUntil = 0;
      campaign.currentRecipient = "";
      this.persist();
      let result = null;
      try {
        const session = browserSession(await this.getMorelogin().ensureDebugPort(account.envId, account.gmailIndex));
        if (this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        this.log("info", account.followupQuery
          ? `Follow-up: searching sent mail in ${oneLine(account.email)} for 1 due client.`
          : `Follow-up: searching sent mail on ${account.followupDate} in ${oneLine(account.email)} for 1 email.`);
        // One follow-up per turn, then the next selected Gmail takes a turn.
        result = await this.gmail.replyFollowupThreads({
          debugPort: session.debugPort,
          browserWSEndpoint: session.browserWSEndpoint,
          targetId: session.targetId,
          gmailIndex: account.gmailIndex,
          mailboxEmail: account.email || "",
          query,
          limit: 1,
          bodyText,
          skipEmails: leftOffEmails(this.store?.data?.clients),
          checkReplies: true,
          isStopped: () => this.shouldHalt(),
        });
      } catch (error) {
        if (error.code === "STOP" || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        if (error.replied) {
          account.sent = (Number(account.sent) || 0) + 1;
          campaign.sentTotal = (campaign.sentTotal || 0) + 1;
          this.noteSentToday(account);
          this.log("info", `Followed up from ${oneLine(account.email)}.`);
          this.persist();
        }
        const message = `${account.envName}: ${error.message || error}`;
        this.log("error", message);
        this.log("info", `Skipped ${oneLine(account.email)} and continued follow-up.`);
        if (!error.replied) account.sent = Number(account.limit) || (Number(account.sent) || 0);
        const next = nextAccountCursor(campaign.accounts, campaign.accountCursor);
        if (next < 0) {
          await this.parkChrome(account.envId);
          await this.finish("done");
          return;
        }
        const nextAccount = campaign.accounts[next];
        if (!nextAccount || nextAccount.envId !== account.envId) await this.parkChrome(account.envId);
        campaign.accountCursor = next;
        if (!error.replied) {
          campaign.phase = "sending";
          campaign.waitUntil = 0;
          this.persist();
          continue;
        }
        const ok = await this.waitInterval();
        if (!ok || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        continue;
      }
      const replied = Array.isArray(result?.replied) ? result.replied : [];
      const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
      for (const item of skipped.slice(0, 8)) {
        const detail = item.messageCount != null
          ? `${item.messageCount} messages, ${item.reason}`
          : String(item.reason || "skipped");
        this.log("info", `Skipped "${oneLine(item.subject)}" (${detail}).`);
      }
      for (const item of replied) {
        account.sent = (Number(account.sent) || 0) + 1;
        campaign.sentTotal = (campaign.sentTotal || 0) + 1;
        this.noteSentToday(account);
        this.noteClientFollowup(account, item);
        this.log("info", `Followed up on "${oneLine(item.subject)}" from ${oneLine(account.email)}.`);
      }
      for (const item of Array.isArray(result?.replies) ? result.replies : []) {
        this.noteClientReply(account, item);
        this.log("info", `${oneLine(item.email)} already replied. Left off the follow-up.`);
      }
      const sentCount = Number(account.sent) || 0;
      const limit = Number(account.limit) || 0;
      const exhausted = !replied.length;
      if (exhausted) {
        if (!sentCount) {
          this.log("info", `No matching mail on ${account.followupDate} in ${oneLine(account.email)}. Skipping it.`);
        } else {
          this.log("info", `No more matching mail for ${oneLine(account.email)} (${sentCount} of ${limit}). Skipping it.`);
        }
        account.sent = limit || sentCount;
      }
      const next = nextAccountCursor(campaign.accounts, campaign.accountCursor);
      if (next < 0) {
        await this.parkChrome(account.envId);
        await this.finish("done");
        return;
      }
      const nextAccount = campaign.accounts[next];
      if (!nextAccount || nextAccount.envId !== account.envId) await this.parkChrome(account.envId);
      campaign.accountCursor = next;
      if (exhausted) {
        campaign.phase = "sending";
        campaign.waitUntil = 0;
        this.persist();
        continue;
      }
      const ok = await this.waitInterval();
      if (!ok || this.shouldHalt()) {
        await this.finishHalt();
        return;
      }
    }
    if (this.shouldHalt()) await this.finishHalt();
  }

  async sendAnalyseLoop() {
    const campaign = this.campaign;
    while (!this.shouldHalt()) {
      const account = campaign.accounts[campaign.accountCursor];
      if (!account || (Number(account.sent) || 0) >= (Number(account.limit) || 0)) {
        const next = nextAccountCursor(campaign.accounts, campaign.accountCursor);
        if (next < 0) {
          await this.finish("done");
          return;
        }
        campaign.accountCursor = next;
        this.persist();
        continue;
      }
      const query = analyseSentQuery(campaign.from, campaign.to);
      const remaining = Math.max(0, (Number(account.limit) || 0) - (Number(account.sent) || 0));
      campaign.phase = "sending";
      campaign.waitUntil = 0;
      campaign.currentRecipient = account.email || "";
      this.persist();
      let result = null;
      try {
        const session = browserSession(await this.getMorelogin().ensureDebugPort(account.envId, account.gmailIndex));
        if (this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        this.log("info", `Analyse: searching sent mail from ${campaign.from} to ${campaign.to} in ${oneLine(account.email)}.`);
        result = await this.gmail.analyseSentThreads({
          debugPort: session.debugPort,
          browserWSEndpoint: session.browserWSEndpoint,
          targetId: session.targetId,
          gmailIndex: account.gmailIndex,
          mailboxEmail: account.email || "",
          query,
          limit: remaining,
          seenIds: account.seenThreadIds || [],
          isStopped: () => this.shouldHalt(),
        });
      } catch (error) {
        if (error.code === "STOP" || this.shouldHalt()) {
          await this.finishHalt();
          return;
        }
        const message = `${account.envName}: ${error.message || error}`;
        this.log("error", message);
        await this.fail(message);
        return;
      }
      const opened = Array.isArray(result?.opened) ? result.opened : [];
      const reports = Array.isArray(result?.reports) ? result.reports : [];
      account.seenThreadIds = Array.isArray(result?.seen) ? result.seen : (account.seenThreadIds || []);
      account.sent = (Number(account.sent) || 0) + opened.length;
      campaign.sentTotal = (campaign.sentTotal || 0) + opened.length;
      if (!Array.isArray(campaign.findings)) campaign.findings = [];
      for (const report of reports) {
        const parsed = parseDeliveryReport(report.body, report);
        if (!parsed) continue;
        const finding = {
          ...parsed,
          subject: oneLine(report.subject),
          gmail: String(account.email || "").trim().toLowerCase(),
        };
        campaign.findings.push(finding);
        this.noteClientBounce(account, finding);
        const who = finding.email
          ? `${finding.email}${finding.firstName ? ` (${finding.firstName})` : ""}`
          : "no client address";
        this.log("info", `${finding.label}: ${who} in ${oneLine(account.email)}.`);
      }
      campaign.counts = countDeliveryTypes(campaign.findings);
      if (result?.exhausted) {
        const previous = (Number(account.sent) || 0) - opened.length;
        if (!previous && !opened.length) {
          this.log("info", `No sent mail from ${campaign.from} to ${campaign.to} in ${oneLine(account.email)}.`);
        } else {
          this.log("info", `No more sent mail for ${oneLine(account.email)} in that period.`);
        }
        account.sent = Number(account.limit) || account.sent;
      }
      const next = nextAccountCursor(campaign.accounts, campaign.accountCursor);
      if (next < 0) {
        await this.parkChrome(account.envId);
        this.persist();
        await this.finish("done");
        return;
      }
      const nextAccount = campaign.accounts[next];
      if (!nextAccount || nextAccount.envId !== account.envId) await this.parkChrome(account.envId);
      campaign.accountCursor = next;
      this.persist();
    }
    if (this.shouldHalt()) await this.finishHalt();
  }

  async parkChrome() {
    // Leave Chrome open. Closing the only Mail Carrier tab quits Chrome while the compose is still on screen.
  }

  async finish(status) {
    if (!this.campaign) return;
    const same = this.campaign.status === status && this.campaign.phase === status && !this.campaign.waitUntil;
    if (!same) {
      this.campaign.status = status;
      this.campaign.phase = status;
      this.campaign.waitUntil = 0;
      const label = this.campaign.kind === "warmup" || this.campaign.kind === "peer-warmup"
        ? "warm-up emails"
        : this.campaign.kind === "followup"
          ? "follow-up emails"
          : this.campaign.kind === "analyse"
            ? "sent emails"
            : "emails";
      const found = (this.campaign.findings || []).length;
      if (status === "done" && this.campaign.kind === "analyse") {
        this.log("info", `Finished. Opened ${this.campaign.sentTotal} sent emails. Found ${found} delivery reports.`);
      } else if (status === "done") this.log("info", `Finished. Sent ${this.campaign.sentTotal} ${label}.`);
      if (status === "paused") this.log("info", `Paused. Sent ${this.campaign.sentTotal} ${label}. Progress saved.`);
      if (status === "stopped") this.log("info", `Stopped. Sent ${this.campaign.sentTotal} ${label}.`);
      this.persist();
    }
    await this.parkChrome();
  }

  async fail(message) {
    if (!this.campaign) return;
    this.campaign.status = "error";
    this.campaign.phase = "error";
    this.campaign.lastError = message;
    this.campaign.waitUntil = 0;
    this.persist();
  }
}

class CampaignHub {
  constructor(deps) {
    this.deps = deps || {};
    this.byKind = new Map();
    this.byId = new Map();
  }

  list(kind) {
    if (!kind) return [...this.byKind.values()].flat();
    return [...(this.byKind.get(normalizeCampaignKind(kind)) || [])];
  }

  track(kind, runner, id) {
    const key = normalizeCampaignKind(kind || runner?.kind);
    const list = this.byKind.get(key) || [];
    if (!list.includes(runner)) list.push(runner);
    this.byKind.set(key, list);
    const jobId = id || runner?.campaign?.id;
    if (jobId) this.byId.set(String(jobId), runner);
  }

  runner(kind) {
    const key = normalizeCampaignKind(kind);
    const list = this.byKind.get(key);
    if (list?.length) return list[list.length - 1];
    const runner = new CampaignRunner({ ...this.deps, kind: key });
    this.byKind.set(key, [runner]);
    return runner;
  }

  isActive(kind) {
    return (kind ? this.list(kind) : this.list()).some((runner) => runner.isActive());
  }

  start(campaign) {
    const kind = normalizeCampaignKind(campaign?.kind);
    const list = this.byKind.get(kind) || [];
    const reusable = list.length === 1 && !list[0].isActive() && !list[0].campaign ? list[0] : null;
    const runner = reusable || new CampaignRunner({ ...this.deps, kind });
    const view = runner.start(campaign);
    this.track(kind, runner, campaign?.id);
    return view;
  }

  stop(kind, id) {
    if (id) {
      const runner = this.byId.get(String(id));
      if (runner) runner.stop();
      return;
    }
    if (!kind) {
      for (const runner of this.list()) {
        if (runner.isActive()) runner.stop();
      }
      return;
    }
    const active = this.list(kind).filter((runner) => runner.isActive());
    const target = active.length ? active[active.length - 1] : this.list(kind).slice(-1)[0];
    if (target) target.stop();
  }

  setBetweenAccounts(id, seconds) {
    const runner = id ? this.byId.get(String(id)) : null;
    if (!runner?.campaign || normalizeCampaignKind(runner.campaign.kind) !== "campaign") {
      throw new Error("Start sending before changing the time between Gmail accounts.");
    }
    const between = applyBetweenAccountGap(runner.campaign, seconds, runner.random);
    runner.persist();
    runner.log("info", between
      ? `Seconds between Gmail accounts is now ${between}.`
      : "No extra wait between Gmail accounts.");
    return campaignView(runner.campaign);
  }

  setJobInterval(id, seconds) {
    const runner = id ? this.byId.get(String(id)) : null;
    const kind = normalizeCampaignKind(runner?.campaign?.kind);
    if (!runner?.campaign || !["campaign", "warmup", "peer-warmup", "followup"].includes(kind)) {
      throw new Error("Start the job before changing the seconds.");
    }
    const interval = applyJobInterval(runner.campaign, seconds, runner.random);
    runner.persist();
    const label = kind === "followup"
      ? "Seconds between Gmail accounts"
      : kind === "campaign"
        ? "Seconds between emails"
        : "Seconds between warm-up emails";
    runner.log("info", `${label} is now ${interval}.`);
    return { view: campaignView(runner.campaign), kind, interval };
  }

  pause(kind, id) {
    const key = normalizeCampaignKind(kind);
    const runner = id
      ? this.byId.get(String(id))
      : this.list(key).filter((item) => item.isActive()).slice(-1)[0];
    if (!runner || !runner.isActive()) throw new Error("Nothing is running to pause.");
    runner.pause();
    return campaignView(runner.campaign);
  }

  resume(kind, id) {
    const key = normalizeCampaignKind(kind);
    if (id && this.byId.has(String(id))) {
      const runner = this.byId.get(String(id));
      if (runner.isActive()) throw new Error("This operation is already running.");
      return runner.resume(id);
    }
    const paused = this.list(key).filter((runner) => (
      !runner.isActive() && runner.campaign && (runner.campaign.status === "paused" || runner.campaign.status === "error")
    ));
    if (!id && paused.length) return paused[paused.length - 1].resume();
    const saved = (id && storedJobById(this.deps.store, id)) || pickPrimaryCampaign(storedJobs(this.deps.store, key).filter((campaign) => (
      campaign.status === "paused" || campaign.status === "error"
    )));
    const runner = new CampaignRunner({ ...this.deps, kind: normalizeCampaignKind(saved?.kind || key) });
    if (saved) runner.campaign = saved;
    this.track(key, runner, saved?.id);
    return runner.resume(saved?.id);
  }

  viewsFor(kind) {
    const key = normalizeCampaignKind(kind);
    const seen = new Set();
    const out = [];
    for (const runner of this.list(key)) {
      if (!runner.campaign) continue;
      const view = campaignView(runner.campaign);
      if (!view?.id || seen.has(String(view.id))) continue;
      seen.add(String(view.id));
      out.push(view);
    }
    for (const campaign of storedJobs(this.deps.store, key)) {
      if (!campaign?.id || seen.has(String(campaign.id))) continue;
      const view = campaignView(campaign);
      if (!view) continue;
      seen.add(String(view.id));
      out.push(view);
    }
    return out;
  }

  view(kind) {
    const key = normalizeCampaignKind(kind);
    return pickPrimaryCampaign(this.viewsFor(key)) || campaignView(storedCampaign(this.deps.store, key));
  }

  views() {
    const out = { jobs: {} };
    for (const key of CAMPAIGN_KINDS) {
      const list = this.viewsFor(key);
      out.jobs[key] = list;
      out[key] = pickPrimaryCampaign(list);
    }
    return out;
  }

  primaryView(preferredKind) {
    const views = this.views();
    const preferred = preferredKind ? views[normalizeCampaignKind(preferredKind)] : null;
    if (preferred && (preferred.status === "running" || preferred.status === "scheduled" || preferred.status === "paused" || preferred.status === "error")) {
      return preferred;
    }
    for (const key of CAMPAIGN_KINDS) {
      const view = views[key];
      if (view && (view.status === "running" || view.status === "scheduled")) return view;
    }
    for (const key of CAMPAIGN_KINDS) {
      const view = views[key];
      if (view && (view.status === "paused" || view.status === "error")) return view;
    }
    return preferred || views.campaign || null;
  }
}

module.exports = {
  CampaignRunner,
  CampaignHub,
  CAMPAIGN_KINDS,
  normalizeCampaignKind,
  storedCampaign,
  createCampaign,
  createWarmupCampaign,
  createPeerWarmupCampaign,
  createFollowupCampaign,
  createAnalyseCampaign,
  campaignView,
  nextAccountCursor,
  activeJobProfiles,
  profilesBusyExcept,
  nextDueIndex,
  sendTimesFromAnchor,
  splitAccountKey,
  validateCampaignInput,
  validateWarmupInput,
  validateFollowupInput,
  validateAnalyseInput,
  interruptibleSleep,
  applyBetweenAccountGap,
  applyJobInterval,
  gmailGapWaitMs,
};
