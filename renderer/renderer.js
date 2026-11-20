const api = window.mailCarrier;

const state = {
  settings: {
    apiBase: "http://127.0.0.1:40000",
    apiToken: "",
    language: "en",
    intervalSeconds: 600,
    betweenAccountSeconds: 10,
    startDelaySeconds: 60,
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
  settingsLoaded: false,
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
  profiles: [],
  hiddenProfiles: [],
  prefs: {},
  cvs: {},
  senderNames: {},
  gmailStatus: {},
  connections: [],
  sentToday: null,
  sendLog: { warmup: {}, followup: {}, contacts: {} },
  campaign: null,
  campaigns: {},
  jobLists: {},
  busy: "",
  tab: "warmup",
  selectedOnly: false,
  peerLockKey: "",
};

function tabKind(tab = state.tab) {
  if (tab === "warmup") return "warmup";
  if (tab === "peer") return "peer-warmup";
  if (tab === "followup") return "followup";
  if (tab === "analyse") return "analyse";
  return "campaign";
}

function pickPrimary(list) {
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

function jobsOfKind(kind) {
  const key = kind || "campaign";
  const listed = state.jobLists?.[key];
  if (Array.isArray(listed) && listed.length) return listed.filter(Boolean);
  const single = state.campaigns?.[key];
  return single && !Array.isArray(single) ? [single] : [];
}

function rememberCampaigns(campaigns, campaign, kind) {
  if (campaigns && typeof campaigns === "object") {
    const jobs = campaigns.jobs;
    const singles = { ...campaigns };
    delete singles.jobs;
    state.campaigns = { ...state.campaigns, ...singles };
    if (jobs && typeof jobs === "object") {
      state.jobLists = { ...state.jobLists, ...jobs };
    }
  }
  if (campaign) {
    const key = kind || campaign.kind || "campaign";
    const list = Array.isArray(state.jobLists[key]) ? [...state.jobLists[key]] : [];
    const index = campaign.id ? list.findIndex((item) => item && item.id === campaign.id) : -1;
    if (index >= 0) list[index] = campaign;
    else list.push(campaign);
    state.jobLists[key] = list;
    state.campaigns[key] = pickPrimary(list) || campaign;
    state.campaign = campaign;
  } else if (!state.campaign) {
    state.campaign = pickPrimary(jobsOfKind(tabKind())) || null;
  }
}

function campaignForTab(tab = state.tab) {
  return pickPrimary(jobsOfKind(tabKind(tab)));
}

function controlJob(action) {
  const jobs = jobsOfKind(tabKind());
  if (action === "pause") return jobs.filter((campaign) => isActiveStatus(campaign.status)).slice(-1)[0] || null;
  if (action === "resume") return jobs.filter((campaign) => isPausedStatus(campaign.status)).slice(-1)[0] || null;
  return jobs.filter((campaign) => isActiveStatus(campaign.status) || isPausedStatus(campaign.status)).slice(-1)[0] || null;
}

function isActiveStatus(status) {
  return status === "running" || status === "scheduled";
}

function isPausedStatus(status) {
  return status === "paused" || status === "error";
}

const seenLogs = new Set();
const pendingEvents = [];
let prefsTimer = null;
let warmupTimer = null;
let peerTimer = null;
let analyseTimer = null;
let warmupEditingId = "";
let progressTimer = null;
let ready = false;
const treeOpen = new Map();

document.addEventListener("DOMContentLoaded", () => {
  document.body.dataset.tab = state.tab;
  bindStaticEvents();
  bindActivityResize();
  boot().catch((error) => {
    showStatus(error.message || String(error), "error");
    setConnection(error.message || "Could not start.", false);
  });
});

async function boot() {
  if (!api) {
    showBanner("This screen is the Mail Carrier desktop window. MoreLogin controls run after you start the app.");
    state.profiles = [
      {
        envId: "1",
        envName: "Example profile",
        uniqueId: 1,
        groupName: "",
        running: true,
        gmailAccounts: [
          { index: 0, email: "ada@gmail.com", name: "Ada Lovelace" },
          { index: 1, email: "ben@gmail.com", name: "Ben Okonkwo" },
        ],
      },
      {
        envId: "2",
        envName: "Closed profile",
        uniqueId: 2,
        groupName: "Outreach",
        running: false,
        gmailAccounts: [],
      },
      {
        envId: "chrome:Profile 2",
        envName: "David (Ron)",
        uniqueId: null,
        groupName: "Chrome",
        source: "chrome",
        running: false,
        gmailAccounts: [{ index: 0, email: "ron@gmail.com", name: "David Ron" }],
      },
    ];
    state.contacts = [{ name: "Sam", email: "sam@client.com", company: "North Co" }];
    state.connections = ["ada@gmail.com|ben@gmail.com"];
    state.prefs = {
      "1:0": {
        selected: true,
        senderName: "Ada",
        limit: 20,
        cvPath: "",
        cvName: "",
        email: "ada@gmail.com",
        contactFileName: "clients.csv",
        contacts: [{ name: "Jane", email: "jane@example.com", company: "Acme" }],
        sendAt: new Date(2026, 10, 3, 13, 0, 0).getTime(),
      },
    };
    state.gmailStatus = { "ada@gmail.com": "Warming up", "ben@gmail.com": "Active" };
    state.senderNames = { "ada@gmail.com-Ada": "Ada" };
    state.settingsLoaded = true;
    fillSettings();
    renderContacts();
    renderProfiles();
    renderProgress();
    syncButtons();
    setConnection("Not connected to the desktop app.", false);
    return;
  }

  api.onEvent((event) => {
    if (!ready) {
      pendingEvents.push(event);
      return;
    }
    onEvent(event);
  });
  const snapshot = await api.getState();
  applySnapshot(snapshot);
  ready = true;
  pendingEvents.splice(0).forEach(onEvent);
  await refreshProfiles();
}

function applySnapshot(snapshot) {
  state.settingsLoaded = true;
  state.settings = snapshot.settings || state.settings;
  state.warmup = snapshot.warmup || state.warmup;
  state.followup = snapshot.followup || state.followup;
  state.analysis = snapshot.analysis || state.analysis;
  state.contacts = snapshot.contacts || [];
  state.clients = snapshot.clients || {};
  state.history = snapshot.history || null;
  state.prefs = snapshot.prefs || {};
  state.cvs = snapshot.cvs && typeof snapshot.cvs === "object" ? snapshot.cvs : {};
  state.senderNames = snapshot.senderNames || {};
  state.sentToday = snapshot.sentToday || null;
  state.sendLog = snapshot.sendLog || { warmup: {}, followup: {}, contacts: {} };
  state.gmailStatus = snapshot.gmailStatus || {};
  state.connections = Array.isArray(snapshot.gmailConnections) ? snapshot.gmailConnections : [];
  state.profiles = snapshot.profiles || [];
  state.hiddenProfiles = snapshot.hiddenProfiles || [];
  rememberCampaigns(snapshot.campaigns, snapshot.campaign);
  fillSettings();
  renderContacts();
  renderProfiles();
  renderProgress();
  paintPeerConnections();
  const statusLine = campaignStatusLine(state.campaign);
  if (statusLine) showStatus(statusLine.message, statusLine.type);
  document.getElementById("log").replaceChildren();
  seenLogs.clear();
  for (const line of snapshot.logs || []) appendLog(line);
  syncButtons();
}

function shouldAutoResume(campaign) {
  if (!campaign || campaign.status !== "error") return false;
  return !/sign in/i.test(String(campaign.lastError || ""));
}

function campaignStatusLine(campaign) {
  if (!campaign) return null;
  const warmup = campaign.kind === "warmup" || campaign.kind === "peer-warmup";
  const followup = campaign.kind === "followup";
  const analyse = campaign.kind === "analyse";
  const peer = campaign.kind === "peer-warmup";
  const sent = peer
    ? `${campaign.sentTotal || 0} warm-up emails sent, ${campaign.replyTotal || 0} replies`
    : followup
      ? `${campaign.sentTotal || 0} of ${campaign.total || 0} follow-up emails sent`
      : analyse
        ? `${campaign.sentTotal || 0} sent emails opened, ${campaign.foundTotal || 0} delivery reports`
        : warmup
          ? `${campaign.sentTotal || 0} of ${campaign.total || 0} warm-up emails sent`
          : `${campaign.sentTotal || 0} of ${campaign.total || 0} sent`;
  if (campaign.status === "scheduled") return { message: "Sending is scheduled.", type: "success" };
  if (campaign.status === "running" && campaign.phase === "waiting" && campaign.waitUntil) {
    return { message: `Next email ${new Date(campaign.waitUntil).toLocaleString()}.`, type: "success" };
  }
  if (campaign.status === "running") {
    return {
      message: analyse ? "Analysing sent mail." : followup ? "Following up." : warmup ? "Warming up." : "Sending.",
      type: "success",
    };
  }
  if (campaign.status === "paused") {
    return {
      message: analyse ? `Analyse paused. ${sent}.` : followup ? `Follow-up paused. ${sent}.` : warmup ? `Warm-up paused. ${sent}.` : `Sending paused. ${sent}.`,
      type: "success",
    };
  }
  if (campaign.status === "error") {
    return {
      message: campaign.lastError || (analyse ? "Analyse paused." : followup ? "Follow-up paused." : warmup ? "Warm-up paused." : "Sending paused."),
      type: "error",
    };
  }
  if (campaign.status === "stopped") {
    return {
      message: analyse ? `Analyse stopped. ${sent}.` : followup ? `Follow-up stopped. ${sent}.` : warmup ? `Warm-up stopped. ${sent}.` : `Sending stopped. ${sent}.`,
      type: "success",
    };
  }
  if (campaign.status === "done") {
    return {
      message: analyse ? `Analyse finished. ${sent}.` : followup ? `Follow-up finished. ${sent}.` : warmup ? `Warm-up finished. ${sent}.` : `Finished. ${sent}.`,
      type: "success",
    };
  }
  return null;
}

function onEvent(event) {
  if (event.type === "log") appendLog(event.line);
  if (event.type === "campaign") {
    rememberCampaigns(event.campaigns, event.campaign, event.kind);
    if (event.contacts) state.contacts = event.contacts;
    if (event.clients) state.clients = event.clients;
    if ("history" in event) state.history = event.history;
    if ("sentToday" in event) state.sentToday = event.sentToday;
    if ("sendLog" in event) state.sendLog = event.sendLog || { warmup: {}, followup: {}, contacts: {} };
    if (event.gmailStatus && typeof event.gmailStatus === "object") {
      const nextStatus = JSON.stringify(event.gmailStatus);
      const sameStatus = JSON.stringify(state.gmailStatus || {}) === nextStatus;
      state.gmailStatus = event.gmailStatus;
      if (!sameStatus) paintGmailStatuses();
    }
    if (event.analysis) {
      state.analysis = event.analysis;
      renderAnalysis();
    }
    if (Array.isArray(event.campaign?.connections)) {
      state.connections = event.campaign.connections;
      paintPeerConnections();
    }
    renderContacts();
    paintTodaySent();
    renderSendLogModal();
    applyCampaignToCards(campaignForTab());
    renderProgress();
    syncButtons();
    const line = campaignStatusLine(event.campaign);
    if (line) showStatus(line.message, line.type);
    queueAutoResume(event.campaign);
  }
}

let resumeInFlight = false;
let resumeTimer = null;
let autoResumeKind = "";
let autoResumeId = "";

function queueAutoResume(campaign) {
  if (!api || !shouldAutoResume(campaign) || resumeInFlight || resumeTimer) return;
  autoResumeKind = campaign?.kind || tabKind();
  autoResumeId = campaign?.id || "";
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    const target = jobsOfKind(autoResumeKind).find((item) => item.id === autoResumeId) || state.campaigns[autoResumeKind] || state.campaign;
    if (!api || !shouldAutoResume(target) || resumeInFlight) return;
    resumeCampaign(autoResumeId);
  }, 1000);
}

const ACTIVITY_HEIGHT_KEY = "mailCarrier.activityHeight";
const ACTIVITY_MIN_HEIGHT = 88;
const ACTIVITY_DEFAULT_HEIGHT = 150;

function activityHeightLimit() {
  return Math.max(ACTIVITY_MIN_HEIGHT, window.innerHeight - 240);
}

function applyActivityHeight(height, persist) {
  const preferred = Math.max(ACTIVITY_MIN_HEIGHT, Math.round(Number(height) || ACTIVITY_DEFAULT_HEIGHT));
  const shown = Math.min(preferred, activityHeightLimit());
  document.documentElement.style.setProperty("--activity-height", `${shown}px`);
  const handle = document.getElementById("activity-resize");
  if (handle) {
    handle.setAttribute("aria-valuemin", String(ACTIVITY_MIN_HEIGHT));
    handle.setAttribute("aria-valuemax", String(activityHeightLimit()));
    handle.setAttribute("aria-valuenow", String(shown));
  }
  if (persist) {
    try {
      localStorage.setItem(ACTIVITY_HEIGHT_KEY, String(preferred));
    } catch (error) {}
  }
  return shown;
}

function storedActivityHeight() {
  try {
    const value = Number(localStorage.getItem(ACTIVITY_HEIGHT_KEY));
    if (value >= ACTIVITY_MIN_HEIGHT) return value;
  } catch (error) {}
  return ACTIVITY_DEFAULT_HEIGHT;
}

function bindActivityResize() {
  const handle = document.getElementById("activity-resize");
  if (!handle) return;
  applyActivityHeight(storedActivityHeight(), false);
  window.addEventListener("resize", () => applyActivityHeight(storedActivityHeight(), false));
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = document.querySelector(".activity").getBoundingClientRect().height;
    document.body.classList.add("is-resizing-activity");
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      applyActivityHeight(startHeight + (startY - moveEvent.clientY), false);
    };
    const end = (endEvent) => {
      if (handle.hasPointerCapture(endEvent.pointerId)) handle.releasePointerCapture(endEvent.pointerId);
      document.body.classList.remove("is-resizing-activity");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      const shown = document.querySelector(".activity").getBoundingClientRect().height;
      applyActivityHeight(shown, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.shiftKey ? 48 : 16;
    const current = document.querySelector(".activity").getBoundingClientRect().height;
    const next = current + (event.key === "ArrowUp" ? step : -step);
    applyActivityHeight(next, true);
  });
  handle.addEventListener("dblclick", () => applyActivityHeight(ACTIVITY_DEFAULT_HEIGHT, true));
}

function bindStaticEvents() {
  document.getElementById("refresh").addEventListener("click", () => refreshProfiles(true));
  document.getElementById("peer-show-connections").addEventListener("click", openConnections);
  document.getElementById("connections-close").addEventListener("click", closeConnections);
  document.getElementById("connections-modal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeConnections();
  });
  document.getElementById("analyse-modal-close").addEventListener("click", closeAnalyseModal);
  document.getElementById("analyse-modal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeAnalyseModal();
  });
  document.getElementById("send-log-modal-close").addEventListener("click", closeSendLogModal);
  document.getElementById("send-log-modal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeSendLogModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!document.getElementById("send-log-modal").hidden) {
      closeSendLogModal();
      return;
    }
    if (!document.getElementById("analyse-modal").hidden) {
      closeAnalyseModal();
      return;
    }
    if (!document.getElementById("connections-modal").hidden) closeConnections();
  });
  document.getElementById("import-contacts").addEventListener("click", importContacts);
  document.getElementById("clear-contacts").addEventListener("click", clearContacts);
  document.getElementById("open-selected").addEventListener("click", openSelected);
  document.getElementById("read-gmail").addEventListener("click", readSelectedGmail);
  document.getElementById("status-pick").addEventListener("change", () => {
    const status = document.getElementById("status-pick").value;
    if (status) selectByStatus(status);
  });
  document.getElementById("select-all").addEventListener("click", () => setAllSelected(true));
  document.getElementById("clear-all").addEventListener("click", () => setAllSelected(false));
  document.getElementById("expand-all").addEventListener("click", () => setAllTreeExpanded(true));
  document.getElementById("collapse-all").addEventListener("click", () => setAllTreeExpanded(false));
  document.getElementById("show-selected").addEventListener("click", toggleSelectedOnly);
  document.getElementById("apply-limit").addEventListener("click", applyLimit);
  document.getElementById("tab-warmup").addEventListener("click", () => showTab("warmup"));
  document.getElementById("tab-peer").addEventListener("click", () => showTab("peer"));
  document.getElementById("tab-followup").addEventListener("click", () => showTab("followup"));
  document.getElementById("tab-analyse").addEventListener("click", () => showTab("analyse"));
  document.getElementById("tab-contacts").addEventListener("click", () => showTab("contacts"));
  document.getElementById("jobs").addEventListener("click", (event) => {
    const job = event.target.closest(".job");
    if (job?.dataset.tab) showTab(job.dataset.tab);
  });
  document.getElementById("source-morelogin").addEventListener("click", () => showSource("morelogin"));
  document.getElementById("source-chrome").addEventListener("click", () => showSource("chrome"));
  document.getElementById("start").addEventListener("click", startCampaign);
  document.getElementById("warmup-start").addEventListener("click", startWarmup);
  document.getElementById("peer-warmup-start").addEventListener("click", startPeerWarmup);
  document.getElementById("followup-start").addEventListener("click", startFollowup);
  document.getElementById("followup-sequence").addEventListener("click", startDueFollowups);
  document.getElementById("warmup-plan-apply").addEventListener("click", applyWarmupPlan);
  document.getElementById("warmup-plan-run").addEventListener("click", runWarmupPlan);
  document.getElementById("client-show").addEventListener("click", showClients);
  document.getElementById("clients-close").addEventListener("click", () => {
    document.getElementById("clients-modal").hidden = true;
  });
  document.getElementById("analyse-start").addEventListener("click", startAnalysis);
  document.getElementById("peer-clear-connections").addEventListener("click", clearPeerConnections);
  document.getElementById("warmup-add").addEventListener("click", saveWarmupDraft);
  document.getElementById("warmup-cancel").addEventListener("click", cancelWarmupEdit);
  document.getElementById("warmup-list").addEventListener("click", onWarmupListClick);
  document.getElementById("warmup-list").addEventListener("change", onWarmupListChange);
  document.getElementById("pause").addEventListener("click", pauseCampaign);
  document.getElementById("stop").addEventListener("click", stopCampaign);
  document.getElementById("resume").addEventListener("click", resumeCampaign);
  document.getElementById("profile-search").addEventListener("input", applySearch);
  document.getElementById("profile-list").addEventListener("input", onProfileEdit);
  document.getElementById("profile-list").addEventListener("change", onProfileEdit);
  document.getElementById("profile-list").addEventListener("click", onProfileClick);
  ["interval-time", "between-accounts", "default-limit", "email-language"].forEach((id) => {
    document.getElementById(id).addEventListener("input", refreshStartButton);
    document.getElementById(id).addEventListener("change", saveSettingsFromForm);
  });
  ["mention-attachment", "warmup-mention-attachment"].forEach((id) => {
    document.getElementById(id).addEventListener("change", onMentionAttachmentChange);
  });
  ["use-custom-templates", "use-custom-templates-warmup", "use-custom-templates-peer"].forEach((id) => {
    document.getElementById(id).addEventListener("change", onCustomTemplateToggle);
  });
  document.getElementById("use-custom-replies").addEventListener("change", onCustomReplyToggle);
  document.getElementById("use-custom-warmup-index").addEventListener("change", onWarmupIndexToggle);
  document.getElementById("warmup-index").addEventListener("input", refreshStartButton);
  document.getElementById("warmup-index").addEventListener("change", saveSettingsFromForm);
  document.getElementById("use-custom-followups").addEventListener("change", onCustomFollowupToggle);
  document.getElementById("custom-subject-add").addEventListener("click", () => addCustomTemplate("subject"));
  document.getElementById("custom-body-add").addEventListener("click", () => addCustomTemplate("body"));
  document.getElementById("custom-reply-add").addEventListener("click", addCustomReply);
  document.getElementById("custom-followup-add").addEventListener("click", addCustomFollowup);
  document.getElementById("custom-subject-import").addEventListener("click", () => importTemplateFile("subject"));
  document.getElementById("custom-body-import").addEventListener("click", () => importTemplateFile("body"));
  document.getElementById("custom-reply-import").addEventListener("click", () => importTemplateFile("reply"));
  document.getElementById("custom-followup-import").addEventListener("click", () => importTemplateFile("followup"));
  document.getElementById("custom-template-sample").addEventListener("click", () => downloadTemplateSamples("message"));
  document.getElementById("custom-reply-sample").addEventListener("click", () => downloadTemplateSamples("reply"));
  document.getElementById("custom-followup-sample").addEventListener("click", () => downloadTemplateSamples("followup"));
  document.getElementById("custom-subject-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addCustomTemplate("subject");
  });
  document.getElementById("custom-template-editor").addEventListener("click", (event) => {
    const control = event.target.closest("[data-template-kind]");
    if (!control) return;
    removeCustomTemplate(control.dataset.templateKind, Number(control.dataset.templateIndex));
  });
  bindTemplateBrowsers();
  document.getElementById("custom-reply-list").addEventListener("click", (event) => {
    const control = event.target.closest("[data-reply-index]");
    if (!control) return;
    removeCustomReply(Number(control.dataset.replyIndex));
  });
  document.getElementById("custom-followup-list").addEventListener("click", (event) => {
    const control = event.target.closest("[data-followup-index]");
    if (!control) return;
    removeCustomFollowup(Number(control.dataset.followupIndex));
  });
  ["api-base", "api-token"].forEach((id) => {
    document.getElementById(id).addEventListener("change", saveSettingsFromForm);
  });
  ["warmup-email", "warmup-company", "warmup-client"].forEach((id) => {
    const field = document.getElementById(id);
    field.addEventListener("input", refreshStartButton);
    field.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      saveWarmupDraft();
    });
  });
  const warmupInterval = document.getElementById("warmup-interval");
  warmupInterval.addEventListener("input", refreshStartButton);
  warmupInterval.addEventListener("change", saveWarmupFromForm);
  ["peer-interval", "peer-periods", "warmup-plan-start", "warmup-plan-step", "warmup-plan-cap"].forEach((id) => {
    const field = document.getElementById(id);
    field.addEventListener("input", () => {
      paintWarmupPlan();
      refreshStartButton();
    });
    field.addEventListener("change", savePeerWarmupFromForm);
  });
  const followupBody = document.getElementById("followup-body");
  followupBody.addEventListener("input", refreshStartButton);
  followupBody.addEventListener("change", saveFollowupFromForm);
  const followupDate = document.getElementById("followup-date");
  followupDate.addEventListener("input", refreshStartButton);
  followupDate.addEventListener("change", saveFollowupFromForm);
  const followupInterval = document.getElementById("followup-interval");
  followupInterval.addEventListener("input", refreshStartButton);
  followupInterval.addEventListener("change", saveFollowupFromForm);
  ["followup-step1-days", "followup-step2-days", "followup-step1-body", "followup-step2-body"].forEach((id) => {
    const field = document.getElementById(id);
    field.addEventListener("input", refreshStartButton);
    field.addEventListener("change", saveFollowupFromForm);
  });
  ["analyse-from", "analyse-to", "analyse-limit"].forEach((id) => {
    const field = document.getElementById(id);
    field.addEventListener("input", refreshStartButton);
    field.addEventListener("change", saveAnalysisFromForm);
  });
}

