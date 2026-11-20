const { app, BrowserWindow, dialog, ipcMain, Menu } = require("electron");
const fs = require("fs");
const path = require("path");
const { CampaignHub, CAMPAIGN_KINDS, campaignView, createAnalyseCampaign, createCampaign, createFollowupCampaign, createPeerWarmupCampaign, createWarmupCampaign, normalizeCampaignKind, profilesBusyExcept, splitAccountKey, validateAnalyseInput, validateCampaignInput, validateFollowupInput, validateWarmupInput } = require("./lib/campaign");
const { ChromeProfiles, directoryFromChromeId, isChromeEnvId, removeUnusedJunction } = require("./lib/chrome-profiles");
const { parseContactFile } = require("./lib/contacts");
const gmail = require("./lib/gmail");
const { MoreLoginClient, normalizeBaseUrl } = require("./lib/morelogin");
const { mergeGmailStatus } = require("./lib/sheet-status");
const { analysisRecord } = require("./lib/analyse");
const { localDayKey, sequenceAccounts, todayWarmupLimit, withoutLeftOff } = require("./lib/clients");
const { Store, businessesFromInput, cvForEmail, followupRecord, mergeAccountPref, rememberSenderName, syncCvs, warmupRecord } = require("./lib/store");
const { validatePeerWarmupInput } = require("./lib/peer-warmup");
const { sampleTemplateFiles } = require("./lib/template-samples");
const { normalizeTemplateList, parseTemplateFileText } = require((() => {
  const candidates = [
    path.join(__dirname, "..", "shared", "email-content.js"),
    path.join(__dirname, "shared", "email-content.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
})());

const LANGUAGES = ["en", "zh", "hi", "de"];

function windowIconPath() {
  const devIcon = path.join(__dirname, "..", "icons", "mail-carrier-128.png");
  const packagedIcon = path.join(__dirname, "icons", "mail-carrier-128.png");
  if (app.isPackaged) return packagedIcon;
  return fs.existsSync(devIcon) ? devIcon : packagedIcon;
}
let mainWindow = null;
let store = null;
let morelogin = null;
let chromeProfiles = null;
let hub = null;
let currentProfiles = [];
const logs = [];

function send(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("app:event", event);
}

function log(level, message) {
  const line = { at: new Date().toISOString(), level, message };
  logs.push(line);
  if (logs.length > 300) logs.shift();
  console.log(`[${level}] ${message}`);
  send({ type: "log", line });
}

function markInterrupted(campaign) {
  if (!campaign) return false;
  if (campaign.status !== "running" && campaign.status !== "scheduled") return false;
  campaign.status = "error";
  campaign.phase = "error";
  campaign.waitUntil = 0;
  campaign.lastError = "Mail Carrier closed while sending. Press Resume to continue.";
  return true;
}

function recoverInterruptedCampaign() {
  if (!store.data.campaigns || typeof store.data.campaigns !== "object") store.data.campaigns = {};
  let changed = false;
  if (store.data.campaign && !store.data.campaigns.campaign) {
    store.data.campaigns.campaign = store.data.campaign;
  }
  for (const kind of CAMPAIGN_KINDS) {
    if (markInterrupted(store.data.campaigns[kind])) changed = true;
  }
  const savedJobs = store.data.campaigns.jobs;
  if (savedJobs && typeof savedJobs === "object") {
    for (const campaign of Object.values(savedJobs)) {
      if (markInterrupted(campaign)) changed = true;
    }
  }
  if (markInterrupted(store.data.campaign)) {
    store.data.campaigns.campaign = store.data.campaign;
    changed = true;
  }
  if (changed) store.save();
}

function publishCampaign(view, kind) {
  const key = normalizeCampaignKind(kind || view?.kind);
  send({
    type: "campaign",
    kind: key,
    campaign: view,
    campaigns: hub ? hub.views() : {},
    contacts: store.data.contacts,
    clients: store.data.clients || {},
    history: store.data.history,
    analysis: store.data.analysis || null,
    sentToday: store.data.sentToday || null,
    sendLog: store.data.sendLog || null,
    gmailStatus: store.data.gmailStatus || {},
  });
}

function moreLoginOptions(baseUrl, token) {
  return {
    baseUrl,
    token,
    onStatus: (message) => log("info", message),
  };
}

function installMoreLogin(client) {
  if (morelogin && morelogin.stable && client) client.stable = morelogin.stable;
  morelogin = client;
}

function rebuildClient() {
  try {
    installMoreLogin(new MoreLoginClient(moreLoginOptions(store.data.settings.apiBase, store.data.settings.apiToken)));
  } catch (error) {
    store.data.settings.apiBase = "http://127.0.0.1:40000";
    store.save();
    installMoreLogin(new MoreLoginClient(moreLoginOptions(store.data.settings.apiBase, store.data.settings.apiToken)));
  }
}

function hiddenIds() {
  return new Set((store.data.hiddenProfileIds || []).map(String));
}

function signedInChromeAccounts(profile, live) {
  const hints = (profile?.hintAccounts || [])
    .filter((account) => /@/.test(String(account?.email || "")))
    .map((account, index) => ({
      index: Number.isInteger(Number(account.index)) ? Number(account.index) : index,
      email: String(account.email).trim(),
      name: String(account.name || ""),
    }));
  const current = (Array.isArray(live) ? live : [])
    .filter((account) => /@/.test(String(account?.email || "")));
  return gmail.mergeMailboxAccounts(current, hints).map((account) => {
    const email = account.email.toLowerCase();
    const fromLive = current.find((item) => String(item.email).toLowerCase() === email);
    const fromHint = hints.find((item) => item.email.toLowerCase() === email);
    const liveName = String(fromLive?.name || "");
    const hintName = String(fromHint?.name || "");
    return {
      index: account.index,
      email: account.email,
      name: liveName.length >= hintName.length ? liveName : hintName,
    };
  });
}

function rememberChromeSignIns() {
  let changed = false;
  for (const profile of currentProfiles) {
    if (!isChromeEnvId(profile.envId)) continue;
    const live = store.data.detectedGmail[profile.envId];
    const next = signedInChromeAccounts(profile, live);
    if (!next.length) continue;
    store.data.detectedGmail[profile.envId] = next;
    changed = true;
  }
  if (changed) store.save();
}

function mapProfile(profile) {
  const hasDetected = Object.prototype.hasOwnProperty.call(store.data.detectedGmail, profile.envId);
  const detected = hasDetected ? store.data.detectedGmail[profile.envId] : null;
  const gmailAccounts = Array.isArray(detected) && detected.length
    ? signedInChromeAccounts(profile, detected)
    : (hasDetected ? [] : (profile.hintAccounts || []));
  return {
    envId: profile.envId,
    envName: profile.envName,
    uniqueId: profile.uniqueId,
    groupName: profile.groupName || "",
    source: profile.source || "morelogin",
    running: Boolean(profile.running),
    gmailAccounts,
  };
}

function profileViews() {
  const hidden = hiddenIds();
  return currentProfiles.filter((profile) => !hidden.has(String(profile.envId))).map(mapProfile);
}

function hiddenProfileViews() {
  const hidden = hiddenIds();
  return currentProfiles.filter((profile) => hidden.has(String(profile.envId))).map(mapProfile);
}

function browserSourceOf(value) {
  return value === "chrome" ? "chrome" : "morelogin";
}

function connectionText({ source, moreloginProfiles, moreloginError, chromeList, hiddenCount = 0 }) {
  const hiddenText = hiddenCount ? ` ${hiddenCount} hidden in this app.` : "";
  if (source === "chrome") {
    const found = chromeList?.profiles || [];
    if (chromeList?.error && !found.length) return `${chromeList.error}${hiddenText}`;
    if (!found.length) return `No Chrome profiles on this computer.${hiddenText}`;
    const noun = found.length === 1 ? "profile" : "profiles";
    const access = chromeList.sessionOpen
      ? "Chrome is ready for Gmail."
      : "Click Open to use a profile. Chrome can stay open.";
    return `${found.length} Chrome ${noun}. ${access}${hiddenText}`;
  }
  if (moreloginError) return moreloginError;
  if (!moreloginProfiles.length) return `Connected. No browser profiles in this MoreLogin account.${hiddenText}`;
  const openCount = moreloginProfiles.filter((profile) => profile.running).length;
  const noun = moreloginProfiles.length === 1 ? "profile" : "profiles";
  return `Connected. ${moreloginProfiles.length} ${noun}, ${openCount} open.${hiddenText}`;
}

function openRequests(entries) {
  const requests = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const envId = String(entry && entry.envId ? entry.envId : entry || "").trim();
    if (!envId) continue;
    const gmailIndex = Number(entry && entry.gmailIndex) || 0;
    const key = `${envId}:${gmailIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({ envId, gmailIndex });
  }
  return requests;
}

async function openBrowser(envId, gmailIndex = 0) {
  if (isChromeEnvId(envId)) {
    const directory = directoryFromChromeId(envId);
    if (!directory) throw new Error("That Chrome profile is not valid.");
    return chromeProfiles.ensureProfile(directory, gmailIndex);
  }
  return morelogin.ensureDebugPort(envId);
}

async function releaseBrowser(envId) {
  if (!chromeProfiles) return false;
  if (browserSourceOf(store.data.settings.browserSource) !== "chrome") return false;
  if (envId && !isChromeEnvId(envId)) return false;
  const directory = envId ? directoryFromChromeId(envId) : "";
  return chromeProfiles.closeOwned(directory);
}

async function reloadProfileLists() {
  const source = browserSourceOf(store.data.settings.browserSource);
  if (source === "chrome") {
    const chromeList = await chromeProfiles.list();
    currentProfiles = chromeList.profiles || [];
    return {
      source,
      chromeList,
      moreloginProfiles: [],
      moreloginError: "",
      openError: "",
    };
  }
  let moreloginProfiles = [];
  let moreloginError = "";
  let openError = "";
  try {
    const listed = await morelogin.listProfiles();
    moreloginProfiles = listed.profiles;
    openError = listed.openError || "";
  } catch (error) {
    moreloginError = error.message;
  }
  currentProfiles = moreloginProfiles;
  return {
    source,
    moreloginProfiles,
    moreloginError,
    openError,
    chromeList: { profiles: [], sessionOpen: false, error: "" },
  };
}

function labelFor(envId) {
  const profile = currentProfiles.find((item) => item.envId === String(envId));
  return profile?.envName || String(envId);
}

function templatePayload(payload) {
  const next = {};
  if (payload?.useCustomTemplates != null) next.useCustomTemplates = payload.useCustomTemplates;
  if (payload?.useCustomReplies != null) next.useCustomReplies = payload.useCustomReplies;
  if (payload?.useCustomFollowups != null) next.useCustomFollowups = payload.useCustomFollowups;
  if (payload?.useCustomWarmupIndex != null) next.useCustomWarmupIndex = payload.useCustomWarmupIndex;
  if (payload?.warmupIndex != null) next.warmupIndex = payload.warmupIndex;
  if (Array.isArray(payload?.customSubjects)) next.customSubjects = payload.customSubjects;
  if (Array.isArray(payload?.customBodies)) next.customBodies = payload.customBodies;
  if (Array.isArray(payload?.customReplies)) next.customReplies = payload.customReplies;
  if (Array.isArray(payload?.customFollowups)) next.customFollowups = payload.customFollowups;
  return next;
}

function outboundTemplates(settings = {}) {
  return {
    useCustomTemplates: settings.useCustomTemplates === true,
    customSubjects: Array.isArray(settings.customSubjects) ? settings.customSubjects : [],
    customBodies: Array.isArray(settings.customBodies) ? settings.customBodies : [],
    useCustomReplies: settings.useCustomReplies === true,
    customReplies: Array.isArray(settings.customReplies) ? settings.customReplies : [],
    useCustomFollowups: settings.useCustomFollowups === true,
    customFollowups: Array.isArray(settings.customFollowups) ? settings.customFollowups : [],
    useCustomWarmupIndex: settings.useCustomWarmupIndex === true,
    warmupIndex: String(settings.warmupIndex || ""),
  };
}

function saveSettings(partial = {}) {
  const next = { ...store.data.settings };
  if (partial.apiBase != null && String(partial.apiBase).trim() !== "") {
    next.apiBase = normalizeBaseUrl(partial.apiBase);
  }
  if (partial.apiToken != null) next.apiToken = String(partial.apiToken);
  if (partial.language != null) {
    next.language = LANGUAGES.includes(partial.language) ? partial.language : "en";
  }
  if (partial.intervalSeconds != null && partial.intervalSeconds !== "") {
    const interval = Number(partial.intervalSeconds);
    if (!(interval >= 3) || interval > 86400) {
      throw new Error("Interval must be between 3 and 86400 seconds.");
    }
    next.intervalSeconds = Math.round(interval);
  }
  if (partial.betweenAccountSeconds != null && partial.betweenAccountSeconds !== "") {
    const between = Number(partial.betweenAccountSeconds);
    if (!(between >= 10) || between > 86400) {
      throw new Error("Seconds between Gmail accounts must be between 10 and 86400.");
    }
    next.betweenAccountSeconds = Math.round(between);
  }
  if (partial.startDelaySeconds != null && partial.startDelaySeconds !== "") {
    const delay = Number(partial.startDelaySeconds);
    if (!(delay >= 0) || delay > 86400) {
      throw new Error("Start delay must be between 0 and 86400 seconds.");
    }
    next.startDelaySeconds = Math.round(delay);
  }
  if (partial.defaultLimit != null && partial.defaultLimit !== "") {
    const limit = Number(partial.defaultLimit);
    if (!(limit >= 1)) throw new Error("Max emails must be at least 1.");
    const rounded = Math.round(limit);
    const tab = String(partial.limitTab || "");
    const tabs = ["warmup", "contacts", "followup", "analyse"];
    if (tabs.includes(tab)) {
      const prior = next.limitByTab && typeof next.limitByTab === "object" ? next.limitByTab : {};
      const base = Number(next.defaultLimit) >= 1 ? Math.round(Number(next.defaultLimit)) : 20;
      const book = {};
      for (const name of tabs) {
        const existing = Number.parseInt(prior[name], 10);
        book[name] = existing >= 1 ? existing : base;
      }
      book[tab] = rounded;
      next.limitByTab = book;
    } else if (tab !== "peer") {
      next.defaultLimit = rounded;
    }
  }
  if (partial.mentionAttachment != null) next.mentionAttachment = Boolean(partial.mentionAttachment);
  if (partial.useCustomTemplates != null) next.useCustomTemplates = Boolean(partial.useCustomTemplates);
  if (partial.useCustomReplies != null) next.useCustomReplies = Boolean(partial.useCustomReplies);
  if (partial.useCustomFollowups != null) next.useCustomFollowups = Boolean(partial.useCustomFollowups);
  if (partial.useCustomWarmupIndex != null) next.useCustomWarmupIndex = Boolean(partial.useCustomWarmupIndex);
  if (partial.warmupIndex != null) {
    next.warmupIndex = String(partial.warmupIndex).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").replace(/"/g, "").trim().slice(0, 40);
  }
  if (Array.isArray(partial.customSubjects)) next.customSubjects = normalizeTemplateList(partial.customSubjects);
  if (Array.isArray(partial.customBodies)) {
    next.customBodies = normalizeTemplateList(partial.customBodies, { multiline: true });
  }
  if (Array.isArray(partial.customReplies)) {
    next.customReplies = normalizeTemplateList(partial.customReplies, { multiline: true });
  }
  if (Array.isArray(partial.customFollowups)) {
    next.customFollowups = normalizeTemplateList(partial.customFollowups, { multiline: true });
  }
  if (partial.browserSource != null) next.browserSource = browserSourceOf(partial.browserSource);
  store.data.settings = next;
  store.save();
  installMoreLogin(new MoreLoginClient(moreLoginOptions(next.apiBase, next.apiToken)));
  return next;
}

function saveWarmup(partial = {}) {
  const next = { ...store.data.warmup };
  if (!Array.isArray(next.businesses)) next.businesses = [];
  if (partial.intervalSeconds != null && partial.intervalSeconds !== "") {
    const interval = Number(partial.intervalSeconds);
    if (!(interval >= 3) || interval > 86400) {
      throw new Error("Interval must be between 3 and 86400 seconds.");
    }
    next.intervalSeconds = Math.round(interval);
  }
  if (partial.peerIntervalSeconds != null && partial.peerIntervalSeconds !== "") {
    const peerInterval = Number(partial.peerIntervalSeconds);
    if (!(peerInterval >= 3) || peerInterval > 86400) {
      throw new Error("Interval must be between 3 and 86400 seconds.");
    }
    next.peerIntervalSeconds = Math.round(peerInterval);
  }
  if (partial.peerPeriods != null && partial.peerPeriods !== "") {
    const peerPeriods = Number(partial.peerPeriods);
    if (!(peerPeriods >= 1) || peerPeriods > 30) {
      throw new Error("Periods must be between 1 and 30.");
    }
    next.peerPeriods = Math.round(peerPeriods);
  }
  if (partial.selectedId != null) next.selectedId = String(partial.selectedId).trim().slice(0, 80);
  if (Array.isArray(partial.businesses)) {
    next.businesses = businessesFromInput(partial.businesses);
  } else {
    if (partial.email != null) next.email = String(partial.email).trim().slice(0, 320);
    if (partial.company != null) next.company = String(partial.company).trim().slice(0, 200);
    if (partial.clientName != null) next.clientName = String(partial.clientName).trim().slice(0, 120);
  }
  if (partial.plan != null) next.plan = partial.plan;
  const saved = warmupRecord(next);
  store.data.warmup = saved;
  store.save();
  return saved;
}

function saveAccountRows(accounts) {
  if (!Array.isArray(accounts)) return;
  const next = { ...store.data.accountPrefs };
  let names = store.data.senderNames || {};
  const fallback = store.data.settings.defaultLimit || 20;
  for (const account of accounts) {
    if (!account?.envId) continue;
    const index = Number(account.gmailIndex) || 0;
    const key = `${account.envId}:${index}`;
    next[key] = mergeAccountPref(next[key], account, fallback);
    names = rememberSenderName(names, account.email, account.senderName);
  }
  store.data.accountPrefs = next;
  store.data.cvs = syncCvs(store.data.cvs, next, accounts);
  store.data.senderNames = names;
  store.save();
}

const CONTACT_FILE_FILTERS = [
  { name: "Spreadsheets", extensions: ["csv", "tsv", "txt", "xlsx", "xls", "xlsm", "xlsb", "ods"] },
];

function accountPrefKey(envId, gmailIndex) {
  return `${String(envId || "")}:${Number(gmailIndex) || 0}`;
}

function cvForSend(account) {
  const mail = String(account?.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return {
      cvPath: String(account?.cvPath || "").trim(),
      cvName: String(account?.cvName || ""),
    };
  }
  const cv = cvForEmail(store.data.cvs, mail);
  return { cvPath: cv?.cvPath || "", cvName: cv?.cvName || "" };
}

function liveCampaigns() {
  const found = new Map();
  if (hub) {
    for (const runner of hub.list()) {
      const campaign = runner?.campaign;
      if (campaign?.id) found.set(String(campaign.id), campaign);
    }
  }
  const savedJobs = store.data.campaigns?.jobs;
  if (savedJobs && typeof savedJobs === "object") {
    for (const campaign of Object.values(savedJobs)) {
      if (campaign?.id && !found.has(String(campaign.id))) found.set(String(campaign.id), campaign);
    }
  }
  for (const kind of CAMPAIGN_KINDS) {
    const single = store.data.campaigns?.[kind];
    if (single?.id && !found.has(String(single.id))) found.set(String(single.id), single);
  }
  return [...found.values()];
}

function takeFreeProfiles(accounts) {
  const campaigns = {};
  for (const campaign of liveCampaigns()) campaigns[campaign.id] = campaign;
  const busy = new Set(profilesBusyExcept(campaigns, ""));
  const kept = [];
  let dropped = 0;
  for (const account of accounts || []) {
    if (busy.has(String(account?.envId || ""))) {
      dropped += 1;
      continue;
    }
    kept.push(account);
  }
  if ((accounts || []).length && !kept.length) {
    return { ok: false, error: "Those profiles are already in another job.", kept, dropped };
  }
  if (dropped) {
    log("info", `Left ${dropped} Gmail ${dropped === 1 ? "account" : "accounts"} out because that profile is already in another job.`);
  }
  return { ok: true, kept, dropped };
}

function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

async function readOneGmailBrowser(envId, openIfClosed) {
  const label = labelFor(envId);
  const profile = currentProfiles.find((item) => item.envId === String(envId));
  const chromeProfile = isChromeEnvId(envId);
  let debugPort = profile?.debugPort || "";
  let browserWSEndpoint = profile?.browserWSEndpoint || "";
  let targetId = profile?.targetId || "";
  // A refresh reads mailboxes that are already open. It must not start a browser.
  if (!openIfClosed && (!debugPort || (chromeProfile && !targetId))) return { envId, skipped: true };
  try {
    log("info", `Reading Gmail in ${label}.`);
    if (!debugPort || (chromeProfile && !targetId)) {
      const opened = await openBrowser(envId);
      if (opened && typeof opened === "object") {
        debugPort = opened.debugPort;
        browserWSEndpoint = opened.browserWSEndpoint || "";
        targetId = opened.targetId || "";
      } else {
        debugPort = opened;
      }
    }
    const found = await withTimeout(
      gmail.detectGmailAccounts(debugPort, { targetId, browserWSEndpoint }),
        120000,
      `Timed out while reading Gmail in ${label}.`
    );
    if (found.needsLogin || !found.accounts.length) {
      return {
        envId,
        accounts: [],
        needsLogin: Boolean(found.needsLogin),
        error: found.needsLogin
          ? `${label} is not signed in to Gmail.`
          : `${label} did not show a signed-in Gmail account.`,
      };
    }
    log("info", `${label}: ${found.accounts.map((account) => account.name ? `${account.email} (${account.name})` : account.email).join(", ")}`);
    return { envId, accounts: found.accounts };
  } catch (error) {
    return { envId, error: `${label}: ${error.message}` };
  }
}

async function readGmailAccounts(envIds, openIfClosed) {
  const errors = [];
  const results = [];
  const morelogin = [];
  const chrome = [];
  for (const envId of envIds) {
    if (isChromeEnvId(envId)) chrome.push(envId);
    else morelogin.push(envId);
  }
  const queue = morelogin.slice();
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const envId = queue.shift();
      results.push(await readOneGmailBrowser(envId, openIfClosed));
    }
  });
  await Promise.all(workers);
  for (const envId of chrome) {
    results.push(await readOneGmailBrowser(envId, openIfClosed));
  }
  for (const result of results) {
    if (!result || result.skipped) continue;
    if (result.envId && Array.isArray(result.accounts) && (result.accounts.length || result.needsLogin)) {
      store.data.detectedGmail[result.envId] = result.accounts;
    }
    if (result.error) {
      errors.push(result.error);
      log("error", result.error);
    }
  }
  store.save();
  return errors;
}

async function refreshProfiles(settings) {
  if (settings) saveSettings(settings);
  const loaded = await reloadProfileLists();
  const hidden = hiddenIds();
  const hiddenCount = currentProfiles.filter((profile) => hidden.has(String(profile.envId))).length;
  const visible = currentProfiles.filter((profile) => !hidden.has(String(profile.envId)));
  const readIds = visible
    .filter((profile) => profile.running && profile.debugPort)
    .map((profile) => profile.envId);
  if (readIds.length) {
    log("info", `Reading signed-in Gmail in ${readIds.length} open browser${readIds.length === 1 ? "" : "s"}.`);
  }
  const gmailErrors = readIds.length ? await readGmailAccounts(readIds, false) : [];
  if (readIds.length) {
    const again = await reloadProfileLists();
    loaded.chromeList = again.chromeList;
    loaded.moreloginProfiles = again.moreloginProfiles;
    loaded.openError = again.openError;
    if (again.moreloginError) loaded.moreloginError = again.moreloginError;
  }
  if (loaded.source === "chrome") rememberChromeSignIns();
  const profiles = profileViews();
  let connection = connectionText({
    source: loaded.source,
    moreloginProfiles: loaded.moreloginProfiles,
    moreloginError: loaded.moreloginError,
    chromeList: loaded.chromeList,
    hiddenCount,
  });
  if (loaded.source !== "chrome" && loaded.openError) {
    connection += ` Could not list browsers that are already open (${loaded.openError}).`;
  }
  const gmailCount = profiles.reduce((sum, profile) => sum + (Array.isArray(profile.gmailAccounts) ? profile.gmailAccounts.filter((account) => account.email).length : 0), 0);
  if (gmailCount) connection += ` ${gmailCount} signed-in Gmail account${gmailCount === 1 ? "" : "s"}.`;
  if (gmailErrors.length) connection += ` ${gmailErrors.join(" ")}`;
  if (loaded.source !== "chrome" && loaded.moreloginError) {
    const failure = new Error(loaded.moreloginError);
    failure.gmailStatus = store.data.gmailStatus;
    throw failure;
  }
  const chromeWarning = loaded.source === "chrome" && loaded.chromeList?.error && !(loaded.chromeList.profiles || []).length
    ? loaded.chromeList.error
    : "";
  return {
    profiles,
    hiddenProfiles: hiddenProfileViews(),
    connection,
    settings: store.data.settings,
    gmailStatus: store.data.gmailStatus,
    openError: loaded.openError,
    warning: chromeWarning,
  };
}

function saveFollowup(partial = {}) {
  const next = { ...store.data.followup };
  if (partial.body != null) next.body = String(partial.body);
  if (partial.date != null) next.date = String(partial.date || "");
  if (partial.intervalSeconds != null && partial.intervalSeconds !== "") {
    const interval = Number(partial.intervalSeconds);
    if (!(interval >= 10) || interval > 86400) {
      throw new Error("Seconds between Gmail accounts must be between 10 and 86400.");
    }
    next.intervalSeconds = Math.round(interval);
  }
  if (partial.steps != null) next.steps = partial.steps;
  const saved = followupRecord(next);
  store.data.followup = saved;
  store.save();
  return saved;
}

function snapshot() {
  return {
    settings: store.data.settings,
    warmup: store.data.warmup,
    followup: store.data.followup,
    analysis: store.data.analysis,
    contacts: store.data.contacts,
    clients: store.data.clients || {},
    history: store.data.history,
    profiles: profileViews(),
    hiddenProfiles: hiddenProfileViews(),
    prefs: store.data.accountPrefs,
    cvs: store.data.cvs || {},
    senderNames: store.data.senderNames || {},
    sentToday: store.data.sentToday || null,
    sendLog: store.data.sendLog || null,
    gmailStatus: store.data.gmailStatus,
    gmailConnections: store.data.gmailConnections || [],
    campaigns: hub ? hub.views() : (store.data.campaigns || {}),
    campaign: hub ? hub.primaryView() : campaignView(store.data.campaign),
    logs,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: "Mail Carrier",
    backgroundColor: "#f3efe7",
    show: false,
    icon: windowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => {
    if (process.env.MAIL_CARRIER_SMOKE === "1" || mainWindow.isDestroyed()) return;
    mainWindow.show();
  });

  if (process.env.MAIL_CARRIER_SMOKE === "1") {
    const smokeTimer = setTimeout(() => {
      console.error("SMOKE_TIMEOUT");
      app.exit(1);
    }, 20000);
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow.webContents
        .executeJavaScript("Boolean(window.mailCarrier && document.getElementById('start') && document.getElementById('warmup-start') && document.getElementById('warmup-email') && document.getElementById('warmup-company') && document.getElementById('warmup-client') && document.getElementById('warmup-interval') && document.getElementById('status-pick') && document.getElementById('mention-attachment') && document.getElementById('source-morelogin') && document.getElementById('source-chrome') && !document.getElementById('settings-open') && !document.getElementById('status-load'))")
        .then((ok) => {
          clearTimeout(smokeTimer);
          console.log(ok ? "SMOKE_OK" : "SMOKE_NO_API");
          app.exit(ok ? 0 : 1);
        })
        .catch((error) => {
          clearTimeout(smokeTimer);
          console.error(error);
          app.exit(1);
        });
    });
  }

  mainWindow.on("close", (event) => {
    if (!hub || !hub.isActive()) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      buttons: ["Keep sending", "Quit"],
      defaultId: 0,
      cancelId: 0,
      message: "Mail Carrier still has work running.",
      detail: "Business warm-up, Gmail warm-up, follow-up, or sending may still be in progress. If you quit, open the app again and press Resume on that tab.",
    });
    if (choice === 0) event.preventDefault();
  });
}

function registerIpc() {
  ipcMain.handle("state:get", () => snapshot());

  ipcMain.handle("settings:save", (_event, partial) => {
    try {
      return { ok: true, settings: saveSettings(partial || {}) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("profiles:refresh", async (_event, settings) => {
    try {
      const result = await refreshProfiles(settings);
      log("info", result.connection);
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: error.message, gmailStatus: error.gmailStatus || store.data.gmailStatus };
    }
  });

  ipcMain.handle("profiles:open", async (_event, envIds) => {
    if (hub.isActive()) return { ok: false, error: "Wait until all warm-up, follow-up, and sending jobs stop before opening browsers." };
    const requests = openRequests(envIds);
    if (!requests.length) return { ok: false, error: "Select at least one profile." };
    const errors = [];
    let code = "";
    for (const request of requests) {
      const envId = request.envId;
      const label = labelFor(envId);
      try {
        log("info", `Opening ${label}.`);
        const opened = await openBrowser(envId, request.gmailIndex);
        if (isChromeEnvId(envId) && opened && opened.targetId) {
          await gmail.focusGmailInbox(opened.debugPort, opened.targetId, {
            browserWSEndpoint: opened.browserWSEndpoint || "",
            gmailIndex: request.gmailIndex,
          });
        }
        log("info", `${label} mailbox is open.`);
      } catch (error) {
        errors.push(`${label}: ${error.message}`);
        log("error", `${label}: ${error.message}`);
        if (error.code === "CHROME_DEBUG") {
          code = error.code;
          break;
        }
      }
    }
    try {
      await reloadProfileLists();
    } catch (error) {
      errors.push(error.message);
    }
    const count = requests.length;
    return {
      ok: errors.length === 0,
      error: errors.join(" "),
      code,
      profiles: profileViews(),
      hiddenProfiles: hiddenProfileViews(),
      message: errors.length ? errors.join(" ") : `Opened ${count} mailbox${count === 1 ? "" : "es"}.`,
    };
  });

  ipcMain.handle("profiles:read-gmail", async (_event, envIds) => {
    if (hub.isActive()) return { ok: false, error: "Wait until all warm-up, follow-up, and sending jobs stop before reading Gmail." };
    let ids = [...new Set((envIds || []).map(String).filter(Boolean))];
    if (!ids.length) {
      const hidden = hiddenIds();
      ids = currentProfiles
        .filter((profile) => profile.running && !hidden.has(String(profile.envId)))
        .map((profile) => profile.envId);
    }
    if (!ids.length) return { ok: false, error: "Open a browser, or check a closed profile." };
    let errors = [];
    try {
      errors = await readGmailAccounts(ids, true);
    } catch (error) {
      log("error", error.message);
      return {
        ok: false,
        error: error.message,
        code: error.code || "",
        profiles: profileViews(),
        hiddenProfiles: hiddenProfileViews(),
      };
    }
    try {
      await reloadProfileLists();
    } catch (error) {
      errors.push(error.message);
    }
    return {
      ok: errors.length === 0,
      error: errors.join(" "),
      profiles: profileViews(),
      hiddenProfiles: hiddenProfileViews(),
      message: errors.length ? errors.join(" ") : "Read the signed-in Gmail accounts.",
    };
  });

  ipcMain.handle("profiles:hide", (_event, envIds) => {
    if (hub.isActive()) return { ok: false, error: "Wait until all warm-up, follow-up, and sending jobs stop before hiding a profile." };
    const ids = [...new Set((envIds || []).map(String).filter(Boolean))];
    if (!ids.length) return { ok: false, error: "Choose a profile to hide." };
    const hidden = new Set(store.data.hiddenProfileIds || []);
    ids.forEach((id) => hidden.add(id));
    store.data.hiddenProfileIds = [...hidden];
    store.save();
    const count = ids.length;
    const chromeCount = ids.filter((envId) => isChromeEnvId(envId)).length;
    const where = chromeCount === count ? "Chrome" : (chromeCount === 0 ? "MoreLogin" : "the browser");
    const stays = count === 1 ? "It stays" : "They stay";
    return {
      ok: true,
      profiles: profileViews(),
      hiddenProfiles: hiddenProfileViews(),
      message: `Hid ${count} profile${count === 1 ? "" : "s"} in this app. ${stays} in ${where}.`,
    };
  });

  ipcMain.handle("profiles:restore", (_event, envIds) => {
    if (hub.isActive()) return { ok: false, error: "Wait until all warm-up, follow-up, and sending jobs stop before showing a profile." };
    const ids = new Set((envIds || []).map(String).filter(Boolean));
    if (!ids.size) return { ok: false, error: "Choose a profile to show." };
    store.data.hiddenProfileIds = (store.data.hiddenProfileIds || []).filter((id) => !ids.has(String(id)));
    store.save();
    return {
      ok: true,
      profiles: profileViews(),
      hiddenProfiles: hiddenProfileViews(),
      message: "The profile is back in this list.",
    };
  });

  ipcMain.handle("contacts:import-account", async (_event, payload) => {
    const envId = String(payload?.envId || "");
    const gmailIndex = Number(payload?.gmailIndex) || 0;
    if (!envId) return { ok: false, error: "Choose a Gmail account." };
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: "Import contacts for this Gmail",
      properties: ["openFile"],
      filters: CONTACT_FILE_FILTERS,
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, canceled: true };
    try {
      const parsed = parseContactFile(picked.filePaths[0]);
      if (!parsed.contacts.length) return { ok: false, error: "That file has no email addresses." };
      const key = accountPrefKey(envId, gmailIndex);
      const previous = store.data.accountPrefs[key] || {};
      const fileName = path.basename(picked.filePaths[0]);
      store.data.accountPrefs[key] = {
        ...previous,
        contacts: parsed.contacts,
        contactFileName: fileName,
      };
      store.save();
      return {
        ok: true,
        key,
        contacts: parsed.contacts,
        skipped: parsed.skipped,
        count: parsed.contacts.length,
        fileName,
      };
    } catch (error) {
      return { ok: false, error: error.message || "Could not read that file." };
    }
  });

  ipcMain.handle("contacts:clear-account", (_event, payload) => {
    const envId = String(payload?.envId || "");
    const gmailIndex = Number(payload?.gmailIndex) || 0;
    if (!envId) return { ok: false, error: "Choose a Gmail account." };
    const key = accountPrefKey(envId, gmailIndex);
    const previous = store.data.accountPrefs[key] || {};
    store.data.accountPrefs[key] = {
      ...previous,
      contacts: [],
      contactFileName: "",
    };
    store.save();
    return { ok: true, key, contacts: [] };
  });

  ipcMain.handle("contacts:import", async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: "Import contacts",
      properties: ["openFile"],
      filters: CONTACT_FILE_FILTERS,
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, canceled: true };
    try {
      const parsed = parseContactFile(picked.filePaths[0]);
      store.data.contacts = parsed.contacts;
      store.save();
      return {
        ok: true,
        contacts: parsed.contacts,
        skipped: parsed.skipped,
        count: parsed.contacts.length,
      };
    } catch (error) {
      return { ok: false, error: error.message || "Could not read that file." };
    }
  });

  ipcMain.handle("contacts:clear", () => {
    store.data.contacts = [];
    store.save();
    return { ok: true, contacts: [] };
  });

  const TEMPLATE_IMPORTS = {
    subject: { multiline: false, title: "Import subjects" },
    body: { multiline: true, title: "Import bodies" },
    reply: { multiline: true, title: "Import warm-up replies" },
    followup: { multiline: true, title: "Import follow-up emails" },
  };

  ipcMain.handle("templates:sample", async (_event, group) => {
    const files = sampleTemplateFiles(String(group || ""));
    if (!files.length) return { ok: false, error: "Choose a template list." };
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a folder for the sample files",
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, canceled: true };
    try {
      const directory = picked.filePaths[0];
      for (const file of files) {
        fs.writeFileSync(path.join(directory, file.name), file.text, "utf8");
      }
      return { ok: true, files: files.map((file) => file.name), directory };
    } catch (error) {
      return { ok: false, error: error.message || "Could not save the sample files." };
    }
  });

  ipcMain.handle("templates:import", async (_event, kind) => {
    const spec = TEMPLATE_IMPORTS[String(kind || "")];
    if (!spec) return { ok: false, error: "Choose a template list." };
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: spec.title,
      properties: ["openFile"],
      filters: [
        { name: "CSV or TXT", extensions: ["csv", "txt"] },
      ],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, canceled: true };
    try {
      const filePath = picked.filePaths[0];
      const ext = path.extname(filePath).slice(1).toLowerCase();
      if (ext !== "csv" && ext !== "txt") return { ok: false, error: "Choose a CSV or TXT file." };
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return { ok: false, error: "Choose a file." };
      if (stat.size > 2 * 1024 * 1024) return { ok: false, error: "That file is larger than 2MB." };
      const texts = parseTemplateFileText(fs.readFileSync(filePath, "utf8"), {
        ext,
        kind,
        multiline: spec.multiline,
      });
      if (!texts.length) return { ok: false, error: "That file has no text." };
      return { ok: true, texts, count: texts.length };
    } catch (error) {
      return { ok: false, error: error.message || "Could not read that file." };
    }
  });

  ipcMain.handle("cv:pick", async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a CV",
      properties: ["openFile"],
      filters: [
        { name: "Documents", extensions: ["pdf", "doc", "docx", "txt", "rtf"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, canceled: true };
    const filePath = picked.filePaths[0];
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { ok: false, error: "Choose a file." };
    if (stat.size > 24 * 1024 * 1024) return { ok: false, error: "That CV is larger than 24MB." };
    return { ok: true, path: filePath, name: path.basename(filePath) };
  });

  ipcMain.handle("prefs:save", (_event, prefs) => {
    saveAccountRows(Object.entries(prefs || {}).map(([key, value]) => {
      const parsed = splitAccountKey(key);
      return { ...value, envId: parsed.envId, gmailIndex: parsed.gmailIndex };
    }));
    return { ok: true, cvs: store.data.cvs || {} };
  });

  ipcMain.handle("campaign:start", (_event, payload) => {
    const rows = Array.isArray(payload?.accounts) ? payload.accounts : [];
    const chosen = rows.filter((account) => account.selected);
    const available = takeFreeProfiles(chosen);
    if (!available.ok) return { ok: false, error: available.error };
    const selected = available.kept;
    try {
      saveSettings(payload || {});
      saveAccountRows(rows);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    let dropped = 0;
    const accounts = selected.map((account) => {
      const index = Number(account.gmailIndex) || 0;
      const pref = store.data.accountPrefs[accountPrefKey(account.envId, index)] || {};
      const own = withoutLeftOff(Array.isArray(pref.contacts) ? pref.contacts : [], store.data.clients);
      dropped += own.dropped;
      return {
        ...account,
        ...cvForSend(account),
        gmailIndex: index,
        contacts: own.contacts,
        scheduleSend: Boolean(account.scheduleSend),
        sendAt: account.scheduleSend ? (Number(account.sendAt) || Number(pref.sendAt) || 0) : 0,
      };
    });
    const shared = withoutLeftOff(store.data.contacts, store.data.clients);
    dropped += shared.dropped;
    if (dropped) log("info", `Left ${dropped} bounced client${dropped === 1 ? "" : "s"} off this send.`);
    const input = {
      contacts: shared.contacts,
      accounts,
      language: store.data.settings.language,
      intervalSeconds: store.data.settings.intervalSeconds,
      betweenAccountSeconds: store.data.settings.betweenAccountSeconds ?? 0,
      startDelaySeconds: 0,
      includeAttach: store.data.settings.mentionAttachment !== false,
      ...outboundTemplates(store.data.settings),
    };
    const errors = validateCampaignInput(input);
    if (errors.length) {
      if (dropped && errors.some((error) => /^Import contacts/.test(error))) {
        return { ok: false, error: "Every client address was left off after a delivery failure." };
      }
      return { ok: false, error: errors.slice(0, 3).join(" ") };
    }
    try {
      const view = hub.start(createCampaign(input));
      const when = Number(view?.startTime) || 0;
      log("info", when > Date.now() + 1000 ? `Sending starts at ${new Date(when).toLocaleString()}.` : "Sending.");
      return { ok: true, campaign: view, campaigns: hub.views(), settings: store.data.settings };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("campaign:stop", (_event, payload) => {
    const kind = payload?.kind ? normalizeCampaignKind(payload.kind) : null;
    hub.stop(kind, payload?.id);
    return {
      ok: true,
      kind: kind || null,
      campaign: kind ? hub.view(kind) : hub.primaryView(),
      campaigns: hub.views(),
    };
  });

  ipcMain.handle("campaign:pause", (_event, payload) => {
    const kind = normalizeCampaignKind(payload?.kind || hub.primaryView()?.kind);
    try {
      const view = hub.pause(kind, payload?.id);
      return { ok: true, kind, campaign: view, campaigns: hub.views() };
    } catch (error) {
      return { ok: false, error: error.message, campaigns: hub.views() };
    }
  });

  ipcMain.handle("campaign:resume", (_event, payload) => {
    const kind = normalizeCampaignKind(payload?.kind || "campaign");
    try {
      return { ok: true, kind, campaign: hub.resume(kind, payload?.id), campaigns: hub.views() };
    } catch (error) {
      return { ok: false, error: error.message, campaigns: hub.views() };
    }
  });

  ipcMain.handle("campaign:between-accounts", (_event, payload) => {
    try {
      const view = hub.setBetweenAccounts(payload?.id, payload?.seconds);
      saveSettings({ betweenAccountSeconds: payload?.seconds });
      return { ok: true, campaign: view, campaigns: hub.views(), settings: store.data.settings };
    } catch (error) {
      return { ok: false, error: error.message, campaigns: hub.views() };
    }
  });

  ipcMain.handle("campaign:interval", (_event, payload) => {
    try {
      const changed = hub.setJobInterval(payload?.id, payload?.seconds);
      if (changed.kind === "warmup") saveWarmup({ intervalSeconds: changed.interval });
      else if (changed.kind === "peer-warmup") saveWarmup({ peerIntervalSeconds: changed.interval });
      else if (changed.kind === "followup") saveFollowup({ intervalSeconds: changed.interval });
      else saveSettings({ intervalSeconds: changed.interval });
      return {
        ok: true,
        campaign: changed.view,
        campaigns: hub.views(),
        settings: store.data.settings,
        warmup: store.data.warmup,
        followup: store.data.followup,
      };
    } catch (error) {
      return { ok: false, error: error.message, campaigns: hub.views() };
    }
  });

  ipcMain.handle("gmail-status:save", (_event, payload) => {
    const email = String(payload?.email || "").trim().toLowerCase();
    const status = String(payload?.status || "").trim().slice(0, 40);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: "That is not an email address." };
    }
    const overrides = { ...(store.data.gmailStatusOverrides || {}) };
    overrides[email] = status;
    store.data.gmailStatusOverrides = overrides;
    store.data.gmailStatus = mergeGmailStatus(store.data.gmailStatus, overrides);
    store.save();
    return { ok: true, gmailStatus: store.data.gmailStatus };
  });

  ipcMain.handle("warmup:save", (_event, partial) => {
    try {
      return { ok: true, warmup: saveWarmup(partial || {}) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("warmup:start", (_event, payload) => {
    const chosen = Array.isArray(payload?.accounts) ? payload.accounts.filter((account) => account.selected) : [];
    const available = takeFreeProfiles(chosen);
    if (!available.ok) return { ok: false, error: available.error };
    const selected = available.kept;
    try {
      saveSettings({
        language: payload?.language,
        mentionAttachment: payload?.mentionAttachment,
        ...templatePayload(payload),
      });
    } catch (error) {
      return { ok: false, error: error.message };
    }
    let warmup;
    try {
      warmup = saveWarmup(payload || {});
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const input = {
      email: warmup.email,
      company: warmup.company,
      clientName: warmup.clientName,
      businesses: warmup.businesses || [],
      selectedId: warmup.selectedId || "",
      accounts: selected,
      language: store.data.settings.language,
      intervalSeconds: warmup.intervalSeconds,
      startDelaySeconds: 0,
      includeAttach: store.data.settings.mentionAttachment !== false,
      ...outboundTemplates(store.data.settings),
    };
    const errors = validateWarmupInput(input);
    if (errors.length) return { ok: false, error: errors.slice(0, 3).join(" "), warmup };
    saveAccountRows(payload?.accounts || []);
    try {
      const view = hub.start(createWarmupCampaign(input));
      log("info", `Warming up ${warmup.email}.`);
      return { ok: true, campaign: view, campaigns: hub.views(), warmup, settings: store.data.settings };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("connections:clear", () => {
    store.data.gmailConnections = [];
    store.save();
    return { ok: true, gmailConnections: [] };
  });

  ipcMain.handle("warmup:start-peers", (_event, payload) => {
    const chosen = Array.isArray(payload?.accounts) ? payload.accounts.filter((account) => account.selected) : [];
    const available = takeFreeProfiles(chosen);
    if (!available.ok) return { ok: false, error: available.error };
    const selected = available.kept;
    let warmup;
    try {
      const templates = templatePayload(payload);
      if (Object.keys(templates).length) saveSettings(templates);
      warmup = saveWarmup({
        peerIntervalSeconds: payload?.intervalSeconds,
        peerPeriods: payload?.periods,
      });
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const input = {
      accounts: selected,
      intervalSeconds: warmup.peerIntervalSeconds,
      periods: warmup.peerPeriods,
      connections: store.data.gmailConnections || [],
      language: store.data.settings.language,
      includeAttach: store.data.settings.mentionAttachment !== false,
      ...outboundTemplates(store.data.settings),
    };
    const errors = validatePeerWarmupInput(input);
    if (errors.length) return { ok: false, error: errors.slice(0, 3).join(" ") };
    try {
      saveAccountRows(payload?.accounts || []);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    try {
      const view = hub.start(createPeerWarmupCampaign(input));
      log("info", `Warming up ${selected.length} Gmail accounts with each other.`);
      return {
        ok: true,
        campaign: view,
        campaigns: hub.views(),
        gmailConnections: store.data.gmailConnections || [],
        warmup,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("followup:save", (_event, partial) => {
    try {
      return { ok: true, followup: saveFollowup(partial || {}) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

function saveAnalysis(partial = {}) {
  const next = { ...(store.data.analysis || {}) };
  if (partial.from != null) next.from = String(partial.from || "");
  if (partial.to != null) next.to = String(partial.to || "");
  if (partial.limit != null && partial.limit !== "") next.limit = partial.limit;
  const saved = analysisRecord(next);
  if (partial.counts && typeof partial.counts === "object") saved.counts = { ...partial.counts };
  store.data.analysis = saved;
  store.save();
  return saved;
}

  ipcMain.handle("analyse:save", (_event, partial) => {
    try {
      return { ok: true, analysis: saveAnalysis(partial || {}) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("analyse:start", (_event, payload) => {
    const chosen = Array.isArray(payload?.accounts) ? payload.accounts.filter((account) => account.selected) : [];
    const available = takeFreeProfiles(chosen);
    if (!available.ok) return { ok: false, error: available.error };
    const selected = available.kept;
    let analysis;
    try {
      analysis = saveAnalysis({
        from: payload?.from,
        to: payload?.to,
        limit: payload?.limit,
      });
      saveAccountRows(payload?.accounts || []);
    } catch (error) {
      return { ok: false, error: error.message, analysis };
    }
    const input = {
      accounts: selected,
      from: analysis.from,
      to: analysis.to || analysis.from,
      limit: analysis.limit,
    };
    const errors = validateAnalyseInput(input);
    if (errors.length) return { ok: false, error: errors.slice(0, 3).join(" "), analysis };
    try {
      const view = hub.start(createAnalyseCampaign(input));
      log("info", `Analysing sent mail in ${selected.length} Gmail account${selected.length === 1 ? "" : "s"}.`);
      return { ok: true, campaign: view, campaigns: hub.views(), analysis: store.data.analysis };
    } catch (error) {
      return { ok: false, error: error.message, analysis };
    }
  });

  ipcMain.handle("warmup:apply-plan", (_event, payload) => {
    const chosen = Array.isArray(payload?.accounts) ? payload.accounts.filter((account) => account.selected) : [];
    const available = takeFreeProfiles(chosen);
    if (!available.ok) return { ok: false, error: available.error };
    const selected = available.kept;
    if (!selected.length) return { ok: false, error: "Check the Gmail accounts that should use today's max." };
    let warmup;
    try {
      warmup = saveWarmup({
        peerIntervalSeconds: payload?.intervalSeconds,
        peerPeriods: payload?.periods,
        plan: payload?.plan,
      });
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const limit = todayWarmupLimit(warmup.plan);
    if (!warmup.plan.startedAt) warmup.plan.startedAt = localDayKey();
    store.data.warmup = warmupRecord({ ...warmup, plan: warmup.plan });
    try {
      saveAccountRows(selected.map((account) => {
        const copy = { ...account };
        delete copy.limit;
        delete copy.limitTab;
        return copy;
      }));
    } catch (error) {
      return { ok: false, error: error.message };
    }
    log("info", `Today's warm-up max is ${limit}.`);
    return { ok: true, warmup: store.data.warmup, prefs: store.data.accountPrefs, limit };
  });

  ipcMain.handle("warmup:run-plan", (_event, payload) => {
    const chosen = Array.isArray(payload?.accounts) ? payload.accounts.filter((account) => account.selected) : [];
    const available = takeFreeProfiles(chosen);
    if (!available.ok) return { ok: false, error: available.error, warmup: store.data.warmup };
    const selected = available.kept;
    let warmup;
    try {
      const templates = templatePayload(payload);
      if (Object.keys(templates).length) saveSettings(templates);
      warmup = saveWarmup({
        peerIntervalSeconds: payload?.intervalSeconds,
        peerPeriods: payload?.periods,
        plan: payload?.plan,
      });
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const today = localDayKey();
    if (warmup.plan.lastRunDay === today) {
      return { ok: false, error: "Today's warm-up already ran. Start Gmail warm-up still runs when you press it.", warmup };
    }
    const input = {
      accounts: selected,
      intervalSeconds: warmup.peerIntervalSeconds,
      periods: warmup.peerPeriods,
      connections: store.data.gmailConnections || [],
      language: store.data.settings.language,
      includeAttach: store.data.settings.mentionAttachment !== false,
      ...outboundTemplates(store.data.settings),
    };
    const errors = validatePeerWarmupInput(input);
    if (errors.length) return { ok: false, error: errors.slice(0, 3).join(" "), warmup };
    try {
      saveAccountRows(payload?.accounts || []);
    } catch (error) {
      return { ok: false, error: error.message, warmup };
    }
    if (!warmup.plan.startedAt) warmup.plan.startedAt = today;
    store.data.warmup = warmupRecord(warmup);
    store.save();
    try {
      const view = hub.start(createPeerWarmupCampaign(input));
      store.data.warmup.plan.lastRunDay = today;
      store.data.warmup = warmupRecord(store.data.warmup);
      store.save();
      log("info", `Today's Gmail warm-up is running for ${selected.length} accounts.`);
      return { ok: true, campaign: view, campaigns: hub.views(), warmup: store.data.warmup, gmailConnections: store.data.gmailConnections || [] };
    } catch (error) {
      return { ok: false, error: error.message, warmup: store.data.warmup };
    }
  });

  ipcMain.handle("followup:start", (_event, payload) => {
    const chosen = Array.isArray(payload?.accounts) ? payload.accounts.filter((account) => account.selected) : [];
    const available = takeFreeProfiles(chosen);
    if (!available.ok) return { ok: false, error: available.error };
    const selected = available.kept;
    let followup;
    try {
      followup = saveFollowup({
        body: payload?.body,
        date: payload?.date,
        intervalSeconds: payload?.intervalSeconds,
      });
      saveAccountRows(payload?.accounts || []);
    } catch (error) {
      return { ok: false, error: error.message, followup };
    }
    const input = {
      accounts: selected,
      body: followup.body,
      date: followup.date,
      intervalSeconds: followup.intervalSeconds,
      useCustomFollowups: store.data.settings.useCustomFollowups === true,
      customFollowups: store.data.settings.customFollowups,
    };
    const errors = validateFollowupInput(input);
    if (errors.length) return { ok: false, error: errors.slice(0, 3).join(" "), followup };
    try {
      const view = hub.start(createFollowupCampaign(input));
      log("info", `Following up from ${selected.length} Gmail account${selected.length === 1 ? "" : "s"}.`);
      return { ok: true, campaign: view, campaigns: hub.views(), followup };
    } catch (error) {
      return { ok: false, error: error.message, followup };
    }
  });

  ipcMain.handle("followup:start-due", (_event, payload) => {
    const chosen = Array.isArray(payload?.accounts) ? payload.accounts.filter((account) => account.selected) : [];
    const available = takeFreeProfiles(chosen);
    if (!available.ok) return { ok: false, error: available.error };
    const selected = available.kept;
    let followup;
    try {
      followup = saveFollowup({
        body: payload?.body,
        date: payload?.date,
        intervalSeconds: payload?.intervalSeconds,
        steps: payload?.steps,
      });
      saveAccountRows(payload?.accounts || []);
    } catch (error) {
      return { ok: false, error: error.message, followup };
    }
    const accounts = sequenceAccounts(selected, store.data.clients, followup.steps);
    if (!accounts.length) {
      return { ok: true, due: 0, followup, message: "No follow-up is due. A client is due after the step's days, until they reply or the address bounces." };
    }
    const input = {
      accounts,
      body: followup.body,
      date: followup.date || localDayKey(),
      intervalSeconds: followup.intervalSeconds,
      useCustomFollowups: store.data.settings.useCustomFollowups === true,
      customFollowups: store.data.settings.customFollowups,
    };
    const errors = validateFollowupInput(input);
    if (errors.length) return { ok: false, error: errors.slice(0, 3).join(" "), followup };
    try {
      const view = hub.start(createFollowupCampaign(input));
      log("info", `Running due follow-ups from ${accounts.length} Gmail account${accounts.length === 1 ? "" : "s"}.`);
      return { ok: true, due: accounts.length, campaign: view, campaigns: hub.views(), followup };
    } catch (error) {
      return { ok: false, error: error.message, followup };
    }
  });
}

app.setAppUserModelId("com.mailcarrier.desktop");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    store = new Store(path.join(app.getPath("userData"), "mail-carrier-state.json"));
    recoverInterruptedCampaign();
    rebuildClient();
    chromeProfiles = new ChromeProfiles({
      onStatus: (message) => log("info", message),
      showInbox: (session, gmailIndex) => gmail.focusGmailInbox(session.debugPort, session.targetId, {
        browserWSEndpoint: session.browserWSEndpoint,
        gmailIndex,
        focus: false,
        compose: true,
      }),
    });
    removeUnusedJunction(chromeProfiles.linkPath, chromeProfiles.userDataDir).catch(() => {});
    hub = new CampaignHub({
      getMorelogin: () => ({
        ensureDebugPort: (envId, gmailIndex) => openBrowser(envId, gmailIndex),
        releaseProfile: (envId) => releaseBrowser(envId),
      }),
      gmail,
      store,
      onLog: (level, message) => log(level, message),
      onUpdate: (view, kind) => publishCampaign(view, kind),
    });
    registerIpc();
    createWindow();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