function readSettingsForm() {
  return {
    apiBase: document.getElementById("api-base").value.trim(),
    apiToken: document.getElementById("api-token").value,
    language: document.getElementById("email-language").value,
    intervalSeconds: document.getElementById("interval-time").value,
    betweenAccountSeconds: document.getElementById("between-accounts").value,
    defaultLimit: document.getElementById("default-limit").value,
    limitTab: currentTab(),
    mentionAttachment: document.getElementById("mention-attachment").checked,
    browserSource: browserSource(),
    ...customTemplatePayload(),
  };
}

function fillSettings() {
  const settings = state.settings;
  setIfIdle("api-base", settings.apiBase);
  setIfIdle("api-token", settings.apiToken || "");
  setIfIdle("email-language", settings.language || "en");
  setIfIdle("interval-time", String(settings.intervalSeconds));
  setIfIdle("between-accounts", String(settings.betweenAccountSeconds ?? 10));
  syncLimitChrome();
  const mentionAttachment = settings.mentionAttachment !== false;
  setChecked("mention-attachment", mentionAttachment);
  setChecked("warmup-mention-attachment", mentionAttachment);
  setCustomTemplateChecks(settings.useCustomTemplates === true);
  setChecked("use-custom-replies", settings.useCustomReplies === true);
  setChecked("use-custom-followups", settings.useCustomFollowups === true);
  setChecked("use-custom-warmup-index", settings.useCustomWarmupIndex === true);
  setIfIdle("warmup-index", settings.warmupIndex || "");
  syncCustomTemplateEditor();
  syncCustomListEditors();
  syncWarmupIndexEditor();
  renderCustomTemplates();
  applySource();
  const warmup = state.warmup || {};
  if (!Array.isArray(warmup.businesses)) warmup.businesses = [];
  setIfIdle("warmup-interval", String(warmup.intervalSeconds ?? 600));
  setIfIdle("peer-interval", String(warmup.peerIntervalSeconds ?? warmup.intervalSeconds ?? 600));
  setIfIdle("peer-periods", String(warmup.peerPeriods ?? 1));
  const followup = state.followup || {};
  setIfIdle("followup-body", followup.body || "");
  setIfIdle("followup-date", followup.date || "");
  setIfIdle("followup-interval", String(followup.intervalSeconds ?? 600));
  const steps = Array.isArray(followup.steps) ? followup.steps : [];
  setIfIdle("followup-step1-days", String(steps[0]?.days ?? 3));
  setIfIdle("followup-step1-body", steps[0]?.body || "");
  setIfIdle("followup-step2-days", String(steps[1]?.days ?? 7));
  setIfIdle("followup-step2-body", steps[1]?.body || "");
  const plan = warmup.plan || {};
  setIfIdle("warmup-plan-start", String(plan.startLimit ?? 5));
  setIfIdle("warmup-plan-step", String(plan.dailyStep ?? 5));
  setIfIdle("warmup-plan-cap", String(plan.cap ?? 20));
  paintWarmupPlan();
  paintClientSummary();
  const analysis = state.analysis || {};
  setIfIdle("analyse-from", analysis.from || "");
  setIfIdle("analyse-to", analysis.to || "");
  setIfIdle("analyse-limit", String(analysis.limit || 40));
  renderWarmupList();
  renderAnalysis();
}

function warmupBusinesses() {
  return Array.isArray(state.warmup?.businesses) ? state.warmup.businesses : [];
}

function selectedWarmupBusiness() {
  const businesses = warmupBusinesses();
  const selectedId = String(state.warmup?.selectedId || "");
  const match = businesses.find((row) => row.id === selectedId);
  if (match) return match;
  return businesses.length === 1 ? businesses[0] : null;
}

function selectionAfterBusinessChange(next, addedId = "") {
  const currentId = String(state.warmup?.selectedId || "");
  if (next.some((row) => row.id === currentId)) return currentId;
  if (addedId && next.some((row) => row.id === addedId)) return addedId;
  return next.length === 1 ? next[0].id : "";
}

function localWarmup(businesses, selectedId) {
  const requested = String(selectedId || "").trim();
  const match = businesses.find((row) => row.id === requested);
  const chosen = match || (businesses.length === 1 ? businesses[0] : null);
  return {
    ...state.warmup,
    businesses,
    selectedId: chosen?.id || "",
    email: chosen?.email || "",
    company: chosen?.company || "",
    clientName: chosen?.firstName || "",
  };
}

function readWarmupDraft() {
  return {
    email: document.getElementById("warmup-email").value.trim(),
    firstName: document.getElementById("warmup-client").value.trim(),
    company: document.getElementById("warmup-company").value.trim(),
  };
}

function readWarmupForm() {
  const draft = readWarmupDraft();
  return {
    email: draft.email,
    company: draft.company,
    clientName: draft.firstName,
    intervalSeconds: document.getElementById("warmup-interval").value,
  };
}

function warmupDraftError(draft, businesses, editingId) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email)) return "Enter the business email.";
  if (!draft.firstName) return "Enter the first name.";
  if (!draft.company) return "Enter the company name.";
  const key = draft.email.toLowerCase();
  const duplicate = businesses.some((row) => String(row.email || "").toLowerCase() === key && row.id !== editingId);
  if (duplicate) return "That business email is already in the list.";
  return "";
}

function businessesWithDraft(businesses, draft, editingId) {
  const next = businesses.map((row) => ({ ...row }));
  if (editingId) {
    const index = next.findIndex((row) => row.id === editingId);
    if (index < 0) return null;
    next[index] = { ...next[index], email: draft.email, firstName: draft.firstName, company: draft.company };
    return next;
  }
  next.push({
    id: `biz-${Date.now().toString(36)}-${next.length}`,
    email: draft.email,
    firstName: draft.firstName,
    company: draft.company,
  });
  return next;
}

function clearWarmupDraft() {
  warmupEditingId = "";
  document.getElementById("warmup-email").value = "";
  document.getElementById("warmup-client").value = "";
  document.getElementById("warmup-company").value = "";
  renderWarmupList();
}

function cancelWarmupEdit() {
  clearWarmupDraft();
  refreshStartButton();
}

function beginWarmupEdit(id) {
  const row = warmupBusinesses().find((item) => item.id === id);
  if (!row || isCampaignRunning() || state.busy) return;
  warmupEditingId = row.id;
  document.getElementById("warmup-email").value = row.email || "";
  document.getElementById("warmup-client").value = row.firstName || "";
  document.getElementById("warmup-company").value = row.company || "";
  renderWarmupList();
  document.getElementById("warmup-email").focus();
}

async function persistWarmupBusinesses(businesses, selectedId = state.warmup?.selectedId || "") {
  if (!api) {
    state.warmup = localWarmup(businesses, selectedId);
    renderWarmupList();
    refreshStartButton();
    return true;
  }
  const result = await api.saveWarmup({
    businesses,
    selectedId,
    intervalSeconds: document.getElementById("warmup-interval").value,
  });
  if (!result.ok) {
    showStatus(result.error, "error");
    return false;
  }
  state.warmup = result.warmup;
  renderWarmupList();
  refreshStartButton();
  return true;
}

async function saveWarmupDraft() {
  if (isCampaignRunning() || state.busy) return;
  const draft = readWarmupDraft();
  const businesses = warmupBusinesses();
  const error = warmupDraftError(draft, businesses, warmupEditingId);
  if (error) {
    showStatus(error, "error");
    return;
  }
  const next = businessesWithDraft(businesses, draft, warmupEditingId);
  if (!next) {
    showStatus("That business email is no longer in the list.", "error");
    clearWarmupDraft();
    return;
  }
  const wasEditing = Boolean(warmupEditingId);
  const addedId = wasEditing ? "" : next[next.length - 1].id;
  const saved = await persistWarmupBusinesses(next, selectionAfterBusinessChange(next, addedId));
  if (!saved) return;
  clearWarmupDraft();
  showStatus(wasEditing ? "Business email saved." : "Business email added.", "success");
}

async function deleteWarmupBusiness(id) {
  if (isCampaignRunning() || state.busy) return;
  const row = warmupBusinesses().find((item) => item.id === id);
  if (!row) return;
  if (!window.confirm(`Delete ${row.email}?`)) return;
  const next = warmupBusinesses().filter((item) => item.id !== id);
  const saved = await persistWarmupBusinesses(next, selectionAfterBusinessChange(next));
  if (!saved) return;
  if (warmupEditingId === id) clearWarmupDraft();
  showStatus("Business email deleted.", "success");
}

function onWarmupListClick(event) {
  const button = event.target.closest("button");
  const row = event.target.closest(".business-row");
  if (!button || !row) return;
  if (button.dataset.action === "edit") beginWarmupEdit(row.dataset.id);
  if (button.dataset.action === "delete") deleteWarmupBusiness(row.dataset.id);
}

function onWarmupListChange(event) {
  const input = event.target;
  if (!input || input.name !== "warmup-business") return;
  selectWarmupBusiness(input.value);
}

async function selectWarmupBusiness(id) {
  if (isCampaignRunning() || state.busy) return;
  if (!warmupBusinesses().some((row) => row.id === id)) return;
  if ((state.warmup?.selectedId || "") === id) return;
  if (!api) {
    state.warmup = localWarmup(warmupBusinesses(), id);
    renderWarmupList();
    refreshStartButton();
    return;
  }
  const result = await api.saveWarmup({ selectedId: id });
  if (!result.ok) {
    showStatus(result.error, "error");
    renderWarmupList();
    return;
  }
  state.warmup = result.warmup;
  renderWarmupList();
  refreshStartButton();
}

function renderWarmupList() {
  const list = document.getElementById("warmup-list");
  const empty = document.getElementById("warmup-empty");
  if (!list || !empty) return;
  const rows = warmupBusinesses();
  const selected = selectedWarmupBusiness();
  empty.hidden = rows.length > 0;
  list.replaceChildren();
  const locked = isCampaignRunning() || Boolean(state.busy);
  for (const row of rows) {
    const item = document.createElement("article");
    const classes = ["business-row"];
    if (row.id === warmupEditingId) classes.push("is-editing");
    if (selected && row.id === selected.id) classes.push("is-selected");
    item.className = classes.join(" ");
    item.dataset.id = row.id;
    const pick = document.createElement("label");
    pick.className = "business-pick";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "warmup-business";
    radio.value = row.id;
    radio.checked = Boolean(selected && row.id === selected.id);
    radio.disabled = locked;
    radio.setAttribute("aria-label", `Select ${row.email || "business email"}`);
    const copy = document.createElement("span");
    copy.className = "business-copy";
    const email = document.createElement("strong");
    email.textContent = row.email || "Business email";
    const meta = document.createElement("span");
    meta.textContent = [row.firstName, row.company].filter(Boolean).join(" · ");
    copy.append(email, meta);
    pick.append(radio, copy);
    const actions = document.createElement("div");
    actions.className = "business-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary";
    edit.dataset.action = "edit";
    edit.textContent = "Edit";
    edit.disabled = locked;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.dataset.action = "delete";
    remove.textContent = "Delete";
    remove.disabled = locked;
    actions.append(edit, remove);
    item.append(pick, actions);
    list.append(item);
  }
  const add = document.getElementById("warmup-add");
  if (add) {
    add.textContent = warmupEditingId ? "Save" : "Add business";
    add.disabled = locked;
  }
  const cancel = document.getElementById("warmup-cancel");
  if (cancel) {
    cancel.hidden = !warmupEditingId;
    cancel.disabled = locked;
  }
}

async function saveWarmupFromForm() {
  if (!api) return;
  clearTimeout(warmupTimer);
  warmupTimer = setTimeout(async () => {
    try {
      const result = await api.saveWarmup({
        intervalSeconds: document.getElementById("warmup-interval").value,
      });
      if (!result.ok) {
        showStatus(result.error, "error");
        return;
      }
      state.warmup = result.warmup;
      refreshStartButton();
    } catch (error) {
      showStatus(error.message || String(error), "error");
    }
  }, 200);
}

async function savePeerWarmupFromForm() {
  if (!api) return;
  clearTimeout(peerTimer);
  peerTimer = setTimeout(async () => {
    try {
      const result = await api.saveWarmup({
        peerIntervalSeconds: document.getElementById("peer-interval").value,
        peerPeriods: document.getElementById("peer-periods").value,
        plan: warmupPlanFromForm(),
      });
      if (!result.ok) {
        showStatus(result.error, "error");
        return;
      }
      state.warmup = result.warmup;
      refreshStartButton();
    } catch (error) {
      showStatus(error.message || String(error), "error");
    }
  }, 200);
}

function setIfIdle(id, value) {
  const field = document.getElementById(id);
  if (document.activeElement === field) return;
  if (field.value !== String(value)) field.value = value;
}

function setChecked(id, checked) {
  const field = document.getElementById(id);
  if (!field || document.activeElement === field) return;
  field.checked = Boolean(checked);
}

function onMentionAttachmentChange(event) {
  const checked = event.target.checked;
  document.getElementById("mention-attachment").checked = checked;
  document.getElementById("warmup-mention-attachment").checked = checked;
  document.querySelectorAll(".gmail-row").forEach((row) => {
    const box = row.querySelector(".mention-attachment");
    if (box) box.checked = checked;
    paintResumeAlert(row);
    rememberRow(row);
  });
  saveSettingsFromForm();
}

function customTemplatePayload() {
  if (api && !state.settingsLoaded) return {};
  return {
    useCustomTemplates: document.getElementById("use-custom-templates").checked,
    customSubjects: templateList("customSubjects"),
    customBodies: templateList("customBodies"),
    useCustomReplies: document.getElementById("use-custom-replies").checked,
    customReplies: templateList("customReplies"),
    useCustomFollowups: document.getElementById("use-custom-followups").checked,
    customFollowups: templateList("customFollowups"),
    useCustomWarmupIndex: document.getElementById("use-custom-warmup-index").checked,
    warmupIndex: document.getElementById("warmup-index").value,
  };
}

function templateList(key) {
  const value = state.settings?.[key];
  return Array.isArray(value) ? value : [];
}

function templateCheckboxIds() {
  return ["use-custom-templates", "use-custom-templates-warmup", "use-custom-templates-peer"];
}

function setCustomTemplateChecks(checked) {
  templateCheckboxIds().forEach((id) => {
    const box = document.getElementById(id);
    if (box) box.checked = checked;
  });
}

function syncCustomTemplateEditor() {
  const box = document.getElementById("use-custom-templates");
  document.getElementById("custom-template-editor").hidden = !box.checked;
}

function syncCustomListEditors() {
  document.getElementById("custom-reply-editor").hidden = !document.getElementById("use-custom-replies").checked;
  document.getElementById("custom-followup-editor").hidden = !document.getElementById("use-custom-followups").checked;
}

function syncWarmupIndexEditor() {
  document.getElementById("custom-warmup-index-editor").hidden = !document.getElementById("use-custom-warmup-index").checked;
}

function onWarmupIndexToggle() {
  syncWarmupIndexEditor();
  refreshStartButton();
  saveSettingsFromForm();
}

function templateEditingLocked() {
  if (!api) return false;
  if (state.busy) return true;
  const campaigns = state.campaigns || {};
  return ["campaign", "warmup", "peer-warmup"].some((kind) => {
    const status = campaigns[kind]?.status;
    return isActiveStatus(status) || isPausedStatus(status);
  });
}

function setTemplateControlsDisabled(disabled) {
  ["use-custom-templates", "use-custom-templates-warmup", "use-custom-templates-peer", "custom-subject-input", "custom-subject-add", "custom-subject-import", "custom-body-input", "custom-body-add", "custom-body-import", "custom-template-sample"].forEach((id) => {
    const node = document.getElementById(id);
    if (node) node.disabled = disabled;
  });
  document.querySelectorAll("[data-template-kind]").forEach((node) => {
    node.disabled = disabled;
  });
}

const TEMPLATE_LIST_MAX = 500;
const TEMPLATE_PAGE_SIZE = 8;
const templateBrowsers = {
  "custom-subject-list": { key: "customSubjects", noun: "subject", nouns: "subjects", kind: "subject" },
  "custom-body-list": { key: "customBodies", noun: "body", nouns: "bodies", kind: "body" },
  "custom-reply-list": { key: "customReplies", noun: "reply", nouns: "replies" },
  "custom-followup-list": { key: "customFollowups", noun: "follow-up", nouns: "follow-ups" },
};
const templateViews = {};

function templateView(listId) {
  if (!templateViews[listId]) templateViews[listId] = { query: "", page: 0, open: -1 };
  return templateViews[listId];
}

function templatePreview(text) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  if (line.length <= 90) return line;
  return `${line.slice(0, 90).trimEnd()}…`;
}

function shiftTemplateOpen(listId, removedIndex) {
  const view = templateView(listId);
  if (view.open === removedIndex) view.open = -1;
  else if (view.open > removedIndex) view.open -= 1;
}

function showNewestTemplate(listId, index) {
  const view = templateView(listId);
  view.query = "";
  view.open = index;
  view.page = Math.floor(index / TEMPLATE_PAGE_SIZE);
  const search = document.querySelector(`[data-template-browser="${listId}"] [data-template-search]`);
  if (search) search.value = "";
}

function bindTemplateBrowsers() {
  document.querySelectorAll("[data-template-browser]").forEach((browser) => {
    const listId = browser.dataset.templateBrowser;
    browser.addEventListener("click", (event) => {
      const toggle = event.target.closest("[data-template-toggle]");
      if (toggle && toggle.dataset.templateList === listId) {
        const view = templateView(listId);
        const index = Number(toggle.dataset.templateToggle);
        view.open = view.open === index ? -1 : index;
        renderTemplateBrowser(listId);
        return;
      }
      const pageButton = event.target.closest("[data-template-page]");
      if (!pageButton || !browser.contains(pageButton)) return;
      const view = templateView(listId);
      view.page += pageButton.dataset.templatePage === "next" ? 1 : -1;
      renderTemplateBrowser(listId);
    });
    const search = browser.querySelector("[data-template-search]");
    if (!search) return;
    search.addEventListener("input", () => {
      const view = templateView(listId);
      view.query = search.value;
      view.page = 0;
      renderTemplateBrowser(listId);
    });
  });
}

function renderTemplateBrowser(listId) {
  const meta = templateBrowsers[listId];
  const items = templateList(meta.key);
  const view = templateView(listId);
  const browser = document.querySelector(`[data-template-browser="${listId}"]`);
  const list = document.getElementById(listId);
  const count = browser?.querySelector("[data-template-count]");
  const pager = browser?.querySelector("[data-template-pager]");
  const pageLabel = pager?.querySelector("[data-template-page-label]");
  const query = view.query.trim().toLowerCase();
  const matched = items
    .map((text, index) => ({ text, index }))
    .filter((item) => !query || String(item.text).toLowerCase().includes(query));
  const pages = Math.max(1, Math.ceil(matched.length / TEMPLATE_PAGE_SIZE));
  if (view.page > pages - 1) view.page = pages - 1;
  if (view.page < 0) view.page = 0;
  const start = view.page * TEMPLATE_PAGE_SIZE;
  const visible = matched.slice(start, start + TEMPLATE_PAGE_SIZE);
  if (browser) browser.classList.toggle("is-empty", items.length === 0);
  if (count) {
    if (!items.length) count.textContent = "";
    else if (query) count.textContent = `${matched.length} of ${items.length}`;
    else count.textContent = `${items.length} ${items.length === 1 ? meta.noun : meta.nouns}`;
  }
  list.replaceChildren();
  if (items.length && !matched.length) list.append(el("li", "template-empty", "No matches."));
  visible.forEach((item) => {
    const row = el("li", "template-item");
    const open = view.open === item.index;
    if (open) row.classList.add("is-open");
    const toggle = button("template-preview", templatePreview(item.text));
    toggle.dataset.templateList = listId;
    toggle.dataset.templateToggle = String(item.index);
    toggle.title = open ? "Hide the full text" : "Show the full text";
    const remove = button("linkish", "Remove");
    if (meta.kind) {
      remove.dataset.templateKind = meta.kind;
      remove.dataset.templateIndex = String(item.index);
    } else if (listId === "custom-reply-list") {
      remove.dataset.replyIndex = String(item.index);
    } else {
      remove.dataset.followupIndex = String(item.index);
    }
    remove.disabled = meta.kind ? templateEditingLocked() : Boolean(state.busy);
    row.append(el("span", "template-index", String(item.index + 1)), toggle, remove);
    if (open) row.append(el("p", "template-full", item.text));
    list.append(row);
  });
  if (pager) {
    const showPager = matched.length > TEMPLATE_PAGE_SIZE;
    pager.hidden = !showPager;
    if (pageLabel && showPager) {
      const end = start + visible.length;
      pageLabel.textContent = `${start + 1}–${end} of ${matched.length}`;
    }
    pager.querySelectorAll("button").forEach((pageButton) => {
      const next = pageButton.dataset.templatePage === "next";
      pageButton.disabled = next ? view.page >= pages - 1 : view.page <= 0;
    });
  }
}

function renderCustomTemplates() {
  Object.keys(templateBrowsers).forEach(renderTemplateBrowser);
  setTemplateControlsDisabled(templateEditingLocked());
}

function onCustomTemplateToggle(event) {
  setCustomTemplateChecks(event.target.checked);
  syncCustomTemplateEditor();
  if (!api) {
    state.settings = {
      ...state.settings,
      useCustomTemplates: event.target.checked,
    };
  } else {
    saveSettingsFromForm();
  }
  syncButtons();
}

function onCustomReplyToggle() {
  syncCustomListEditors();
  if (!api) {
    state.settings = {
      ...state.settings,
      useCustomReplies: document.getElementById("use-custom-replies").checked,
    };
  } else {
    saveSettingsFromForm();
  }
  syncButtons();
}

function onCustomFollowupToggle() {
  syncCustomListEditors();
  if (!api) {
    state.settings = {
      ...state.settings,
      useCustomFollowups: document.getElementById("use-custom-followups").checked,
    };
  } else {
    saveSettingsFromForm();
  }
  syncButtons();
}

function customTemplatesReady() {
  const box = document.getElementById("use-custom-templates");
  if (!box?.checked) return true;
  return templateList("customSubjects").length > 0 && templateList("customBodies").length > 0;
}

async function saveTemplateLists(patch) {
  if (!api) {
    state.settings = {
      ...state.settings,
      useCustomTemplates: document.getElementById("use-custom-templates").checked,
      customSubjects: templateList("customSubjects"),
      customBodies: templateList("customBodies"),
      useCustomReplies: document.getElementById("use-custom-replies").checked,
      customReplies: templateList("customReplies"),
      useCustomFollowups: document.getElementById("use-custom-followups").checked,
      customFollowups: templateList("customFollowups"),
      ...patch,
    };
    fillSettings();
    refreshStartButton();
    return true;
  }
  const result = await api.saveSettings({ ...readSettingsForm(), ...patch });
  if (!result.ok) {
    showStatus(result.error, "error");
    return false;
  }
  state.settings = result.settings;
  fillSettings();
  refreshStartButton();
  return true;
}

const TEMPLATE_IMPORTS = {
  subject: { key: "customSubjects", listId: "custom-subject-list", flag: "useCustomTemplates", noun: "subject", nouns: "subjects" },
  body: { key: "customBodies", listId: "custom-body-list", flag: "useCustomTemplates", noun: "body", nouns: "bodies" },
  reply: { key: "customReplies", listId: "custom-reply-list", flag: "useCustomReplies", noun: "reply", nouns: "replies" },
  followup: { key: "customFollowups", listId: "custom-followup-list", flag: "useCustomFollowups", noun: "follow-up", nouns: "follow-ups" },
};

async function downloadTemplateSamples(group) {
  if (!api) {
    showStatus("Download the sample files after you start the desktop app.", "error");
    return;
  }
  state.busy = "import";
  syncButtons();
  try {
    const result = await api.downloadTemplateSamples(group);
    if (!result || result.canceled) return;
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    showStatus(`Saved ${(result.files || []).join(", ")}.`, "success");
  } catch (error) {
    showStatus(error.message || "Could not save the sample files.", "error");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

async function importTemplateFile(kind) {
  const meta = TEMPLATE_IMPORTS[kind];
  if (!meta) return;
  if (!api) {
    showStatus("Import a text file after you start the desktop app.", "error");
    return;
  }
  state.busy = "import";
  syncButtons();
  try {
    const result = await api.importTemplates(kind);
    if (!result || result.canceled) return;
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    const current = templateList(meta.key);
    const seen = new Set(current.map((item) => String(item).toLowerCase()));
    const added = [];
    let duplicate = 0;
    let overflow = 0;
    for (const text of result.texts || []) {
      const token = String(text).toLowerCase();
      if (seen.has(token)) {
        duplicate += 1;
        continue;
      }
      if (current.length + added.length >= TEMPLATE_LIST_MAX) {
        overflow += 1;
        continue;
      }
      seen.add(token);
      added.push(text);
    }
    if (!added.length) {
      showStatus(duplicate ? "Those texts are already in the list." : "That file has no text.", "error");
      return;
    }
    showNewestTemplate(meta.listId, current.length + added.length - 1);
    const saved = await saveTemplateLists({
      [meta.key]: current.concat(added),
      [meta.flag]: true,
    });
    if (!saved) return;
    const noun = added.length === 1 ? meta.noun : meta.nouns;
    const duplicateNote = duplicate ? ` ${duplicate} already in the list were left out.` : "";
    const overflowNote = overflow ? ` The list stops at ${TEMPLATE_LIST_MAX}.` : "";
    showStatus(`Imported ${added.length} ${noun}.${duplicateNote}${overflowNote}`, "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

async function addCustomTemplate(kind) {
  const inputId = kind === "subject" ? "custom-subject-input" : "custom-body-input";
  const key = kind === "subject" ? "customSubjects" : "customBodies";
  const raw = document.getElementById(inputId).value;
  const text = kind === "subject" ? raw.replace(/\s+/g, " ").trim() : raw.replace(/\r\n/g, "\n").trim();
  if (!text) {
    showStatus(kind === "subject" ? "Write a subject first." : "Write a body first.", "error");
    return;
  }
  const current = templateList(key);
  if (current.some((item) => item.toLowerCase() === text.toLowerCase())) {
    showStatus(kind === "subject" ? "That subject is already in the list." : "That body is already in the list.", "error");
    return;
  }
  if (current.length >= TEMPLATE_LIST_MAX) {
    showStatus(kind === "subject" ? `You can save ${TEMPLATE_LIST_MAX} subjects.` : `You can save ${TEMPLATE_LIST_MAX} bodies.`, "error");
    return;
  }
  showNewestTemplate(kind === "subject" ? "custom-subject-list" : "custom-body-list", current.length);
  const saved = await saveTemplateLists({ [key]: current.concat(text), useCustomTemplates: true });
  if (!saved) return;
  document.getElementById(inputId).value = "";
}

async function addCustomReply() {
  const input = document.getElementById("custom-reply-input");
  const text = input.value.replace(/\r\n/g, "\n").trim();
  if (!text) {
    showStatus("Write a reply first.", "error");
    return;
  }
  const current = templateList("customReplies");
  if (current.some((item) => item.toLowerCase() === text.toLowerCase())) {
    showStatus("That reply is already in the list.", "error");
    return;
  }
  if (current.length >= TEMPLATE_LIST_MAX) {
    showStatus(`You can save ${TEMPLATE_LIST_MAX} replies.`, "error");
    return;
  }
  showNewestTemplate("custom-reply-list", current.length);
  const saved = await saveTemplateLists({ customReplies: current.concat(text), useCustomReplies: true });
  if (!saved) return;
  input.value = "";
}

async function addCustomFollowup() {
  const input = document.getElementById("custom-followup-input");
  const text = input.value.replace(/\r\n/g, "\n").trim();
  if (!text) {
    showStatus("Write a follow-up email first.", "error");
    return;
  }
  const current = templateList("customFollowups");
  if (current.some((item) => item.toLowerCase() === text.toLowerCase())) {
    showStatus("That follow-up email is already in the list.", "error");
    return;
  }
  if (current.length >= TEMPLATE_LIST_MAX) {
    showStatus(`You can save ${TEMPLATE_LIST_MAX} follow-up emails.`, "error");
    return;
  }
  showNewestTemplate("custom-followup-list", current.length);
  const saved = await saveTemplateLists({ customFollowups: current.concat(text), useCustomFollowups: true });
  if (!saved) return;
  input.value = "";
}

async function removeCustomFollowup(index) {
  const current = templateList("customFollowups").slice();
  if (!(index >= 0) || index >= current.length) return;
  current.splice(index, 1);
  shiftTemplateOpen("custom-followup-list", index);
  await saveTemplateLists({ customFollowups: current });
}

async function removeCustomReply(index) {
  const current = templateList("customReplies").slice();
  if (!(index >= 0) || index >= current.length) return;
  current.splice(index, 1);
  shiftTemplateOpen("custom-reply-list", index);
  await saveTemplateLists({ customReplies: current });
}

async function removeCustomTemplate(kind, index) {
  const key = kind === "subject" ? "customSubjects" : "customBodies";
  const current = templateList(key).slice();
  if (!(index >= 0) || index >= current.length) return;
  current.splice(index, 1);
  shiftTemplateOpen(kind === "subject" ? "custom-subject-list" : "custom-body-list", index);
  await saveTemplateLists({ [key]: current });
}

async function saveSettingsFromForm() {
  if (!api) return;
  const result = await api.saveSettings(readSettingsForm());
  if (!result.ok) {
    showStatus(result.error, "error");
    return;
  }
  state.settings = result.settings;
  fillSettings();
  refreshStartButton();
  syncButtons();
}

async function refreshProfiles(readAll) {
  if (!api) return;
  state.busy = "refresh";
  syncButtons();
  try {
    const result = await api.refreshProfiles(readSettingsForm(), { readAll: readAll === true });
    if (result.settings) {
      state.settings = result.settings;
      fillSettings();
    }
    if (result.gmailStatus) state.gmailStatus = result.gmailStatus;
    state.loadingProfiles = false;
    if (!result.ok) {
      setConnection(result.error, false);
      showStatus(result.error, "error");
      renderProfiles();
      return;
    }
    state.profiles = result.profiles;
    if (result.hiddenProfiles) state.hiddenProfiles = result.hiddenProfiles;
    setConnection(result.connection, !result.warning);
    if (result.warning) showStatus(result.warning, "error");
    renderProfiles();
  } finally {
    state.loadingProfiles = false;
    state.busy = "";
    syncButtons();
  }
}

async function openSelected() {
  const accounts = collectAccounts().filter((account) => account.selected);
  if (!accounts.length) {
    showStatus("Select at least one profile.", "error");
    return;
  }
  await runProfileAction("open", () => api.openProfiles(accounts.map((account) => ({
    envId: account.envId,
    gmailIndex: account.gmailIndex,
  }))));
}

async function readSelectedGmail() {
  let envIds = selectedEnvIds();
  if (!envIds.length) envIds = state.profiles.filter((profile) => profile.running).map((profile) => profile.envId);
  if (!envIds.length) {
    showStatus("Open a browser, or check a closed profile.", "error");
    return;
  }
  await runProfileAction("read", (options) => api.readGmail(envIds, options));
}

async function runProfileAction(busy, action) {
  state.busy = busy;
  syncButtons();
  try {
    const result = await action();
    if (result.profiles) state.profiles = result.profiles;
    if (result.hiddenProfiles) state.hiddenProfiles = result.hiddenProfiles;
    if (result.profiles || result.hiddenProfiles) renderProfiles();
    if (!result.ok) showStatus(result.error || result.message, "error");
    else showStatus(result.message, "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

async function importContacts() {
  if (!api) {
    showStatus("Import a contact list after you start the desktop app.", "error");
    return;
  }
  state.busy = "import";
  syncButtons();
  try {
    const result = await api.importContacts();
    if (!result || result.canceled) return;
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    state.contacts = result.contacts;
    renderContacts();
    const skipped = result.skipped ? ` ${result.skipped} invalid rows were skipped.` : "";
    showStatus(`Imported ${result.count} shared contacts.${skipped}`, "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

async function clearContacts() {
  if (!state.contacts.length) return;
  if (!confirm("Remove the shared contact list?")) return;
  if (!api) {
    state.contacts = [];
    renderContacts();
    syncButtons();
    return;
  }
  const result = await api.clearContacts();
  if (!result.ok) {
    showStatus(result.error, "error");
    return;
  }
  state.contacts = [];
  renderContacts();
  syncButtons();
}

async function importAccountContacts(row) {
  if (!api) {
    showStatus("Import a contact list after you start the desktop app.", "error");
    return;
  }
  state.busy = "import";
  syncButtons();
  try {
    const result = await api.importAccountContacts({
      envId: row.dataset.envId,
      gmailIndex: Number(row.dataset.gmailIndex) || 0,
    });
    if (!result || result.canceled) return;
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    const key = row.dataset.accountKey;
    state.prefs[key] = {
      ...(state.prefs[key] || {}),
      contacts: result.contacts || [],
      contactFileName: result.fileName || "",
    };
    paintAccountContacts(row);
    rememberRow(row);
    renderContacts();
    const skipped = result.skipped ? ` ${result.skipped} invalid rows were skipped.` : "";
    const who = row.dataset.email || "this Gmail";
    showStatus(`Imported ${result.count} contacts for ${who}.${skipped}`, "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

async function clearAccountContacts(row) {
  const key = row.dataset.accountKey;
  const count = (state.prefs[key]?.contacts || []).length;
  if (!count) return;
  const who = row.dataset.email || "this Gmail";
  if (!confirm(`Remove the contact list for ${who}?`)) return;
  if (api) {
    const result = await api.clearAccountContacts({
      envId: row.dataset.envId,
      gmailIndex: Number(row.dataset.gmailIndex) || 0,
    });
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
  }
  state.prefs[key] = {
    ...(state.prefs[key] || {}),
    contacts: [],
    contactFileName: "",
  };
  paintAccountContacts(row);
  rememberRow(row);
  renderContacts();
  syncButtons();
}

async function startCampaign() {
  state.busy = "start";
  syncButtons();
  try {
    const result = await api.startCampaign({
      ...readSettingsForm(),
      accounts: collectAccounts(),
    });
    if (result.settings) {
      state.settings = result.settings;
      fillSettings();
    }
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    rememberCampaigns(result.campaigns, result.campaign, "campaign");
    renderProgress();
    applyCampaignToCards(campaignForTab() || state.campaign);
    const when = Number(result.campaign?.startTime) || 0;
    showStatus(when > Date.now() + 1000 ? `Sending starts ${new Date(when).toLocaleString()}.` : "Sending.", "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

async function startWarmup() {
  clearTimeout(warmupTimer);
  const draft = readWarmupDraft();
  const draftTouched = Boolean(warmupEditingId) || Boolean(draft.email || draft.firstName || draft.company);
  if (draftTouched) {
    const error = warmupDraftError(draft, warmupBusinesses(), warmupEditingId);
    if (error) {
      showStatus(error, "error");
      return;
    }
    const next = businessesWithDraft(warmupBusinesses(), draft, warmupEditingId);
    if (!next) {
      showStatus("That business email is no longer in the list.", "error");
      clearWarmupDraft();
      return;
    }
    const targetId = warmupEditingId || next[next.length - 1].id;
    const saved = await persistWarmupBusinesses(next, targetId);
    if (!saved) return;
    clearWarmupDraft();
  }
  state.busy = "warmup";
  syncButtons();
  try {
    const result = await api.startWarmup({
      businesses: warmupBusinesses(),
      selectedId: state.warmup?.selectedId || "",
      intervalSeconds: document.getElementById("warmup-interval").value,
      language: document.getElementById("email-language").value,
      mentionAttachment: document.getElementById("mention-attachment").checked,
      ...customTemplatePayload(),
      accounts: collectAccounts(),
    });
    if (result.warmup) state.warmup = result.warmup;
    if (result.settings) state.settings = result.settings;
    fillSettings();
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    rememberCampaigns(result.campaigns, result.campaign, "warmup");
    renderProgress();
    applyCampaignToCards(campaignForTab() || state.campaign);
    showStatus("Warming up.", "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

async function startPeerWarmup() {
  state.busy = "peer-warmup";
  syncButtons();
  try {
    const result = await api.startPeerWarmup({
      intervalSeconds: document.getElementById("peer-interval").value,
      periods: document.getElementById("peer-periods").value,
      ...customTemplatePayload(),
      accounts: collectAccounts(),
    });
    if (result.warmup) state.warmup = result.warmup;
    if (Array.isArray(result.gmailConnections)) state.connections = result.gmailConnections;
    fillSettings();
    paintPeerConnections();
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    rememberCampaigns(result.campaigns, result.campaign, "peer-warmup");
    if (Array.isArray(result.campaign?.connections)) state.connections = result.campaign.connections;
    renderProgress();
    applyCampaignToCards(campaignForTab() || state.campaign);
    paintPeerConnections();
    showStatus("Warming up the selected Gmail accounts.", "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

async function saveFollowupFromForm() {
  if (!api) return;
  clearTimeout(peerTimer);
  try {
    const result = await api.saveFollowup({
      body: document.getElementById("followup-body").value,
      date: document.getElementById("followup-date").value,
      intervalSeconds: document.getElementById("followup-interval").value,
      steps: followupStepsFromForm(),
    });
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    if (result.followup) state.followup = result.followup;
  } catch (error) {
    showStatus(error.message || String(error), "error");
  }
}

async function saveAnalysisFromForm() {
  if (!api) return;
  clearTimeout(analyseTimer);
  analyseTimer = setTimeout(async () => {
    try {
      const result = await api.saveAnalysis({
        from: document.getElementById("analyse-from").value,
        to: document.getElementById("analyse-to").value,
        limit: document.getElementById("analyse-limit").value,
      });
      if (!result.ok) {
        showStatus(result.error, "error");
        return;
      }
      if (result.analysis) {
        state.analysis = result.analysis;
        renderAnalysis();
      }
    } catch (error) {
      showStatus(error.message || String(error), "error");
    }
  }, 200);
}

async function startAnalysis() {
  clearTimeout(analyseTimer);
  state.busy = "analyse";
  syncButtons();
  try {
    const result = await api.startAnalysis({
      from: document.getElementById("analyse-from").value,
      to: document.getElementById("analyse-to").value,
      limit: document.getElementById("analyse-limit").value,
      accounts: collectAccounts(),
    });
    if (result.analysis) state.analysis = result.analysis;
    renderAnalysis();
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    rememberCampaigns(result.campaigns, result.campaign, "analyse");
    renderProgress();
    applyCampaignToCards(campaignForTab() || state.campaign);
    showStatus("Analysing sent mail.", "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

let analyseModalEmail = "";

function analysisContactsFor(email) {
  const key = String(email || "").trim().toLowerCase();
  return (Array.isArray(state.analysis?.contacts) ? state.analysis.contacts : [])
    .filter((item) => String(item.gmail || "").trim().toLowerCase() === key);
}

function openAnalyseResult(row) {
  const email = String(row?.dataset.email || "").trim();
  analyseModalEmail = email.toLowerCase();
  document.getElementById("analyse-modal-title").textContent = email || "Gmail";
  document.getElementById("analyse-modal").hidden = false;
  renderAnalyseModal();
}

function closeAnalyseModal() {
  analyseModalEmail = "";
  document.getElementById("analyse-modal").hidden = true;
}

function renderAnalyseModal() {
  const body = document.getElementById("analyse-modal-body");
  const modal = document.getElementById("analyse-modal");
  if (!body || !modal || modal.hidden) return;
  const contacts = analysisContactsFor(analyseModalEmail);
  const counts = {};
  contacts.forEach((item) => {
    const label = item.label || "Delivery report";
    counts[label] = (counts[label] || 0) + 1;
  });
  body.replaceChildren();
  const countRows = Object.entries(counts);
  if (!countRows.length) {
    body.append(el("p", "help", "No delivery reports for this Gmail yet."));
    return;
  }
  const list = el("div", "analyse-counts");
  countRows.forEach(([label, count]) => {
    const line = el("div", "analyse-count");
    line.append(el("span", "", label), el("span", "", String(count)));
    list.append(line);
  });
  body.append(list);
  const saved = el("ul", "analyse-contacts");
  contacts.forEach((item) => {
    const name = item.firstName ? `${item.firstName} · ` : "";
    saved.append(el("li", "", `${name}${item.email} · ${item.label || "Delivery report"}`));
  });
  body.append(saved);
}

function renderAnalysis() {
  renderAnalyseModal();
}

function followupStepsFromForm() {
  return [
    {
      days: document.getElementById("followup-step1-days").value,
      body: document.getElementById("followup-step1-body").value,
    },
    {
      days: document.getElementById("followup-step2-days").value,
      body: document.getElementById("followup-step2-body").value,
    },
  ];
}

function warmupPlanFromForm() {
  return {
    startLimit: document.getElementById("warmup-plan-start").value,
    dailyStep: document.getElementById("warmup-plan-step").value,
    cap: document.getElementById("warmup-plan-cap").value,
    startedAt: state.warmup?.plan?.startedAt || "",
    lastRunDay: state.warmup?.plan?.lastRunDay || "",
  };
}

function paintWarmupPlan() {
  const node = document.getElementById("warmup-plan-today");
  if (!node) return;
  const plan = warmupPlanFromForm();
  const start = Math.max(1, Number(plan.startLimit) || 5);
  const step = Math.max(0, Number(plan.dailyStep) || 0);
  const cap = Math.max(start, Number(plan.cap) || start);
  const started = plan.startedAt;
  let days = 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(started)) {
    const [year, month, day] = started.split("-").map((part) => Number(part));
    const from = Date.UTC(year, month - 1, day);
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    days = Math.max(0, Math.round((today - from) / 86400000));
  }
  const limit = Math.min(cap, start + days * step);
  node.textContent = started
    ? `Today's max is ${limit}. The plan started on ${started}.`
    : `Today's max is ${limit}. It starts the first time you apply it.`;
}

function clientStatus(record) {
  if (record.bouncedAt) return record.bounceLabel || "Bounced";
  if (record.repliedAt) return "Replied";
  if (record.followups) return `Follow-up ${record.followups}`;
  if (record.sentAt) return "Sent";
  return "";
}

function paintClientSummary() {
  const node = document.getElementById("client-summary");
  if (!node) return;
  const rows = Object.values(state.clients || {});
  if (!rows.length) {
    node.textContent = "No client record yet. It fills in as client emails are sent.";
    return;
  }
  const bounced = rows.filter((row) => row.bouncedAt).length;
  const replied = rows.filter((row) => row.repliedAt).length;
  node.textContent = `${rows.length} client record${rows.length === 1 ? "" : "s"}. ${bounced} bounced. ${replied} replied.`;
  if (!document.getElementById("clients-modal").hidden) renderClientTable();
}

function renderClientTable() {
  const table = document.getElementById("clients-table");
  table.replaceChildren();
  const rows = Object.values(state.clients || {}).sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
  if (!rows.length) {
    table.append(el("p", "help", "No client record yet."));
    return;
  }
  const grid = document.createElement("table");
  const head = document.createElement("tr");
  ["Client", "Gmail", "Status"].forEach((label) => head.append(el("th", "", label)));
  grid.append(head);
  rows.slice(0, 200).forEach((record) => {
    const line = document.createElement("tr");
    line.append(
      el("td", "", record.email),
      el("td", "", record.gmail || ""),
      el("td", "", clientStatus(record))
    );
    grid.append(line);
  });
  table.append(grid);
}

function showClients() {
  renderClientTable();
  document.getElementById("clients-modal").hidden = false;
}

async function startDueFollowups() {
  state.busy = "followup";
  syncButtons();
  try {
    const result = await api.startDueFollowups({
      body: document.getElementById("followup-body").value,
      date: document.getElementById("followup-date").value,
      intervalSeconds: document.getElementById("followup-interval").value,
      steps: followupStepsFromForm(),
      accounts: collectAccounts(),
    });
    if (result.followup) state.followup = result.followup;
    fillSettings();
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    if (!result.due) {
      showStatus(result.message || "No follow-up is due.", "success");
      return;
    }
    rememberCampaigns(result.campaigns, result.campaign, "followup");
    renderProgress();
    applyCampaignToCards(campaignForTab() || state.campaign);
    showStatus("Running due follow-ups.", "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

async function applyWarmupPlan() {
  state.busy = "warmup-plan";
  syncButtons();
  try {
    const result = await api.applyWarmupPlan({
      intervalSeconds: document.getElementById("peer-interval").value,
      periods: document.getElementById("peer-periods").value,
      plan: warmupPlanFromForm(),
      accounts: collectAccounts(),
    });
    if (result.warmup) state.warmup = result.warmup;
    if (result.prefs) state.prefs = result.prefs;
    fillSettings();
    renderProfiles();
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    showStatus(`Today's max is ${result.limit}.`, "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

async function runWarmupPlan() {
  state.busy = "peer";
  syncButtons();
  try {
    const result = await api.runWarmupPlan({
      intervalSeconds: document.getElementById("peer-interval").value,
      periods: document.getElementById("peer-periods").value,
      plan: warmupPlanFromForm(),
      ...customTemplatePayload(),
      accounts: collectAccounts(),
    });
    if (result.warmup) state.warmup = result.warmup;
    fillSettings();
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    if (Array.isArray(result.gmailConnections)) state.connections = result.gmailConnections;
    paintPeerConnections();
    rememberCampaigns(result.campaigns, result.campaign, "peer");
    renderProgress();
    applyCampaignToCards(campaignForTab() || state.campaign);
    showStatus("Today's Gmail warm-up is running.", "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

async function startFollowup() {
  state.busy = "followup";
  syncButtons();
  try {
    const result = await api.startFollowup({
      body: document.getElementById("followup-body").value,
      date: document.getElementById("followup-date").value,
      intervalSeconds: document.getElementById("followup-interval").value,
      accounts: collectAccounts(),
    });
    if (result.followup) state.followup = result.followup;
    fillSettings();
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    rememberCampaigns(result.campaigns, result.campaign, "followup");
    renderProgress();
    applyCampaignToCards(campaignForTab() || state.campaign);
    showStatus("Following up.", "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

async function clearPeerConnections() {
  if (!api) return;
  state.busy = "connections";
  syncButtons();
  try {
    const result = await api.clearGmailConnections();
    if (!result.ok) {
      showStatus(result.error || "Could not clear connections.", "error");
      return;
    }
    state.connections = [];
    paintPeerConnections();
    showStatus("Cleared the saved Gmail connections.", "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

function paintPeerConnections() {
  const node = document.getElementById("peer-connections");
  if (!node) return;
  const count = connectionPairs().length;
  node.textContent = count === 0
    ? "No connections saved."
    : count === 1
      ? "1 connection saved."
      : `${count} connections saved.`;
  if (!document.getElementById("connections-modal").hidden) renderConnectionsTable();
}

function connectionPairs() {
  const pairs = [];
  for (const item of Array.isArray(state.connections) ? state.connections : []) {
    const text = String(item || "");
    const splitAt = text.indexOf("|");
    if (splitAt <= 0) continue;
    const left = text.slice(0, splitAt).trim();
    const right = text.slice(splitAt + 1).trim();
    if (!left || !right) continue;
    pairs.push([left, right]);
  }
  pairs.sort((left, right) => `${left[0]}|${left[1]}`.localeCompare(`${right[0]}|${right[1]}`));
  return pairs;
}

function emailLabel(email) {
  const wanted = String(email || "").trim().toLowerCase();
  let name = "";
  for (const pref of Object.values(state.prefs || {})) {
    if (String(pref?.email || "").trim().toLowerCase() !== wanted) continue;
    name = String(pref.senderName || "").trim();
    if (name) break;
  }
  if (!name) {
    for (const profile of state.profiles || []) {
      for (const account of profile.gmailAccounts || []) {
        if (String(account.email || "").trim().toLowerCase() !== wanted) continue;
        name = String(account.name || "").trim();
        if (name) break;
      }
      if (name) break;
    }
  }
  return name ? `${name} · ${email}` : email;
}

function renderConnectionsTable() {
  const wrap = document.getElementById("connections-table");
  if (!wrap) return;
  const pairs = connectionPairs();
  wrap.replaceChildren();
  if (!pairs.length) {
    wrap.append(el("p", "help", "No connections saved."));
    return;
  }
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(el("th", "", "Gmail"), el("th", "", "Connected Gmail"));
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const [left, right] of pairs) {
    const row = document.createElement("tr");
    row.append(el("td", "", emailLabel(left)), el("td", "", emailLabel(right)));
    body.append(row);
  }
  table.append(head, body);
  wrap.append(table);
}

function openConnections() {
  renderConnectionsTable();
  document.getElementById("connections-modal").hidden = false;
  document.getElementById("connections-close").focus();
}

function closeConnections() {
  document.getElementById("connections-modal").hidden = true;
}

async function pauseCampaign(id) {
  const kind = tabKind();
  const jobId = typeof id === "string" ? id : controlJob("pause")?.id;
  showStatus("Pausing after the current step. Progress will be saved.", "success");
  const result = await api.pauseCampaign({ kind, id: jobId });
  if (!result.ok) showStatus(result.error, "error");
  rememberCampaigns(result.campaigns, result.campaign, result.kind || kind);
  renderProgress();
  syncButtons();
}

async function stopCampaign(id) {
  const kind = tabKind();
  const jobId = typeof id === "string" ? id : controlJob("stop")?.id;
  showStatus("Stopping.", "success");
  const result = await api.stopCampaign({ kind, id: jobId });
  if (!result.ok) showStatus(result.error, "error");
  rememberCampaigns(result.campaigns, result.campaign, result.kind || kind);
  renderProgress();
  applyCampaignToCards(campaignForTab() || state.campaign);
  syncButtons();
}

async function resumeCampaign(id) {
  if (resumeInFlight) return;
  resumeInFlight = true;
  if (resumeTimer) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  try {
    const kind = autoResumeKind || tabKind();
    const jobId = typeof id === "string" ? id : (autoResumeId || controlJob("resume")?.id);
    const result = await api.resumeCampaign({ kind, id: jobId });
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    rememberCampaigns(result.campaigns, result.campaign, result.kind || kind);
    renderProgress();
    applyCampaignToCards(campaignForTab() || state.campaign);
    syncButtons();
    showStatus("Resuming.", "success");
  } finally {
    resumeInFlight = false;
    autoResumeKind = "";
    autoResumeId = "";
  }
}

function renderContacts() {
  const history = document.getElementById("last-history");
  history.textContent = state.history?.date ? `Last sent: ${state.history.date} — ${state.history.sent}` : "";
  paintClientSummary();
  const preview = document.getElementById("contacts-preview");
  if (!preview) return;
  preview.replaceChildren();
  if (!state.contacts.length) {
    preview.append(el("p", "help", "No shared contacts yet."));
  } else {
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Name", "Email", "Company"].forEach((label) => headRow.append(el("th", "", label)));
    thead.append(headRow);
    const tbody = document.createElement("tbody");
    state.contacts.slice(0, 5).forEach((contact) => {
      const row = document.createElement("tr");
      row.append(el("td", "", contact.name), el("td", "", contact.email), el("td", "", contact.company));
      tbody.append(row);
    });
    if (state.contacts.length > 5) {
      const row = document.createElement("tr");
      const cell = el("td", "", `...and ${state.contacts.length - 5} more contacts`);
      cell.colSpan = 3;
      row.append(cell);
      tbody.append(row);
    }
    table.append(thead, tbody);
    const noun = state.contacts.length === 1 ? "shared contact" : "shared contacts";
    preview.append(el("p", "help", `${state.contacts.length} ${noun}`), table);
  }
  const lists = contactLists();
  if (!lists.length) return;
  preview.append(el("p", "help", "Gmail accounts with their own list"));
  const items = document.createElement("ul");
  items.className = "contact-summary";
  lists.forEach((list) => {
    const noun = list.count === 1 ? "contact" : "contacts";
    const file = list.fileName ? `${list.fileName} · ` : "";
    items.append(el("li", "", `${list.email} — ${file}${list.count} ${noun}`));
  });
  preview.append(items);
}

function contactLists() {
  return Object.entries(state.prefs || {})
    .map(([key, pref]) => ({
      key,
      email: pref?.email || key,
      count: Array.isArray(pref?.contacts) ? pref.contacts.length : 0,
      fileName: pref?.contactFileName || "",
    }))
    .filter((row) => row.count > 0);
}

function browserSource() {
  return state.settings.browserSource === "chrome" ? "chrome" : "morelogin";
}

function isChromeProfile(profile) {
  return profile?.source === "chrome";
}

function profilesForSource() {
  const chromeMode = browserSource() === "chrome";
  return state.profiles.filter((profile) => isChromeProfile(profile) === chromeMode);
}

function hiddenForSource() {
  const chromeMode = browserSource() === "chrome";
  return state.hiddenProfiles.filter((profile) => isChromeProfile(profile) === chromeMode);
}

const MORELOGIN_NOTE = "Groups open into browsers, then Gmail accounts. Each tab keeps its own checks. Hide on a browser removes that browser from this list. Hide on a Gmail removes only that account.";
const CHROME_NOTE = "Chrome profiles on this computer. Open one to use the Gmail signed in there. Each tab keeps its own checks. Hide on a profile removes that profile from this list. Hide on a Gmail removes only that account.";

function applySource() {
  const chromeMode = browserSource() === "chrome";
  document.getElementById("source-morelogin").setAttribute("aria-selected", chromeMode ? "false" : "true");
  document.getElementById("source-chrome").setAttribute("aria-selected", chromeMode ? "true" : "false");
  document.getElementById("morelogin-fields").hidden = chromeMode;
  document.getElementById("brand-tagline").textContent = chromeMode
    ? "Send through the Gmail account signed in to each Chrome profile."
    : "Send through the Gmail account signed in to each MoreLogin browser.";
  document.getElementById("browser-title").textContent = chromeMode ? "Chrome profiles" : "MoreLogin browsers";
  const note = document.getElementById("toolbar-note");
  note.textContent = chromeMode ? CHROME_NOTE : MORELOGIN_NOTE;
  note.title = note.textContent;
}

async function showSource(source) {
  const next = source === "chrome" ? "chrome" : "morelogin";
  if (browserSource() === next || isCampaignRunning() || state.busy) return;
  state.settings.browserSource = next;
  applySource();
  if (!api) {
    renderProfiles();
    return;
  }
  state.loadingProfiles = true;
  state.profiles = [];
  state.hiddenProfiles = [];
  renderProfiles();
  await refreshProfiles();
}

function renderProfiles() {
  const list = document.getElementById("profile-list");
  list.querySelectorAll("details[data-node]").forEach((node) => {
    treeOpen.set(node.dataset.node, node.open);
  });
  list.querySelectorAll(".profile-node[data-node]").forEach((node) => {
    treeOpen.set(node.dataset.node, node.classList.contains("is-open"));
  });
  list.replaceChildren();
  applySource();
  const profiles = profilesForSource();
  const hidden = hiddenForSource();
  const hiddenCount = hidden.length;
  const chromeMode = browserSource() === "chrome";

  if (state.loadingProfiles) {
    list.append(el("p", "help", "Loading profiles."));
  } else if (!profiles.length && !hiddenCount) {
    list.append(el("p", "help", chromeMode
      ? "No Chrome profiles yet. Sign in to Gmail in Chrome, then click Refresh."
      : "No profiles yet. Open MoreLogin and sign in, then click Refresh."));
  } else if (!profiles.length) {
    list.append(el("p", "help", "Every profile is hidden in this app. Show one below to use it again."));
  } else if (chromeMode) {
    profiles.forEach((profile) => list.append(renderProfile(profile)));
  } else {
    groupedProfiles(profiles).forEach(([groupName, group]) => {
      list.append(renderGroup(groupName, group));
    });
  }
  if (hiddenCount) list.append(renderHidden(hidden));
  const hiddenGmail = hiddenGmailEntries();
  if (hiddenGmail.length) list.append(renderHiddenGmail(hiddenGmail));
  fillStatusPick();
  syncShowSelectedButton();
  updateSelectedSummary();
  applySearch();
  applyCampaignToCards(campaignForTab());
  state.peerLockKey = peerLockSignature();
  setRowsLocked(Boolean(state.busy));
}

function groupedProfiles(profiles) {
  const groups = new Map();
  profiles.forEach((profile) => {
    const name = profile.groupName || "Ungrouped";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(profile);
  });
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === "Ungrouped") return 1;
    if (b[0] === "Ungrouped") return -1;
    return a[0].localeCompare(b[0]);
  });
}

function disclosure(className, nodeKey, fallbackOpen) {
  const node = document.createElement("details");
  node.className = className;
  node.dataset.node = nodeKey;
  node.open = treeOpen.has(nodeKey) ? treeOpen.get(nodeKey) : fallbackOpen;
  node.addEventListener("toggle", () => {
    treeOpen.set(nodeKey, node.open);
  });
  return node;
}

function renderGroup(groupName, profiles) {
  const group = disclosure("tree-group", `group:${groupName}`, true);
  const summary = document.createElement("summary");
  summary.append(el("span", "twisty", ""));
  const openCount = profiles.filter((profile) => profile.running).length;
  summary.append(el("span", "group-label", `${groupName} · ${profiles.length} browsers, ${openCount} open`));
  group.append(summary);
  profiles.forEach((profile) => group.append(renderProfile(profile)));
  return group;
}

function gmailAccountsOf(profile) {
  return profile.gmailAccounts?.length ? profile.gmailAccounts : [{ index: 0, email: "", name: "" }];
}

function visibleGmailAccounts(profile) {
  return gmailAccountsOf(profile).filter((account) => !prefFor(profile, account).hidden);
}

function gmailSummary(profile) {
  const accounts = gmailAccountsOf(profile);
  const visible = visibleGmailAccounts(profile);
  const hiddenCount = accounts.length - visible.length;
  const emails = visible.map((account) => account.email).filter(Boolean);
  const hiddenNote = hiddenCount ? `${hiddenCount} hidden` : "";
  if (!emails.length && !hiddenCount) return "Gmail not read yet";
  if (!emails.length) return hiddenNote;
  const listed = `${emails.length} Gmail account${emails.length === 1 ? "" : "s"} · ${emails.join(", ")}`;
  return hiddenNote ? `${listed} · ${hiddenNote}` : listed;
}

function renderProfile(profile) {
  const accounts = visibleGmailAccounts(profile);
  const emails = gmailAccountsOf(profile).map((account) => `${account.email} ${account.name || ""} ${statusFor(account.email)}`).join(" ");
  const nodeKey = `profile:${profile.envId}`;
  const node = el("div", "profile-node");
  node.dataset.node = nodeKey;
  node.dataset.search = `${profile.envName} ${profile.groupName || ""} ${profile.uniqueId ?? ""} ${emails}`.toLowerCase();
  const expanded = treeOpen.has(nodeKey) ? treeOpen.get(nodeKey) : Boolean(profile.running);
  if (expanded) node.classList.add("is-open");

  const head = el("div", "profile-head");
  const twisty = button("twisty-btn", "");
  twisty.append(el("span", "twisty", ""));
  twisty.setAttribute("aria-label", expanded ? `Collapse ${profile.envName}` : `Expand ${profile.envName}`);
  const master = document.createElement("input");
  master.type = "checkbox";
  master.className = "profile-select";
  const blocked = profileBlocked(profile.envId);
  const chosen = accounts.filter((account) => prefFor(profile, account).selected).length;
  master.checked = !blocked && chosen === accounts.length && accounts.length > 0;
  master.indeterminate = !blocked && chosen > 0 && chosen < accounts.length;
  master.dataset.empty = accounts.length ? "0" : "1";
  master.dataset.peerBusy = blocked ? "1" : "";
  master.disabled = blocked;
  master.title = blocked ? profileBlockTitle(profile.envId) : "";
  master.setAttribute("aria-label", `Select every Gmail in ${profile.envName}`);
  if (blocked) node.classList.add("is-peer-busy");
  const text = el("div", "profile-text");
  const title = el("div", "profile-title");
  title.append(document.createTextNode(profile.envName));
  if (profile.uniqueId != null) title.append(el("span", "help profile-serial", ` #${profile.uniqueId}`));
  text.append(title, el("div", "profile-meta", gmailSummary(profile)));
  const hide = button("linkish hide-profile", "Hide");
  hide.dataset.envId = profile.envId;
  hide.title = profile.source === "chrome"
    ? "Remove this profile from the list. It stays in Chrome."
    : "Remove this browser from the list. It stays in MoreLogin.";
  head.append(twisty, master, text, el("span", profile.running ? "pill open" : "pill", profile.running ? "Open" : "Closed"), hide);

  const branch = el("div", "gmail-branch");
  branch.hidden = !expanded;
  if (accounts.length) accounts.forEach((account) => branch.append(renderGmailRow(profile, account)));
  else branch.append(el("p", "help gmail-empty", "Every Gmail in this browser is hidden."));
  twisty.addEventListener("click", () => setProfileExpanded(node, branch.hidden));
  text.addEventListener("click", () => twisty.click());
  node.append(head, branch);
  return node;
}

function renderHidden(hiddenProfiles) {
  const hidden = hiddenProfiles || hiddenForSource();
  const group = disclosure("tree-group hidden-group", "hidden-bin", false);
  const summary = document.createElement("summary");
  summary.append(el("span", "twisty", ""));
  summary.append(el("span", "group-label", `Hidden in this app · ${hidden.length}`));
  group.append(summary);
  hidden.forEach((profile) => {
    const row = el("div", "hidden-row");
    const label = el("span", "profile-title", profile.envName);
    const meta = [profile.uniqueId != null ? `#${profile.uniqueId}` : "", profile.groupName || "", profile.running ? "Open" : "Closed"]
      .filter(Boolean)
      .join(" · ");
    const show = button("linkish show-profile", "Show");
    show.dataset.envId = profile.envId;
    row.append(label, el("span", "help", meta), show);
    row.dataset.search = `${profile.envName} ${profile.groupName || ""} ${profile.uniqueId ?? ""}`.toLowerCase();
    group.append(row);
  });
  return group;
}

function hiddenGmailEntries() {
  const entries = [];
  profilesForSource().forEach((profile) => {
    gmailAccountsOf(profile).forEach((account) => {
      const pref = prefFor(profile, account);
      if (!pref.hidden) return;
      entries.push({ profile, account, pref });
    });
  });
  return entries;
}

function renderHiddenGmail(entries) {
  const group = disclosure("tree-group hidden-group hidden-gmail-group", "hidden-gmail", false);
  const summary = document.createElement("summary");
  summary.append(el("span", "twisty", ""));
  summary.append(el("span", "group-label", `Hidden Gmail accounts · ${entries.length}`));
  group.append(summary);
  entries.forEach(({ profile, account, pref }) => {
    const row = el("div", "hidden-row");
    const who = account.email || pref.email || `Gmail ${account.index}`;
    const show = button("linkish show-gmail", "Show");
    show.dataset.accountKey = pref.key;
    show.title = "Show this Gmail in the list again.";
    row.append(el("span", "profile-title", who), el("span", "help", profile.envName), show);
    row.dataset.search = `${who} ${account.name || ""} ${profile.envName}`.toLowerCase();
    group.append(row);
  });
  return group;
}

function renderGmailRow(profile, account) {
  const pref = prefFor(profile, account);
  const blocked = profileBlocked(profile.envId);
  const row = el("div", `gmail-row${pref.selected && !blocked ? " is-selected" : ""}${blocked ? " is-peer-busy" : ""}${currentTab() === "analyse" ? " is-analyse" : ""}${showsSendRecord() ? " is-record" : ""}`);
  row.dataset.accountKey = pref.key;
  row.dataset.envId = profile.envId;
  row.dataset.envName = profile.envName;
  row.dataset.gmailIndex = String(account.index);
  row.dataset.email = account.email || pref.email || "";
  row.dataset.peerBusy = blocked ? "1" : "";
  row.dataset.cvPath = pref.cvPath || "";
  row.dataset.cvName = pref.cvName || "";

  const line = el("div", "account-line");
  const main = el("label", "account-main");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "account-select";
  checkbox.checked = Boolean(pref.selected) && !blocked;
  checkbox.disabled = blocked;
  checkbox.title = blocked ? profileBlockTitle(profile.envId) : "";
  const copy = el("span", "account-identity");
  copy.append(el("span", "account-email", account.email || "Gmail not read yet"));
  if (account.name) copy.append(el("span", "account-name", account.name));
  const analyseTab = currentTab() === "analyse";
  const recordTab = showsSendRecord();
  const badge = el("span", "badge", String(account.index));
  if (analyseTab) {
    const open = button("analyse-open", "");
    open.append(copy);
    open.title = "Show delivery reports for this Gmail";
    main.append(checkbox, badge);
    line.append(main, open);
  } else if (recordTab) {
    const open = button("analyse-open send-log-open", "");
    open.append(copy);
    open.title = "Show the send record for this Gmail";
    main.append(checkbox, badge);
    line.append(main, open);
  } else {
    main.append(checkbox, badge, copy);
    line.append(main);
  }
  const status = el("div", "account-status");
  const today = el("span", "today-sent", todaySentLabel(pref.key));
  const sent = el("span", "campaign-sent", "");
  today.hidden = analyseTab;
  sent.hidden = analyseTab;
  status.hidden = analyseTab;
  status.append(today, sent);
  const hideAccount = button("linkish hide-gmail", "Hide");
  hideAccount.title = "Hide this Gmail from the list. It stays signed in.";
  line.append(status, renderStatusSelect(account.email), hideAccount);

  const tools = el("div", "account-tools");
  const senderLabel = el("label", "", "First name");
  const sender = document.createElement("input");
  sender.type = "text";
  sender.className = "sender";
  sender.value = senderFor(pref, account);
  sender.placeholder = "First name";
  senderLabel.append(sender);
  const limitLabel = el("label", "", "Max");
  const limit = document.createElement("input");
  limit.type = "number";
  limit.min = "1";
  limit.className = "limit";
  const tabLimit = LIMIT_TABS.includes(currentTab())
    ? limitForTab(pref, currentTab(), state.settings.defaultLimit || 20)
    : (positiveLimit(pref.limit) || positiveLimit(state.settings.defaultLimit) || 20);
  limit.value = String(tabLimit);
  limit.title = "Max emails";
  limitLabel.append(limit);
  const cvLine = el("div", "cv-line");
  const pick = button("secondary pick-cv", "CV");
  pick.title = "Choose the CV for this email address";
  cvLine.append(pick);
  cvLine.append(el("span", "cv-name", pref.cvName || "No CV"));
  const remove = button("linkish remove-cv", "Remove");
  remove.hidden = !pref.cvPath;
  cvLine.append(remove);
  const contactLine = el("div", "contact-line");
  const importList = button("secondary import-contacts-account", "Import list");
  importList.title = "Import a contact list for this Gmail. Without one, it sends the shared list.";
  contactLine.append(importList);
  const contactName = el("span", "contact-name", contactLabel(pref));
  const contactCount = Array.isArray(pref.contacts) ? pref.contacts.length : 0;
  contactName.title = contactCount
    ? pref.contacts.slice(0, 3).map((item) => item.email).join(", ")
    : "This Gmail sends the shared contact list.";
  contactLine.append(contactName);
  const clearList = button("linkish clear-contacts-account", "Clear");
  clearList.hidden = contactCount === 0;
  contactLine.append(clearList);
  const scheduleLine = el("label", "schedule-line");
  const scheduleBox = document.createElement("input");
  scheduleBox.type = "checkbox";
  scheduleBox.className = "use-send-time";
  scheduleBox.checked = Boolean(pref.scheduleSend);
  scheduleBox.title = "Show a send time for this Gmail. The time is required.";
  const sendAt = document.createElement("input");
  sendAt.type = "datetime-local";
  sendAt.className = "send-at";
  sendAt.value = toDatetimeLocal(pref.sendAt);
  sendAt.hidden = !scheduleBox.checked;
  sendAt.title = "Required while Send at a time is checked. This Gmail waits until then, and its controls lock while sending.";
  scheduleLine.append(scheduleBox, document.createTextNode("Send at a time"), sendAt);
  const followupLine = el("label", "followup-date-line");
  followupLine.append(document.createTextNode("Sent date"));
  const followupDate = document.createElement("input");
  followupDate.type = "date";
  followupDate.className = "followup-date";
  followupDate.value = pref.followupDate || "";
  followupDate.title = "Optional. Overrides the Follow-up tab date for this Gmail.";
  followupLine.append(followupDate);
  const mention = el("label", "mention-line");
  const mentionBox = document.createElement("input");
  mentionBox.type = "checkbox";
  mentionBox.className = "mention-attachment";
  mentionBox.checked = pref.mentionAttachment !== false;
  mention.append(mentionBox, document.createTextNode("Mention the attached resume"));
  const alert = el("p", "cv-alert", "Attach a CV. This Gmail says the resume is attached.");
  alert.hidden = true;
  const followupTab = currentTab() === "followup";
  const extrasHidden = hidesAccountExtras();
  followupLine.hidden = !followupTab;
  senderLabel.hidden = analyseTab;
  limitLabel.hidden = analyseTab || currentTab() === "peer";
  cvLine.hidden = extrasHidden;
  contactLine.hidden = extrasHidden;
  scheduleLine.hidden = extrasHidden;
  mention.hidden = extrasHidden;
  alert.hidden = true;
  tools.hidden = analyseTab;
  tools.append(senderLabel, limitLabel, cvLine, contactLine, scheduleLine, followupLine, mention, alert);
  row.append(line, tools);
  paintResumeAlert(row);
  return row;
}

function firstPersonalName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (!name) return "";
  return name.split(" ")[0].slice(0, 80);
}

function senderNameKey(email, name) {
  const mail = String(email || "").trim().toLowerCase();
  const first = firstPersonalName(name);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || !first || first.includes("@")) return "";
  return `${mail}-${first}`;
}

function storedSenderName(email, detectedName) {
  const book = state.senderNames || {};
  const exact = book[senderNameKey(email, detectedName)];
  if (exact) return exact;
  const mail = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return "";
  const matches = Object.entries(book).filter(([key]) => key.startsWith(`${mail}-`));
  return matches.length === 1 ? matches[0][1] : "";
}

function senderFor(pref, account) {
  const saved = String(pref.senderName || "").trim();
  const full = String(account.name || "").trim();
  const stored = storedSenderName(account.email, full || saved);
  if (stored) return stored;
  const first = firstPersonalName(full);
  if (!saved || (full && saved.toLowerCase() === full.toLowerCase())) return first;
  return saved;
}

function jobHoldLabel(kind) {
  if (kind === "peer-warmup") return "Gmail warm-up";
  if (kind === "warmup") return "Business warm-up";
  if (kind === "followup") return "Follow-up";
  if (kind === "analyse") return "Analyse";
  if (kind === "campaign") return "Contacts";
  return "another job";
}

function profilesBusyElsewhere() {
  const holders = new Map();
  for (const kind of ["campaign", "warmup", "peer-warmup", "followup", "analyse"]) {
    for (const campaign of jobsOfKind(kind)) {
      const status = String(campaign?.status || "");
      if (!["running", "scheduled", "paused", "error"].includes(status)) continue;
      for (const account of campaign.accounts || []) {
        const id = String(account?.envId || "");
        if (id && !holders.has(id)) holders.set(id, campaign.kind || kind);
      }
    }
  }
  return holders;
}

function profileBlocked(envId) {
  return profilesBusyElsewhere().has(String(envId || ""));
}

function profileBlockTitle(envId) {
  const kind = profilesBusyElsewhere().get(String(envId || ""));
  return kind ? `This profile is in ${jobHoldLabel(kind)}.` : "";
}

function peerLockSignature() {
  return [...profilesBusyElsewhere().keys()].sort().join("|");
}

function currentTab() {
  if (state.tab === "peer" || state.tab === "contacts" || state.tab === "followup" || state.tab === "analyse") return state.tab;
  return "warmup";
}

function hidesAccountExtras() {
  const tab = currentTab();
  return tab === "warmup" || tab === "peer" || tab === "followup" || tab === "analyse";
}

function tabName(tab = currentTab()) {
  if (tab === "peer") return "Gmail";
  if (tab === "followup") return "Follow-up";
  if (tab === "analyse") return "Analyse";
  if (tab === "contacts") return "Contacts";
  return "Business";
}

const LIMIT_TABS = ["warmup", "contacts", "followup", "analyse"];

function positiveLimit(value) {
  const number = Number.parseInt(value, 10);
  return number >= 1 ? number : 0;
}

function limitBook(pref, fallback) {
  const legacy = positiveLimit(pref?.limit);
  const base = legacy || positiveLimit(fallback) || 20;
  const saved = pref?.limitByTab && typeof pref.limitByTab === "object" ? pref.limitByTab : {};
  const book = {};
  for (const tab of LIMIT_TABS) book[tab] = positiveLimit(saved[tab]) || base;
  return book;
}

function limitForTab(pref, tab, fallback) {
  if (!LIMIT_TABS.includes(tab)) return positiveLimit(fallback) || 20;
  return limitBook(pref, fallback)[tab];
}

function toolbarLimit(tab = currentTab()) {
  const fallback = positiveLimit(state.settings.defaultLimit) || 20;
  if (!LIMIT_TABS.includes(tab)) return fallback;
  const book = state.settings.limitByTab;
  return (book && positiveLimit(book[tab])) || fallback;
}

function syncLimitChrome() {
  const peer = currentTab() === "peer";
  const label = document.getElementById("default-limit-label");
  const button = document.getElementById("apply-limit");
  if (label) label.hidden = peer;
  if (button) button.hidden = peer;
  const input = document.getElementById("default-limit");
  if (input && !peer && document.activeElement !== input) input.value = String(toolbarLimit());
}

function selectionMap(saved) {
  const prior = saved?.selectedByTab && typeof saved.selectedByTab === "object" ? saved.selectedByTab : null;
  const fallback = Boolean(saved?.selected);
  const value = (tab) => (prior && Object.prototype.hasOwnProperty.call(prior, tab) ? Boolean(prior[tab]) : fallback);
  return {
    warmup: value("warmup"),
    peer: value("peer"),
    contacts: value("contacts"),
    followup: value("followup"),
    analyse: value("analyse"),
  };
}

function cvEmailKey(email) {
  const mail = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) ? mail : "";
}

function cvRecord(account, saved) {
  const email = cvEmailKey(account?.email || saved?.email);
  const book = state.cvs && typeof state.cvs === "object" ? state.cvs : {};
  const stored = email ? book[email] : null;
  if (stored?.cvPath) return { cvPath: stored.cvPath, cvName: stored.cvName || "" };
  const slotEmail = cvEmailKey(saved?.email);
  const slotPath = String(saved?.cvPath || "").trim();
  if (!slotPath || (slotEmail && email && slotEmail !== email)) return { cvPath: "", cvName: "" };
  return { cvPath: slotPath, cvName: String(saved?.cvName || "").trim() };
}

function writeCvForEmail(email, cvPath, cvName) {
  const key = cvEmailKey(email);
  if (!key) return;
  const file = String(cvPath || "").trim();
  const name = file ? String(cvName || "").trim() : "";
  if (!state.cvs || typeof state.cvs !== "object") state.cvs = {};
  if (file) state.cvs[key] = { cvPath: file, cvName: name };
  else delete state.cvs[key];
  for (const pref of Object.values(state.prefs || {})) {
    if (!pref || cvEmailKey(pref.email) !== key) continue;
    pref.cvPath = file;
    pref.cvName = name;
  }
  document.querySelectorAll(".gmail-row").forEach((row) => {
    if (cvEmailKey(row.dataset.email) !== key) return;
    row.dataset.cvPath = file;
    row.dataset.cvName = name;
    const label = row.querySelector(".cv-name");
    if (label) label.textContent = name || "No CV";
    const remove = row.querySelector(".remove-cv");
    if (remove) remove.hidden = !file;
    paintResumeAlert(row);
  });
}

function prefFor(profile, account) {
  const key = `${profile.envId}:${account.index}`;
  const saved = state.prefs[key] || {};
  const fallback = state.prefs[`${profile.envId}:0`] || {};
  const own = Boolean(state.prefs[key]);
  const selectionSource = own ? saved : (account.index === 0 ? fallback : null);
  const cv = cvRecord(account, saved);
  return {
    key,
    selected: selectionSource ? selectionMap(selectionSource)[currentTab()] : false,
    selectedByTab: selectionMap(selectionSource || {}),
    senderName: own ? (saved.senderName || "") : (account.index === 0 ? (fallback.senderName || "") : ""),
    limit: limitForTab(own ? saved : fallback, currentTab(), state.settings.defaultLimit || 20),
    limitByTab: limitBook(own ? saved : fallback, state.settings.defaultLimit || 20),
    cvPath: cv.cvPath,
    cvName: cv.cvName,
    mentionAttachment: (own ? saved.mentionAttachment : fallback.mentionAttachment) !== false,
    contacts: Array.isArray(saved.contacts) ? saved.contacts : [],
    contactFileName: saved.contactFileName || "",
    scheduleSend: own
      ? (Object.prototype.hasOwnProperty.call(saved, "scheduleSend") ? Boolean(saved.scheduleSend) : Number(saved.sendAt) > 0)
      : false,
    sendAt: Number(saved.sendAt) || 0,
    followupDate: own ? String(saved.followupDate || "").trim() : (account.index === 0 ? String(fallback.followupDate || "").trim() : ""),
    email: saved.email || account.email || "",
    hidden: own ? Boolean(saved.hidden) : false,
  };
}

function contactLabel(pref) {
  const count = Array.isArray(pref?.contacts) ? pref.contacts.length : 0;
  if (!count) return "Uses shared list";
  const noun = count === 1 ? "contact" : "contacts";
  const file = pref.contactFileName ? `${pref.contactFileName} · ` : "";
  return `${file}${count} ${noun}`;
}

function paintAccountContacts(row) {
  const pref = state.prefs[row.dataset.accountKey] || {};
  const count = Array.isArray(pref.contacts) ? pref.contacts.length : 0;
  const name = row.querySelector(".contact-name");
  if (name) {
    name.textContent = contactLabel(pref);
    name.title = count
      ? pref.contacts.slice(0, 3).map((item) => item.email).join(", ")
      : "This Gmail sends the shared contact list.";
  }
  const clear = row.querySelector(".clear-contacts-account");
  if (clear) clear.hidden = count === 0;
}

function parseLocalDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const time = new Date(text).getTime();
  return Number.isFinite(time) ? time : 0;
}

function toDatetimeLocal(ms) {
  const date = new Date(Number(ms));
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return "";
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const STATUS_ORDER = ["Active", "Warming up", "Paused", "Blocked"];

function statusFor(email) {
  return state.gmailStatus[String(email || "").trim().toLowerCase()] || "";
}

function statusChoices(map) {
  const found = new Set(Object.values(map || {}).map((status) => String(status || "").trim()).filter(Boolean));
  const ordered = STATUS_ORDER.filter((status) => found.has(status));
  const extra = [...found].filter((status) => !STATUS_ORDER.includes(status)).sort((a, b) => a.localeCompare(b));
  return [...ordered, ...extra];
}

function statusClass(status) {
  const key = String(status || "").toLowerCase();
  if (key === "active") return "is-active-status";
  if (key === "warming up") return "is-warming";
  if (key === "paused") return "is-paused";
  if (key === "blocked") return "is-blocked";
  return "";
}

function paintStatusSelect(select) {
  select.classList.remove("is-active-status", "is-warming", "is-paused", "is-blocked");
  const extra = statusClass(select.value);
  if (extra) select.classList.add(extra);
}

function renderStatusSelect(email) {
  const select = document.createElement("select");
  select.className = "status-select";
  select.title = "Status for this Gmail. This choice is kept when you reopen the app.";
  const current = statusFor(email);
  const choices = [...STATUS_ORDER];
  statusChoices(state.gmailStatus).forEach((status) => {
    if (!choices.includes(status)) choices.push(status);
  });
  if (current && !choices.includes(current)) choices.push(current);
  select.append(new Option("No status", ""));
  choices.forEach((status) => select.append(new Option(status, status)));
  select.value = current;
  select.disabled = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
  paintStatusSelect(select);
  return select;
}

function fillStatusPick() {
  const select = document.getElementById("status-pick");
  if (!select) return;
  const choices = statusChoices(state.gmailStatus);
  select.replaceChildren(new Option("Choose", ""));
  choices.forEach((status) => select.append(new Option(status, status)));
  select.value = "";
}

function revealGmailRow(row) {
  const card = row.closest(".profile-node");
  const branch = row.closest(".gmail-branch");
  if (branch) branch.hidden = false;
  if (card) {
    card.classList.add("is-open");
    if (card.dataset.node) treeOpen.set(card.dataset.node, true);
  }
  let node = row.parentElement;
  while (node) {
    if (node.tagName === "DETAILS") {
      node.open = true;
      if (node.dataset.node) treeOpen.set(node.dataset.node, true);
    }
    node = node.parentElement;
  }
}

function selectByStatus(status) {
  let count = 0;
  document.querySelectorAll(".profile-node").forEach((card) => {
    card.querySelectorAll(".gmail-row").forEach((row) => {
      const email = (row.dataset.email || "").trim().toLowerCase();
      const match = Boolean(email) && state.gmailStatus[email] === status;
      const box = row.querySelector(".account-select");
      box.checked = match;
      row.classList.toggle("is-selected", match);
      if (match) {
        count += 1;
        revealGmailRow(row);
      }
      rememberRow(row);
    });
    syncProfileCheckbox(card);
  });
  document.getElementById("status-pick").value = "";
  refreshSelectionChrome();
  const noun = count === 1 ? "Gmail account" : "Gmail accounts";
  showStatus(
    count ? `Selected ${count} ${noun} marked ${status} for ${tabName()}.` : `No Gmail accounts are marked ${status}.`,
    count ? "success" : "error"
  );
}

function onProfileEdit(event) {
  if (event.target.classList.contains("status-select")) {
    if (event.type !== "change") return;
    const row = event.target.closest(".gmail-row");
    if (!row) return;
    const email = (row.dataset.email || "").trim().toLowerCase();
    const status = event.target.value;
    if (email) {
      if (status) state.gmailStatus[email] = status;
      else delete state.gmailStatus[email];
    }
    paintStatusSelect(event.target);
    fillStatusPick();
    if (api && email) {
      api.saveGmailStatus({ email, status }).then((result) => {
        if (!result?.ok) {
          showStatus(result?.error || "Could not save that status.", "error");
          return;
        }
        if (result.gmailStatus) state.gmailStatus = result.gmailStatus;
      }).catch((error) => showStatus(error.message, "error"));
    }
    return;
  }
  if (event.target.classList.contains("profile-select")) {
    if (event.target.dataset.peerBusy === "1") return;
    const node = event.target.closest(".profile-node");
    node.querySelectorAll(".gmail-row").forEach((row) => {
      if (row.dataset.peerBusy === "1") return;
      const box = row.querySelector(".account-select");
      box.checked = event.target.checked;
      row.classList.toggle("is-selected", event.target.checked);
      rememberRow(row);
    });
    event.target.indeterminate = false;
    refreshSelectionChrome();
    return;
  }
  const row = event.target.closest(".gmail-row");
  if (!row) return;
  if (event.target.classList.contains("account-select")) {
    if (row.dataset.peerBusy === "1") return;
    row.classList.toggle("is-selected", event.target.checked);
    syncProfileCheckbox(row.closest(".profile-node"));
  }
  if (event.target.classList.contains("mention-attachment")) paintResumeAlert(row);
  if (event.target.classList.contains("use-send-time")) {
    const field = row.querySelector(".send-at");
    if (field) field.hidden = !event.target.checked;
  }
  rememberRow(row);
  if (event.target.classList.contains("account-select") || event.target.classList.contains("mention-attachment")) {
    refreshSelectionChrome();
  }
}

function syncProfileCheckbox(node) {
  if (!node) return;
  const boxes = [...node.querySelectorAll(".account-select")];
  const selected = boxes.filter((box) => box.checked).length;
  const master = node.querySelector(".profile-select");
  if (!master) return;
  master.checked = boxes.length > 0 && selected === boxes.length;
  master.indeterminate = selected > 0 && selected < boxes.length;
}

function onProfileClick(event) {
  const control = event.target.closest("button");
  if (!control) return;
  if (control.classList.contains("analyse-open") && !control.classList.contains("send-log-open")) {
    event.preventDefault();
    event.stopPropagation();
    openAnalyseResult(control.closest(".gmail-row"));
    return;
  }
  if (control.classList.contains("send-log-open")) {
    event.preventDefault();
    event.stopPropagation();
    openSendLog(control.closest(".gmail-row"));
    return;
  }
  if (control.classList.contains("hide-profile") || control.classList.contains("show-profile") || control.classList.contains("hide-gmail") || control.classList.contains("show-gmail")) {
    event.preventDefault();
    event.stopPropagation();
    if (control.classList.contains("hide-profile")) hideProfile(control.dataset.envId);
    else if (control.classList.contains("show-profile")) restoreProfile(control.dataset.envId);
    else if (control.classList.contains("hide-gmail")) hideGmail(control.closest(".gmail-row"));
    else showGmail(control.dataset.accountKey);
    return;
  }
  const row = control.closest(".gmail-row");
  if (!row) return;
  if (control.classList.contains("pick-cv")) pickCv(row);
  if (control.classList.contains("remove-cv")) removeCv(row);
  if (control.classList.contains("import-contacts-account")) importAccountContacts(row);
  if (control.classList.contains("clear-contacts-account")) clearAccountContacts(row);
}

function hideGmail(row) {
  if (!row) return;
  const who = row.dataset.email || "this Gmail";
  if (!confirm(`Hide ${who} from this list?\n\nIt stays signed in. Show it again under Hidden Gmail accounts.`)) return;
  const box = row.querySelector(".account-select");
  if (box) box.checked = false;
  row.dataset.hidden = "1";
  const saved = readRow(row);
  saved.hidden = true;
  saved.selected = false;
  saved.selectedByTab = { warmup: false, peer: false, contacts: false, followup: false, analyse: false };
  state.prefs[saved.key] = saved;
  schedulePrefsSave();
  renderProfiles();
}

function showGmail(key) {
  const accountKey = String(key || "");
  if (!accountKey) return;
  const prior = state.prefs[accountKey] || {};
  state.prefs[accountKey] = { ...prior, key: accountKey, hidden: false };
  schedulePrefsSave();
  renderProfiles();
}

async function hideProfile(envId) {
  const profile = state.profiles.find((item) => item.envId === envId);
  const name = profile?.envName || "this profile";
  const where = profile?.source === "chrome" ? "Chrome" : "MoreLogin";
  if (!confirm(`Hide "${name}" from this list?\n\nIt stays in ${where}. Show it again under Hidden in this app.`)) return;
  if (!api) {
    state.profiles = state.profiles.filter((item) => item.envId !== envId);
    if (profile) state.hiddenProfiles = [...state.hiddenProfiles, profile];
    renderProfiles();
    return;
  }
  state.busy = "hide";
  syncButtons();
  try {
    const result = await api.hideProfiles([envId]);
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    if (result.profiles) state.profiles = result.profiles;
    if (result.hiddenProfiles) state.hiddenProfiles = result.hiddenProfiles;
    renderProfiles();
    showStatus(result.message, "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

async function restoreProfile(envId) {
  if (!api) {
    const profile = state.hiddenProfiles.find((item) => item.envId === envId);
    state.hiddenProfiles = state.hiddenProfiles.filter((item) => item.envId !== envId);
    if (profile) state.profiles = [...state.profiles, profile];
    renderProfiles();
    return;
  }
  state.busy = "restore";
  syncButtons();
  try {
    const result = await api.restoreProfiles([envId]);
    if (!result.ok) {
      showStatus(result.error, "error");
      return;
    }
    if (result.profiles) state.profiles = result.profiles;
    if (result.hiddenProfiles) state.hiddenProfiles = result.hiddenProfiles;
    renderProfiles();
    showStatus(result.message, "success");
  } finally {
    state.busy = "";
    syncButtons();
  }
}

function rememberRow(row) {
  const account = readRow(row);
  state.prefs[account.key] = account;
  const key = senderNameKey(account.email, account.senderName);
  if (key) {
    const prefix = `${String(account.email || "").trim().toLowerCase()}-`;
    const next = {};
    for (const [item, value] of Object.entries(state.senderNames || {})) {
      if (!item.startsWith(prefix)) next[item] = value;
    }
    next[key] = firstPersonalName(account.senderName);
    state.senderNames = next;
  }
  schedulePrefsSave();
  refreshStartButton();
}

function readRow(row) {
  const key = row.dataset.accountKey;
  const prior = state.prefs[key] || {};
  const blocked = row.dataset.peerBusy === "1";
  const selected = blocked
    ? Boolean(selectionMap(prior)[currentTab()])
    : Boolean(row.querySelector(".account-select").checked);
  const tab = currentTab();
  const selectedByTab = { ...selectionMap(prior), [tab]: selected };
  const limitPrior = state.prefs[key] || state.prefs[`${row.dataset.envId}:0`] || {};
  const limitByTab = limitBook(limitPrior, state.settings.defaultLimit || 20);
  let limit = positiveLimit(prior.limit) || limitByTab.contacts;
  let limitTab = "";
  if (LIMIT_TABS.includes(tab)) {
    const parsed = positiveLimit(row.querySelector(".limit")?.value);
    if (parsed) limitByTab[tab] = parsed;
    limit = limitByTab[tab];
    limitTab = tab;
  }
  return {
    key,
    envId: row.dataset.envId,
    envName: row.dataset.envName,
    gmailIndex: Number(row.dataset.gmailIndex) || 0,
    email: row.dataset.email || prior.email || "",
    selected,
    selectedByTab,
    senderName: row.querySelector(".sender").value,
    limit,
    limitTab,
    limitByTab,
    cvPath: row.dataset.cvPath || "",
    cvName: row.dataset.cvName || "",
    mentionAttachment: Boolean(row.querySelector(".mention-attachment")?.checked),
    scheduleSend: Boolean(row.querySelector(".use-send-time")?.checked),
    sendAt: parseLocalDateTime(row.querySelector(".send-at")?.value),
    followupDate: String(row.querySelector(".followup-date")?.value || "").trim(),
    hidden: row.dataset.hidden === "1" || Boolean(prior.hidden),
    contacts: Array.isArray(prior.contacts) ? prior.contacts : [],
    contactFileName: prior.contactFileName || "",
  };
}

function collectAccounts() {
  return [...document.querySelectorAll(".gmail-row")].map(readRow);
}

function selectedEnvIds() {
  return [...new Set(collectAccounts().filter((account) => account.selected).map((account) => account.envId))];
}

function schedulePrefsSave() {
  if (!api) return;
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    api.savePrefs(prefsForSave(state.prefs)).then((result) => {
      if (result?.cvs && typeof result.cvs === "object") state.cvs = result.cvs;
    }).catch((error) => showStatus(error.message, "error"));
  }, 250);
}

function prefsForSave(prefs) {
  const next = {};
  for (const [key, value] of Object.entries(prefs || {})) {
    if (!value || typeof value !== "object") continue;
    const rest = { ...value };
    delete rest.contacts;
    delete rest.contactFileName;
    next[key] = rest;
  }
  return next;
}

async function pickCv(row) {
  const result = await api.pickCv();
  if (!result || result.canceled) return;
  if (!result.ok) {
    showStatus(result.error, "error");
    return;
  }
  writeCvForEmail(row.dataset.email, result.path, result.name);
  row.dataset.cvPath = result.path;
  row.dataset.cvName = result.name;
  row.querySelector(".cv-name").textContent = result.name;
  row.querySelector(".remove-cv").hidden = false;
  paintResumeAlert(row);
  rememberRow(row);
}

function removeCv(row) {
  writeCvForEmail(row.dataset.email, "", "");
  row.dataset.cvPath = "";
  row.dataset.cvName = "";
  row.querySelector(".cv-name").textContent = "No CV";
  row.querySelector(".remove-cv").hidden = true;
  paintResumeAlert(row);
  rememberRow(row);
}

function setAllSelected(selected) {
  document.querySelectorAll(".profile-node").forEach((card) => {
    if (card.hidden) return;
    card.querySelectorAll(".gmail-row").forEach((row) => {
      if (row.hidden || row.dataset.peerBusy === "1") return;
      const box = row.querySelector(".account-select");
      box.checked = selected;
      row.classList.toggle("is-selected", selected);
      rememberRow(row);
    });
    syncProfileCheckbox(card);
  });
  refreshSelectionChrome();
}

function applyLimit() {
  if (!LIMIT_TABS.includes(currentTab())) return;
  const value = Number.parseInt(document.getElementById("default-limit").value, 10);
  if (!(value >= 1)) {
    showStatus("Max emails must be at least 1.", "error");
    return;
  }
  document.querySelectorAll(".limit").forEach((input) => {
    input.value = String(value);
  });
  document.querySelectorAll(".gmail-row").forEach(rememberRow);
  saveSettingsFromForm();
}

function paintResumeAlert(row) {
  if (hidesAccountExtras()) {
    row.classList.remove("needs-cv");
    const alert = row.querySelector(".cv-alert");
    if (alert) alert.hidden = true;
    return;
  }
  const sentenceOn = Boolean(row.querySelector(".mention-attachment")?.checked);
  const needsCv = sentenceOn && !row.dataset.cvPath;
  row.classList.toggle("needs-cv", needsCv);
  const alert = row.querySelector(".cv-alert");
  if (alert) alert.hidden = !needsCv;
}

function selectedAccountCount() {
  return [...document.querySelectorAll("#profile-list .account-select")].filter((box) => box.checked).length;
}

function updateSelectedSummary() {
  const count = selectedAccountCount();
  const profiles = profilesForSource();
  const hiddenCount = hiddenForSource().length;
  const open = profiles.filter((profile) => profile.running).length;
  const line = document.getElementById("profile-count");
  if (!profiles.length && !hiddenCount) {
    line.textContent = count ? `${count} selected` : "";
    return;
  }
  const shown = `${profiles.length} shown${hiddenCount ? `, ${hiddenCount} hidden` : ""}, ${open} open`;
  line.textContent = `${count} selected · ${shown}`;
}

function syncShowSelectedButton() {
  const button = document.getElementById("show-selected");
  if (!button) return;
  button.setAttribute("aria-pressed", state.selectedOnly ? "true" : "false");
  button.textContent = state.selectedOnly ? "Show all" : "Show selected";
}

function toggleSelectedOnly() {
  state.selectedOnly = !state.selectedOnly;
  syncShowSelectedButton();
  applySearch();
}

function setProfileExpanded(node, open) {
  node.classList.toggle("is-open", open);
  const branch = node.querySelector(".gmail-branch");
  if (branch) branch.hidden = !open;
  const twisty = node.querySelector(".twisty-btn");
  if (twisty) {
    const name = (twisty.getAttribute("aria-label") || "").replace(/^(Collapse|Expand)\s+/, "") || "profile";
    twisty.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${name}`);
  }
  if (node.dataset.node) treeOpen.set(node.dataset.node, open);
}

function setAllTreeExpanded(open) {
  document.querySelectorAll("#profile-list .tree-group:not(.hidden-group)").forEach((group) => {
    group.open = open;
    if (group.dataset.node) treeOpen.set(group.dataset.node, open);
  });
  document.querySelectorAll("#profile-list .profile-node").forEach((node) => setProfileExpanded(node, open));
}

function revealCard(card) {
  setProfileExpanded(card, true);
}

function cardMatchesFilter(card, query) {
  let visibleRows = 0;
  card.querySelectorAll(".gmail-row").forEach((row) => {
    const show = !state.selectedOnly || Boolean(row.querySelector(".account-select")?.checked);
    row.hidden = !show;
    if (show) visibleRows += 1;
  });
  const textMatch = !query || (card.dataset.search || "").includes(query);
  return textMatch && (!state.selectedOnly || visibleRows > 0);
}

function refreshSelectionChrome() {
  updateSelectedSummary();
  applySearch();
}

function applySearch() {
  const query = document.getElementById("profile-search").value.trim().toLowerCase();
  const filtering = Boolean(query) || state.selectedOnly;
  let visible = 0;
  let hiddenMatches = 0;
  document.querySelectorAll("#profile-list > .profile-node").forEach((card) => {
    const match = cardMatchesFilter(card, query);
    card.hidden = !match;
    if (!match) return;
    visible += 1;
    if (filtering) revealCard(card);
  });
  document.querySelectorAll(".tree-group").forEach((group) => {
    if (group.classList.contains("hidden-group")) {
      if (state.selectedOnly) {
        group.hidden = true;
        return;
      }
      let hiddenVisible = 0;
      group.querySelectorAll(".hidden-row").forEach((row) => {
        const match = !query || (row.dataset.search || "").includes(query);
        row.hidden = !match;
        if (match) hiddenVisible += 1;
      });
      hiddenMatches += query ? hiddenVisible : 0;
      group.hidden = Boolean(query) && hiddenVisible === 0;
      if (query && hiddenVisible) group.open = true;
      return;
    }
    let groupVisible = 0;
    group.querySelectorAll(".profile-node").forEach((card) => {
      const match = cardMatchesFilter(card, query);
      card.hidden = !match;
      if (match) {
        groupVisible += 1;
        visible += 1;
        if (filtering) revealCard(card);
      }
    });
    group.hidden = filtering && groupVisible === 0;
    if (filtering && groupVisible) group.open = true;
  });
  const searchable = profilesForSource().length + hiddenForSource().length;
  const empty = document.getElementById("search-empty");
  empty.hidden = !filtering || visible + hiddenMatches > 0 || !searchable;
  empty.textContent = state.selectedOnly && !query
    ? "No selected Gmail accounts."
    : "No profiles match that search.";
}

function localDayKey(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function todaySentCount(key) {
  const book = state.sentToday;
  if (!book || book.day !== localDayKey() || !book.counts) return 0;
  return Math.max(0, Number(book.counts[key]) || 0);
}

function showsSendRecord() {
  const tab = currentTab();
  return tab === "warmup" || tab === "peer" || tab === "followup" || tab === "contacts";
}

function sendLogKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return text.toLowerCase();
  return text;
}

function formatLogDay(key) {
  const match = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(key || "");
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function recordKeys(email, accountKey) {
  const keys = [];
  const seen = new Set();
  for (const key of [sendLogKey(email), sendLogKey(accountKey)]) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function warmupRecordFor(email, accountKey) {
  const book = state.sendLog?.warmup || {};
  let sent = 0;
  let replies = 0;
  for (const key of recordKeys(email, accountKey)) {
    const row = book[key];
    if (!row || typeof row !== "object") continue;
    sent += Math.max(0, Number(row.sent) || 0);
    replies += Math.max(0, Number(row.replies) || 0);
  }
  return { sent, replies };
}

function followupRowsFor(email, accountKey) {
  const book = state.sendLog?.followup || {};
  const merged = {};
  for (const key of recordKeys(email, accountKey)) {
    const rows = book[key];
    if (!rows || typeof rows !== "object") continue;
    for (const [id, count] of Object.entries(rows)) {
      const amount = Math.max(0, Number(count) || 0);
      if (amount) merged[id] = (merged[id] || 0) + amount;
    }
  }
  return Object.entries(merged)
    .map(([id, count]) => {
      const [selected, sent] = String(id).split("|");
      return { selected: selected || "", sent: sent || "", count };
    })
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.sent))
    .sort((a, b) => (a.sent < b.sent ? 1 : a.sent > b.sent ? -1 : (a.selected < b.selected ? 1 : -1)));
}

function contactRowsFor(email, accountKey) {
  const book = state.sendLog?.contacts || {};
  const merged = {};
  for (const key of recordKeys(email, accountKey)) {
    const days = book[key];
    if (!days || typeof days !== "object") continue;
    for (const [day, count] of Object.entries(days)) {
      const amount = Math.max(0, Number(count) || 0);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && amount) merged[day] = (merged[day] || 0) + amount;
    }
  }
  return Object.entries(merged).sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

function countLine(label, value) {
  const line = el("div", "analyse-count");
  line.append(el("span", "", label), el("span", "", value));
  return line;
}

let sendLogModal = null;

function openSendLog(row) {
  if (!row || !showsSendRecord()) return;
  sendLogModal = {
    email: String(row.dataset.email || "").trim(),
    accountKey: String(row.dataset.accountKey || ""),
  };
  document.getElementById("send-log-modal").hidden = false;
  renderSendLogModal();
}

function closeSendLogModal() {
  sendLogModal = null;
  const modal = document.getElementById("send-log-modal");
  if (modal) modal.hidden = true;
}

function renderSendLogModal() {
  const modal = document.getElementById("send-log-modal");
  if (!modal || modal.hidden || !sendLogModal) return;
  if (!showsSendRecord()) {
    closeSendLogModal();
    return;
  }
  const email = sendLogModal.email;
  const accountKey = sendLogModal.accountKey;
  document.getElementById("send-log-modal-title").textContent = email || "Gmail";
  const note = document.getElementById("send-log-modal-note");
  note.hidden = true;
  const body = document.getElementById("send-log-modal-body");
  body.replaceChildren();

  const warm = warmupRecordFor(email, accountKey);
  const warmSection = el("section", "send-record-section");
  warmSection.append(el("h3", "", "Warm up"));
  const warmList = el("div", "analyse-counts");
  warmList.append(countLine("total sent", String(warm.sent)), countLine("total reply", String(warm.replies)));
  warmSection.append(warmList);
  body.append(warmSection);

  const followSection = el("section", "send-record-section");
  followSection.append(el("h3", "", "Follow up"));
  const followRows = followupRowsFor(email, accountKey);
  if (!followRows.length) {
    followSection.append(el("p", "help", "No follow-ups recorded yet."));
  } else {
    const table = el("div", "send-record-table cols-3");
    ["Selected date", "Send date", "Emails"].forEach((header) => table.append(el("span", "send-record-head", header)));
    followRows.forEach((row) => {
      table.append(
        el("span", "", row.selected ? formatLogDay(row.selected) : "—"),
        el("span", "", formatLogDay(row.sent)),
        el("span", "send-record-count", String(row.count)),
      );
    });
    followSection.append(table);
  }
  body.append(followSection);

  const contactSection = el("section", "send-record-section");
  contactSection.append(el("h3", "", "Contacts"));
  const contactRows = contactRowsFor(email, accountKey);
  if (!contactRows.length) {
    contactSection.append(el("p", "help", "No contact emails recorded yet."));
  } else {
    const table = el("div", "send-record-table cols-2");
    ["Send date", "Emails"].forEach((header) => table.append(el("span", "send-record-head", header)));
    contactRows.forEach(([day, count]) => {
      table.append(el("span", "", formatLogDay(day)), el("span", "send-record-count", String(count)));
    });
    contactSection.append(table);
  }
  body.append(contactSection);
}

function todaySentLabel(key) {
  return `Today sent : ${todaySentCount(key)}`;
}

function paintGmailStatuses() {
  document.querySelectorAll(".gmail-row").forEach((row) => {
    const select = row.querySelector(".status-select");
    if (!select) return;
    const current = statusFor(row.dataset.email);
    if (current && ![...select.options].some((option) => option.value === current)) {
      select.append(new Option(current, current));
    }
    if (select.value !== current) select.value = current;
    paintStatusSelect(select);
  });
  fillStatusPick();
}

function paintTodaySent() {
  document.querySelectorAll(".gmail-row").forEach((row) => {
    const node = row.querySelector(".today-sent");
    if (node) node.textContent = todaySentLabel(row.dataset.accountKey);
  });
}

function applyCampaignToCards() {
  const jobs = jobsOfKind(tabKind()).filter((campaign) => (
    campaign && ["running", "scheduled", "paused", "error", "done"].includes(campaign.status)
  ));
  document.querySelectorAll(".gmail-row").forEach((row) => {
    row.classList.remove("is-active", "is-done", "is-held");
    const sent = row.querySelector(".campaign-sent");
    const matches = [];
    for (const campaign of jobs) {
      const match = campaign.accounts?.find((account) => account.key === row.dataset.accountKey);
      if (match) matches.push(match);
    }
    if (sent) {
      const totalSent = matches.reduce((sum, match) => sum + (Number(match.sent) || 0), 0);
      if (tabKind() === "peer-warmup") {
        sent.textContent = matches.length ? `Sent ${totalSent}` : "";
      } else {
        const totalLimit = matches.reduce((sum, match) => sum + (Number(match.limit) || 0), 0);
        sent.textContent = matches.length ? `Sent ${totalSent} / ${totalLimit}` : "";
      }
    }
    if (!matches.length) return;
    if (matches.some((match) => match.active)) row.classList.add("is-active");
    if (matches.every((match) => match.done)) row.classList.add("is-done");
    if (matches.some((match) => Number(match.sendAt) > 0) && jobs.some((campaign) => campaign.status === "running" || campaign.status === "scheduled")) {
      row.classList.add("is-held");
    }
  });
}

function campaignKindLabel(campaign) {
  if (campaign?.kind === "followup") return "Follow-up";
  if (campaign?.kind === "analyse") return "Analyse";
  if (campaign?.kind === "peer-warmup") return "Gmail warm-up";
  if (campaign?.kind === "warmup") return "Business warm-up";
  return "Sending";
}

function accountLines(account) {
  if (!account) return [];
  const email = String(account.email || "").trim();
  const name = String(account.envName || "").trim();
  const fallback = email || (account.gmailIndex != null ? `Gmail ${account.gmailIndex}` : "");
  if (name && fallback && name !== fallback) return [name, fallback];
  return [name || fallback].filter(Boolean);
}

function progressSummary(campaign) {
  if (!campaign) return { title: "", lines: [] };
  const account = campaign.accounts?.[campaign.accountCursor];
  const who = accountLines(account).join(" · ");
  const warmup = campaign.kind === "warmup";
  const peer = campaign.kind === "peer-warmup";
  const followup = campaign.kind === "followup";
  const analyse = campaign.kind === "analyse";
  const sent = peer
    ? `${campaign.sentTotal || 0} warm-up emails sent`
    : followup
      ? `${campaign.sentTotal || 0} of ${campaign.total || 0} follow-up emails sent`
      : analyse
        ? `${campaign.sentTotal || 0} sent emails opened`
        : warmup
          ? `${campaign.sentTotal || 0} of ${campaign.total || 0} warm-up emails sent`
          : `${campaign.sentTotal || 0} of ${campaign.total || 0} sent`;
  const extra = peer
    ? `${campaign.replyTotal || 0} replies`
    : analyse
      ? `${campaign.foundTotal || 0} delivery reports`
      : "";
  const toLine = campaign.currentRecipient ? `To ${campaign.currentRecipient}` : "";
  const join = (...parts) => parts.map((part) => String(part || "").trim()).filter(Boolean).join(" · ");
  const pair = (title, detail) => ({ title, lines: detail ? [detail] : [] });
  if (campaign.status === "scheduled") {
    return pair(join(`${campaignKindLabel(campaign)}: waiting to start`, who), `Starts in ${formatDuration((campaign.startTime || 0) - Date.now())}`);
  }
  if (campaign.status === "running" && campaign.phase === "waiting") {
    return pair(
      join(campaignKindLabel(campaign), who),
      join(`Next step in ${formatDuration((campaign.waitUntil || 0) - Date.now())}`, toLine, sent, extra),
    );
  }
  if (campaign.status === "running") {
    const peerReply = peer && (campaign.stage === "replying" || campaign.phase === "replying");
    const title = peerReply ? `${campaignKindLabel(campaign)}: replying` : campaignKindLabel(campaign);
    return pair(join(title, who), join(toLine, sent, extra));
  }
  if (campaign.status === "paused") {
    return pair(join(`${campaignKindLabel(campaign)} paused`, who), join(sent, extra, "Progress saved."));
  }
  if (campaign.status === "error") {
    return pair(join(`${campaignKindLabel(campaign)} needs attention`, who), join(campaign.lastError || "Gmail needs attention.", sent, extra));
  }
  if (campaign.status === "stopped") {
    return pair(join(`${campaignKindLabel(campaign)} stopped`, who), join(sent, extra));
  }
  if (campaign.status === "done") {
    return pair(join(`${campaignKindLabel(campaign)} finished`, who), join(sent, extra));
  }
  return pair(campaignKindLabel(campaign), join(sent, extra));
}

const JOBS = [
  { tab: "warmup", kind: "warmup", idle: "Warm up one business inbox" },
  { tab: "peer", kind: "peer-warmup", idle: "Warm up between your Gmail accounts" },
  { tab: "followup", kind: "followup", idle: "Reply to mail you already sent" },
  { tab: "analyse", kind: "analyse", idle: "Read delivery reports in sent mail" },
  { tab: "contacts", kind: "campaign", idle: "Send to client lists" },
];

function jobVisualState(campaign) {
  if (!campaign?.status || campaign.status === "idle") return "idle";
  if (campaign.status === "scheduled") return "scheduled";
  if (campaign.status === "running" && campaign.phase === "waiting") return "waiting";
  if (campaign.status === "running") return "running";
  if (campaign.status === "paused") return "paused";
  if (campaign.status === "error") return "error";
  if (campaign.status === "done") return "done";
  if (campaign.status === "stopped") return "stopped";
  return "idle";
}

function jobStateLabel(mode) {
  if (mode === "scheduled") return "Scheduled";
  if (mode === "waiting") return "Waiting";
  if (mode === "running") return "Running";
  if (mode === "paused") return "Paused";
  if (mode === "error") return "Error";
  if (mode === "done") return "Done";
  if (mode === "stopped") return "Stopped";
  return "Ready";
}

function jobCountText(campaign) {
  if (campaign?.kind === "peer-warmup") {
    const replies = campaign.replyTotal || 0;
    return `${campaign.sentTotal || 0} sent, ${replies} ${replies === 1 ? "reply" : "replies"}`;
  }
  if (campaign?.kind === "analyse") {
    const found = campaign.foundTotal || 0;
    return `${campaign.sentTotal || 0} opened, ${found} ${found === 1 ? "report" : "reports"}`;
  }
  return `${campaign?.sentTotal || 0} of ${campaign?.total || 0}`;
}

function jobCardDetail(campaign, idleText) {
  const mode = jobVisualState(campaign);
  if (mode === "idle") return idleText;
  const account = campaign.accounts?.[campaign.accountCursor];
  const who = accountLines(account);
  const sent = jobCountText(campaign);
  const to = campaign.currentRecipient ? `To ${campaign.currentRecipient}` : "";
  const join = (...parts) => parts.map((part) => String(part || "").trim()).filter(Boolean).join("\n");
  if (mode === "scheduled") return `Starts in ${formatDuration((campaign.startTime || 0) - Date.now())}`;
  if (mode === "waiting") return join(...who, `Next in ${formatDuration((campaign.waitUntil || 0) - Date.now())}`);
  if (mode === "running") return join(...who, to, sent);
  if (mode === "error") return campaign.lastError || "Needs attention";
  if (mode === "done") return join("Finished", sent);
  return sent;
}

function renderJobs() {
  for (const job of JOBS) {
    const list = jobsOfKind(job.kind);
    const live = list.filter((campaign) => isActiveStatus(campaign.status) || isPausedStatus(campaign.status));
    const campaign = pickPrimary(list);
    const mode = live.length > 1 ? "running" : jobVisualState(campaign);
    const detail = live.length > 1 ? `${live.length} jobs running` : jobCardDetail(campaign, job.idle);
    const card = document.getElementById(`job-${job.tab}`);
    const pip = document.querySelector(`#tab-${job.tab} .tab-pip`);
    if (card) {
      card.dataset.state = mode;
      card.classList.toggle("is-current", state.tab === job.tab);
      card.setAttribute("aria-pressed", state.tab === job.tab ? "true" : "false");
      card.title = detail;
      const stateNode = card.querySelector(".job-state");
      const detailNode = card.querySelector(".job-detail");
      if (stateNode) stateNode.textContent = jobStateLabel(mode);
      if (detailNode) detailNode.textContent = detail;
    }
    if (pip) {
      pip.dataset.state = mode;
      pip.hidden = mode === "idle";
    }
  }
}

function progressGapSeconds(campaign) {
  return Math.max(0, Math.round((Number(campaign?.betweenAccountMs) || 0) / 1000));
}

function betweenAccountLabel(seconds) {
  const value = Math.round(Number(seconds));
  if (!(value >= 10)) return "At least 10 sec";
  if (value < 60) return `${value} sec`;
  return gapLabel(value, true);
}

function showsProgressGap(campaign) {
  return Boolean(campaign)
    && (campaign.kind === "campaign" || !campaign.kind)
    && (isActiveStatus(campaign.status) || isPausedStatus(campaign.status));
}

function progressIntervalSeconds(campaign) {
  return Math.max(0, Math.round((Number(campaign?.intervalMs) || 0) / 1000));
}

function intervalControlLabel(kind) {
  if (kind === "followup") return "Seconds between Gmail accounts";
  if (kind === "warmup" || kind === "peer-warmup") return "Seconds between warm-up emails";
  return "Seconds between emails";
}

function intervalFieldId(kind) {
  if (kind === "warmup") return "warmup-interval";
  if (kind === "peer-warmup") return "peer-interval";
  if (kind === "followup") return "followup-interval";
  return "interval-time";
}

function showsProgressInterval(campaign) {
  const kind = campaign?.kind || "campaign";
  return ["campaign", "warmup", "peer-warmup", "followup"].includes(kind)
    && (isActiveStatus(campaign.status) || isPausedStatus(campaign.status));
}

function progressRowKey(campaign) {
  const marks = [];
  if (showsProgressInterval(campaign)) marks.push("interval");
  if (showsProgressGap(campaign)) marks.push("gap");
  return `${campaign.id}:${campaign.status}:${marks.join("+")}`;
}

async function commitProgressInterval(input) {
  const seconds = Math.round(Number(input.value));
  const kind = input.dataset.jobKind || "campaign";
  const minimum = kind === "followup" ? 10 : 3;
  if (!(seconds >= minimum) || seconds > 86400) {
    showStatus(kind === "followup"
      ? "Seconds between Gmail accounts must be between 10 and 86400."
      : "Seconds must be between 3 and 86400.", "error");
    return;
  }
  input.value = String(seconds);
  const hint = input.parentElement?.querySelector(".progress-gap-hint");
  if (hint) hint.textContent = gapLabel(seconds);
  if (input.dataset.saved === String(seconds)) return;
  const field = document.getElementById(intervalFieldId(kind));
  if (!api) {
    if (kind === "warmup") state.warmup.intervalSeconds = seconds;
    else if (kind === "peer-warmup") state.warmup.peerIntervalSeconds = seconds;
    else if (kind === "followup") state.followup.intervalSeconds = seconds;
    else state.settings.intervalSeconds = seconds;
    for (const campaign of jobsOfKind(kind)) {
      if (String(campaign.id) === String(input.dataset.campaignId)) campaign.intervalMs = seconds * 1000;
    }
    if (field) field.value = String(seconds);
    input.dataset.saved = String(seconds);
    renderProgress();
    return;
  }
  const result = await api.setJobInterval({ id: input.dataset.campaignId, seconds });
  if (!result?.ok) {
    showStatus(result?.error || "Could not change the seconds.", "error");
    return;
  }
  input.dataset.saved = String(seconds);
  if (result.warmup) state.warmup = result.warmup;
  if (result.followup) state.followup = result.followup;
  rememberCampaigns(result.campaigns, result.campaign, kind);
  if (field) field.value = String(seconds);
  renderProgress();
}

function progressIntervalControl(campaign) {
  const kind = campaign.kind || "campaign";
  const seconds = progressIntervalSeconds(campaign);
  const title = intervalControlLabel(kind);
  const label = el("label", "progress-gap");
  label.append(document.createTextNode(title));
  const input = document.createElement("input");
  input.type = "number";
  input.min = kind === "followup" ? "10" : "3";
  input.max = "86400";
  input.className = "progress-interval-input";
  input.dataset.campaignId = String(campaign.id || "");
  input.dataset.jobKind = kind;
  input.setAttribute("aria-label", title);
  const previous = document.activeElement;
  const editing = previous
    && previous.classList.contains("progress-interval-input")
    && previous.dataset.campaignId === input.dataset.campaignId;
  input.value = editing ? previous.value : String(seconds);
  input.dataset.saved = String(seconds);
  const hint = el("span", "progress-gap-hint", gapLabel(editing ? input.value : seconds));
  input.addEventListener("input", () => {
    hint.textContent = gapLabel(input.value);
  });
  input.addEventListener("change", () => commitProgressInterval(input));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
  });
  label.append(input, hint);
  return { label, input, editing };
}

async function commitProgressGap(input) {
  const seconds = Math.round(Number(input.value));
  if (!(seconds >= 10) || seconds > 86400) {
    showStatus("Seconds between Gmail accounts must be between 10 and 86400.", "error");
    return;
  }
  input.value = String(seconds);
  const hint = input.parentElement?.querySelector(".progress-gap-hint");
  if (hint) hint.textContent = betweenAccountLabel(seconds);
  if (input.dataset.saved === String(seconds)) return;
  const field = document.getElementById("between-accounts");
  if (!api) {
    state.settings.betweenAccountSeconds = seconds;
    for (const campaign of jobsOfKind("campaign")) {
      if (String(campaign.id) === String(input.dataset.campaignId)) campaign.betweenAccountMs = seconds * 1000;
    }
    if (field) field.value = String(seconds);
    input.dataset.saved = String(seconds);
    renderProgress();
    return;
  }
  const result = await api.setBetweenAccounts({ id: input.dataset.campaignId, seconds });
  if (!result?.ok) {
    showStatus(result?.error || "Could not change the time between Gmail accounts.", "error");
    return;
  }
  input.dataset.saved = String(seconds);
  if (result.settings) state.settings = result.settings;
  if (field) field.value = String(state.settings.betweenAccountSeconds ?? seconds);
  rememberCampaigns(result.campaigns, result.campaign, "campaign");
  renderProgress();
}

function progressGapControl(campaign) {
  const seconds = progressGapSeconds(campaign);
  const label = el("label", "progress-gap");
  label.append(document.createTextNode("Seconds between Gmail accounts"));
  const input = document.createElement("input");
  input.type = "number";
  input.min = "10";
  input.max = "86400";
  input.className = "progress-gap-input";
  input.dataset.campaignId = String(campaign.id || "");
  input.setAttribute("aria-label", "Seconds between Gmail accounts");
  const previous = document.activeElement;
  const editing = previous
    && previous.classList.contains("progress-gap-input")
    && previous.dataset.campaignId === input.dataset.campaignId;
  input.value = editing ? previous.value : String(seconds);
  input.dataset.saved = String(seconds);
  const hint = el("span", "progress-gap-hint", betweenAccountLabel(editing ? input.value : seconds));
  input.addEventListener("input", () => {
    hint.textContent = betweenAccountLabel(input.value);
  });
  input.addEventListener("change", () => commitProgressGap(input));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
  });
  label.append(input, hint);
  return { label, input, editing };
}

function renderProgress() {
  clearInterval(progressTimer);
  const jobs = jobsOfKind(tabKind()).filter((campaign) => campaign && campaign.status && campaign.status !== "idle");
  const live = jobs.filter((campaign) => isActiveStatus(campaign.status) || isPausedStatus(campaign.status));
  const shown = live.length ? live : jobs.slice(-1);
  const panel = document.getElementById("progress");
  const paint = () => {
    renderJobs();
    const currentJobs = jobsOfKind(tabKind()).filter((campaign) => campaign && campaign.status && campaign.status !== "idle");
    const currentLive = currentJobs.filter((campaign) => isActiveStatus(campaign.status) || isPausedStatus(campaign.status));
    const rows = currentLive.length ? currentLive : currentJobs.slice(-1);
    if (!rows.length) {
      panel.hidden = true;
      panel.replaceChildren();
      panel.dataset.key = "";
      return;
    }
    panel.hidden = false;
    const key = rows.map((campaign) => progressRowKey(campaign)).join("|");
    if (panel.dataset.key === key && panel.childElementCount === rows.length) {
      rows.forEach((campaign, index) => {
        const summary = progressSummary(campaign);
        const row = panel.children[index];
        const title = row.querySelector(".progress-title");
        const details = [...row.querySelectorAll(".progress-detail")];
        const lines = summary.lines || [];
        if (details.length !== lines.length) {
          panel.dataset.key = "";
          return;
        }
        if (title) title.textContent = summary.title;
        lines.forEach((line, lineIndex) => {
          details[lineIndex].textContent = line;
        });
        const intervalInput = row.querySelector(".progress-interval-input");
        if (intervalInput && document.activeElement !== intervalInput) {
          const seconds = progressIntervalSeconds(campaign);
          intervalInput.value = String(seconds);
          intervalInput.dataset.saved = String(seconds);
          const hint = intervalInput.parentElement?.querySelector(".progress-gap-hint");
          if (hint) hint.textContent = gapLabel(seconds);
        }
        const input = row.querySelector(".progress-gap-input");
        if (input && document.activeElement !== input) {
          const seconds = progressGapSeconds(campaign);
          input.value = String(seconds);
          input.dataset.saved = String(seconds);
          const hint = input.parentElement?.querySelector(".progress-gap-hint");
          if (hint) hint.textContent = betweenAccountLabel(seconds);
        }
      });
      if (panel.dataset.key === key) return;
    }
    panel.dataset.key = key;
    panel.replaceChildren();
    let focusInput = null;
    for (const campaign of rows) {
      const summary = progressSummary(campaign);
      const row = el("div", "progress-job");
      const copy = el("div", "progress-copy");
      copy.append(el("div", "progress-title", summary.title));
      for (const line of summary.lines || []) copy.append(el("div", "progress-detail", line));
      row.append(copy);
      const actions = el("div", "progress-actions");
      if (isActiveStatus(campaign.status)) {
        const pause = button("secondary", "Pause");
        pause.addEventListener("click", () => pauseCampaign(campaign.id));
        const stop = button("secondary", "Stop");
        stop.addEventListener("click", () => stopCampaign(campaign.id));
        actions.append(pause, stop);
      } else if (isPausedStatus(campaign.status)) {
        const resume = button("", "Resume");
        resume.addEventListener("click", () => resumeCampaign(campaign.id));
        const stop = button("secondary", "Stop");
        stop.addEventListener("click", () => stopCampaign(campaign.id));
        actions.append(resume, stop);
      }
      if (showsProgressInterval(campaign)) {
        const interval = progressIntervalControl(campaign);
        actions.append(interval.label);
        if (interval.editing) focusInput = interval.input;
      }
      if (showsProgressGap(campaign)) {
        const gap = progressGapControl(campaign);
        actions.append(gap.label);
        if (gap.editing) focusInput = gap.input;
      }
      if (actions.childElementCount) row.append(actions);
      panel.append(row);
    }
    if (focusInput) focusInput.focus();
  };
  paint();
  if (live.length || shown.some((campaign) => campaign.status === "scheduled" || (campaign.status === "running" && campaign.phase === "waiting"))) {
    progressTimer = setInterval(paint, 1000);
  }
}

function accountLabel(account) {
  if (!account) return "the next profile";
  const who = account.email || `Gmail ${account.gmailIndex}`;
  return `${account.envName} (${who})`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function appendLog(line) {
  if (!line) return;
  const key = `${line.at}|${line.message}`;
  if (seenLogs.has(key)) return;
  seenLogs.add(key);
  const item = el("li", `log-line ${line.level || "info"}`);
  item.append(el("time", "", new Date(line.at).toLocaleTimeString()), document.createTextNode(line.message));
  const log = document.getElementById("log");
  log.append(item);
  while (log.children.length > 200) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function showTab(name) {
  state.tab = name === "contacts" || name === "peer" || name === "followup" || name === "analyse" ? name : "warmup";
  document.body.dataset.tab = state.tab;
  document.getElementById("pane-warmup").hidden = state.tab !== "warmup";
  document.getElementById("pane-peer").hidden = state.tab !== "peer";
  document.getElementById("pane-followup").hidden = state.tab !== "followup";
  document.getElementById("pane-analyse").hidden = state.tab !== "analyse";
  document.getElementById("pane-contacts").hidden = state.tab !== "contacts";
  document.getElementById("tab-warmup").setAttribute("aria-selected", state.tab === "warmup" ? "true" : "false");
  document.getElementById("tab-peer").setAttribute("aria-selected", state.tab === "peer" ? "true" : "false");
  document.getElementById("tab-followup").setAttribute("aria-selected", state.tab === "followup" ? "true" : "false");
  document.getElementById("tab-analyse").setAttribute("aria-selected", state.tab === "analyse" ? "true" : "false");
  document.getElementById("tab-contacts").setAttribute("aria-selected", state.tab === "contacts" ? "true" : "false");
  renderProfiles();
  applyCampaignToCards(campaignForTab());
  renderProgress();
  syncButtons();
  if (!showsSendRecord()) closeSendLogModal();
  else renderSendLogModal();
}

function isCampaignRunning() {
  return ["campaign", "warmup", "peer-warmup", "followup", "analyse"].some((kind) => (
    jobsOfKind(kind).some((campaign) => isActiveStatus(campaign.status))
  ));
}

function tabJobBusy(tab = state.tab) {
  const own = campaignForTab(tab);
  return isActiveStatus(own?.status) || isPausedStatus(own?.status);
}

function syncButtons() {
  const ownJobs = jobsOfKind(tabKind());
  const running = ownJobs.some((campaign) => isActiveStatus(campaign.status));
  const paused = ownJobs.some((campaign) => isPausedStatus(campaign.status));
  const anyRunning = isCampaignRunning();
  const noApi = !api;
  const busy = Boolean(state.busy);
  const locked = busy;
  const peerLive = jobsOfKind("peer-warmup").some((campaign) => isActiveStatus(campaign.status) || isPausedStatus(campaign.status));
  ["refresh", "open-selected", "read-gmail"].forEach((id) => {
    document.getElementById(id).disabled = noApi || locked || anyRunning;
  });
  ["import-contacts", "clear-contacts"].forEach((id) => {
    document.getElementById(id).disabled = noApi || locked;
  });
  ["select-all", "clear-all", "apply-limit"].forEach((id) => {
    document.getElementById(id).disabled = noApi || locked;
  });
  syncLimitChrome();
  ["source-morelogin", "source-chrome"].forEach((id) => {
    document.getElementById(id).disabled = locked || anyRunning;
  });
  ["api-base", "api-token"].forEach((id) => {
    document.getElementById(id).disabled = noApi || locked || anyRunning;
  });
  const kind = tabKind();
  const jobName = kind === "followup"
    ? "follow-up"
    : kind === "analyse"
      ? "analyse"
      : kind === "peer-warmup"
        ? "Gmail warm-up"
        : kind === "warmup"
          ? "business warm-up"
          : "sending";
  const pauseButton = document.getElementById("pause");
  const stopButton = document.getElementById("stop");
  const resumeButton = document.getElementById("resume");
  pauseButton.textContent = "Pause";
  stopButton.textContent = "Stop";
  resumeButton.textContent = "Resume";
  pauseButton.title = `Pause ${jobName}`;
  stopButton.title = `Stop ${jobName}`;
  resumeButton.title = `Resume ${jobName}`;
  pauseButton.setAttribute("aria-label", pauseButton.title);
  stopButton.setAttribute("aria-label", stopButton.title);
  resumeButton.setAttribute("aria-label", resumeButton.title);
  document.getElementById("start").hidden = state.tab !== "contacts";
  document.getElementById("warmup-start").hidden = state.tab !== "warmup";
  document.getElementById("peer-warmup-start").hidden = state.tab !== "peer";
  document.getElementById("followup-start").hidden = state.tab !== "followup";
  document.getElementById("analyse-start").hidden = state.tab !== "analyse";
  document.getElementById("peer-clear-connections").hidden = state.tab !== "peer";
  document.getElementById("peer-clear-connections").disabled = noApi || peerLive;
  document.getElementById("pause").hidden = !running;
  document.getElementById("stop").hidden = !(running || paused);
  document.getElementById("resume").hidden = !paused;
  document.getElementById("status-pick").disabled = noApi || busy;
  ["email-language", "interval-time", "between-accounts", "mention-attachment", "default-limit"].forEach((id) => {
    document.getElementById(id).disabled = noApi || locked;
  });
  if (document.getElementById("use-custom-templates").checked) {
    document.getElementById("email-language").disabled = true;
  }
  ["use-custom-replies", "use-custom-followups", "custom-followup-input", "custom-followup-add", "custom-followup-import", "custom-followup-sample"].forEach((id) => {
    document.getElementById(id).disabled = locked;
  });
  setTemplateControlsDisabled(Boolean(api) && locked);
  ["warmup-interval", "warmup-mention-attachment", "warmup-email", "warmup-company", "warmup-client"].forEach((id) => {
    document.getElementById(id).disabled = noApi || locked;
  });
  ["peer-interval", "peer-periods", "warmup-plan-start", "warmup-plan-step", "warmup-plan-cap", "use-custom-warmup-index", "warmup-index"].forEach((id) => {
    document.getElementById(id).disabled = noApi || locked;
  });
  ["custom-reply-input", "custom-reply-add", "custom-reply-import", "custom-reply-sample"].forEach((id) => {
    document.getElementById(id).disabled = locked;
  });
  document.querySelectorAll("[data-reply-index], [data-followup-index]").forEach((node) => {
    node.disabled = locked;
  });
  ["followup-interval", "followup-body", "followup-date", "followup-step1-days", "followup-step2-days", "followup-step1-body", "followup-step2-body"].forEach((id) => {
    document.getElementById(id).disabled = noApi || locked;
  });
  ["analyse-from", "analyse-to", "analyse-limit"].forEach((id) => {
    document.getElementById(id).disabled = noApi || locked;
  });
  if (peerLockSignature() !== state.peerLockKey) renderProfiles();
  setRowsLocked(locked);
  renderWarmupList();
  refreshStartButton();
}

function setRowsLocked(locked) {
  const freeze = Boolean(locked) && tabJobBusy();
  const hold = Boolean(state.busy);
  const peerBusy = profilesBusyElsewhere();
  document.querySelectorAll(".gmail-row").forEach((row) => {
    const held = peerBusy.has(String(row.dataset.envId || ""));
    row.dataset.peerBusy = held ? "1" : "";
    row.classList.toggle("is-peer-busy", held);
    const timed = Boolean(row.querySelector(".use-send-time")?.checked);
    const selected = Boolean(row.querySelector(".account-select")?.checked);
    const disable = hold || held || (freeze && (selected || timed));
    if (held) {
      const box = row.querySelector(".account-select");
      if (box) {
        box.checked = false;
        box.title = profileBlockTitle(row.dataset.envId);
      }
      row.classList.remove("is-selected");
    }
    row.classList.toggle("is-held", Boolean(freeze && timed));
    row.querySelectorAll("input, button").forEach((node) => {
      if (node.classList.contains("analyse-open") || node.classList.contains("send-log-open")) return;
      if (node.classList.contains("hide-gmail")) {
        node.disabled = hold || isCampaignRunning();
        return;
      }
      if (node.classList.contains("status-select")) {
        const email = (row.dataset.email || "").trim();
        node.disabled = disable || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        return;
      }
      node.disabled = disable;
    });
  });
  document.querySelectorAll(".profile-select").forEach((node) => {
    const envId = String(node.closest(".profile-node")?.dataset.node || "").replace(/^profile:/, "");
    const held = peerBusy.has(envId);
    const profile = node.closest(".profile-node");
    if (profile) profile.classList.toggle("is-peer-busy", held);
    node.dataset.peerBusy = held ? "1" : "";
    if (held) {
      node.checked = false;
      node.indeterminate = false;
      node.title = profileBlockTitle(envId);
    }
    node.disabled = hold || freeze || held || node.dataset.empty === "1";
  });
  document.querySelectorAll(".hide-profile, .show-profile, .show-gmail").forEach((node) => {
    node.disabled = hold || isCampaignRunning();
  });
}

function gapLabel(seconds, allowZero) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "";
  if (allowZero && !(value >= 10)) return "At least 10 sec";
  if (!allowZero && value < 3) return "At least 3 sec";
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts = [];
  if (hours) parts.push(hours === 1 ? "1 hour" : `${hours} hours`);
  if (minutes) parts.push(`${minutes} min`);
  if (secs && hours === 0) parts.push(`${secs} sec`);
  return parts.join(" ");
}

function dayLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return "";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function paintTimeHints() {
  [
    ["warmup-interval", false],
    ["peer-interval", false],
    ["followup-interval", false],
    ["interval-time", false],
    ["between-accounts", true],
  ].forEach(([id, allowZero]) => {
    const hint = document.getElementById(`${id}-hint`);
    const input = document.getElementById(id);
    if (hint && input) hint.textContent = gapLabel(input.value, allowZero);
  });
}

function paintActionNote(selected) {
  const note = document.getElementById("action-note");
  if (!note) return;
  const count = selected.length;
  const gmails = count === 1 ? "1 Gmail" : `${count} Gmails`;
  if (state.tab === "analyse") {
    if (!count) {
      note.textContent = "Check the Gmail accounts to analyse.";
      return;
    }
    const from = dayLabel(document.getElementById("analyse-from").value);
    const to = dayLabel(document.getElementById("analyse-to").value) || from;
    const limit = Number(document.getElementById("analyse-limit").value) || 40;
    const when = from && to && from !== to ? `${from} to ${to}` : (from || "the dates you choose");
    note.textContent = `${gmails} · sent ${when} · open up to ${limit} each.`;
    return;
  }
  if (state.tab === "followup") {
    if (!count) {
      note.textContent = "Check the Gmail accounts that should follow up.";
      return;
    }
    const wait = gapLabel(document.getElementById("followup-interval").value, false);
    const day = dayLabel(document.getElementById("followup-date").value);
    note.textContent = day
      ? `${gmails} · sent on ${day} · ${wait} after each reply. An empty search skips that Gmail.`
      : `${gmails} · ${wait} after each reply. Set a sent date here, or on a Gmail row. An empty search skips that Gmail.`;
    return;
  }
  if (state.tab === "contacts") {
    if (!count) {
      note.textContent = "Check the Gmail accounts that should email clients.";
      return;
    }
    const people = state.contacts.length;
    const list = people ? `${people} shared contact${people === 1 ? "" : "s"} · ` : "No shared list · ";
    const wait = gapLabel(document.getElementById("interval-time").value, false);
    note.textContent = `${gmails} · ${list}${wait} between emails from the same Gmail.`;
    return;
  }
  if (state.tab === "peer") {
    if (count < 2) {
      note.textContent = "Check at least two Gmail accounts.";
      return;
    }
    const periods = Number(document.getElementById("peer-periods").value) || 1;
    const rounds = periods === 1 ? "1 period" : `${periods} periods`;
    const wait = gapLabel(document.getElementById("peer-interval").value, false);
    note.textContent = `${gmails} email each other · ${rounds} · ${wait} between messages.`;
    return;
  }
  const business = selectedWarmupBusiness();
  const who = business?.email || "the business you select";
  if (!count) {
    note.textContent = `Check the Gmail accounts that should email ${who}.`;
    return;
  }
  const wait = gapLabel(document.getElementById("warmup-interval").value, false);
  note.textContent = count === 1
    ? `1 Gmail sends one email to ${who} · ${wait} apart.`
    : `${gmails} each send one email to ${who} · ${wait} apart.`;
}

function refreshStartButton() {
  paintTimeHints();
  const busyProfiles = profilesBusyElsewhere();
  const selected = collectAccounts().filter((account) => account.selected && !busyProfiles.has(String(account.envId)));
  const namesReady = selected.length > 0 && selected.every((account) => account.senderName.trim() && account.limit >= 1);
  const timesReady = selected.every((account) => !account.scheduleSend || account.sendAt > 0);
  const covered = namesReady && (state.contacts.length > 0 || selected.every((account) => {
    const list = state.prefs[account.key]?.contacts;
    return Array.isArray(list) && list.length > 0;
  }));
  const apiReady = Boolean(api) && !state.busy;
  const contactsIdle = apiReady;
  const warmupIdle = apiReady;
  const peerIdle = apiReady;
  const followupIdle = apiReady;
  const analyseIdle = apiReady;
  const emailInterval = Number(document.getElementById("interval-time").value);
  const betweenAccounts = Number(document.getElementById("between-accounts").value);
  const templatesReady = customTemplatesReady();
  document.getElementById("start").disabled = !(templatesReady && contactsIdle && namesReady && timesReady && covered && emailInterval >= 3 && emailInterval <= 86400 && betweenAccounts >= 10 && betweenAccounts <= 86400);
  const warmupInterval = Number(document.getElementById("warmup-interval").value);
  const peerInterval = Number(document.getElementById("peer-interval").value);
  const peerPeriods = Number(document.getElementById("peer-periods").value);
  const selectedBusiness = selectedWarmupBusiness();
  const listReady = Boolean(selectedBusiness)
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(selectedBusiness.email || "").trim())
    && String(selectedBusiness.firstName || "").trim()
    && String(selectedBusiness.company || "").trim();
  const warmupReady = templatesReady
    && warmupIdle
    && listReady
    && namesReady
    && warmupInterval >= 3
    && warmupInterval <= 86400;
  document.getElementById("warmup-start").disabled = !warmupReady;
  const peerAccounts = selected.filter((account) => account.senderName.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email));
  const repliesReady = !document.getElementById("use-custom-replies").checked || templateList("customReplies").length > 0;
  const indexOn = document.getElementById("use-custom-warmup-index").checked;
  const indexReady = !indexOn || Boolean(String(document.getElementById("warmup-index").value || "").trim());
  const peerReady = templatesReady && repliesReady && indexReady && peerIdle && peerAccounts.length >= 2 && peerInterval >= 3 && peerInterval <= 86400 && peerPeriods >= 1 && peerPeriods <= 30;
  document.getElementById("peer-warmup-start").disabled = !peerReady;
  const followupInterval = Number(document.getElementById("followup-interval").value);
  const followupBody = String(document.getElementById("followup-body").value || "").trim();
  const followupCustom = document.getElementById("use-custom-followups").checked;
  const followupTextReady = followupCustom ? templateList("customFollowups").length > 0 : Boolean(followupBody);
  const followupDate = String(document.getElementById("followup-date").value || "").trim();
  const followupDateOk = /^\d{4}-\d{2}-\d{2}$/.test(followupDate);
  const followupAccounts = selected.filter((account) => (
    account.senderName.trim()
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email)
    && account.limit >= 1
    && (/^\d{4}-\d{2}-\d{2}$/.test(String(account.followupDate || "").trim()) || followupDateOk)
  ));
  const followupReady = followupIdle
    && followupAccounts.length > 0
    && followupAccounts.length === selected.length
    && followupTextReady
    && followupInterval >= 10
    && followupInterval <= 86400;
  document.getElementById("followup-start").disabled = !followupReady;
  const sequenceAccounts = selected.filter((account) => (
    account.senderName.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email)
  ));
  document.getElementById("followup-sequence").disabled = !(followupIdle && sequenceAccounts.length > 0 && followupTextReady && followupInterval >= 10 && followupInterval <= 86400);
  document.getElementById("warmup-plan-apply").disabled = !(peerIdle && peerAccounts.length >= 1);
  document.getElementById("warmup-plan-run").disabled = !peerReady;
  const analyseFrom = String(document.getElementById("analyse-from").value || "").trim();
  const analyseTo = String(document.getElementById("analyse-to").value || "").trim() || analyseFrom;
  const analyseLimit = Number(document.getElementById("analyse-limit").value);
  const analyseDateOk = /^\d{4}-\d{2}-\d{2}$/.test(analyseFrom) && /^\d{4}-\d{2}-\d{2}$/.test(analyseTo) && analyseTo >= analyseFrom;
  const analyseAccounts = selected.filter((account) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email));
  const analyseReady = analyseIdle && analyseAccounts.length > 0 && analyseDateOk && analyseLimit >= 1 && analyseLimit <= 200;
  document.getElementById("analyse-start").disabled = !analyseReady;
  paintActionNote(selected);
  paintPeerConnections();
}

function showBanner(message) {
  const banner = document.getElementById("banner");
  banner.hidden = false;
  banner.textContent = message;
}

function setConnection(text, ok) {
  const node = document.getElementById("connection-status");
  node.textContent = text;
  node.classList.toggle("is-ok", Boolean(ok));
  node.classList.toggle("is-error", !ok);
}

function showStatus(message, type) {
  const status = document.getElementById("status");
  status.textContent = message || "";
  status.className = message ? `status ${type || ""}` : "status";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(className, text) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  return node;
}
