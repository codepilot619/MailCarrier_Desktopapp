const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { applyPlaceholders, personalizeEmail, emailContentByLanguage, withoutAttachSentences, normalizeTemplateList, parseTemplateFileText } = require("../../shared/email-content");
const {
  CampaignHub,
  CampaignRunner,
  campaignView,
  createCampaign,
  createAnalyseCampaign,
  createFollowupCampaign,
  createPeerWarmupCampaign,
  createWarmupCampaign,
  nextAccountCursor,
  activeJobProfiles,
  profilesBusyExcept,
  nextDueIndex,
  sendTimesFromAnchor,
  splitAccountKey,
  validateCampaignInput,
  validateAnalyseInput,
  validateFollowupInput,
  validateWarmupInput,
  applyBetweenAccountGap,
  applyJobInterval,
  gmailGapWaitMs,
  interruptibleSleep,
} = require("../lib/campaign");
const { mapContactRows, parseContactFile } = require("../lib/contacts");
const { analyseSentQuery, mergeSavedAnalysis, parseDeliveryReport } = require("../lib/analyse");
const { applyFollowupTemplate, followupSentQuery, normalizeFollowupDay } = require("../lib/followup");
const { addConnection, nextPeer, peerIntro, peerReply, repliesForMailbox, validatePeerWarmupInput, warmupMarkerFrom } = require("../lib/peer-warmup");
const { sampleTemplateFiles } = require("../lib/template-samples");
const { accountsFromListPayloads, accountsFromListRows, attachAccountNames, atomMailboxFromFeed, clickComposeButtonInPage, combineDetectedMailboxes, MAILBOX_PROBE_LIMIT, feedProbeSettled, mailboxesFromFeeds, probeAllInPage, signedInMailboxes, mailboxesFromHints, mergeMailboxAccounts, withKnownIndex, composeButtonPointInPage, composeOpenPlan, expandCollapsedComposeInPage, exactReplyQuery, exactThreadPointInPage, firstPersonalName, mailboxNameKey, followupOpenPointInPage, followupResultsAlreadyOpen, followupRowIdentity, followupSearchSettledInPage, followupSearchSnapshotInPage, followupThreadListInPage, openFollowupThreadHashInPage, gmailAccountIndex, inboxNavigationPlan, inboxReady, isLoginUrl, mailboxMatches, nameFromAccountLabel, notSpamClearedInPage, openComposeRouteInPage, openedMessageCountInPage, openedMessagesFromMailboxInPage, threadHasDraftInPage, discardOpenDraftInPage, confirmDiscardDraftInPage, expandCollapsedDraftInPage, readInspectedComposeInPage, writeInspectedComposeInPage, openedSubjectMatchesInPage, pickAccountName, plainFromHtml, reportNotSpamPointInPage, replySendPointInPage, searchHasResultInPage, searchScopeReadyInPage, gmailSearchUrl, warmupSearchQuery, warmupSearchToken, warmupThreadListInPage } = require("../lib/gmail");
const {
  MoreLoginClient,
  mergeProfileLists,
  normalizeBaseUrl,
  normalizeProfile,
  parseMoreLoginJson,
  postJson,
} = require("../lib/morelogin");
const { exportUrlFromSheetLink, fetchSheetText, loadStatusFromUrl, loadStatusMap, mergeGmailStatus, statusesFromCsv, statusesFromFile } = require("../lib/sheet-status");
const { Store, businessesFromInput, cvForEmail, cvsFromPrefs, followupRecord, localDayKey, mergeAccountPref, recordDailySend, recordKindSend, rememberSenderName, selectionRecord, senderNameFor, senderNameKey, sentTodayCount, syncCvs, warmupRecord } = require("../lib/store");

const root = path.join(__dirname, "..", "..");

function contact(name, email, company) {
  return { name, email, company };
}

function account(envId, envName, senderName, limit = 1) {
  return {
    envId,
    envName,
    gmailIndex: 0,
    email: `${envId}@gmail.com`,
    senderName,
    limit,
  };
}

function memoryStore() {
  return {
    data: { contacts: [], history: null, campaign: null },
    save() {},
  };
}

function buildRunner(overrides = {}) {
  const sent = [];
  const store = overrides.store || memoryStore();
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort(envId) {
        return `port-${envId}`;
      },
    }),
    gmail: {
      async sendGmail(request) {
        sent.push(request);
      },
    },
    store,
    sleep: async () => true,
    ...overrides,
    store,
  });
  return { runner, sent, store };
}

test("large MoreLogin ids stay exact strings", () => {
  const parsed = parseMoreLoginJson('{\n  "id": 1795695767353204736,\n  "debugPort": "5555"\n}');
  assert.equal(parsed.id, "1795695767353204736");
  assert.equal(parsed.debugPort, "5555");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:40000/api/"), "http://127.0.0.1:40000");
  assert.throws(() => normalizeBaseUrl("not a url"), /http:\/\/127\.0\.0\.1:40000/);
});

test("profile list keeps ids and marks browsers that are already open", async () => {
  const calls = [];
  const client = new MoreLoginClient({
    baseUrl: "http://127.0.0.1:40000/",
    token: "secret-token",
    request: async (url, headers, body) => {
      calls.push({ url, headers, body });
      assert.equal(headers.Authorization, "secret-token");
      if (url.endsWith("/api/env/getAllDebugInfo")) {
        return {
          status: 200,
          text: '{"code":0,"data":[{"envId":"1","debugPort":"5555","envName":"A"}]}',
        };
      }
      if (body.pageNo === 1) {
        return {
          status: 200,
          text: '{"code":0,"data":{"total":2,"dataList":[{"id":"1","envName":"A","uniqueId":2}]}}',
        };
      }
      return {
        status: 200,
        text: '{"code":0,"data":{"total":2,"dataList":[{"id":1795695767353204736,"envName":"B","uniqueId":9}]}}',
      };
    },
  });

  const listed = await client.listProfiles();
  assert.equal(listed.profiles.length, 2);
  assert.equal(listed.profiles[0].envId, "1");
  assert.equal(listed.profiles[0].running, true);
  assert.equal(listed.profiles[0].debugPort, "5555");
  assert.equal(listed.profiles[1].envId, "1795695767353204736");
  assert.equal(listed.profiles[1].running, false);
  assert.ok(calls.some((call) => call.url === "http://127.0.0.1:40000/api/env/page"));
});

test("MoreLogin uses an already open profile without restarting it", async () => {
  const calls = [];
  const open = [{ envId: "1", debugPort: "5555" }];
  const notes = [];
  const client = new MoreLoginClient({
    baseUrl: "http://127.0.0.1:40000",
    delay: async () => {},
    onStatus: (message) => notes.push(message),
    request: async (url, headers, body) => {
      calls.push({ url, body });
      if (url.endsWith("/api/env/getAllDebugInfo")) {
        return { status: 200, text: JSON.stringify({ code: 0, data: open }) };
      }
      if (url.endsWith("/api/env/close")) {
        return { status: 200, text: '{"code":0,"data":{"envId":"1"}}' };
      }
      if (url.endsWith("/api/env/start")) {
        return { status: 200, text: '{"code":0,"data":{"envId":"1","debugPort":"6666"}}' };
      }
      throw new Error(url);
    },
  });
  assert.equal(await client.ensureDebugPort("1"), "5555");
  assert.equal(await client.ensureDebugPort("1"), "5555");
  assert.equal(calls.filter((call) => call.url.endsWith("/api/env/close")).length, 0);
  assert.equal(calls.filter((call) => call.url.endsWith("/api/env/start")).length, 0);
  assert.equal(notes.length, 0);
});

test("an older MoreLogin still starts when it rejects session protection", async () => {
  let starts = 0;
  let open = [];
  const client = new MoreLoginClient({
    baseUrl: "http://127.0.0.1:40000",
    delay: async () => {},
    request: async (url, headers, body) => {
      if (url.endsWith("/api/env/getAllDebugInfo")) {
        return { status: 200, text: JSON.stringify({ code: 0, data: open }) };
      }
      if (url.endsWith("/api/env/start")) {
        starts += 1;
        if (body.cdpEvasion) return { status: 200, text: '{"code":1,"msg":"Unknown parameter cdpEvasion"}' };
        open = [{ envId: "4", debugPort: "9" }];
        return { status: 200, text: '{"code":0,"data":{"debugPort":"9"}}' };
      }
      throw new Error(url);
    },
  });
  assert.equal(await client.ensureDebugPort("4"), "9");
  assert.equal(starts, 2);
  assert.equal(await client.ensureDebugPort("4"), "9");
  assert.equal(starts, 2);
});

test("MoreLogin errors stay readable", async () => {
  const client = new MoreLoginClient({
    baseUrl: "http://127.0.0.1:40000",
    request: async () => ({ status: 200, text: '{"code":19001,"msg":"Not logged in"}' }),
  });
  await assert.rejects(() => client.listProfiles(), /Not logged in/);

  const down = new MoreLoginClient({
    baseUrl: "http://127.0.0.1:40000",
    request: async () => ({ status: 500, text: "nope" }),
  });
  await assert.rejects(() => down.listProfiles(), /HTTP 500/);
});

test("merge keeps an open browser that was missing from the profile page", () => {
  const merged = mergeProfileLists(
    [normalizeProfile({ id: "10", envName: "Closed", uniqueId: 2 })],
    [
      { envId: "10", debugPort: "1" },
      { envId: "999", envName: "Extra", debugPort: "2", uniqueId: 1 },
    ]
  );
  assert.deepEqual(merged.map((profile) => profile.envId), ["999", "10"]);
  assert.equal(merged[0].running, true);
  assert.equal(merged[1].envName, "Closed");
  assert.equal(merged[1].debugPort, "1");
});

test("contact rows accept the spreadsheet headers", () => {
  const mapped = mapContactRows([
    { "First Name": "Ann", Email: "ann@example.com", "Company Name for Emails": "Aco" },
    { name: "Skip", "E-mail": "not-an-email", Company: "Nope" },
    { Name: "Ben", "Email Address": "ben@example.com", "Company Name": "Bco" },
    { Email: "" },
  ]);
  assert.equal(mapped.skipped, 1);
  assert.deepEqual(mapped.contacts, [
    contact("Ann", "ann@example.com", "Aco"),
    contact("Ben", "ben@example.com", "Bco"),
  ]);
});

test("parse a csv contact file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-"));
  const file = path.join(dir, "contacts.csv");
  fs.writeFileSync(file, "First Name,Email,Company Name for Emails\nJane,jane@example.com,Acme\n");
  const parsed = parseContactFile(file);
  assert.equal(parsed.contacts[0].email, "jane@example.com");
  assert.equal(parsed.contacts[0].company, "Acme");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("placeholders and html escaping", () => {
  assert.equal(
    applyPlaceholders("Hi [Name] at [Company]", { company: "Acme" }, "Marek"),
    "Hi Marek at Acme"
  );
  const safe = personalizeEmail("en", contact("<img>", "a@b.co", "Acme"), "<b>");
  assert.match(safe.bodyHtml, /Hello &lt;img&gt;/);
  assert.match(safe.bodyHtml, /&lt;b&gt;/);
  assert.equal(safe.bodyHtml.includes("<img>"), false);
  assert.equal(safe.bodyHtml.includes("[Name]"), false);
  const chinese = personalizeEmail("zh", contact("Li", "a@b.co", "Acme"), "Marek");
  assert.match(chinese.bodyHtml, /您好 Li/);
  const fallback = personalizeEmail("fr", contact("Li", "a@b.co", "Acme"), "Marek");
  assert.match(fallback.bodyHtml, /Hello Li/);
  assert.ok(emailContentByLanguage.de.subjects.length > 10);
});

test("template lists keep more than 200 subjects and bodies", () => {
  const subjects = Array.from({ length: 220 }, (_, index) => `Subject ${index}`);
  assert.equal(normalizeTemplateList(subjects).length, 220);
  const bodies = Array.from({ length: 220 }, (_, index) => `Body ${index}\nSecond line`);
  const savedBodies = normalizeTemplateList(bodies, { multiline: true });
  assert.equal(savedBodies.length, 220);
  assert.equal(savedBodies[0], "Body 0\nSecond line");
  const overflow = Array.from({ length: 600 }, (_, index) => `Item ${index}`);
  assert.equal(normalizeTemplateList(overflow).length, 500);
});

test("custom subject and body templates replace the built-in message", async () => {
  const person = contact("Ada", "ada@example.com", "Acme");
  const mail = personalizeEmail("en", person, "Marek", {
    useCustom: true,
    subjectIndex: 1,
    templateIndex: 0,
    subjects: ["Hello [Company]", "Role for [Recipient]"],
    bodies: ["Hi [Recipient], I am [Name]."],
  });
  assert.equal(mail.subject, "Role for Ada");
  assert.equal(mail.bodyText, "Hi Ada, I am Marek.");
  const stripped = personalizeEmail("en", person, "Marek", {
    useCustom: true,
    includeAttach: false,
    subjectIndex: 0,
    templateIndex: 0,
    subjects: ["Hello [Company]"],
    bodies: ["Hi [Recipient]. I have attached my resume. See you."],
  });
  assert.equal(stripped.bodyText, "Hi Ada. See you.");
  const builtin = personalizeEmail("en", person, "Marek", {
    useCustom: false,
    subjectIndex: 0,
    templateIndex: 1,
    subjects: ["Hello [Company]"],
    bodies: ["Hi [Recipient], I am [Name]."],
  });
  assert.equal(builtin.subject, "Needs extra hands?");
  assert.match(builtin.bodyText, /^Hello Ada,/);
  assert.doesNotMatch(builtin.bodyText, /Hi Ada, I am Marek/);
  const unsafe = personalizeEmail("en", person, "<b>", {
    useCustom: true,
    subjectIndex: 0,
    templateIndex: 0,
    subjects: ["Safe"],
    bodies: ["Hello <img>"],
  });
  assert.match(unsafe.bodyHtml, /Hello &lt;img&gt;/);
  assert.equal(unsafe.bodyHtml.includes("<img>"), false);
  const missing = validateCampaignInput({
    contacts: [person],
    accounts: [account("a", "Alpha", "Ada")],
    intervalSeconds: 3,
    startDelaySeconds: 0,
    useCustomTemplates: true,
    customSubjects: ["  "],
    customBodies: [],
  });
  assert.match(missing.join(" "), /subject template/);
  assert.match(missing.join(" "), /body template/);
  const ready = validateCampaignInput({
    contacts: [person],
    accounts: [account("a", "Alpha", "Ada")],
    intervalSeconds: 3,
    startDelaySeconds: 0,
    useCustomTemplates: false,
    customSubjects: [],
    customBodies: [],
  });
  assert.equal(ready.some((error) => /template/.test(error)), false);
  const campaign = createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    useCustomTemplates: true,
    customSubjects: ["  Hello [Company]  ", "hello [company]"],
    customBodies: ["Body [Name]"],
    contacts: [person],
    accounts: [account("a", "Alpha", "Ada")],
  });
  assert.equal(campaign.useCustomTemplates, true);
  assert.deepEqual(campaign.customSubjects, ["Hello [Company]"]);
  assert.deepEqual(campaign.customBodies, ["Body [Name]"]);
  const { runner, sent } = buildRunner();
  runner.start(campaign);
  await runner.loopPromise;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "Hello Acme");
  assert.equal(sent[0].bodyText, "Body Ada");
  const warmup = createWarmupCampaign({
    email: "biz@example.com",
    company: "Acme",
    clientName: "Ann",
    intervalSeconds: 3,
    useCustomTemplates: true,
    customSubjects: ["Role at [Company]"],
    customBodies: ["Hello [Recipient], from [Name]."],
    accounts: [account("a", "Alpha", "Ada")],
  });
  assert.equal(warmup.includeAttach, false);
  const warm = buildRunner();
  warm.runner.start(warmup);
  await warm.runner.loopPromise;
  assert.equal(warm.sent[0].subject, "Role at Acme");
  assert.equal(warm.sent[0].bodyText, "Hello Ann, from Ada.");
  assert.equal(warm.sent[0].subject.includes("(w-u)"), false);
  const intro = peerIntro("Ada", "Bea", {
    includeAttach: false,
    useCustom: true,
    subjectIndex: 0,
    templateIndex: 0,
    subjects: ["Ping [Company]"],
    bodies: ["From [Name] to [Recipient]."],
  });
  assert.equal(intro.subject, "Ping Metaroom (w-u)");
  assert.equal(intro.bodyText, "From Ada to Bea.");
  assert.equal(
    peerReply("Ada", 0),
    "Thanks for your email. Unfortunately we don't have any job position for you.\n\nBest luck for your search\nAda"
  );
  const peerErrors = validatePeerWarmupInput({
    accounts: [account("a", "Alpha", "Ada"), account("b", "Beta", "Bea")],
    intervalSeconds: 3,
    periods: 1,
    useCustomTemplates: true,
    customSubjects: [],
    customBodies: ["Hi"],
  });
  assert.match(peerErrors.join(" "), /subject template/);
  assert.equal(peerErrors.some((error) => /body template/.test(error)), false);
  const followup = createFollowupCampaign({
    date: "2026-11-01",
    body: "Checking in, {sender}",
    intervalSeconds: 3,
    useCustomTemplates: true,
    customSubjects: ["Nope"],
    customBodies: ["Nope"],
    accounts: [account("a", "Alpha", "Ada")],
  });
  assert.equal(followup.useCustomTemplates, undefined);
  assert.equal(followup.body, "Checking in, {sender}");
  assert.equal(followup.useCustomFollowups, false);
  assert.deepEqual(followup.customFollowups, []);
  assert.equal(
    peerReply("Ada Example", 0, {
      replies: ["Thanks [Name]. Hello [Recipient] at [Company]."],
      contact: { name: "Bea", company: "Metaroom" },
    }),
    "Thanks Ada. Hello Bea at Metaroom."
  );
  assert.equal(peerReply("Ada Example", 1, { replies: ["One {sender}", "Two [Name]"] }), "Two Ada");
  assert.match(peerReply("Ada", 0, { replies: ["  "] }), /^Thanks for your email/);
  const withFollowups = createFollowupCampaign({
    date: "2026-11-01",
    body: "",
    intervalSeconds: 3,
    useCustomFollowups: true,
    customFollowups: ["  Ping [Name]  ", "ping [name]"],
    accounts: [account("a", "Alpha", "Ada")],
  });
  assert.equal(withFollowups.useCustomFollowups, true);
  assert.deepEqual(withFollowups.customFollowups, ["Ping [Name]"]);
  assert.deepEqual(validateFollowupInput({
    accounts: [account("a", "Alpha", "Ada")],
    date: "2026-11-01",
    body: "",
    intervalSeconds: 10,
    useCustomFollowups: true,
    customFollowups: ["Ping [Name]"],
  }), []);
  assert.match(validateFollowupInput({
    accounts: [account("a", "Alpha", "Ada")],
    date: "2026-11-01",
    body: "",
    intervalSeconds: 3,
    useCustomFollowups: true,
  }).join(" "), /follow-up email/);
  assert.match(validatePeerWarmupInput({
    accounts: [account("a", "Alpha", "Ada"), account("b", "Beta", "Bea")],
    intervalSeconds: 3,
    periods: 1,
    useCustomReplies: true,
  }).join(" "), /reply email/);
});

test("a csv or txt file imports many subjects, bodies, replies, and follow-ups", () => {
  assert.deepEqual(parseTemplateFileText("  Role at [Company]  \n\nHello [Recipient]\nRole at [Company]\n", {
    ext: "txt",
    kind: "subject",
  }), ["Role at [Company]", "Hello [Recipient]"]);
  const bodies = parseTemplateFileText("Hello [Recipient],\n\nI am [Name].\n---\nHello [Recipient],\n\nI am [Name].\n---\nThanks,\n[Name]\n", {
    ext: "txt",
    kind: "body",
    multiline: true,
  });
  assert.equal(bodies.length, 2);
  assert.match(bodies[0], /I am \[Name\]/);
  assert.equal(bodies[1], "Thanks,\n[Name]");
  const csv = "Subject,Body\n\"Role at [Company]\",\"Hello [Recipient],\n\nI am [Name].\"\n\"Open role\",\"Second [Company] note\"\n";
  assert.deepEqual(parseTemplateFileText(csv, { ext: "csv", kind: "subject" }), ["Role at [Company]", "Open role"]);
  assert.deepEqual(parseTemplateFileText(csv, { ext: "csv", kind: "body", multiline: true }), [
    "Hello [Recipient],\n\nI am [Name].",
    "Second [Company] note",
  ]);
  assert.deepEqual(parseTemplateFileText("reply\nThanks, [Name]\n", { ext: "csv", kind: "reply", multiline: true }), ["Thanks, [Name]"]);
  assert.deepEqual(parseTemplateFileText("Hi [Name]\n---\nHello [Recipient]\n", {
    ext: "txt",
    kind: "followup",
    multiline: true,
  }), ["Hi [Name]", "Hello [Recipient]"]);
  assert.deepEqual(parseTemplateFileText("Just one follow-up for [Company].", {
    ext: "txt",
    kind: "followup",
    multiline: true,
  }), ["Just one follow-up for [Company]."]);
});

test("sample txt and csv files keep the placeholders for each template list", () => {
  const files = ["message", "reply", "followup"].flatMap((group) => sampleTemplateFiles(group));
  assert.deepEqual(files.map((file) => file.name), [
    "subjects.txt",
    "subjects.csv",
    "bodies.txt",
    "bodies.csv",
    "warmup-replies.txt",
    "warmup-replies.csv",
    "follow-ups.txt",
    "follow-ups.csv",
  ]);
  for (const file of files) {
    const texts = parseTemplateFileText(file.text, {
      ext: file.name.endsWith(".csv") ? "csv" : "txt",
      kind: file.kind,
      multiline: file.kind !== "subject",
    });
    assert.ok(texts.length >= 3, file.name);
    assert.match(texts.join("\n"), /\[Name\]/, file.name);
  }
  const subjects = parseTemplateFileText(files[1].text, { ext: "csv", kind: "subject" });
  assert.equal(subjects.some((item) => item.includes("[Company], [Recipient]")), true);
  const followups = parseTemplateFileText(files[6].text, { ext: "txt", kind: "followup", multiline: true });
  assert.equal(followups.some((item) => /\[Recipient\]|\[Company\]/.test(item)), false);
  assert.match(followups.join("\n"), /\{sender\}/);
  const replies = parseTemplateFileText(files[4].text, { ext: "txt", kind: "reply", multiline: true });
  assert.match(replies.join("\n"), /\[Company\]/);
  assert.match(replies.join("\n"), /\[Recipient\]/);
});

test("a saved reply email is used for warm-up replies and follow-up", async () => {
  const replies = [];
  const followups = [];
  const peer = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async sendGmail() {},
      async replyAllWarmupThreads(request) {
        for (const thread of request.threads || []) replies.push(request.pickBody(thread));
        return {
          replied: (request.threads || []).map((thread) => ({ fromEmail: thread.fromEmail, subject: thread.subject })),
        };
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  peer.start(createPeerWarmupCampaign({
    intervalSeconds: 3,
    accounts: [
      { ...account("a", "Alpha", "Ada"), email: "a@gmail.com" },
      { ...account("b", "Beta", "Bea"), email: "b@gmail.com" },
    ],
    useCustomReplies: true,
    customReplies: ["Noted, [Name]. Hi [Recipient]."],
  }));
  await peer.loopPromise;
  assert.deepEqual(replies, ["Noted, Ada. Hi Bea.", "Noted, Bea. Hi Ada."]);

  const builtin = [];
  const builtinRunner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async sendGmail() {},
      async replyAllWarmupThreads(request) {
        for (const thread of request.threads || []) builtin.push(request.pickBody(thread));
        return {
          replied: (request.threads || []).map((thread) => ({ fromEmail: thread.fromEmail, subject: thread.subject })),
        };
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  builtinRunner.start(createPeerWarmupCampaign({
    intervalSeconds: 3,
    accounts: [
      { ...account("a", "Alpha", "Ada"), email: "a@gmail.com" },
      { ...account("b", "Beta", "Bea"), email: "b@gmail.com" },
    ],
    useCustomReplies: false,
    customReplies: ["Noted, [Name]. Hi [Recipient]."],
  }));
  await builtinRunner.loopPromise;
  assert.equal(builtin.some((text) => text.includes("Noted,")), false);
  assert.match(builtin[0], /Ada$/);
  assert.match(builtin[1], /Bea$/);

  const follow = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async replyFollowupThreads(request) {
        followups.push(request.bodyText);
        return { replied: [{ toEmail: "client@co.com", subject: "Still open", messageCount: 1 }], skipped: [] };
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  follow.start(createFollowupCampaign({
    accounts: [
      { ...account("a", "Alpha", "Ada Lane"), email: "a@gmail.com", limit: 1, followupBody: "Step {sender}" },
      { ...account("b", "Beta", "Bea"), email: "b@gmail.com", limit: 1 },
    ],
    date: "2026-11-10",
    body: "Hello {sender}",
    useCustomFollowups: true,
    customFollowups: ["Reply from [Name]"],
    intervalSeconds: 3,
  }));
  await follow.loopPromise;
  assert.deepEqual(followups, ["Step Ada", "Reply from Bea"]);
});

test("gmail warm-up marks the sending mailbox from the spam check", async () => {
  const store = memoryStore();
  store.data.gmailStatus = { "a@gmail.com": "Paused", "b@gmail.com": "Blocked" };
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async sendGmail() {},
      async replyAllWarmupThreads(request) {
        const mailbox = String(request.mailboxEmail || "").toLowerCase();
        if (mailbox === "b@gmail.com") {
          return {
            replied: [
              { fromEmail: "a@gmail.com", subject: "Hi (w-u)", folder: "spam" },
              { fromEmail: "c@gmail.com", subject: "Also (w-u)", folder: "inbox" },
            ],
          };
        }
        return {
          replied: (request.threads || []).map((thread) => ({
            fromEmail: thread.fromEmail,
            subject: thread.subject,
            folder: "inbox",
          })),
        };
      },
    },
    store,
    sleep: async () => true,
  });
  runner.start(createPeerWarmupCampaign({
    intervalSeconds: 3,
    accounts: [
      { ...account("a", "Alpha", "Ada"), email: "a@gmail.com" },
      { ...account("b", "Beta", "Bea"), email: "b@gmail.com" },
    ],
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.equal(store.data.gmailStatus["a@gmail.com"], "Warming up");
  assert.equal(store.data.gmailStatus["b@gmail.com"], "Active");
  assert.equal(store.data.gmailStatus["c@gmail.com"], "Active");
  assert.equal(store.data.gmailStatusOverrides["a@gmail.com"], "Warming up");
  assert.equal(store.data.gmailStatusOverrides["b@gmail.com"], "Active");
  assert.equal(store.data.gmailStatusOverrides["c@gmail.com"], "Active");
});

test("the attachment sentence can be left out of the email", () => {
  const person = contact("Ann", "ann@example.com", "Acme");
  const kept = personalizeEmail("en", person, "Ada", { includeAttach: true, templateIndex: 0, subjectIndex: 0 });
  assert.match(kept.bodyText, /I have attached my resume/);
  const dropped = personalizeEmail("en", person, "Ada", { includeAttach: false, templateIndex: 0, subjectIndex: 0 });
  assert.equal(/attach/i.test(dropped.bodyText), false);
  assert.match(dropped.bodyText, /Thank you for your time and consideration/);
  assert.match(dropped.bodyText, /Best regards,\nAda$/);
  const alongside = withoutAttachSentences("I'm seeking a role. I've attached my resume for your review. Thank you.");
  assert.equal(alongside, "I'm seeking a role. Thank you.");
  for (const language of ["en", "zh", "hi", "de"]) {
    for (const template of emailContentByLanguage[language].templates) {
      const stripped = withoutAttachSentences(template);
      assert.equal(/attach|附上|已附|beigefügt|anhang|संलग्न/i.test(stripped), false);
      assert.match(stripped, /\[Name\]/);
    }
    for (let i = 0; i < 8; i += 1) {
      const mail = personalizeEmail(language, person, "Ada", { includeAttach: false });
      assert.equal(/attach|附上|已附|beigefügt|anhang|संलग्न/i.test(mail.bodyText), false);
      assert.match(mail.bodyText, /Ada$/);
    }
  }
  const campaign = createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    includeAttach: false,
    contacts: [person],
    accounts: [account("a", "Alpha", "Ada")],
  });
  assert.equal(campaign.includeAttach, false);
  const unchanged = createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [person],
    accounts: [account("a", "Alpha", "Ada")],
  });
  assert.equal(unchanged.includeAttach, true);
});

test("each Gmail account chooses the resume sentence", async () => {
  const { runner, sent } = buildRunner();
  const person = contact("Ann", "ann@example.com", "Aco");
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    includeAttach: true,
    contacts: [person, person],
    accounts: [
      { ...account("a", "Alpha", "Ada"), mentionAttachment: false },
      { ...account("b", "Beta", "Bea", 1), mentionAttachment: true, cvPath: "C:\\resume.pdf" },
    ],
  }));
  await runner.loopPromise;
  assert.equal(sent.length, 2);
  assert.equal(/attach|附上|已附|beigefügt|anhang|संलग्न/i.test(sent[0].bodyText), false);
  assert.equal(sent[1].cvPath, "C:\\resume.pdf");
  assert.equal(sent[0].fromEmail, "a@gmail.com");
  assert.equal(sent[1].fromEmail, "b@gmail.com");
});

test("a send is kept on the selected Gmail address", () => {
  assert.equal(mailboxMatches("Ada@gmail.com", "ada@gmail.com"), true);
  assert.equal(mailboxMatches("other@gmail.com", "ada@gmail.com"), false);
  assert.equal(mailboxMatches("", "ada@gmail.com"), false);
  assert.equal(mailboxMatches("ada@gmail.com", ""), true);
});

test("Chrome stays open when the next profile sends", async () => {
  const released = [];
  const { runner, sent } = buildRunner({
    getMorelogin: () => ({
      async ensureDebugPort(envId) {
        return `port-${envId}`;
      },
      async releaseProfile(envId) {
        released.push({ envId: envId || "", sent: sent.length });
        return true;
      },
    }),
  });
  const person = contact("Ann", "ann@example.com", "Aco");
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [person, person],
    accounts: [
      { ...account("chrome:Default", "One", "Ada"), mentionAttachment: false },
      { ...account("chrome:Profile 1", "Two", "Bea"), mentionAttachment: false },
    ],
  }));
  await runner.loopPromise;
  assert.equal(sent.length, 2);
  assert.deepEqual(released, []);
});

test("a failed Chrome warm-up leaves the filled window open", async () => {
  const released = [];
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile(envId) {
        released.push(envId || "");
        return true;
      },
    }),
    gmail: {
      async sendGmail() {
        throw new Error("The compose window is still empty.");
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  runner.start(createPeerWarmupCampaign({
    intervalSeconds: 3,
    periods: 1,
    accounts: [
      { envId: "chrome:Profile 16", envName: "Sterling", email: "sterlingburt00@gmail.com", senderName: "Sterling Burt", gmailIndex: 0 },
      { envId: "chrome:Profile 10", envName: "Tajon", email: "tajondavy1990@gmail.com", senderName: "Tajon Davy", gmailIndex: 0 },
    ],
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.equal(runner.campaign.sentTotal, 0);
  assert.deepEqual(released, []);
});

test("a MoreLogin send leaves Chrome open", async () => {
  const released = [];
  const { runner, sent } = buildRunner({
    getMorelogin: () => ({
      async ensureDebugPort(envId) {
        return `port-${envId}`;
      },
      async releaseProfile(envId) {
        released.push(envId || "");
        return true;
      },
    }),
  });
  const person = contact("Ann", "ann@example.com", "Aco");
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [person, person],
    accounts: [
      account("2095504023381151744", "One", "Ada"),
      account("2095511977182433280", "Two", "Bea"),
    ],
  }));
  await runner.loopPromise;
  assert.equal(sent.length, 2);
  assert.deepEqual(released, []);
});

test("one Chrome profile stays open while it still has emails to send", async () => {
  const released = [];
  const { runner, sent } = buildRunner({
    getMorelogin: () => ({
      async ensureDebugPort(envId) {
        return `port-${envId}`;
      },
      async releaseProfile(envId) {
        released.push({ envId: envId || "", sent: sent.length });
        return true;
      },
    }),
  });
  const person = contact("Ann", "ann@example.com", "Aco");
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [person, person],
    accounts: [{ ...account("chrome:Default", "One", "Ada", 2), mentionAttachment: false }],
  }));
  await runner.loopPromise;
  assert.equal(sent.length, 2);
  assert.deepEqual(released, []);
});

test("account rotation and validation", () => {
  assert.equal(nextAccountCursor([{ sent: 1, limit: 1 }, { sent: 0, limit: 1 }], 0), 1);
  assert.equal(nextAccountCursor([{ sent: 1, limit: 2 }], 0), 0);
  assert.equal(nextAccountCursor([{ sent: 2, limit: 2 }, { sent: 1, limit: 1 }], 0), -1);
  const errors = validateCampaignInput({
    contacts: [],
    accounts: [],
    intervalSeconds: 1,
    startDelaySeconds: -1,
  });
  assert.ok(errors.some((error) => /Import contacts/.test(error)));
  assert.ok(errors.some((error) => /Interval/.test(error)));
  const missingCv = validateCampaignInput({
    contacts: [contact("Ann", "ann@example.com", "Aco")],
    accounts: [{ ...account("a", "Alpha", "Ada"), cvPath: "D:\\no-such-mail-carrier-cv.pdf" }],
    intervalSeconds: 3,
    startDelaySeconds: 0,
  });
  assert.match(missingCv.join(" "), /CV file was not found/);
  const sentenceWithoutCv = validateCampaignInput({
    contacts: [contact("Ann", "ann@example.com", "Aco")],
    accounts: [{ ...account("a", "Alpha", "Ada"), mentionAttachment: true }],
    intervalSeconds: 3,
    startDelaySeconds: 0,
  });
  assert.match(sentenceWithoutCv.join(" "), /resume sentence is on/);
  const badGap = validateCampaignInput({
    contacts: [contact("Ann", "ann@example.com", "Aco")],
    accounts: [account("a", "Alpha", "Ada")],
    intervalSeconds: 3,
    startDelaySeconds: 0,
    betweenAccountSeconds: -1,
  });
  assert.match(badGap.join(" "), /between Gmail accounts/);
  assert.equal(createCampaign({
    language: "en",
    intervalSeconds: 3,
    betweenAccountSeconds: 15,
    startDelaySeconds: 0,
    contacts: [contact("Ann", "ann@example.com", "Aco")],
    accounts: [account("a", "Alpha", "Ada")],
  }).betweenAccountMs, 15000);
  assert.deepEqual(validateCampaignInput({
    contacts: [contact("Ann", "ann@example.com", "Aco")],
    accounts: [{ ...account("a", "Alpha", "Ada"), mentionAttachment: false }],
    intervalSeconds: 3,
    startDelaySeconds: 0,
  }), []);
});

test("a profile in any running job is busy for the other jobs", () => {
  const running = {
    status: "running",
    accounts: [{ envId: "chrome:Profile 1" }, { envId: "chrome:Profile 1" }],
  };
  assert.deepEqual(activeJobProfiles(running), ["chrome:Profile 1"]);
  assert.deepEqual(activeJobProfiles({ status: "done", accounts: [{ envId: "chrome:Profile 1" }] }), []);
  assert.deepEqual(profilesBusyExcept({
    campaign: running,
    warmup: { status: "paused", accounts: [{ envId: "chrome:Profile 2" }] },
    "peer-warmup": { status: "done", accounts: [{ envId: "chrome:Profile 3" }] },
  }, "campaign"), ["chrome:Profile 2"]);
  assert.deepEqual(profilesBusyExcept({
    followup: { status: "running", accounts: [{ envId: "chrome:Profile 2" }] },
    analyse: { status: "error", accounts: [{ envId: "chrome:Profile 4" }] },
  }, "followup"), ["chrome:Profile 4"]);
});

test("each Gmail keeps its own contact list and send time", () => {
  const anchor = Date.parse("2026-11-03T13:00:00");
  assert.deepEqual(sendTimesFromAnchor(anchor, 3600, 3), [anchor, anchor + 3600000, anchor + 7200000]);
  const kept = mergeAccountPref(
    {
      contacts: [contact("Ann", "ann@example.com", "Aco")],
      contactFileName: "clients.csv",
      sendAt: anchor,
      senderName: "Old",
    },
    {
      selected: true,
      senderName: "Ada",
      limit: 4,
      cvPath: "",
      cvName: "",
      email: "ada@gmail.com",
      sendAt: anchor + 3600000,
      mentionAttachment: false,
    },
    20
  );
  assert.equal(kept.contacts[0].email, "ann@example.com");
  assert.equal(kept.contactFileName, "clients.csv");
  assert.equal(kept.sendAt, anchor + 3600000);
  assert.equal(kept.scheduleSend, true);
  assert.equal(kept.senderName, "Ada");
  assert.equal(kept.mentionAttachment, false);
  assert.equal(kept.hidden, false);
  assert.equal(mergeAccountPref({ hidden: true, senderName: "Ada" }, { senderName: "Ada", limit: 1 }, 20).hidden, true);
  assert.equal(mergeAccountPref({ hidden: true }, { senderName: "Ada", limit: 1, hidden: false }, 20).hidden, false);
  const missingList = validateCampaignInput({
    accounts: [{ ...account("a", "Alpha", "Ada"), contacts: [], sendAt: anchor }],
    intervalSeconds: 3,
    startDelaySeconds: 0,
  });
  assert.match(missingList.join(" "), /shared contact list/);
  assert.deepEqual(validateCampaignInput({
    contacts: [contact("Sam", "sam@client.com", "North")],
    accounts: [{ ...account("a", "Alpha", "Ada"), contacts: [], sendAt: anchor }],
    intervalSeconds: 3,
    startDelaySeconds: 0,
  }), []);
  assert.deepEqual(validateCampaignInput({
    accounts: [{ ...account("a", "Alpha", "Ada"), contacts: [contact("Ann", "ann@example.com", "Aco")], sendAt: 0 }],
    intervalSeconds: 3,
    startDelaySeconds: 0,
  }), []);
  const requiredTime = validateCampaignInput({
    accounts: [{ ...account("a", "Alpha", "Ada"), contacts: [contact("Ann", "ann@example.com", "Aco")], scheduleSend: true, sendAt: 0 }],
    intervalSeconds: 3,
    startDelaySeconds: 0,
  });
  assert.match(requiredTime.join(" "), /Choose a send time for Alpha/);
});

test("a CV stays with the Gmail email when the mailbox index changes", () => {
  const prefs = {
    "profile:0": { email: "old@gmail.com", cvPath: "C:\\old.pdf", cvName: "old.pdf" },
    "profile:2": { email: "Ada@Gmail.com", cvPath: "C:\\ada.pdf", cvName: "ada.pdf" },
  };
  const seeded = cvsFromPrefs(prefs);
  assert.equal(seeded["ada@gmail.com"].cvPath, "C:\\ada.pdf");
  assert.equal(cvForEmail(seeded, "ada@gmail.com").cvName, "ada.pdf");
  assert.equal(cvForEmail(seeded, "ben@gmail.com"), null);

  const moved = {
    "profile:0": { email: "ben@gmail.com", cvPath: "C:\\ada.pdf", cvName: "ada.pdf" },
    "profile:5": { email: "ada@gmail.com", cvPath: "", cvName: "" },
  };
  const synced = syncCvs(seeded, moved, [
    { email: "ben@gmail.com", cvPath: "", cvName: "" },
    { email: "ada@gmail.com", cvPath: "C:\\ada.pdf", cvName: "ada.pdf" },
  ]);
  assert.equal(synced["ada@gmail.com"].cvPath, "C:\\ada.pdf");
  assert.equal(synced["ben@gmail.com"], undefined);
  assert.equal(moved["profile:0"].cvPath, "");
  assert.equal(moved["profile:5"].cvPath, "C:\\ada.pdf");

  const replaced = syncCvs(synced, moved, [
    { email: "ada@gmail.com", cvPath: "", cvName: "" },
    { email: "ada@gmail.com", cvPath: "C:\\new.pdf", cvName: "new.pdf" },
  ]);
  assert.equal(replaced["ada@gmail.com"].cvPath, "C:\\new.pdf");
  const removed = syncCvs(replaced, moved, [
    { email: "ada@gmail.com", cvPath: "", cvName: "" },
  ]);
  assert.equal(removed["ada@gmail.com"], undefined);
  assert.equal(moved["profile:5"].cvPath, "");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-cv-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({ accountPrefs: prefs }));
  const store = new Store(file);
  assert.equal(store.data.cvs["ada@gmail.com"].cvPath, "C:\\ada.pdf");
  store.data.cvs = {};
  store.save();
  const again = new Store(file);
  assert.equal(again.data.cvs["ada@gmail.com"], undefined);

  const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer", "renderer.js"), "utf8");
  assert.match(renderer, /state\.cvs\[key\]/);
  assert.match(renderer, /cvRecord\(account, saved\)/);
  assert.match(renderer, /Choose the CV for this email address/);
});

test("a Gmail with no send time sends when sending starts", async () => {
  const sleeps = [];
  const now = Date.now();
  const { runner, sent, store } = buildRunner({
    sleep: async (ms) => {
      sleeps.push(ms);
      return true;
    },
  });
  store.data.contacts = [contact("Ann", "ann@example.com", "Aco"), contact("Ben", "ben@example.com", "Bco")];
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    contacts: store.data.contacts,
    accounts: [
      { ...account("a", "Alpha", "Ada", 1), contacts: [], sendAt: 0 },
      { ...account("b", "Beta", "Bea", 1), contacts: [contact("Cay", "cay@example.com", "Cco")], sendAt: now + 60000 },
    ],
  }, now));
  await runner.loopPromise;
  assert.deepEqual(sent.map((item) => `${item.fromEmail}:${item.contact.email}`), [
    "a@gmail.com:ann@example.com",
    "b@gmail.com:cay@example.com",
  ]);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 50000);
  assert.equal(store.data.contacts[0].email, "ben@example.com");
  assert.equal(runner.campaign.accounts.find((item) => item.envId === "a").sendAt, 0);
  assert.equal(sentTodayCount(store.data, "a:0", now), 1);
  assert.equal(sentTodayCount(store.data, "b:0", now), 1);
  assert.equal(store.data.sendLog.contacts["a@gmail.com"][localDayKey()], 1);
  assert.equal(store.data.sendLog.contacts["b@gmail.com"][localDayKey()], 1);
  assert.deepEqual(store.data.sendLog.warmup, {});
  assert.deepEqual(store.data.sendLog.followup, {});
});

test("today's send count starts over on the next day", () => {
  const data = {};
  const now = Date.parse("2026-11-03T15:00:00");
  assert.equal(recordDailySend(data, "a:0", now), 1);
  assert.equal(recordDailySend(data, "a:0", now + 1000), 2);
  assert.equal(sentTodayCount(data, "a:0", now), 2);
  const nextDay = Date.parse("2026-11-04T09:00:00");
  assert.equal(sentTodayCount(data, "a:0", nextDay), 0);
  assert.equal(recordDailySend(data, "a:0", nextDay), 1);
  assert.equal(sentTodayCount(data, "a:0", now), 0);
});

test("follow-up and warm-up keep a send count for each Gmail on each date", () => {
  const data = {};
  const day = Date.parse("2026-11-18T12:00:00");
  const next = Date.parse("2026-11-19T12:00:00");
  assert.equal(recordKindSend(data, "followup", "Ada@Gmail.com", day, { selectedDate: "2026-11-10" }), 1);
  assert.equal(recordKindSend(data, "followup", "ada@gmail.com", day, { selectedDate: "2026-11-10" }), 2);
  assert.equal(recordKindSend(data, "followup", "ada@gmail.com", next, { selectedDate: "2026-11-12" }), 1);
  assert.equal(recordKindSend(data, "warmup", "ada@gmail.com", day), 1);
  assert.equal(recordKindSend(data, "peer-warmup", "ada@gmail.com", day, { reply: true }), 1);
  assert.equal(recordKindSend(data, "campaign", "ada@gmail.com", day), 1);
  assert.equal(recordKindSend(data, "followup", "", day), 0);
  assert.deepEqual(data.sendLog.followup["ada@gmail.com"], {
    "2026-11-12|2026-11-19": 1,
    "2026-11-10|2026-11-18": 2,
  });
  assert.deepEqual(data.sendLog.warmup["ada@gmail.com"], { sent: 1, replies: 1 });
  assert.deepEqual(data.sendLog.contacts["ada@gmail.com"], { "2026-11-18": 1 });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-"));
  const file = path.join(dir, "state.json");
  const store = new Store(file);
  store.data.sendLog = {
    warmup: { "ada@gmail.com": { "2026-11-17": 2 } },
    peer: { "ada@gmail.com": { "2026-11-17": 3 } },
    followup: { "ada@gmail.com": { "2026-11-16": 4 }, junk: { "not-a-date": 3 } },
  };
  store.save();
  const again = new Store(file);
  assert.deepEqual(again.data.sendLog.warmup["ada@gmail.com"], { sent: 5, replies: 0 });
  assert.equal(again.data.sendLog.followup["ada@gmail.com"]["|2026-11-16"], 4);
  assert.equal(again.data.sendLog.followup.junk, undefined);
  assert.equal(again.data.sendLog.peer, undefined);
});

test("each Gmail sends only its own contacts, at that account's time", async () => {
  const released = [];
  const sleeps = [];
  const now = Date.now();
  const { runner, sent, store } = buildRunner({
    getMorelogin: () => ({
      async ensureDebugPort(envId) {
        return `port-${envId}`;
      },
      async releaseProfile(envId) {
        released.push(envId || "");
        return true;
      },
    }),
    sleep: async (ms) => {
      sleeps.push(ms);
      return true;
    },
  });
  store.data.contacts = [contact("Keep", "keep@example.com", "KeepCo")];
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 60,
    accounts: [
      {
        ...account("a", "Alpha", "Ada", 5),
        contacts: [contact("Ann", "ann@example.com", "Aco"), contact("Cay", "cay@example.com", "Cco")],
        sendAt: now + 5000,
      },
      {
        ...account("b", "Beta", "Bea", 5),
        contacts: [contact("Ben", "ben@example.com", "Bco")],
        sendAt: now + 1000,
      },
    ],
  }, now));
  await runner.loopPromise;
  assert.deepEqual(sent.map((item) => `${item.fromEmail}:${item.contact.email}`), [
    "b@gmail.com:ben@example.com",
    "a@gmail.com:ann@example.com",
    "a@gmail.com:cay@example.com",
  ]);
  assert.ok(sleeps[0] > 500 && sleeps[0] < 1500);
  assert.ok(sleeps[1] > 4000 && sleeps[1] < 5500);
  assert.ok(sleeps[2] > 2500 && sleeps[2] < 3500);
  assert.equal(store.data.contacts[0].email, "keep@example.com");
  assert.equal(runner.campaign.status, "done");
  assert.equal(runner.campaign.sentTotal, 3);
  assert.deepEqual(released, []);
});

test("a Gmail stops at its max and does not send another account's contacts", async () => {
  const { runner, sent } = buildRunner();
  const now = Date.now() - 10000;
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    accounts: [
      {
        ...account("a", "Alpha", "Ada", 1),
        contacts: [contact("Ann", "ann@example.com", "Aco"), contact("Cay", "cay@example.com", "Cco")],
        sendAt: now,
      },
      {
        ...account("b", "Beta", "Bea", 5),
        contacts: [contact("Ben", "ben@example.com", "Bco")],
        sendAt: now + 1,
      },
    ],
  }, now));
  await runner.loopPromise;
  assert.deepEqual(sent.map((item) => item.contact.email), ["ann@example.com", "ben@example.com"]);
  assert.equal(runner.campaign.status, "done");
  assert.equal(nextDueIndex(runner.campaign.accounts), -1);
});

test("stopping during a Gmail's send time does not send", async () => {
  const { runner, sent } = buildRunner({ sleep: async () => false });
  const now = Date.now();
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    accounts: [{
      ...account("a", "Alpha", "Ada"),
      contacts: [contact("Ann", "ann@example.com", "Aco")],
      sendAt: now + 60000,
    }],
  }, now));
  await runner.loopPromise;
  assert.equal(sent.length, 0);
  assert.equal(runner.campaign.status, "stopped");
  assert.equal(runner.campaign.accounts[0].contactIndex, 0);
});

test("a Gmail without its own list sends the shared contacts", async () => {
  const now = Date.now() - 10000;
  const { runner, sent, store } = buildRunner();
  store.data.contacts = [contact("Keep", "keep@example.com", "KeepCo")];
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [contact("Ann", "ann@example.com", "Aco"), contact("Ben", "ben@example.com", "Bco")],
    accounts: [
      {
        ...account("a", "Alpha", "Ada", 5),
        contacts: [contact("Cay", "cay@example.com", "Cco")],
        sendAt: now,
      },
      {
        ...account("b", "Beta", "Bea", 1),
        contacts: [],
        sendAt: now + 1,
      },
    ],
  }, now));
  await runner.loopPromise;
  assert.deepEqual(sent.map((item) => `${item.fromEmail}:${item.contact.email}`), [
    "a@gmail.com:cay@example.com",
    "b@gmail.com:ann@example.com",
  ]);
  assert.equal(runner.campaign.status, "done");
  assert.equal(store.data.contacts.length, 1);
  assert.equal(store.data.contacts[0].email, "ben@example.com");
});

test("a due Gmail waits out the gap after another Gmail sends", async () => {
  const sleeps = [];
  const now = Date.now() - 10000;
  const { runner, sent } = buildRunner({
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
      return true;
    },
  });
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 30,
    betweenAccountSeconds: 15,
    startDelaySeconds: 0,
    accounts: [
      {
        ...account("a", "Alpha", "Ada", 1),
        contacts: [contact("Ann", "ann@example.com", "Aco")],
        sendAt: now,
      },
      {
        ...account("b", "Beta", "Bea", 1),
        contacts: [contact("Ben", "ben@example.com", "Bco")],
        sendAt: now,
      },
      {
        ...account("c", "Gamma", "Cam", 1),
        contacts: [contact("Cay", "cay@example.com", "Cco")],
        sendAt: now,
      },
    ],
  }, now));
  await runner.loopPromise;
  assert.deepEqual(sent.map((item) => `${item.fromEmail}:${item.contact.email}`), [
    "a@gmail.com:ann@example.com",
    "b@gmail.com:ben@example.com",
    "c@gmail.com:cay@example.com",
  ]);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms > 9000 && ms < 11000));
  assert.equal(runner.campaign.status, "done");
});

test("the gap between Gmail accounts can change while sending", async () => {
  const now = 1_700_000_000_000;
  const campaign = {
    betweenAccountMs: 15000,
    paceFrom: now,
    paceUntil: now + 15000,
    phase: "waiting",
    accountCursor: 1,
    lastSentKey: "a:0",
    accounts: [
      { key: "a:0", nextSendAt: 0 },
      { key: "b:0", nextSendAt: 0 },
    ],
  };
  assert.equal(applyBetweenAccountGap(campaign, 20, () => 0), 20);
  assert.equal(campaign.betweenAccountMs, 20000);
  assert.equal(campaign.paceUntil, now + 15000);
  assert.equal(campaign.waitUntil, now + 15000);
  assert.throws(() => applyBetweenAccountGap(campaign, 9), /between 10 and 86400/);
  assert.equal(gmailGapWaitMs(30000, () => 0), 25000);
  assert.equal(gmailGapWaitMs(30000, () => 0.5), 30000);
  assert.equal(gmailGapWaitMs(30000, () => 0.999), 35000);
  assert.equal(gmailGapWaitMs(10000, () => 0), 5000);

  const sleeps = [];
  const started = Date.now() - 10000;
  const { runner, sent } = buildRunner({
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 1) applyBetweenAccountGap(runner.campaign, 20, () => 0);
      return true;
    },
  });
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 30,
    betweenAccountSeconds: 15,
    startDelaySeconds: 0,
    accounts: [
      {
        ...account("a", "Alpha", "Ada", 1),
        contacts: [contact("Ann", "ann@example.com", "Aco")],
        sendAt: started,
      },
      {
        ...account("b", "Beta", "Bea", 1),
        contacts: [contact("Ben", "ben@example.com", "Bco")],
        sendAt: started,
      },
      {
        ...account("c", "Gamma", "Cam", 1),
        contacts: [contact("Cay", "cay@example.com", "Cco")],
        sendAt: started,
      },
    ],
  }, started));
  await runner.loopPromise;
  assert.deepEqual(sent.map((item) => item.fromEmail), ["a@gmail.com", "b@gmail.com", "c@gmail.com"]);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[0] > 9000 && sleeps[0] < 11000);
  assert.ok(sleeps[1] > 14000 && sleeps[1] < 16000);
});

test("the seconds between sends can change while the job is waiting", async () => {
  const started = Date.now() - 4000;
  const waiting = {
    kind: "warmup",
    phase: "waiting",
    intervalMs: 30000,
    waitFrom: started,
    waitUntil: started + 30000,
    accounts: [],
  };
  assert.equal(applyJobInterval(waiting, 3), 3);
  assert.equal(waiting.intervalMs, 3000);
  assert.equal(waiting.waitUntil, started + 3000);
  const finished = await interruptibleSleep(30000, () => false, () => waiting.waitUntil);
  assert.equal(finished, true);
  assert.ok(Date.now() - started < 8000);

  const scheduledAt = 1_700_000_000_000;
  const scheduled = {
    kind: "campaign",
    mode: "scheduled",
    phase: "waiting",
    intervalMs: 30000,
    accountCursor: 0,
    accounts: [{ key: "a:0", intervalFrom: scheduledAt, nextSendAt: scheduledAt + 30000 }],
  };
  applyJobInterval(scheduled, 10);
  assert.equal(scheduled.accounts[0].nextSendAt, scheduledAt + 10000);
  assert.throws(() => applyJobInterval(scheduled, 1), /between 3 and 86400/);
});

test("a later send time stays later than the gap between Gmail accounts", async () => {
  const sleeps = [];
  const now = Date.now();
  const { runner, sent } = buildRunner({
    sleep: async (ms) => {
      sleeps.push(ms);
      return true;
    },
  });
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    betweenAccountSeconds: 15,
    startDelaySeconds: 0,
    accounts: [
      {
        ...account("a", "Alpha", "Ada", 1),
        contacts: [contact("Ann", "ann@example.com", "Aco")],
        sendAt: now,
      },
      {
        ...account("b", "Beta", "Bea", 1),
        contacts: [contact("Ben", "ben@example.com", "Bco")],
        sendAt: now + 60000,
      },
    ],
  }, now));
  await runner.loopPromise;
  assert.deepEqual(sent.map((item) => item.fromEmail), ["a@gmail.com", "b@gmail.com"]);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 55000 && sleeps[0] < 65000);
});

test("the same Gmail keeps its own interval when it sends the next email", async () => {
  const sleeps = [];
  const now = Date.now() - 10000;
  const { runner, sent } = buildRunner({
    sleep: async (ms) => {
      sleeps.push(ms);
      return true;
    },
  });
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    betweenAccountSeconds: 15,
    startDelaySeconds: 0,
    accounts: [{
      ...account("a", "Alpha", "Ada", 2),
      contacts: [contact("Ann", "ann@example.com", "Aco"), contact("Ben", "ben@example.com", "Bco")],
      sendAt: now,
    }],
  }, now));
  await runner.loopPromise;
  assert.deepEqual(sent.map((item) => item.contact.email), ["ann@example.com", "ben@example.com"]);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 2500 && sleeps[0] < 3500);
});

test("stopping during the gap between Gmail accounts does not send the next account", async () => {
  const { runner, sent } = buildRunner({ sleep: async () => false });
  const now = Date.now() - 10000;
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 30,
    betweenAccountSeconds: 15,
    startDelaySeconds: 0,
    accounts: [
      {
        ...account("a", "Alpha", "Ada", 1),
        contacts: [contact("Ann", "ann@example.com", "Aco")],
        sendAt: now,
      },
      {
        ...account("b", "Beta", "Bea", 1),
        contacts: [contact("Ben", "ben@example.com", "Bco")],
        sendAt: now,
      },
    ],
  }, now));
  await runner.loopPromise;
  assert.deepEqual(sent.map((item) => item.contact.email), ["ann@example.com"]);
  assert.equal(runner.campaign.status, "stopped");
  assert.equal(runner.campaign.accounts[1].sent, 0);
});

test("account keys keep a Chrome profile id intact", () => {
  assert.deepEqual(splitAccountKey("chrome:Profile 2:1"), { envId: "chrome:Profile 2", gmailIndex: 1 });
  assert.deepEqual(splitAccountKey("1795695767353204736:0"), { envId: "1795695767353204736", gmailIndex: 0 });
});

test("a Chrome session passes its tab through to Gmail", async () => {
  const { runner, sent } = buildRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return {
          debugPort: "9334",
          browserWSEndpoint: "ws://127.0.0.1:9334/devtools/browser/abc",
          targetId: "tab-1",
        };
      },
    }),
  });
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [contact("Ann", "ann@example.com", "Aco")],
    accounts: [account("chrome:Profile 2", "David (Ron)", "David")],
  }));
  await runner.loopPromise;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].debugPort, "9334");
  assert.equal(sent[0].browserWSEndpoint, "ws://127.0.0.1:9334/devtools/browser/abc");
  assert.equal(sent[0].targetId, "tab-1");
  assert.equal(sent[0].gmailIndex, 0);
});

test("profiles take turns until each max is reached", async () => {
  const { runner, sent, store } = buildRunner();
  const campaign = createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [contact("Ann", "ann@example.com", "Aco"), contact("Ben", "ben@example.com", "Bco")],
    accounts: [account("a", "Alpha", "Ada"), account("b", "Beta", "Bea")],
  });
  runner.start(campaign);
  await runner.loopPromise;
  assert.deepEqual(sent.map((item) => `${item.debugPort}:${item.contact.email}`), [
    "port-a:ann@example.com",
    "port-b:ben@example.com",
  ]);
  assert.match(sent[0].bodyHtml, /Hello Ann/);
  assert.match(sent[0].bodyHtml, /Ada/);
  assert.match(sent[1].bodyHtml, /Bea/);
  assert.equal(runner.campaign.status, "done");
  assert.equal(store.data.contacts.length, 0);
  assert.equal(store.data.history.sent, 2);
});

test("a profile stops at its max and leaves the remaining contacts", async () => {
  const { runner, sent, store } = buildRunner();
  const campaign = createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [contact("Ann", "ann@example.com", "Aco"), contact("Ben", "ben@example.com", "Bco")],
    accounts: [account("a", "Alpha", "Ada", 1)],
  });
  runner.start(campaign);
  await runner.loopPromise;
  assert.equal(sent.length, 1);
  assert.equal(runner.campaign.status, "done");
  assert.equal(store.data.contacts.length, 1);
  assert.equal(store.data.contacts[0].email, "ben@example.com");
});

test("stop during the start delay does not send", async () => {
  const { runner, sent } = buildRunner({ sleep: async () => false });
  const now = Date.now();
  const campaign = createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 60,
    contacts: [contact("Ann", "ann@example.com", "Aco")],
    accounts: [account("a", "Alpha", "Ada")],
  }, now);
  assert.equal(campaign.status, "scheduled");
  assert.equal(campaign.startTime, now + 60000);
  runner.start(campaign);
  await runner.loopPromise;
  assert.equal(sent.length, 0);
  assert.equal(runner.campaign.status, "stopped");
});

test("a failed send is retried, and a sign-in failure continues with the next contact", async () => {
  let calls = 0;
  const retry = buildRunner({
    gmail: {
      async sendGmail() {
        calls += 1;
        if (calls === 1) throw new Error("compose missing");
      },
    },
  });
  retry.runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [contact("Ann", "ann@example.com", "Aco")],
    accounts: [account("a", "Alpha", "Ada")],
  }));
  await retry.runner.loopPromise;
  assert.equal(calls, 2);
  assert.equal(retry.runner.campaign.status, "done");

  let fatalCalls = 0;
  const paused = buildRunner({
    gmail: {
      async sendGmail(request) {
        fatalCalls += 1;
        if (request.contact.email === "ann@example.com") {
          const error = new Error("Sign in");
          error.fatal = true;
          throw error;
        }
      },
    },
  });
  paused.runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [contact("Ann", "ann@example.com", "Aco"), contact("Ben", "ben@example.com", "Bco")],
    accounts: [account("a", "Alpha", "Ada", 5)],
  }));
  await paused.runner.loopPromise;
  assert.equal(fatalCalls, 2);
  assert.equal(paused.runner.campaign.status, "done");
  assert.equal(paused.runner.campaign.sentTotal, 1);
  assert.equal(paused.store.data.contacts.length, 0);
});

test("a follow-up error continues with the next Gmail", async () => {
  const calls = [];
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async replyFollowupThreads(request) {
        calls.push(request.mailboxEmail);
        if (request.mailboxEmail === "a@gmail.com") throw new Error("Search did not open.");
        return { replied: [{ toEmail: "client@co.com", subject: "Still open", messageCount: 1 }], skipped: [] };
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  runner.start(createFollowupCampaign({
    accounts: [
      { ...account("a", "Alpha", "Ada"), email: "a@gmail.com", limit: 2 },
      { ...account("b", "Beta", "Bea"), email: "b@gmail.com", limit: 1 },
    ],
    date: "2026-11-10",
    body: "Hello {sender}",
    intervalSeconds: 3,
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.deepEqual(calls, ["a@gmail.com", "b@gmail.com"]);
  assert.equal(runner.campaign.sentTotal, 1);
  assert.equal(runner.campaign.accounts[0].sent, 2);
  assert.equal(runner.campaign.accounts[1].sent, 1);
});

test("business warm-up, gmail warm-up, follow-up, and sending can run together", async () => {
  const starts = [];
  const hub = new CampaignHub({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async sendGmail(request) {
        starts.push(`send:${request.fromEmail || request.contact?.email || ""}`);
      },
      async replyAllWarmupThreads() {
        starts.push("peer-reply");
        return { replied: [] };
      },
      async replyFollowupThreads(request) {
        starts.push(`followup:${request.mailboxEmail}`);
        return { replied: [{ toEmail: "c@co.com", subject: "Hi", messageCount: 1 }], skipped: [] };
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  hub.start(createWarmupCampaign({
    email: "biz@co.com",
    company: "Biz",
    clientName: "Biz",
    accounts: [{ ...account("a", "Alpha", "Ada"), email: "a@gmail.com", limit: 1 }],
    intervalSeconds: 3,
    language: "en",
  }));
  hub.start(createPeerWarmupCampaign({
    accounts: [
      { ...account("a", "Alpha", "Ada"), email: "a@gmail.com" },
      { ...account("b", "Beta", "Bea"), email: "b@gmail.com" },
    ],
    intervalSeconds: 3,
    periods: 1,
    connections: [],
    language: "en",
  }));
  hub.start(createFollowupCampaign({
    accounts: [{ ...account("c", "Gamma", "Cara"), email: "c@gmail.com", limit: 1 }],
    date: "2026-11-10",
    body: "Hello {sender}",
    intervalSeconds: 3,
  }));
  hub.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [contact("Ann", "ann@example.com", "Aco")],
    accounts: [{ ...account("d", "Delta", "Dan"), email: "d@gmail.com", limit: 1 }],
  }));
  assert.equal(hub.isActive("warmup"), true);
  assert.equal(hub.isActive("peer-warmup"), true);
  assert.equal(hub.isActive("followup"), true);
  assert.equal(hub.isActive("campaign"), true);
  await Promise.all([
    hub.runner("warmup").loopPromise,
    hub.runner("peer-warmup").loopPromise,
    hub.runner("followup").loopPromise,
    hub.runner("campaign").loopPromise,
  ]);
  assert.equal(hub.view("warmup").status, "done");
  assert.equal(hub.view("followup").status, "done");
  assert.equal(hub.view("campaign").status, "done");
  assert.equal(hub.isActive(), false);
  assert.ok(starts.some((item) => item.startsWith("send:")));
  assert.ok(starts.some((item) => item.startsWith("followup:")));
});

test("two jobs of the same kind run at the same time", async () => {
  const sent = [];
  const hub = new CampaignHub({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async sendGmail(request) {
        sent.push(request.fromEmail || request.contact?.email || "sent");
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  hub.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [contact("Ann", "ann@example.com", "Aco")],
    accounts: [{ ...account("chrome:A", "Alpha", "Ada"), email: "a@gmail.com", limit: 1, mentionAttachment: false }],
  }));
  hub.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [contact("Ben", "ben@example.com", "Bco")],
    accounts: [{ ...account("chrome:B", "Beta", "Bea"), email: "b@gmail.com", limit: 1, mentionAttachment: false }],
  }));
  assert.equal(hub.list("campaign").filter((runner) => runner.isActive()).length, 2);
  assert.deepEqual(profilesBusyExcept({
    one: { status: "running", accounts: [{ envId: "chrome:A" }] },
    two: { status: "running", accounts: [{ envId: "chrome:B" }] },
  }, ""), ["chrome:A", "chrome:B"]);
  await Promise.all(hub.list("campaign").map((runner) => runner.loopPromise));
  assert.equal(hub.isActive("campaign"), false);
  assert.equal(hub.views().jobs.campaign.length, 2);
  assert.equal(sent.length, 2);
});

test("pause saves progress and resume continues from there", async () => {
  let calls = 0;
  const { runner, store } = buildRunner({
    gmail: {
      async sendGmail() {
        calls += 1;
      },
    },
    sleep: async (_ms, isStopped) => {
      if (calls >= 1) {
        runner.pause();
        assert.equal(isStopped(), true);
        return false;
      }
      return true;
    },
  });
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [
      contact("Ann", "ann@example.com", "Aco"),
      contact("Ben", "ben@example.com", "Bco"),
    ],
    accounts: [account("a", "Alpha", "Ada", 5)],
  }));
  await runner.loopPromise;
  assert.equal(calls, 1);
  assert.equal(runner.campaign.status, "paused");
  assert.equal(store.data.campaign.status, "paused");
  assert.equal(store.data.campaign.sentTotal, 1);
  assert.equal(store.data.contacts[0].email, "ben@example.com");
  runner.resume();
  await runner.loopPromise;
  assert.equal(calls, 2);
  assert.equal(runner.campaign.status, "done");
});

test("stop ends a paused campaign so it cannot keep focus", async () => {
  const { runner, store } = buildRunner({
    gmail: {
      async sendGmail() {},
    },
    sleep: async () => {
      runner.pause();
      return false;
    },
  });
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [
      contact("Ann", "ann@example.com", "Aco"),
      contact("Ben", "ben@example.com", "Bco"),
    ],
    accounts: [account("a", "Alpha", "Ada", 5)],
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "paused");
  runner.stop();
  assert.equal(runner.campaign.status, "stopped");
  assert.equal(store.data.campaign.status, "stopped");
  assert.throws(() => runner.resume(), /no paused campaign/i);
});

test("stop after the first email keeps the rest of the list", async () => {
  const { runner, sent, store } = buildRunner({ sleep: async () => false });
  runner.start(createCampaign({
    language: "en",
    intervalSeconds: 3,
    startDelaySeconds: 0,
    contacts: [contact("Ann", "ann@example.com", "Aco"), contact("Ben", "ben@example.com", "Bco")],
    accounts: [account("a", "Alpha", "Ada", 5)],
  }));
  await runner.loopPromise;
  assert.equal(sent.length, 1);
  assert.equal(runner.campaign.status, "stopped");
  assert.equal(store.data.contacts[0].email, "ben@example.com");
});

test("settings survive a restart of the store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-"));
  const file = path.join(dir, "state.json");
  const store = new Store(file);
  store.data.contacts = [contact("Ann", "ann@example.com", "Aco")];
  store.data.settings.intervalSeconds = 30;
  store.data.settings.betweenAccountSeconds = 15;
  store.save();
  const again = new Store(file);
  assert.equal(again.data.contacts[0].email, "ann@example.com");
  assert.equal(again.data.settings.intervalSeconds, 30);
  assert.equal(again.data.settings.betweenAccountSeconds, 15);
  assert.equal(again.data.settings.apiBase, "http://127.0.0.1:40000");
  assert.equal(again.data.settings.useCustomTemplates, false);
  assert.deepEqual(again.data.settings.customSubjects, []);
  assert.deepEqual(again.data.settings.customBodies, []);
  assert.deepEqual(again.data.settings.customReplies, []);
  assert.equal(again.data.settings.useCustomReplies, false);
  assert.deepEqual(again.data.settings.customFollowups, []);
  assert.equal(again.data.settings.useCustomFollowups, false);
  again.data.hiddenProfileIds = ["1795695767353204736"];
  again.save();
  const restored = new Store(file);
  assert.deepEqual(restored.data.hiddenProfileIds, ["1795695767353204736"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("warm-up input requires one business inbox and a gap between sends", () => {
  const errors = validateWarmupInput({
    email: "not-an-email",
    company: " ",
    clientName: "",
    accounts: [],
    intervalSeconds: 1,
  });
  assert.match(errors.join(" "), /business email/);
  assert.match(errors.join(" "), /company name/);
  assert.match(errors.join(" "), /client's name/);
  assert.match(errors.join(" "), /Gmail account/);
  assert.match(errors.join(" "), /Interval/);
  const withoutCv = validateWarmupInput({
    email: "pat@client.com",
    company: "Client Co",
    clientName: "Pat",
    accounts: [{
      ...account("a", "Alpha", "Ada"),
      cvPath: "D:\\no-such-mail-carrier-cv.pdf",
      mentionAttachment: true,
      scheduleSend: true,
      sendAt: Date.now(),
      contacts: [{ name: "Ann", email: "ann@example.com", company: "Aco" }],
    }],
    intervalSeconds: 3,
  });
  assert.deepEqual(withoutCv, []);
  const stripped = createWarmupCampaign({
    email: "pat@client.com",
    company: "Client Co",
    clientName: "Pat",
    accounts: [{
      ...account("a", "Alpha", "Ada"),
      cvPath: "D:\\resume.pdf",
      cvName: "resume.pdf",
      mentionAttachment: true,
    }],
    intervalSeconds: 3,
    includeAttach: true,
  });
  assert.equal(stripped.includeAttach, false);
  assert.equal(stripped.accounts[0].cvPath, "");
  assert.equal(stripped.accounts[0].mentionAttachment, false);
  const peerStripped = createPeerWarmupCampaign({
    intervalSeconds: 3,
    includeAttach: true,
    accounts: [
      { ...account("a", "Alpha", "Ada"), email: "a@gmail.com", mentionAttachment: true, cvPath: "C:\\resume.pdf", cvName: "resume.pdf" },
      { ...account("b", "Beta", "Bea"), email: "b@gmail.com", mentionAttachment: true },
    ],
  });
  assert.equal(peerStripped.includeAttach, false);
  assert.equal(peerStripped.accounts[0].mentionAttachment, false);
  assert.equal(peerStripped.accounts[0].cvPath, "");
  assert.deepEqual(validateWarmupInput({
    email: " pat@client.com ",
    company: "Client Co",
    clientName: "Pat",
    accounts: [account("a", "Alpha", "Ada")],
    intervalSeconds: 3,
  }), []);
});

test("warm-up sends only to the business inbox and keeps imported contacts", async () => {
  const store = memoryStore();
  store.data.contacts = [contact("Keep", "keep@example.com", "KeepCo")];
  const { runner, sent } = buildRunner({ store });
  const campaign = createWarmupCampaign({
    language: "en",
    intervalSeconds: 15,
    email: "pat@client.com",
    company: "Client Co",
    clientName: "Pat",
    accounts: [account("a", "Alpha", "Ada", 2), account("b", "Beta", "Bea", 1)],
  });
  const view = campaignView(campaign);
  assert.equal(campaign.kind, "warmup");
  assert.equal(campaign.status, "running");
  assert.equal(campaign.intervalMs, 15000);
  assert.equal(view.kind, "warmup");
  assert.equal(view.total, 2);
  assert.equal(campaign.accounts[0].limit, 1);
  assert.equal(campaign.accounts[1].limit, 1);
  assert.equal(view.currentRecipient, "pat@client.com");
  runner.start(campaign);
  await runner.loopPromise;
  assert.deepEqual(sent.map((item) => `${item.debugPort}:${item.contact.email}`), [
    "port-a:pat@client.com",
    "port-b:pat@client.com",
  ]);
  assert.match(sent[0].bodyHtml, /Hello Pat/);
  assert.match(sent[0].bodyHtml, /Ada/);
  assert.equal(/attach/i.test(sent[0].bodyText), false);
  assert.match(sent[1].bodyHtml, /Hello Pat/);
  assert.match(sent[1].bodyHtml, /Bea/);
  assert.equal(runner.campaign.status, "done");
  assert.equal(runner.campaign.sentTotal, 2);
  assert.equal(store.data.contacts.length, 1);
  assert.equal(store.data.contacts[0].email, "keep@example.com");
  assert.equal(store.data.history.sent, 2);
  assert.equal(store.data.sendLog.warmup["a@gmail.com"].sent, 1);
  assert.equal(store.data.sendLog.warmup["a@gmail.com"].replies, 0);
  assert.equal(store.data.sendLog.warmup["b@gmail.com"].sent, 1);
  assert.deepEqual(store.data.sendLog.followup, {});
  assert.deepEqual(store.data.sendLog.contacts, {});
});

test("stopping a warm-up keeps the contact list", async () => {
  const store = memoryStore();
  store.data.contacts = [contact("Keep", "keep@example.com", "KeepCo")];
  const { runner, sent } = buildRunner({ store, sleep: async () => false });
  runner.start(createWarmupCampaign({
    language: "en",
    intervalSeconds: 30,
    email: "pat@client.com",
    company: "Client Co",
    clientName: "Pat",
    accounts: [account("a", "Alpha", "Ada", 3), account("b", "Beta", "Bea", 3)],
  }));
  await runner.loopPromise;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].contact.email, "pat@client.com");
  assert.equal(runner.campaign.status, "stopped");
  assert.equal(runner.campaign.sentTotal, 1);
  assert.equal(store.data.contacts[0].email, "keep@example.com");
});

test("warm-up can resume after a pause without touching the contact list", async () => {
  let calls = 0;
  const store = memoryStore();
  store.data.contacts = [contact("Keep", "keep@example.com", "KeepCo")];
  const { runner } = buildRunner({
    store,
    gmail: {
      async sendGmail() {
        calls += 1;
        if (calls === 1) {
          const error = new Error("Sign in");
          error.fatal = true;
          throw error;
        }
      },
    },
  });
  runner.start(createWarmupCampaign({
    language: "en",
    intervalSeconds: 3,
    email: "pat@client.com",
    company: "Client Co",
    clientName: "Pat",
    accounts: [account("a", "Alpha", "Ada", 2)],
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "error");
  assert.equal(calls, 1);
  assert.equal(store.data.contacts[0].email, "keep@example.com");
  runner.resume();
  await runner.loopPromise;
  assert.equal(calls, 2);
  assert.equal(runner.campaign.status, "done");
  assert.equal(runner.campaign.sentTotal, 1);
  assert.equal(store.data.contacts[0].email, "keep@example.com");
});

test("warm-up inbox is kept in the store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-"));
  const file = path.join(dir, "state.json");
  const store = new Store(file);
  store.data.warmup.email = "pat@client.com";
  store.data.warmup.company = "Client Co";
  store.data.warmup.clientName = "Pat";
  store.data.warmup.intervalSeconds = 45;
  delete store.data.warmup.businesses;
  store.save();
  const again = new Store(file);
  assert.equal(again.data.warmup.email, "pat@client.com");
  assert.equal(again.data.warmup.company, "Client Co");
  assert.equal(again.data.warmup.clientName, "Pat");
  assert.equal(again.data.warmup.intervalSeconds, 45);
  assert.equal(again.data.warmup.peerIntervalSeconds, 600);
  assert.equal(again.data.warmup.peerPeriods, 1);
  const copied = warmupRecord({ intervalSeconds: 45, businesses: [] });
  assert.equal(copied.intervalSeconds, 45);
  assert.equal(copied.peerIntervalSeconds, 45);
  const separate = warmupRecord({ intervalSeconds: 45, peerIntervalSeconds: 90, businesses: [] });
  assert.equal(separate.intervalSeconds, 45);
  assert.equal(separate.peerIntervalSeconds, 90);
  assert.equal(again.data.warmup.businesses.length, 1);
  assert.equal(again.data.warmup.businesses[0].email, "pat@client.com");
  assert.equal(again.data.warmup.businesses[0].firstName, "Pat");
  assert.equal(again.data.warmup.businesses[0].company, "Client Co");
  assert.equal(again.data.warmup.selectedId, "legacy");
  assert.equal(again.data.settings.intervalSeconds, 600);
  again.data.warmup.businesses = businessesFromInput([
    { id: "pat", email: "pat@client.com", firstName: "Pat", company: "Client Co" },
    { id: "sam", email: "sam@other.com", firstName: "Sam", company: "Other Co" },
  ]);
  again.data.warmup.email = "pat@client.com";
  again.save();
  const listed = new Store(file);
  assert.equal(listed.data.warmup.businesses.length, 2);
  assert.equal(listed.data.warmup.businesses[1].firstName, "Sam");
  assert.equal(listed.data.warmup.selectedId, "");
  assert.equal(listed.data.warmup.email, "pat@client.com");
  listed.data.warmup.selectedId = "sam";
  listed.save();
  const picked = new Store(file);
  assert.equal(picked.data.warmup.selectedId, "sam");
  assert.equal(picked.data.warmup.email, "sam@other.com");
  assert.equal(picked.data.warmup.clientName, "Sam");
  assert.equal(picked.data.warmup.company, "Other Co");
  assert.throws(
    () => businessesFromInput([
      { email: "pat@client.com", firstName: "Pat", company: "Client Co" },
      { email: "Pat@client.com", firstName: "Sam", company: "Other Co" },
    ]),
    /already in the list/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("warm-up sends one email from each Gmail to the selected business", async () => {
  const { runner, sent } = buildRunner({});
  const businesses = [
    { id: "pat", email: "pat@client.com", firstName: "Pat", company: "Client Co" },
    { id: "sam", email: "sam@other.com", firstName: "Sam", company: "Other Co" },
  ];
  const campaign = createWarmupCampaign({
    language: "en",
    intervalSeconds: 3,
    selectedId: "sam",
    businesses,
    accounts: [account("a", "Alpha", "Ada", 9), account("b", "Beta", "Bea", 9)],
  });
  const view = campaignView(campaign);
  assert.equal(view.total, 2);
  assert.equal(view.currentRecipient, "sam@other.com");
  assert.equal(campaign.accounts[0].limit, 1);
  assert.equal(campaign.accounts[1].limit, 1);
  assert.equal(campaign.targets.length, 1);
  const errors = validateWarmupInput({
    businesses: [],
    accounts: [account("a", "Alpha", "Ada")],
    intervalSeconds: 3,
  });
  assert.match(errors.join(" "), /Add a business email/);
  assert.match(validateWarmupInput({
    businesses: [{ email: "pat@client.com", firstName: "", company: "Client Co" }],
    accounts: [account("a", "Alpha", "Ada")],
    intervalSeconds: 3,
  }).join(" "), /first name/);
  assert.match(validateWarmupInput({
    businesses,
    accounts: [account("a", "Alpha", "Ada")],
    intervalSeconds: 3,
  }).join(" "), /Select a business email/);
  assert.deepEqual(validateWarmupInput({
    selectedId: "sam",
    businesses,
    accounts: [account("a", "Alpha", "Ada")],
    intervalSeconds: 3,
  }), []);
  const solo = createWarmupCampaign({
    language: "en",
    intervalSeconds: 3,
    businesses: [businesses[0]],
    accounts: [account("a", "Alpha", "Ada", 4)],
  });
  assert.equal(solo.accounts[0].limit, 1);
  assert.equal(solo.target.email, "pat@client.com");
  runner.start(campaign);
  await runner.loopPromise;
  assert.deepEqual(sent.map((item) => `${item.contact.email}:${item.contact.name}`), [
    "sam@other.com:Sam",
    "sam@other.com:Sam",
  ]);
  assert.match(sent[0].bodyHtml, /Hello Sam/);
  assert.equal(runner.campaign.status, "done");
  assert.equal(runner.campaign.sentTotal, 2);
});

test("selected Gmail accounts warm each other up and keep the connection", async () => {
  const people = [
    { ...account("a", "Alpha", "Ada"), email: "a@gmail.com" },
    { ...account("b", "Beta", "Bea"), email: "b@gmail.com" },
    { ...account("c", "Gamma", "Cara"), email: "c@gmail.com" },
    { ...account("d", "Delta", "Dan"), email: "d@gmail.com" },
  ];
  assert.equal(nextPeer(people, 0, []).email, "b@gmail.com");
  let links = [];
  const order = [];
  people.forEach((person, index) => {
    const peer = nextPeer(people, index, links);
    order.push(`${person.senderName}->${peer.senderName}`);
    links = addConnection(links, person.email, peer.email);
  });
  assert.deepEqual(order, ["Ada->Bea", "Bea->Cara", "Cara->Dan", "Dan->Ada"]);
  assert.equal(nextPeer(people, 1, links).email, "d@gmail.com");
  assert.match(validatePeerWarmupInput({ accounts: [people[0]], intervalSeconds: 3 }).join(" "), /at least two/);
  const intro = peerIntro("Ada", "Bea", { subjectIndex: 1, templateIndex: 1, includeAttach: false });
  assert.equal(intro.subject, "Ready to Contribute to Metaroom (w-u)");
  assert.match(intro.bodyText, /^Hello Bea,/);
  assert.match(intro.bodyText, /Metaroom/);
  assert.match(intro.bodyText, /Ada/);
  assert.doesNotMatch(intro.bodyText, /introduce myself/);
  const remembered = repliesForMailbox([
    { fromEmail: "a@gmail.com", toEmail: "b@gmail.com", fromName: "Ada", subject: "Hello Bea" },
    { fromEmail: "c@gmail.com", toEmail: "b@gmail.com", fromName: "Cara", subject: "Hello Bea" },
    { fromEmail: "a@gmail.com", toEmail: "b@gmail.com", fromName: "Ada", subject: "Hello again" },
    { fromEmail: "a@gmail.com", toEmail: "d@gmail.com", fromName: "Ada", subject: "Hello Dan" },
  ], "B@gmail.com");
  assert.deepEqual(remembered.map((item) => `${item.fromEmail}:${item.subject}`), [
    "a@gmail.com:Hello Bea",
    "c@gmail.com:Hello Bea",
    "a@gmail.com:Hello again",
  ]);
  assert.equal(
    peerReply("Bea Example", 0),
    "Thanks for your email. Unfortunately we don't have any job position for you.\n\nBest luck for your search\nBea"
  );
  assert.equal(
    peerReply("Bea Example", 1),
    "There isn't any position for your application. Sorry for this. I will ping you if there is any update on my company.\n\nThanks,\nBea"
  );
  assert.equal(
    peerReply("Bea Example", 2),
    "Thanks for reaching out. Let me keep you on my mind if there is any update for you.\n\nGood luck,\nBea"
  );
  assert.equal(
    peerReply("Bea Example", 3),
    "Thanks. But I'm not interested.\n\nBest regards\nBea"
  );

  const sent = [];
  const replies = [];
  const waits = [];
  const store = memoryStore();
  store.data.contacts = [contact("Keep", "keep@example.com", "KeepCo")];
  store.data.gmailConnections = [];
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async sendGmail(request) {
        sent.push(request);
      },
      async replyAllWarmupThreads(request) {
        const replied = [];
        for (const thread of request.threads || []) {
          replies.push({
            mailboxEmail: request.mailboxEmail,
            fromEmail: thread.fromEmail,
            subject: thread.subject,
            bodyText: request.pickBody(thread),
            content: request.marker,
          });
          replied.push({ fromEmail: thread.fromEmail, subject: thread.subject, folder: "inbox" });
        }
        return { replied };
      },
    },
    store,
    sleep: async (ms) => {
      waits.push(ms);
      return true;
    },
  });
  runner.start(createPeerWarmupCampaign({
    intervalSeconds: 3,
    accounts: people,
    connections: [],
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.deepEqual(sent.map((item) => `${item.fromEmail}:${item.contact.email}`), [
    "a@gmail.com:b@gmail.com",
    "b@gmail.com:c@gmail.com",
    "c@gmail.com:d@gmail.com",
    "d@gmail.com:a@gmail.com",
  ]);
  assert.equal(sent[0].cvPath, "");
  assert.equal(sent[0].contact.company, "Metaroom");
  assert.match(sent[0].bodyText, /^Hello Bea,/);
  assert.match(sent[0].bodyText, /Ada/);
  assert.equal(/attach/i.test(sent[0].bodyText), false);
  assert.doesNotMatch(sent[0].bodyText, /introduce myself/);
  assert.deepEqual(replies.map((item) => `${item.mailboxEmail}:${item.fromEmail}`), [
    "a@gmail.com:d@gmail.com",
    "b@gmail.com:a@gmail.com",
    "c@gmail.com:b@gmail.com",
    "d@gmail.com:c@gmail.com",
  ]);
  assert.match(replies[1].bodyText, /Bea$/);
  assert.doesNotMatch(replies[1].bodyText, /Dear Ada/);
  assert.doesNotMatch(sent[0].subject, /MC-/);
  assert.match(sent[0].subject, / \(w-u\)$/);
  assert.equal(replies[1].content, "(w-u)");
  assert.equal(replies[1].subject, sent[0].subject);
  assert.equal(store.data.gmailConnections.length, 4);
  assert.equal(store.data.contacts[0].email, "keep@example.com");
  assert.equal(runner.campaign.replyTotal, 4);
  assert.equal(waits[3], 15000);
  assert.equal(runner.campaign.periods, 1);
});

test("a custom warm-up index replaces (w-u) on the subject and the reply search", async () => {
  assert.equal(warmupMarkerFrom({ useCustomWarmupIndex: false, warmupIndex: "hello" }), "(w-u)");
  assert.equal(warmupMarkerFrom({ useCustomWarmupIndex: true, warmupIndex: "hello" }), "(hello)");
  assert.equal(warmupMarkerFrom({ useCustomWarmupIndex: true, warmupIndex: "(abc)" }), "(abc)");
  assert.equal(warmupMarkerFrom({ useCustomWarmupIndex: true, warmupIndex: "  " }), "");
  const missing = validatePeerWarmupInput({
    intervalSeconds: 3,
    periods: 1,
    useCustomWarmupIndex: true,
    warmupIndex: "",
    accounts: [
      { ...account("a", "Alpha", "Ada"), email: "a@gmail.com" },
      { ...account("b", "Beta", "Bea"), email: "b@gmail.com" },
    ],
  });
  assert.equal(missing.some((item) => /index/i.test(item)), true);
  const sent = [];
  const replies = [];
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async sendGmail(request) {
        sent.push(request);
      },
      async replyAllWarmupThreads(request) {
        replies.push(request.marker);
        return { replied: [] };
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  runner.start(createPeerWarmupCampaign({
    intervalSeconds: 3,
    periods: 1,
    useCustomWarmupIndex: true,
    warmupIndex: "hello",
    accounts: [
      { ...account("a", "Alpha", "Ada"), email: "a@gmail.com" },
      { ...account("b", "Beta", "Bea"), email: "b@gmail.com" },
    ],
    connections: [],
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.equal(runner.campaign.warmupMarker, "(hello)");
  assert.match(sent[0].subject, / \(hello\)$/);
  assert.equal(sent[0].subject.includes("(w-u)"), false);
  assert.equal(replies[0], "(hello)");
});

test("a gmail warm-up repeats the send and reply period", async () => {
  const people = [
    { ...account("a", "Alpha", "Ada"), email: "a@gmail.com" },
    { ...account("b", "Beta", "Bea"), email: "b@gmail.com" },
    { ...account("c", "Gamma", "Cara"), email: "c@gmail.com" },
    { ...account("d", "Delta", "Dan"), email: "d@gmail.com" },
  ];
  assert.match(validatePeerWarmupInput({ accounts: people, intervalSeconds: 3, periods: 0 }).join(" "), /Periods/);
  const sent = [];
  const replies = [];
  const waits = [];
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async sendGmail(request) {
        sent.push(request);
      },
      async replyAllWarmupThreads(request) {
        const replied = [];
        for (const thread of request.threads || []) {
          replies.push({
            mailboxEmail: request.mailboxEmail,
            fromEmail: thread.fromEmail,
            subject: thread.subject,
          });
          replied.push({ fromEmail: thread.fromEmail, subject: thread.subject, folder: "inbox" });
        }
        return { replied };
      },
    },
    store: memoryStore(),
    sleep: async (ms) => {
      waits.push(ms);
      return true;
    },
  });
  runner.start(createPeerWarmupCampaign({
    intervalSeconds: 3,
    periods: 2,
    accounts: people,
    connections: [],
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.equal(runner.campaign.period, 2);
  assert.deepEqual(sent.map((item) => `${item.fromEmail}:${item.contact.email}`), [
    "a@gmail.com:b@gmail.com",
    "b@gmail.com:c@gmail.com",
    "c@gmail.com:d@gmail.com",
    "d@gmail.com:a@gmail.com",
    "a@gmail.com:c@gmail.com",
    "b@gmail.com:d@gmail.com",
    "c@gmail.com:a@gmail.com",
    "d@gmail.com:b@gmail.com",
  ]);
  assert.deepEqual(replies.map((item) => `${item.mailboxEmail}:${item.fromEmail}`), [
    "a@gmail.com:d@gmail.com",
    "b@gmail.com:a@gmail.com",
    "c@gmail.com:b@gmail.com",
    "d@gmail.com:c@gmail.com",
    "a@gmail.com:c@gmail.com",
    "b@gmail.com:d@gmail.com",
    "c@gmail.com:a@gmail.com",
    "d@gmail.com:b@gmail.com",
  ]);
  assert.equal(waits.filter((ms) => ms === 15000).length, 2);
  assert.equal(runner.store.data.gmailConnections.length, 6);
});

test("one period sends at most 3 warm-up emails to the same Gmail", async () => {
  const people = ["a", "b", "c", "d", "e"].map((id, index) => ({
    ...account(id, `Box ${index}`, id.toUpperCase()),
    email: `${id}@gmail.com`,
  }));
  const links = [
    "a@gmail.com|b@gmail.com",
    "a@gmail.com|c@gmail.com",
    "a@gmail.com|d@gmail.com",
    "b@gmail.com|c@gmail.com",
    "b@gmail.com|d@gmail.com",
    "c@gmail.com|d@gmail.com",
  ];
  assert.equal(nextPeer(people, 0, links).email, "e@gmail.com");
  assert.equal(nextPeer(people, 3, links, {
    receiveLimit: 3,
    deliveries: [
      { toEmail: "e@gmail.com" },
      { toEmail: "e@gmail.com" },
      { toEmail: "e@gmail.com" },
    ],
  }), null);
  assert.equal(nextPeer(people, 0, [], {
    receiveLimit: 3,
    deliveries: [
      { toEmail: "b@gmail.com" },
      { toEmail: "b@gmail.com" },
      { toEmail: "b@gmail.com" },
    ],
  }).email, "c@gmail.com");

  const sent = [];
  const logs = [];
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async sendGmail(request) {
        sent.push(`${request.fromEmail}:${request.contact.email}`);
      },
      async replyAllWarmupThreads(request) {
        return {
          replied: (request.threads || []).map((thread) => ({
            fromEmail: thread.fromEmail,
            subject: thread.subject,
            folder: "inbox",
          })),
        };
      },
    },
    store: memoryStore(),
    sleep: async () => true,
    onLog: (_level, message) => logs.push(message),
  });
  runner.start(createPeerWarmupCampaign({
    intervalSeconds: 3,
    periods: 1,
    accounts: people,
    connections: links,
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.deepEqual(sent, [
    "a@gmail.com:e@gmail.com",
    "b@gmail.com:e@gmail.com",
    "c@gmail.com:e@gmail.com",
    "e@gmail.com:a@gmail.com",
  ]);
  const received = sent.filter((item) => item.endsWith(":e@gmail.com"));
  assert.equal(received.length, 3);
  assert.match(logs.join(" "), /already has 3 warm-up emails/);
});

test("a sender emails another Gmail when the next one already has 3 this period", async () => {
  const people = ["a", "b", "c", "d", "e", "f"].map((id) => ({
    ...account(id, `Box ${id}`, id.toUpperCase()),
    email: `${id}@gmail.com`,
  }));
  const links = [
    "a@gmail.com|b@gmail.com",
    "a@gmail.com|c@gmail.com",
    "b@gmail.com|c@gmail.com",
    "f@gmail.com|a@gmail.com",
    "f@gmail.com|b@gmail.com",
    "f@gmail.com|c@gmail.com",
  ];
  assert.equal(nextPeer(people, 5, links, {
    receiveLimit: 3,
    deliveries: [
      { toEmail: "d@gmail.com" },
      { toEmail: "d@gmail.com" },
      { toEmail: "d@gmail.com" },
      { toEmail: "e@gmail.com" },
    ],
  }).email, "e@gmail.com");

  const sent = [];
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async sendGmail(request) {
        sent.push(`${request.fromEmail}:${request.contact.email}`);
      },
      async replyAllWarmupThreads(request) {
        return {
          replied: (request.threads || []).map((thread) => ({
            fromEmail: thread.fromEmail,
            subject: thread.subject,
            folder: "inbox",
          })),
        };
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  runner.start(createPeerWarmupCampaign({
    intervalSeconds: 3,
    periods: 1,
    accounts: people,
    connections: links,
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.deepEqual(sent, [
    "a@gmail.com:d@gmail.com",
    "b@gmail.com:d@gmail.com",
    "c@gmail.com:d@gmail.com",
    "d@gmail.com:e@gmail.com",
    "e@gmail.com:f@gmail.com",
    "f@gmail.com:e@gmail.com",
  ]);
  assert.equal(sent.filter((item) => item.endsWith(":d@gmail.com")).length, 3);
  assert.equal(sent.some((item) => item.startsWith("f@gmail.com:")), true);
});

test("a mailbox replies to every warm-up email received in the period", async () => {
  const people = [
    { ...account("a", "Alpha", "Ada"), email: "a@gmail.com" },
    { ...account("b", "Beta", "Bea"), email: "b@gmail.com" },
    { ...account("c", "Gamma", "Cara"), email: "c@gmail.com" },
  ];
  const replies = [];
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async sendGmail() {},
      async replyAllWarmupThreads(request) {
        const replied = [];
        for (const thread of request.threads || []) {
          replies.push(`${request.mailboxEmail}:${thread.fromEmail}:${thread.subject}`);
          replied.push({ fromEmail: thread.fromEmail, subject: thread.subject, folder: "inbox" });
        }
        return { replied };
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  runner.start(createPeerWarmupCampaign({
    intervalSeconds: 3,
    periods: 1,
    accounts: people,
    connections: ["a@gmail.com|c@gmail.com"],
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.deepEqual(replies.filter((item) => item.startsWith("b@gmail.com:")), [
    replies.find((item) => item.startsWith("b@gmail.com:a@gmail.com:")),
    replies.find((item) => item.startsWith("b@gmail.com:c@gmail.com:")),
  ]);
  assert.equal(replies.filter((item) => item.startsWith("b@gmail.com:")).length, 2);
  assert.ok(runner.store.data.sendLog.warmup["a@gmail.com"].sent >= 1);
  assert.ok(runner.store.data.sendLog.warmup["b@gmail.com"].replies >= 1);
  assert.deepEqual(runner.store.data.sendLog.followup, {});
  assert.deepEqual(runner.store.data.sendLog.contacts, {});
});

test("a gmail warm-up error continues with the next Gmail", async () => {
  const people = [
    { ...account("a", "Alpha", "Ada"), email: "a@gmail.com" },
    { ...account("b", "Beta", "Bea"), email: "b@gmail.com" },
    { ...account("c", "Gamma", "Cara"), email: "c@gmail.com" },
  ];
  const sent = [];
  const replies = [];
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async sendGmail(request) {
        if (request.fromEmail === "b@gmail.com") {
          const error = new Error("Compose did not open.");
          error.fatal = true;
          throw error;
        }
        sent.push(request.fromEmail);
      },
      async replyAllWarmupThreads(request) {
        if (request.mailboxEmail === "c@gmail.com") throw new Error("Search did not open.");
        replies.push(request.mailboxEmail);
        return { replied: [{ fromEmail: "x@gmail.com", subject: "Hi (w-u)" }] };
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  runner.start(createPeerWarmupCampaign({
    intervalSeconds: 3,
    periods: 1,
    accounts: people,
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.deepEqual(sent, ["a@gmail.com", "c@gmail.com"]);
  assert.deepEqual(replies, ["a@gmail.com", "b@gmail.com"]);
  assert.equal(runner.campaign.sentTotal, 2);
  assert.equal(runner.campaign.replyTotal, 2);
  assert.equal(runner.store.data.gmailConnections.some((item) => item.includes("b@gmail.com") && item.includes("c@gmail.com")), false);
});

test("warm-up screen exposes the business inbox fields", () => {
  const html = fs.readFileSync(path.join(root, "desktop", "renderer", "index.html"), "utf8");
  for (const id of ["warmup-email", "warmup-company", "warmup-client", "warmup-interval", "warmup-start", "warmup-list", "warmup-add", "warmup-cancel", "warmup-empty", "tab-warmup", "tab-peer", "tab-followup", "tab-contacts", "pane-warmup", "pane-peer", "pane-followup", "pane-contacts", "peer-interval", "peer-periods", "use-custom-warmup-index", "warmup-index", "custom-warmup-index-editor", "custom-reply-input", "custom-reply-add", "custom-reply-import", "custom-reply-sample", "custom-reply-list", "custom-reply-editor", "use-custom-replies", "use-custom-templates-warmup", "use-custom-templates-peer", "use-custom-followups", "custom-followup-editor", "custom-followup-input", "custom-followup-add", "custom-followup-import", "custom-followup-sample", "custom-followup-list", "followup-date", "followup-body", "followup-interval", "followup-start", "tab-analyse", "pane-analyse", "analyse-from", "analyse-to", "analyse-limit", "analyse-start", "analyse-modal", "analyse-modal-close", "status-pick", "mention-attachment", "use-custom-templates", "custom-template-editor", "custom-subject-input", "custom-subject-add", "custom-subject-import", "custom-subject-list", "custom-body-input", "custom-body-add", "custom-body-import", "custom-template-sample", "custom-body-list", "warmup-mention-attachment", "peer-warmup-start", "peer-clear-connections", "peer-show-connections", "connections-modal", "connections-close", "connections-table", "between-accounts"]) {
    assert.equal(html.includes(`id="${id}"`), true, id);
  }
  for (const id of ["schedule-anchor", "schedule-gap", "apply-schedule", "status-mode-file", "status-pick-file", "status-file-name", "settings-open", "settings-modal", "status-url", "status-load", "status-cancel"]) {
    assert.equal(html.includes(`id="${id}"`), false, id);
  }
  assert.match(html, /First name/);
  assert.match(html, /Add business/);
  assert.match(html, /pick one recipient, then start/);
  assert.match(html, /Click a Gmail to see its send record/);
  assert.match(html, /including replies/);
  assert.equal(html.includes('id="send-log-modal"'), true);
  assert.equal(html.includes('id="activity-resize"'), true);
  assert.match(html, /\{sender\}/);
  const warmupPane = html.slice(html.indexOf('id="pane-warmup"'), html.indexOf('id="pane-peer"'));
  const peerPane = html.slice(html.indexOf('id="pane-peer"'), html.indexOf('id="pane-followup"'));
  const followupPane = html.slice(html.indexOf('id="pane-followup"'), html.indexOf('id="pane-contacts"'));
  assert.equal(warmupPane.includes("peer-connections"), false);
  assert.equal(warmupPane.includes("warmup-email"), true);
  assert.equal(peerPane.includes("peer-connections"), true);
  assert.equal(peerPane.includes("warmup-email"), false);
  assert.equal(followupPane.includes("followup-body"), true);
  assert.equal(followupPane.includes('id="followup-date"'), true);
  assert.equal(followupPane.includes("mention-attachment"), false);
  assert.equal(followupPane.includes("use-custom-templates"), false);
  assert.equal(followupPane.includes("warmup-email"), false);
  assert.equal(html.includes("<footer"), false);
  const renderer = fs.readFileSync(path.join(root, "desktop", "renderer", "renderer.js"), "utf8");
  assert.equal(renderer.includes("status-select"), true);
  assert.equal(renderer.includes("progress-gap-input"), true);
  assert.equal(renderer.includes("progress-interval-input"), true);
  assert.equal(renderer.includes("Seconds between Gmail accounts"), true);
  assert.equal(renderer.includes("use-send-time"), true);
  assert.equal(renderer.includes('getElementById("followup-date")'), true);
  assert.equal(renderer.includes("followup-date-line"), true);
  assert.equal(renderer.includes("Today sent :"), true);
  assert.equal(renderer.includes("total sent"), true);
  assert.equal(renderer.includes("total reply"), true);
  assert.equal(renderer.includes("Selected date"), true);
  assert.equal(renderer.includes("Send date"), true);
  assert.equal(renderer.includes("send-log-open"), true);
  assert.equal(renderer.includes("saveWarmupDraft"), true);
  assert.equal(renderer.includes("deleteWarmupBusiness"), true);
  assert.equal(renderer.includes("selectWarmupBusiness"), true);
  assert.equal(renderer.includes("startFollowup"), true);
  assert.equal(renderer.includes("addCustomTemplate"), true);
});

test("follow-up templates replace {sender} and search sent mail by day", () => {
  assert.equal(normalizeFollowupDay("2026-11-10"), "2026-11-10");
  assert.equal(normalizeFollowupDay("2026-13-40"), "");
  assert.equal(followupSentQuery("2026-11-10"), "in:sent after:2026/11/10 before:2026/11/11");
  assert.equal(
    applyFollowupTemplate("Thanks again.\n\nBest,\n{sender}", "Ada Lovelace"),
    "Thanks again.\n\nBest,\nAda"
  );
  assert.deepEqual(validateFollowupInput({
    accounts: [{ email: "a@gmail.com", senderName: "Ada", limit: 3, envName: "Alpha" }],
    date: "2026-11-10",
    body: "Hello {sender}",
    intervalSeconds: 30,
  }), []);
  assert.deepEqual(validateFollowupInput({
    accounts: [{ email: "a@gmail.com", senderName: "Ada", followupDate: "2026-11-09", limit: 3, envName: "Alpha" }],
    date: "",
    body: "Hello {sender}",
    intervalSeconds: 30,
  }), []);
  assert.match(validateFollowupInput({
    accounts: [{ email: "a@gmail.com", senderName: "Ada", limit: 3, envName: "Alpha" }],
    date: "",
    body: "Hello",
    intervalSeconds: 30,
  }).join(" "), /sent date/i);
  const saved = followupRecord({ body: "Ping {sender}", intervalSeconds: 45, date: "2026-11-10" });
  assert.equal(saved.body, "Ping {sender}");
  assert.equal(saved.intervalSeconds, 45);
  assert.equal(saved.date, "2026-11-10");
  const selection = selectionRecord({ selected: true, selectedByTab: { followup: false } }, {});
  assert.equal(selection.followup, false);
  assert.equal(selection.warmup, true);
  const pref = mergeAccountPref({}, {
    selected: true,
    selectedByTab: { warmup: false, peer: false, contacts: false, followup: true },
    senderName: "Ada",
    limit: 5,
    followupDate: "2026-11-10",
  });
  assert.equal(pref.followupDate, "2026-11-10");
  assert.equal(pref.selectedByTab.followup, true);
  const campaign = createFollowupCampaign({
    accounts: [
      { envId: "a", envName: "Alpha", senderName: "Ada", email: "a@gmail.com", followupDate: "2026-11-09", limit: 1 },
      { envId: "b", envName: "Beta", senderName: "Bea", email: "b@gmail.com", limit: 1 },
    ],
    date: "2026-11-10",
    body: "Hello {sender}",
    intervalSeconds: 3,
  });
  assert.equal(campaign.accounts[0].followupDate, "2026-11-09");
  assert.equal(campaign.accounts[1].followupDate, "2026-11-10");
});

test("each job keeps its own max and gmail warm-up does not use it", async () => {
  const shared = mergeAccountPref({}, {
    selected: true,
    senderName: "Ada",
    limit: 20,
    email: "ada@gmail.com",
  }, 20);
  assert.equal(shared.limit, 20);
  assert.deepEqual(shared.limitByTab, { warmup: 20, contacts: 20, followup: 20, analyse: 20 });
  const contacts = mergeAccountPref(shared, {
    selected: true,
    senderName: "Ada",
    limit: 10,
    limitTab: "contacts",
    email: "ada@gmail.com",
  }, 20);
  assert.equal(contacts.limitByTab.contacts, 10);
  assert.equal(contacts.limitByTab.warmup, 20);
  assert.equal(contacts.limitByTab.followup, 20);
  assert.equal(contacts.limitByTab.analyse, 20);
  const followupPref = mergeAccountPref(contacts, {
    selected: true,
    senderName: "Ada",
    limit: 3,
    limitTab: "followup",
    email: "ada@gmail.com",
  }, 20);
  assert.equal(followupPref.limitByTab.followup, 3);
  assert.equal(followupPref.limitByTab.contacts, 10);
  assert.equal(followupPref.limitByTab.warmup, 20);
  const leaked = mergeAccountPref(followupPref, {
    selected: true,
    senderName: "Ada",
    limit: 8,
    email: "ada@gmail.com",
  }, 20);
  assert.equal(leaked.limitByTab.contacts, 10);
  assert.equal(leaked.limitByTab.followup, 3);
  assert.equal(leaked.limitByTab.warmup, 20);
  assert.equal(leaked.limitByTab.analyse, 20);

  const sending = createCampaign({
    language: "en",
    intervalSeconds: 3,
    contacts: [contact("Ann", "ann@example.com", "Aco")],
    accounts: [{
      ...account("a", "Alpha", "Ada", 8),
      limitByTab: { contacts: 2, followup: 5, warmup: 9, analyse: 4 },
    }],
  });
  assert.equal(sending.accounts[0].limit, 2);
  const followup = createFollowupCampaign({
    date: "2026-11-10",
    body: "Hello",
    intervalSeconds: 3,
    accounts: [{
      envId: "a",
      envName: "Alpha",
      senderName: "Ada",
      email: "a@gmail.com",
      limit: 8,
      limitByTab: { contacts: 2, followup: 5, warmup: 9 },
    }],
  });
  assert.equal(followup.accounts[0].limit, 5);

  const people = [
    { ...account("a", "Alpha", "Ada", 1), email: "a@gmail.com", limitByTab: { contacts: 10 } },
    { ...account("b", "Beta", "Bea", 1), email: "b@gmail.com" },
    { ...account("c", "Gamma", "Cara", 1), email: "c@gmail.com" },
    { ...account("d", "Delta", "Dan", 1), email: "d@gmail.com" },
  ];
  const peer = createPeerWarmupCampaign({
    intervalSeconds: 3,
    periods: 2,
    accounts: people,
  });
  assert.equal(peer.accounts[0].limit, undefined);
  assert.equal(campaignView(peer).accounts[0].done, false);
  assert.equal(campaignView(peer).accounts[0].limit, undefined);
  for (const item of peer.accounts) item.limit = 1;
  const sent = [];
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async sendGmail(request) {
        sent.push(request.fromEmail);
      },
      async replyAllWarmupThreads() {
        return { replied: [{ fromEmail: "x@gmail.com", subject: "Hi (w-u)" }] };
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  runner.start(peer);
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.equal(sent.length, 8);
  assert.equal(sent.filter((email) => email === "a@gmail.com").length, 2);
});

function runFollowupSearchState(document) {
  return vm.runInNewContext(`
    ${followupSearchSnapshotInPage.toString()}
    ${followupSearchSettledInPage.toString()}
    followupSearchSettledInPage()
  `, {
    document,
    window: {
      getComputedStyle() {
        return { visibility: "visible", display: "block", opacity: "1" };
      },
    },
  });
}

test("follow-up search waits while Gmail is still loading results", () => {
  const visibleBar = {
    nodeType: 1,
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
  };
  const loading = runFollowupSearchState({
    querySelectorAll(selector) {
      if (String(selector).includes("progressbar")) return [visibleBar];
      return [];
    },
    querySelector() {
      return null;
    },
    body: { innerText: "Loading..." },
  });
  assert.equal(loading, "loading");
  const row = {
    getAttribute: () => "threadabc123",
    querySelector: () => ({ textContent: "Job note" }),
  };
  const rows = runFollowupSearchState({
    querySelectorAll(selector) {
      return selector === "tr.zA" ? [row] : [];
    },
    querySelector() {
      return null;
    },
    body: { innerText: "Searching the mailbox" },
  });
  assert.equal(rows, "rows");
  const stillLoadingMore = vm.runInNewContext(`
    ${followupSearchSnapshotInPage.toString()}
    followupSearchSnapshotInPage()
  `, {
    document: {
      querySelectorAll(selector) {
        if (selector === "tr.zA") return [row];
        if (String(selector).includes("progressbar")) return [visibleBar];
        return [];
      },
      querySelector() {
        return null;
      },
      body: { innerText: "Loading..." },
    },
    window: {
      getComputedStyle() {
        return { visibility: "visible", display: "block", opacity: "1" };
      },
    },
  });
  assert.equal(stillLoadingMore.state, "rows");
  assert.equal(stillLoadingMore.count, 1);
  const empty = runFollowupSearchState({
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    body: { innerText: "No messages matched your search." },
  });
  assert.equal(empty, "empty");
  const query = "in:sent after:2026/11/10 before:2026/11/11";
  const url = gmailSearchUrl(0, query);
  assert.equal(followupResultsAlreadyOpen(url, query), true);
  assert.equal(followupResultsAlreadyOpen(`${url}/threadabc123`, query), false);
  assert.equal(followupResultsAlreadyOpen("https://mail.google.com/mail/u/0/#inbox", query), false);
});

test("follow-up replies only to one-message sent threads", async () => {
  function mailRow(subject, email, count, sent, extras = {}) {
    const toLabel = extras.toLabel || (sent ? `To: ${email || "Someone"}` : "Ada");
    const snippet = extras.snippet || "";
    const threadId = extras.threadId || "";
    return {
      getAttribute(name) {
        if (name === "data-legacy-thread-id") return threadId;
        if (name === "data-thread-id") return threadId ? `#${threadId}` : "";
        return "";
      },
      getBoundingClientRect() {
        return { width: 400, height: 24, left: 8, top: 20 };
      },
      querySelector(selector) {
        if (selector === ".bog" || selector === ".bqe" || selector === ".y6") return { textContent: subject };
        if (selector === ".yW [email]" || selector === "[email]") {
          return email ? { getAttribute: (name) => (name === "email" ? email : "") } : null;
        }
        if (selector === ".yW") return { innerText: toLabel, textContent: toLabel };
        if (selector === ".y2" || selector === ".xT .y2") return snippet ? { textContent: snippet } : null;
        if (selector === ".bx0") {
          return count > 1 ? { textContent: String(count), getAttribute: () => "" } : null;
        }
        if (selector === "[aria-label*='message'], [aria-label*='Message']" || selector === "[aria-label*='message']") {
          return extras.messageLabel
            ? { textContent: extras.messageLabel, getAttribute: () => extras.messageLabel }
            : null;
        }
        if (selector === "[data-legacy-thread-id], [data-thread-id]") return null;
        if (selector === "input[type='checkbox'][value], input[name='t'][value]") return null;
        return null;
      },
    };
  }
  const oneSent = mailRow("Job note", "client@co.com", 1, true, { threadId: "t1", snippet: "Hello client" });
  const oneNoToPrefix = mailRow("Job note again", "other@co.com", 1, false, { threadId: "t2", snippet: "Hello other" });
  const timedOne = mailRow("Still one message", "late@co.com", 1, true, { threadId: "t5", messageLabel: "Opened message 3:41 PM" });
  const twoMessages = mailRow("Already followed", "client@co.com", 2, true, { threadId: "t3" });
  const threeMessages = mailRow("Conversation", "client@co.com", 3, true, { threadId: "t4" });
  const labeledMany = mailRow("Grouped", "late@co.com", 1, true, { threadId: "t6", messageLabel: "3 messages" });
  const document = {
    querySelectorAll(selector) {
      return selector === "tr.zA" ? [oneSent, oneNoToPrefix, timedOne, twoMessages, threeMessages, labeledMany] : [];
    },
  };
  const rows = vm.runInNewContext(`(${followupThreadListInPage.toString()})()`, { document });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].count, 1);
  assert.equal(rows[0].subject, "Job note");
  assert.equal(rows[0].threadId, "t1");
  assert.equal(rows[1].count, 1);
  assert.equal(rows[1].subject, "Job note again");
  assert.equal(rows[2].threadId, "t5");
  const sameSubject = [
    mailRow("Job note", "a@co.com", 1, true, { threadId: "ta", toLabel: "To: Ann", snippet: "Hi Ann" }),
    mailRow("Job note", "b@co.com", 1, true, { threadId: "tb", toLabel: "To: Bea", snippet: "Hi Bea" }),
    mailRow("Job note", "c@co.com", 1, true, { threadId: "tc", toLabel: "To: Cy", snippet: "Hi Cy" }),
  ];
  const sameSubjectRows = vm.runInNewContext(`(${followupThreadListInPage.toString()})()`, {
    document: {
      querySelectorAll(selector) {
        return selector === "tr.zA" ? sameSubject : [];
      },
    },
  });
  assert.equal(sameSubjectRows.length, 3);
  const identities = sameSubjectRows.map((row) => followupRowIdentity(row));
  assert.equal(new Set(identities).size, 3);
  assert.equal(followupRowIdentity(sameSubjectRows[0]), "id:ta");
  const subject = {
    textContent: "Job note",
    getBoundingClientRect() {
      return { left: 420, top: 180, width: 240, height: 18 };
    },
    scrollIntoView() {
      subject.scrolled = true;
    },
  };
  const sentRow = {
    getAttribute(name) {
      if (name === "data-legacy-thread-id") return "threadabc123";
      return "";
    },
    querySelector(selector) {
      if (selector === ".bog" || selector === ".bqe" || selector === ".y6") return subject;
      return null;
    },
    getBoundingClientRect() {
      return { left: 8, top: 20, width: 400, height: 24 };
    },
  };
  const point = vm.runInNewContext(`(${followupOpenPointInPage.toString()})("threadabc123", 0)`, {
    document: {
      querySelectorAll(selector) {
        return selector === "tr.zA" ? [sentRow] : [];
      },
    },
  });
  assert.equal(subject.scrolled, true);
  assert.equal(point.x, 540);
  assert.equal(point.y, 189);
  let hash = "#search/in%3Asent+after%3A2026%2F11%2F10+before%3A2026%2F11%2F11";
  const location = {
    get hash() {
      return hash;
    },
    set hash(value) {
      hash = value;
    },
  };
  const openedHash = vm.runInNewContext(`(${openFollowupThreadHashInPage.toString()})("threadabc123")`, { location });
  assert.equal(openedHash, "#search/in%3Asent+after%3A2026%2F11%2F10+before%3A2026%2F11%2F11/threadabc123");
  assert.equal(hash, openedHash);
  assert.equal(vm.runInNewContext(`(${openFollowupThreadHashInPage.toString()})(":1v")`, { location }), "");
  const mine = vm.runInNewContext(`(${openedMessagesFromMailboxInPage.toString()})("me@gmail.com")`, {
    document: {
      querySelectorAll(selector) {
        if (selector !== "div.adn") return [];
        return [
          { querySelector: () => ({ getAttribute: (name) => (name === "email" ? "me@gmail.com" : ""), textContent: "me" }) },
          { querySelector: () => ({ getAttribute: (name) => (name === "email" ? "me@gmail.com" : ""), textContent: "me" }) },
        ];
      },
      querySelector() {
        return null;
      },
    },
  });
  assert.equal(mine.count, 2);
  assert.equal(mine.ready, true);
  assert.equal(mine.allMine, true);
  const asMe = vm.runInNewContext(`(${openedMessagesFromMailboxInPage.toString()})("me@gmail.com")`, {
    document: {
      querySelectorAll(selector) {
        if (selector !== "div.adn") return [];
        return [
          { querySelector: () => ({ getAttribute: () => "", textContent: "me" }) },
        ];
      },
      querySelector() {
        return null;
      },
    },
  });
  assert.equal(asMe.count, 1);
  assert.equal(asMe.ready, true);
  assert.equal(asMe.allMine, true);
  const mixed = vm.runInNewContext(`(${openedMessagesFromMailboxInPage.toString()})("me@gmail.com")`, {
    document: {
      querySelectorAll(selector) {
        if (selector !== "div.adn") return [];
        return [
          { querySelector: () => ({ getAttribute: (name) => (name === "email" ? "me@gmail.com" : ""), textContent: "me" }) },
          { querySelector: () => ({ getAttribute: (name) => (name === "email" ? "client@co.com" : ""), textContent: "Client" }) },
        ];
      },
      querySelector() {
        return null;
      },
    },
  });
  assert.equal(mixed.allMine, false);
  assert.equal(mixed.ready, true);
  const withDraft = vm.runInNewContext(`(${openedMessagesFromMailboxInPage.toString()})("me@gmail.com")`, {
    document: {
      querySelectorAll(selector) {
        if (selector !== "div.adn") return [];
        return [
          {
            querySelector() {
              return { getAttribute: (name) => (name === "email" ? "me@gmail.com" : ""), textContent: "me" };
            },
            querySelectorAll() {
              return [];
            },
          },
          {
            querySelector(selectorText) {
              if (String(selectorText).includes("Discard draft")) {
                return { getAttribute: (name) => (name === "aria-label" ? "Discard draft" : "") };
              }
              return { getAttribute: (name) => (name === "email" ? "me@gmail.com" : ""), textContent: "me" };
            },
            querySelectorAll() {
              return [{ textContent: "Draft" }];
            },
          },
        ];
      },
      querySelector() {
        return null;
      },
    },
  });
  assert.equal(withDraft.count, 1);
  assert.equal(withDraft.drafts, 1);
  assert.equal(withDraft.allMine, true);
  const clicked = [];
  const draftDom = {
    document: {
      querySelectorAll(selector) {
        const text = String(selector);
        if (text.includes("Discard draft")) {
          return [{
            nodeType: 1,
            getAttribute: (name) => (name === "aria-label" ? "Discard draft" : ""),
            getBoundingClientRect: () => ({ width: 24, height: 24 }),
            closest: () => null,
            click() {
              clicked.push("discard");
            },
          }];
        }
        if (text.includes("alertdialog")) {
          return [{
            innerText: "Discard this draft?",
            querySelectorAll: () => [{
              innerText: "Discard",
              getAttribute: () => "",
              click() {
                clicked.push("confirm");
              },
            }],
          }];
        }
        if (text.includes("Draft")) {
          return [{
            nodeType: 1,
            textContent: "Draft",
            getAttribute: () => "",
            getBoundingClientRect: () => ({ width: 40, height: 16 }),
            closest: () => null,
            click() {
              clicked.push("expand");
            },
          }];
        }
        return [];
      },
    },
  };
  assert.equal(vm.runInNewContext(`(${threadHasDraftInPage.toString()})()`, draftDom), true);
  assert.equal(vm.runInNewContext(`(${discardOpenDraftInPage.toString()})()`, draftDom), true);
  assert.equal(vm.runInNewContext(`(${confirmDiscardDraftInPage.toString()})()`, draftDom), true);
  assert.equal(vm.runInNewContext(`(${expandCollapsedDraftInPage.toString()})()`, draftDom), true);
  assert.deepEqual(clicked, ["discard", "confirm", "expand"]);

  const calls = [];
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async replyFollowupThreads(request) {
        calls.push(request);
        return {
          replied: [{
            toEmail: "client@co.com",
            subject: `Subject ${calls.length}`,
            messageCount: 1,
          }],
        };
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  const people = [
    { ...account("a", "Alpha", "Ada"), email: "a@gmail.com", limit: 2 },
    { ...account("b", "Beta", "Bea"), email: "b@gmail.com", limit: 1 },
  ];
  assert.deepEqual(validateFollowupInput({
    accounts: people,
    date: "2026-11-10",
    body: "Hello {sender}",
    intervalSeconds: 10,
  }), []);
  runner.start(createFollowupCampaign({
    accounts: people,
    date: "2026-11-10",
    body: "Hello {sender}",
    intervalSeconds: 3,
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.equal(runner.campaign.sentTotal, 3);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].limit, 1);
  assert.equal(calls[0].bodyText, "Hello Ada");
  assert.equal(calls[1].limit, 1);
  assert.equal(calls[1].bodyText, "Hello Bea");
  assert.equal(calls[2].limit, 1);
  assert.equal(calls[2].bodyText, "Hello Ada");
  assert.equal(campaignView(runner.campaign).kind, "followup");
  assert.equal(runner.store.data.sendLog.followup["a@gmail.com"][`2026-11-10|${localDayKey()}`], 2);
  assert.equal(runner.store.data.sendLog.followup["b@gmail.com"][`2026-11-10|${localDayKey()}`], 1);
  assert.deepEqual(runner.store.data.sendLog.warmup, {});
  assert.deepEqual(runner.store.data.sendLog.contacts, {});

  const turnCalls = [];
  const turnRunner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async replyFollowupThreads(request) {
        turnCalls.push({ email: request.mailboxEmail, limit: request.limit });
        return {
          replied: [{ toEmail: "client@co.com", subject: `Turn ${turnCalls.length}`, messageCount: 1 }],
          skipped: [],
        };
      },
    },
    store: memoryStore(),
    sleep: async () => true,
  });
  turnRunner.start(createFollowupCampaign({
    accounts: [
      { ...account("a", "Alpha", "Ada"), email: "a@gmail.com", limit: 2 },
      { ...account("b", "Beta", "Bea"), email: "b@gmail.com", limit: 2 },
    ],
    date: "2026-11-10",
    body: "Hello {sender}",
    intervalSeconds: 3,
  }));
  await turnRunner.loopPromise;
  assert.equal(turnRunner.campaign.status, "done");
  assert.equal(turnRunner.campaign.sentTotal, 4);
  assert.deepEqual(turnCalls.map((item) => `${item.email}:${item.limit}`), [
    "a@gmail.com:1",
    "b@gmail.com:1",
    "a@gmail.com:1",
    "b@gmail.com:1",
  ]);
});

test("an empty follow-up search skips that Gmail without waiting", async () => {
  const calls = [];
  const waits = [];
  const runner = new CampaignRunner({
    getMorelogin: () => ({
      async ensureDebugPort() {
        return "port";
      },
      async releaseProfile() {
        return true;
      },
    }),
    gmail: {
      async replyFollowupThreads(request) {
        calls.push(request.mailboxEmail);
        if (request.mailboxEmail === "b@gmail.com") {
          return { replied: [{ toEmail: "client@co.com", subject: "Still open", messageCount: 1 }], skipped: [] };
        }
        return { replied: [], skipped: [] };
      },
    },
    store: memoryStore(),
    random: () => 0,
    sleep: async (ms) => {
      waits.push(ms);
      return true;
    },
  });
  runner.start(createFollowupCampaign({
    accounts: [
      { ...account("a", "Alpha", "Ada"), email: "a@gmail.com", limit: 3 },
      { ...account("b", "Beta", "Bea"), email: "b@gmail.com", limit: 1 },
      { ...account("c", "Gamma", "Cara"), email: "c@gmail.com", limit: 2 },
    ],
    date: "2026-11-10",
    body: "Hello {sender}",
    intervalSeconds: 30,
  }));
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.equal(runner.campaign.sentTotal, 1);
  assert.deepEqual(calls, ["a@gmail.com", "b@gmail.com", "c@gmail.com"]);
  assert.deepEqual(waits, [25000]);
  assert.equal(runner.campaign.accounts[0].sent, 3);
  assert.equal(runner.campaign.accounts[2].sent, 2);
});

test("status sheet keeps email and status only", async () => {
  const csv = [
    "Email,Name,Pwd,Recovery email,2FA key,app password,Status,10/29",
    '"Ada@gmail.com","Ada","secret,1","recover@example.com","JBSWY3DPEHPK3PXP","abcd efgh","Warming up","Not send"',
    "1,,,,,,,",
    "bob@example.com,Bob,pw,r,k,p,Active,Sent",
    '"cara@example.com","Cara","a,b",r,k,"line\npass",Blocked,Sent',
  ].join("\n");
  const map = statusesFromCsv(csv);
  assert.deepEqual(map, {
    "ada@gmail.com": "Warming up",
    "bob@example.com": "Active",
    "cara@example.com": "Blocked",
  });
  const blob = JSON.stringify(map);
  for (const secret of ["secret", "recover@", "JBSW", "abcd", "line"]) {
    assert.equal(blob.includes(secret), false);
  }
  assert.equal(
    exportUrlFromSheetLink("https://docs.google.com/spreadsheets/d/abc_DEF-123/edit?pli=1&gid=1193245648#gid=1193245648"),
    "https://docs.google.com/spreadsheets/d/abc_DEF-123/export?format=csv&gid=1193245648"
  );
  assert.throws(() => exportUrlFromSheetLink("https://evil.example/spreadsheets/d/abc/edit"), /Google Sheets/);
  await assert.rejects(() => fetchSheetText("http://docs.google.com/spreadsheets/d/abc/export"), /Google Sheets/);
  let seen = "";
  const loaded = await loadStatusMap("https://docs.google.com/spreadsheets/d/abc_DEF-123/edit?gid=9#gid=9", async (url) => {
    seen = url;
    return "Email,Pwd,Status\nada@gmail.com,hidden,Paused\n";
  });
  assert.equal(seen, "https://docs.google.com/spreadsheets/d/abc_DEF-123/export?format=csv&gid=9");
  assert.deepEqual(loaded, { "ada@gmail.com": "Paused" });
  await assert.rejects(
    () => loadStatusMap("https://docs.google.com/spreadsheets/d/abc/edit", async () => "<html>sign in</html>"),
    /not shared/
  );
});

test("stored gmail status drops anything that is not an email status", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-"));
  const file = path.join(dir, "state.json");
  const store = new Store(file);
  store.data.gmailStatus = {
    "Ada@gmail.com": " Active ",
    "not-an-email": "Blocked",
    "bob@example.com": "",
  };
  store.data.settings.sheetUrl = "https://docs.google.com/spreadsheets/d/old/edit";
  store.data.settings.statusMode = "file";
  store.data.settings.statusFilePath = "C:\\status.csv";
  store.save();
  const again = new Store(file);
  assert.deepEqual(again.data.gmailStatus, { "ada@gmail.com": "Active" });
  assert.equal(again.data.settings.sheetUrl, undefined);
  assert.equal(again.data.settings.statusMode, undefined);
  assert.equal(again.data.settings.statusFilePath, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a Gmail status chosen in the app stays when the sheet is read again", () => {
  const sheet = {
    "ada@gmail.com": "Active",
    "ben@gmail.com": "Warming up",
    "cara@example.com": "Blocked",
  };
  const chosen = mergeGmailStatus(sheet, {
    "Ada@gmail.com": "Paused",
    "ben@gmail.com": "",
    "not-an-email": "Blocked",
  });
  assert.deepEqual(chosen, {
    "ada@gmail.com": "Paused",
    "cara@example.com": "Blocked",
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-"));
  const file = path.join(dir, "state.json");
  const store = new Store(file);
  store.data.gmailStatus = sheet;
  store.data.gmailStatusOverrides = { "ada@gmail.com": "Paused", "ben@gmail.com": "" };
  store.save();
  const again = new Store(file);
  assert.equal(again.data.gmailStatus["ada@gmail.com"], "Paused");
  assert.equal(again.data.gmailStatus["ben@gmail.com"], undefined);
  assert.deepEqual(
    mergeGmailStatus(sheet, again.data.gmailStatusOverrides),
    { "ada@gmail.com": "Paused", "cara@example.com": "Blocked" }
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("status file keeps email and status from csv, excel, and other spreadsheets", async () => {
  const XLSX = require("xlsx");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-status-"));
  const csvPath = path.join(dir, "status.csv");
  fs.writeFileSync(csvPath, "Email Address,Password,Status\nAda@gmail.com,secret,Paused\n");
  const fromCsv = statusesFromFile(csvPath);
  assert.deepEqual(fromCsv, { "ada@gmail.com": "Paused" });
  assert.equal(JSON.stringify(fromCsv).includes("secret"), false);

  const tsvPath = path.join(dir, "status.tsv");
  fs.writeFileSync(tsvPath, "Email\t2FA key\tStatus\nBob@example.com\tJBSWY3DPEHPK3PXP\tActive\n");
  const fromTsv = statusesFromFile(tsvPath);
  assert.deepEqual(fromTsv, { "bob@example.com": "Active" });
  assert.equal(JSON.stringify(fromTsv).includes("JBSW"), false);

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Notes"], ["nothing"]]), "Cover");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ["Account export"],
    ["Email", "Pwd", "Status"],
    ["Cara@example.com", "hidden-pass", "Blocked"],
    ["not-an-email", "x", "Active"],
  ]), "People");
  const xlsxPath = path.join(dir, "status.xlsx");
  XLSX.writeFile(book, xlsxPath);
  const fromXlsx = statusesFromFile(xlsxPath);
  assert.deepEqual(fromXlsx, { "cara@example.com": "Blocked" });
  assert.equal(JSON.stringify(fromXlsx).includes("hidden-pass"), false);

  const otherPath = path.join(dir, "status.sheet");
  fs.writeFileSync(otherPath, "Email,Status\nada@gmail.com,Warming up\n");
  assert.deepEqual(statusesFromFile(otherPath), { "ada@gmail.com": "Warming up" });

  const xlsxBuffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  let requested = "";
  const fromUrl = await loadStatusFromUrl("https://files.example/status.xlsx", async () => {
    throw new Error("Google sheet fetch should not run for this link.");
  }, async (url) => {
    requested = url;
    return xlsxBuffer;
  });
  assert.equal(requested, "https://files.example/status.xlsx");
  assert.deepEqual(fromUrl, { "cara@example.com": "Blocked" });

  let seen = "";
  const fromSheet = await loadStatusFromUrl(
    "https://docs.google.com/spreadsheets/d/abc_DEF-123/edit?gid=9#gid=9",
    async (url) => {
      seen = url;
      return "Email,Pwd,Status\nada@gmail.com,hidden,Paused\n";
    }
  );
  assert.equal(seen, "https://docs.google.com/spreadsheets/d/abc_DEF-123/export?format=csv&gid=9");
  assert.deepEqual(fromSheet, { "ada@gmail.com": "Paused" });
  await assert.rejects(() => loadStatusFromUrl("http://files.example/status.csv"), /https/);
  await assert.rejects(
    () => loadStatusFromUrl("https://files.example/page", async () => "", async () => "<html>sign in</html>"),
    /spreadsheet/
  );
  await assert.rejects(async () => statusesFromFile(path.join(dir, "missing.csv")), /not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("later gmail accounts use their own inbox and a visible compose button", () => {
  assert.equal(gmailAccountIndex("https://mail.google.com/mail/u/10/#inbox"), 10);
  assert.equal(gmailAccountIndex("https://mail.google.com/mail/u/1/#inbox"), 1);
  assert.equal(gmailAccountIndex("https://mail.google.com/mail/u/0/#inbox"), 0);

  function element(spec) {
    return {
      nodeType: 1,
      role: spec.role,
      gh: spec.gh || "",
      className: spec.className || "",
      aria: spec.aria || "",
      text: spec.text || "",
      rect: spec.rect,
      clicked: false,
      getAttribute(name) {
        return name === "aria-label" ? this.aria : "";
      },
      getBoundingClientRect() {
        return this.rect;
      },
      get textContent() {
        return this.text;
      },
      scrollIntoView() {},
      click() {
        this.clickCount = (this.clickCount || 0) + 1;
        this.clicked = true;
      },
      dispatchEvent() {
        this.dispatchCount = (this.dispatchCount || 0) + 1;
      },
    };
  }

  function matches(node, selector) {
    if (selector === 'div[role="button"][gh="cm"]') return node.role === "button" && node.gh === "cm";
    if (selector === 'div.T-I.T-I-KE[role="button"]') {
      return node.role === "button" && String(node.className).includes("T-I-KE");
    }
    if (selector === 'div[role="button"]') return node.role === "button";
    return false;
  }

  function run(fn, href, specs, arg) {
    const nodes = specs.map(element);
    const document = {
      querySelector(selector) {
        return nodes.find((node) => matches(node, selector)) || null;
      },
      querySelectorAll(selector) {
        return nodes.filter((node) => matches(node, selector));
      },
    };
    const context = vm.createContext({
      document,
      location: { href },
      window: {
        getComputedStyle() {
          return { visibility: "visible", display: "block" };
        },
      },
      MouseEvent: function MouseEvent() {},
    });
    const call = arg === undefined ? `(${fn.toString()})()` : `(${fn.toString()})(${JSON.stringify(arg)})`;
    const result = vm.runInContext(call, context);
    return { result, nodes };
  }

  const hidden = { role: "button", gh: "cm", rect: { width: 0, height: 0, left: 0, top: 0 } };
  const compose = { role: "button", aria: "Compose", text: "Compose", rect: { width: 48, height: 32, left: 12, top: 80 } };
  const wrongAccount = run(inboxReady, "https://mail.google.com/mail/u/10/#inbox", [compose], 1);
  assert.equal(wrongAccount.result, false);
  const hiddenOnly = run(inboxReady, "https://mail.google.com/mail/u/1/#inbox", [hidden], 1);
  assert.equal(hiddenOnly.result, false);
  const ready = run(inboxReady, "https://mail.google.com/mail/u/1/#inbox", [hidden, compose], 1);
  assert.equal(ready.result, true);
  const clicked = run(clickComposeButtonInPage, "https://mail.google.com/mail/u/1/#inbox", [hidden, compose]);
  assert.equal(clicked.result, true);
  assert.equal(clicked.nodes[0].clickCount || 0, 0);
  assert.equal(clicked.nodes[1].clickCount, 1);
  assert.equal(clicked.nodes[1].dispatchCount || 0, 0);
  const pointed = run(composeButtonPointInPage, "https://mail.google.com/mail/u/1/#inbox", [hidden, compose]);
  assert.equal(pointed.result.x, 36);
  assert.equal(pointed.result.y, 96);
  assert.equal(pointed.nodes[1].clickCount || 0, 0);
  assert.equal(composeOpenPlan(0, false), "click");
  assert.equal(composeOpenPlan(1, false), "close-all");
  assert.equal(composeOpenPlan(2, false), "close-all");
  assert.equal(composeOpenPlan(0, true), "wait");
  assert.equal(composeOpenPlan(1, true), "wait");
  assert.equal(composeOpenPlan(2, true), "close-extras");
});

test("finished campaign replaces the Sending status", () => {
  const renderer = fs.readFileSync(path.join(root, "desktop", "renderer", "renderer.js"), "utf8");
  const match = renderer.match(/function campaignStatusLine\(campaign\) \{[\s\S]*?\n\}/);
  assert.ok(match);
  const campaignStatusLine = vm.runInNewContext("(" + match[0] + ")");
  assert.equal(campaignStatusLine({ status: "running", kind: "campaign", sentTotal: 1, total: 10 }).message, "Sending.");
  assert.equal(
    campaignStatusLine({ status: "done", kind: "campaign", sentTotal: 3, total: 2071 }).message,
    "Finished. 3 of 2071 sent."
  );
  assert.equal(
    campaignStatusLine({ status: "done", kind: "warmup", sentTotal: 2, total: 2 }).message,
    "Warm-up finished. 2 of 2 warm-up emails sent."
  );
  assert.equal(
    campaignStatusLine({ status: "done", kind: "followup", sentTotal: 2, total: 5 }).message,
    "Follow-up finished. 2 of 5 follow-up emails sent."
  );
  assert.equal(
    campaignStatusLine({ status: "stopped", kind: "campaign", sentTotal: 3, total: 2071 }).message,
    "Sending stopped. 3 of 2071 sent."
  );
  assert.equal(
    campaignStatusLine({ status: "paused", kind: "followup", sentTotal: 2, total: 5 }).message,
    "Follow-up paused. 2 of 5 follow-up emails sent."
  );
  assert.equal(
    campaignStatusLine({ status: "error", kind: "campaign", lastError: "Gmail needs attention." }).message,
    "Gmail needs attention."
  );
  assert.match(renderer, /campaignStatusLine\(event\.campaign\)/);
  assert.match(renderer, /campaignStatusLine\(state\.campaign\)/);
  const autoResume = renderer.match(/function shouldAutoResume\(campaign\) \{[\s\S]*?\n\}/);
  assert.ok(autoResume);
  const shouldAutoResume = vm.runInNewContext("(" + autoResume[0] + ")");
  assert.equal(shouldAutoResume({ status: "error", lastError: "Sterling: The compose window is still empty." }), true);
  assert.equal(shouldAutoResume({ status: "error", lastError: "Gmail is not signed in. Sign in inside this browser, then press Resume." }), false);
  assert.equal(shouldAutoResume({ status: "paused", lastError: "" }), false);
  assert.equal(shouldAutoResume({ status: "running", lastError: "" }), false);
  assert.match(renderer, /queueAutoResume\(event\.campaign\)/);
  assert.match(renderer, /getElementById\("pause"\)/);
  assert.match(renderer, /getElementById\("resume"\)/);
  assert.match(renderer, /pauseCampaign/);
});

test("an open inbox is not loaded again just to keep compose=new", () => {
  const inbox = "https://mail.google.com/mail/u/0/#inbox";
  const compose = "https://mail.google.com/mail/u/0/#inbox?compose=new";
  assert.equal(inboxNavigationPlan(compose, 0, 0), "ready");
  assert.equal(inboxNavigationPlan(inbox, 0, 1), "ready");
  assert.equal(inboxNavigationPlan("about:blank", 0, 0), "navigate");
  assert.equal(inboxNavigationPlan("about:blank", 0, 1), "navigate");
  assert.equal(inboxNavigationPlan("about:blank", 0, 2), "wait");
});

test("collapsed gmail compose expands from the Maximize button", () => {
  function box(spec, children = []) {
    const item = {
      nodeType: 1,
      role: spec.role || "",
      aria: spec.aria || "",
      tooltip: spec.tooltip || "",
      name: spec.name || "",
      rect: spec.rect || { width: 24, height: 24, left: 0, top: 0 },
      children,
      clickCount: 0,
      getAttribute(name) {
        if (name === "aria-label") return this.aria;
        if (name === "data-tooltip") return this.tooltip;
        if (name === "name") return this.name;
        if (name === "role") return this.role;
        return "";
      },
      getBoundingClientRect() {
        return this.rect;
      },
      click() {
        this.clickCount += 1;
      },
      contains(other) {
        if (other === this) return true;
        return this.children.some((child) => child.contains(other));
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      },
      querySelectorAll(selector) {
        const found = [];
        for (const child of this.children) {
          if (matches(child, selector)) found.push(child);
          found.push(...child.querySelectorAll(selector));
        }
        return found;
      },
    };
    return item;
  }

  function matches(item, selector) {
    return selector.split(",").some((part) => {
      const text = part.trim();
      if (text === 'div[role="dialog"]') return item.role === "dialog";
      if (text === 'div[role="region"]') return item.role === "region";
      if (text === 'input[name="subjectbox"]') return item.name === "subjectbox";
      if (text === '[role="button"]') return item.role === "button";
      if (text === "button") return false;
      return false;
    });
  }

  function run(root) {
    const document = {
      querySelectorAll(selector) {
        const found = [];
        const walk = (item) => {
          if (matches(item, selector)) found.push(item);
          item.children.forEach(walk);
        };
        walk(root);
        return found;
      },
    };
    return vm.runInNewContext(`(${expandCollapsedComposeInPage.toString()})()`, {
      document,
      window: { getComputedStyle: () => ({ visibility: "visible", display: "block" }) },
    });
  }

  const subject = box({ name: "subjectbox", rect: { width: 0, height: 0, left: 0, top: 0 } });
  const maximize = box({ role: "button", aria: "Maximize", tooltip: "Maximize" });
  const close = box({ role: "button", aria: "Save & close", tooltip: "Save & close" });
  const collapsed = box(
    { role: "dialog", aria: "New Message", rect: { width: 480, height: 36, left: 0, top: 700 } },
    [subject, maximize, close]
  );
  assert.equal(run(collapsed), "clicked");
  assert.equal(maximize.clickCount, 1);
  assert.equal(close.clickCount, 0);

  const openSubject = box({ name: "subjectbox", rect: { width: 360, height: 28, left: 12, top: 80 } });
  const minimize = box({ role: "button", aria: "Minimize", tooltip: "Minimize" });
  const expanded = box(
    { role: "dialog", aria: "New Message", rect: { width: 500, height: 420, left: 0, top: 200 } },
    [openSubject, minimize]
  );
  assert.equal(run(expanded), "expanded");
  assert.equal(minimize.clickCount, 0);
});

test("chrome compose writes the inspected To, subject, and message fields", () => {
  function el(tag, attrs) {
    return {
      nodeType: 1,
      tag,
      attrs,
      value: "",
      children: [],
      root: null,
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
      },
      closest() { return this.root; },
      focus() {},
      getBoundingClientRect() { return { width: 240, height: 28, left: 8, top: 8 }; },
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren() { this.children = []; },
      dispatchEvent() {},
      get textContent() {
        return this.children.map((child) => child.text || "").join("");
      },
      get innerText() { return this.textContent; },
    };
  }
  function matches(node, selector) {
    const tag = (selector.match(/^[a-z]+/) || [])[0];
    if (tag && node.tag !== tag) return false;
    const attrs = [...selector.matchAll(/\[([^\]=\s]+)(?:="([^"]*)")?\]/g)];
    return attrs.every(([, name, value]) => {
      const actual = node.getAttribute(name);
      if (value === undefined) return actual != null;
      return actual === value;
    });
  }
  const to = el("input", { "aria-label": "To recipients", "peoplekit-id": "BbVj", role: "combobox" });
  const subject = el("input", { name: "subjectbox", "aria-label": "Subject", placeholder: "Subject" });
  const body = el("div", { "aria-label": "Message Body", contenteditable: "true", g_editable: "true", role: "textbox" });
  const dialog = el("div", { role: "dialog", "aria-label": "New Message" });
  const subjectRegion = el("div", { role: "region", "aria-label": "Subject region" });
  to.root = dialog;
  body.root = dialog;
  subject.root = subjectRegion;
  subjectRegion.querySelectorAll = (selector) => [subjectRegion, subject].filter((node) => matches(node, selector));
  const all = [dialog, subjectRegion, to, subject, body];
  function query(selector) {
    const selectors = selector.split(",").map((part) => part.trim());
    return all.filter((node) => selectors.some((part) => matches(node, part)));
  }
  const document = {
    querySelectorAll: query,
    createElement(tag) { return el(tag, {}); },
    createTextNode(text) { return { text }; },
  };
  dialog.querySelectorAll = query;
  const sandbox = {
    document,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    InputEvent: class InputEvent {},
    Event: class Event {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const write = `(${writeInspectedComposeInPage.toString()})("bea@example.com", "Hello Bea", "Need extra hands")`;
  const wrote = vm.runInContext(write, sandbox);
  assert.equal(wrote.ok, true);
  assert.equal(wrote.to, true);
  assert.equal(wrote.subject, true);
  assert.equal(wrote.body, true);
  assert.equal(to.value, "bea@example.com");
  assert.equal(subject.value, "Hello Bea");
  assert.equal(body.textContent, "Need extra hands");
  const read = `(${readInspectedComposeInPage.toString()})("bea@example.com", "Hello Bea", "Need extra hands")`;
  const state = vm.runInContext(read, sandbox);
  assert.equal(state.to, true);
  assert.equal(state.subject, true);
  assert.equal(state.body, true);
});

test("a Gmail recipient chip counts as a filled compose", () => {
  function matches(node, selector) {
    const tag = (selector.match(/^[a-z]+/) || [])[0];
    if (tag && node.tag !== tag) return false;
    const attrs = [...selector.matchAll(/\[([^\]=\s]+)(?:="([^"]*)")?\]/g)];
    return attrs.every(([, name, value]) => {
      const actual = node.getAttribute(name);
      if (value === undefined) return actual != null;
      return actual === value;
    });
  }
  function el(tag, attrs) {
    const node = {
      tag,
      attrs,
      children: [],
      parentElement: null,
      value: "",
      nodeType: 1,
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      },
      getBoundingClientRect() {
        return node.rect;
      },
      rect: { width: 240, height: 28, left: 8, top: 8 },
      get textContent() {
        return node.children.map((child) => child.textContent || "").join("");
      },
      get innerText() {
        return node.textContent;
      },
      querySelectorAll(selector) {
        const selectors = String(selector).split(",").map((part) => part.trim());
        const found = [];
        const walk = (item) => {
          if (!item || item.nodeType !== 1) return;
          if (selectors.some((part) => matches(item, part))) found.push(item);
          (item.children || []).forEach(walk);
        };
        node.children.forEach(walk);
        return found;
      },
    };
    return node;
  }
  const dialog = el("div", { role: "dialog", "aria-label": "New Message" });
  const subject = el("input", { name: "subjectbox" });
  const to = el("input", { "aria-label": "To recipients", "peoplekit-id": "BbVj", role: "combobox" });
  const chip = el("div", { "data-hovercard-id": "bea@example.com", "data-name": "Bea" });
  const body = el("div", { "aria-label": "Message Body", contenteditable: "true", role: "textbox" });
  const inbox = el("div", { email: "bea@example.com" });
  subject.value = "Hello Bea";
  body.children.push({ textContent: "Need extra hands" });
  dialog.children.push(subject, to, chip, body);
  [subject, to, chip, body].forEach((node) => {
    node.parentElement = dialog;
  });
  const bodyNode = el("body", {});
  bodyNode.children.push(dialog, inbox);
  dialog.parentElement = bodyNode;
  inbox.parentElement = bodyNode;
  const document = {
    body: bodyNode,
    querySelectorAll(selector) {
      return bodyNode.querySelectorAll(selector);
    },
  };
  const context = vm.createContext({
    document,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  });
  context.window = context;
  const read = `(${readInspectedComposeInPage.toString()})("bea@example.com", "Hello Bea", "Need extra hands")`;
  const filled = vm.runInContext(read, context);
  assert.equal(filled.to, true);
  assert.equal(filled.subject, true);
  assert.equal(filled.body, true);
  chip.attrs["data-hovercard-id"] = "other@example.com";
  const outsideOnly = vm.runInContext(read, context);
  assert.equal(outsideOnly.to, false);
  subject.rect = { width: 0, height: 0, left: 0, top: 0 };
  body.rect = { width: 0, height: 0, left: 0, top: 0 };
  chip.attrs["data-hovercard-id"] = "bea@example.com";
  const offDesktop = vm.runInContext(read, context);
  assert.equal(offDesktop.to, true);
  assert.equal(offDesktop.subject, true);
  assert.equal(offDesktop.body, true);
});

test("the inbox address opens a new compose window", () => {
  const location = { hash: "#inbox" };
  const context = vm.createContext({ location });
  const call = `(${openComposeRouteInPage.toString()})()`;
  assert.equal(vm.runInContext(call, context), "set");
  assert.equal(location.hash, "#inbox?compose=new");
  assert.equal(vm.runInContext(call, context), "already");
});

test("a warm-up reply lists only received one-message threads marked (w-u)", () => {
  function mailRow(subject, email, count, sent, rowText, extra) {
    const info = extra || {};
    return {
      innerText: rowText || subject,
      textContent: rowText || subject,
      getBoundingClientRect() {
        return { width: 400, height: 24, left: 8, top: 20 };
      },
      getAttribute(name) {
        if (name === "data-legacy-thread-id") return info.threadId || "";
        return "";
      },
      querySelector(selector) {
        if (selector === ".bog" || selector === ".bqe" || selector === ".y6") {
          return {
            textContent: subject,
            getAttribute(name) {
              return name === "title" ? (info.title || "") : "";
            },
          };
        }
        if (selector === "[email]") return { getAttribute: (name) => (name === "email" ? email : "") };
        if (selector === ".yW") return { innerText: sent ? "To: Someone" : "Ada", textContent: sent ? "To: Someone" : "Ada" };
        if (selector === ".bx0") {
          return count > 1 ? { textContent: String(count), getAttribute: () => "" } : null;
        }
        if (selector === "[aria-label*='message'], [aria-label*='Message']" || selector === "[aria-label*='message']") {
          return info.messageLabel
            ? { textContent: info.messageLabel, getAttribute: () => info.messageLabel }
            : null;
        }
        return null;
      },
    };
  }
  const received = mailRow("Ready to Contribute to Metaroom (w-u)", "a@gmail.com", 1, false);
  const sent = mailRow("Ready to Contribute to Metaroom (w-u)", "b@gmail.com", 1, true);
  const own = mailRow("Ready to Contribute to Metaroom (w-u)", "me@gmail.com", 1, false);
  const conversation = mailRow("Looking to Join Metaroom (w-u)", "b@gmail.com", 3, false);
  const other = mailRow("Weekly update", "c@gmail.com", 1, false);
  const spamSubject = mailRow("Ready to Contribute to Metaroom", "d@gmail.com", 1, false, "Dana Ready to Contribute to Metaroom (w-u)");
  const timed = mailRow("Ready to Contribute to Metaroom (w-u)", "e@gmail.com", 1, false, "", { messageLabel: "Opened message 3:41 PM" });
  const titled = mailRow("Ready to Contribute", "f@gmail.com", 1, false, "Ready to Contribute", { title: "Ready to Contribute (w-u)" });
  const many = mailRow("Hello (w-u)", "g@gmail.com", 1, false, "", { messageLabel: "3 messages" });
  const document = {
    querySelectorAll(selector) {
      return selector === "tr.zA" ? [received, sent, own, conversation, other, spamSubject, timed, titled, many] : [];
    },
  };
  assert.equal(warmupSearchToken("(w-u)"), "w-u");
  assert.equal(warmupSearchQuery("inbox", "(w-u)"), 'in:anywhere "w-u"');
  const rows = vm.runInNewContext(`(${warmupThreadListInPage.toString()})("w-u", "me@gmail.com")`, { document });
  assert.equal(rows.length, 4);
  assert.equal(String(rows[0].email), "a@gmail.com");
  assert.equal(String(rows[0].name), "Ada");
  assert.equal(mailboxNameKey(rows[0].email, rows[0].name), "a@gmail.com-Ada");
  assert.equal(Number(rows[0].count), 1);
  assert.equal(String(rows[0].subject), "Ready to Contribute to Metaroom (w-u)");
  assert.equal(String(rows[1].email), "d@gmail.com");
  assert.equal(String(rows[2].email), "e@gmail.com");
  assert.equal(String(rows[3].email), "f@gmail.com");
  assert.equal(gmailSearchUrl(0, 'in:anywhere "w-u"'), "https://mail.google.com/mail/u/0/#search/in%3Aanywhere+%22w-u%22");
  const anywhereScope = vm.runInNewContext(`(${searchScopeReadyInPage.toString()})("w-u", "anywhere")`, {
    document: {
      querySelector() {
        return { value: "in:anywhere w-u" };
      },
    },
    location: { hash: "#search/in:anywhere+w-u" },
  });
  assert.equal(anywhereScope, true);
  const inboxScope = vm.runInNewContext(`(${searchScopeReadyInPage.toString()})("w-u", "anywhere")`, {
    document: {
      querySelector() {
        return { value: "in:inbox w-u" };
      },
    },
    location: { hash: "#search/in:inbox+w-u" },
  });
  assert.equal(inboxScope, false);
});

test("a warm-up reply counts one visible message when a hidden copy is in the page", () => {
  function node(size) {
    return {
      nodeType: 1,
      getBoundingClientRect() {
        return { width: size, height: size, left: 0, top: 0 };
      },
    };
  }
  const document = {
    querySelectorAll(selector) {
      return selector === "div.adn" ? [node(40), node(0)] : [];
    },
  };
  const count = vm.runInNewContext(`(${openedMessageCountInPage.toString()})()`, { document });
  assert.equal(count, 1);
});

test("a reply send click lands on the Send button", () => {
  function element(spec) {
    const item = {
      nodeType: 1,
      role: spec.role || "",
      aria: spec.aria || "",
      tooltip: spec.tooltip || "",
      text: spec.text || "",
      editable: spec.editable || "",
      rect: spec.rect,
      children: [],
      parentElement: null,
      innerText: spec.text || "",
      textContent: spec.text || "",
      getAttribute(name) {
        if (name === "role") return this.role;
        if (name === "aria-label") return this.aria;
        if (name === "data-tooltip") return this.tooltip;
        if (name === "g_editable") return this.editable;
        return "";
      },
      getBoundingClientRect() {
        return this.rect;
      },
      scrollIntoView() {},
      querySelectorAll(selector) {
        const found = [];
        for (const child of this.children) {
          if (matches(child, selector)) found.push(child);
          found.push(...child.querySelectorAll(selector));
        }
        return found;
      },
    };
    return item;
  }
  function matches(item, selector) {
    return String(selector).split(",").some((part) => {
      const text = part.trim();
      if (text === 'div[role="textbox"]') return item.role === "textbox";
      if (text === '[role="button"]') return item.role === "button";
      if (text === "button") return false;
      if (text === '[data-tooltip="Send"]') return item.tooltip === "Send";
      if (text === '[aria-label="Send"]') return item.aria === "Send";
      return false;
    });
  }
  function adopt(parent, children) {
    parent.children = children;
    children.forEach((child) => {
      child.parentElement = parent;
    });
    return parent;
  }
  const body = element({
    role: "textbox",
    aria: "Message Body",
    editable: "true",
    rect: { width: 420, height: 90, left: 40, top: 400 },
  });
  const send = element({
    role: "button",
    aria: "Send",
    tooltip: "Send",
    text: "Send",
    rect: { width: 72, height: 36, left: 40, top: 500 },
  });
  const more = element({
    role: "button",
    aria: "More send options",
    tooltip: "More send options",
    text: "",
    rect: { width: 28, height: 36, left: 116, top: 500 },
  });
  const form = adopt(element({ rect: { width: 480, height: 160, left: 24, top: 380 } }), [body, send, more]);
  const page = adopt(element({ rect: { width: 800, height: 700, left: 0, top: 0 } }), [form]);
  const document = {
    body: page,
    querySelectorAll(selector) {
      return page.querySelectorAll(selector);
    },
  };
  const point = vm.runInNewContext(`(${replySendPointInPage.toString()})()`, {
    document,
    window: {
      getComputedStyle() {
        return { visibility: "visible", display: "block", opacity: "1" };
      },
    },
  });
  assert.equal(point.x, 76);
  assert.equal(point.y, 518);
});

test("a reply searches the exact email and does not open a newer different one", () => {
  const contentQuery = "Hello Bea";
  assert.equal(exactReplyQuery(contentQuery), contentQuery);
  assert.equal(
    exactReplyQuery("Hello Bea,\n\nNeed extra hands to help scale your development efforts?"),
    "Hello Bea, Need extra hands to help scale your development efforts?"
  );
  function mailRow(subject, email, title, top) {
    return {
      rect: { width: 400, height: 24, left: 8, top },
      getBoundingClientRect() {
        return this.rect;
      },
      querySelector(selector) {
        if (selector === ".bog, .bqe") return { textContent: subject };
        if (selector === "[email]") return { getAttribute: (name) => (name === "email" ? email : "") };
        if (selector === "td.xW [title]" || selector === "[title]") {
          return { getAttribute: (name) => (name === "title" ? title : "") };
        }
        return null;
      },
    };
  }
  const olderExact = mailRow("Hello Bea", "a@gmail.com", "Mon, Nov 2, 2026, 1:00 PM", 80);
  const newerExact = mailRow("Hello Bea", "a@gmail.com", "Tue, Nov 3, 2026, 4:30 PM", 140);
  const newestOther = mailRow("Weekly update", "other@gmail.com", "Tue, Nov 3, 2026, 5:00 PM", 40);
  const document = {
    body: { innerText: "Inbox" },
    querySelector(selector) {
      if (selector === 'input[name="q"], input[aria-label="Search mail"]') return { value: "" };
      if (selector === "h2.hP") return { textContent: "Hello Bea" };
      return null;
    },
    querySelectorAll(selector) {
      return selector === "tr.zA" ? [newestOther, olderExact, newerExact] : [];
    },
  };
  const inbox = vm.runInNewContext(`(${searchHasResultInPage.toString()})("a@gmail.com", "Hello Bea")`, {
    document,
    location: { hash: "#inbox" },
  });
  assert.equal(inbox, "");
  document.body.innerText = "No messages matched your search.";
  document.querySelector = (selector) => {
    if (selector === 'input[name="q"], input[aria-label="Search mail"]') return { value: "a@gmail.com" };
    if (selector === "h2.hP") return { textContent: "Hello Bea" };
    return null;
  };
  const addressQuery = vm.runInNewContext(`(${searchHasResultInPage.toString()})("a@gmail.com", "Hello Bea", ${JSON.stringify(contentQuery)})`, {
    document,
    location: { hash: "#inbox" },
  });
  assert.equal(addressQuery, "");
  document.querySelector = (selector) => {
    if (selector === 'input[name="q"], input[aria-label="Search mail"]') return { value: contentQuery };
    if (selector === "h2.hP") return { textContent: "Hello Bea" };
    return null;
  };
  const empty = vm.runInNewContext(`(${searchHasResultInPage.toString()})("a@gmail.com", "Hello Bea", ${JSON.stringify(contentQuery)})`, {
    document,
    location: { hash: "#search" },
  });
  assert.equal(empty, "empty");
  document.body.innerText = "Hello Bea";
  const ready = vm.runInNewContext(`(${searchHasResultInPage.toString()})("a@gmail.com", "Hello Bea", ${JSON.stringify(contentQuery)})`, {
    document,
    location: { hash: "#search" },
  });
  assert.equal(ready, "row");
  document.querySelector = (selector) => {
    if (selector === 'input[name="q"], input[aria-label="Search mail"]') return { value: 'from:a@gmail.com subject:"Hello Bea"' };
    return null;
  };
  const subjectQuery = vm.runInNewContext(`(${searchHasResultInPage.toString()})("a@gmail.com", "Hello Bea", ${JSON.stringify(contentQuery)})`, {
    document,
    location: { hash: "#inbox" },
  });
  assert.equal(subjectQuery, "");
  document.querySelector = (selector) => {
    if (selector === 'input[name="q"], input[aria-label="Search mail"]') return { value: contentQuery };
    if (selector === "h2.hP") return { textContent: "Hello Bea" };
    return null;
  };
  const spam = vm.runInNewContext(`(${searchHasResultInPage.toString()})("a@gmail.com", "Hello Bea", ${JSON.stringify(contentQuery)})`, {
    document,
    location: { hash: "#spam" },
  });
  assert.equal(spam, "row");
  document.querySelector = (selector) => {
    if (selector === 'input[name="q"], input[aria-label="Search mail"]') return { value: `${contentQuery} in:spam` };
    if (selector === "h2.hP") return { textContent: "Hello Bea" };
    return null;
  };
  const spamScoped = vm.runInNewContext(`(${searchHasResultInPage.toString()})("a@gmail.com", "Hello Bea", ${JSON.stringify(contentQuery)})`, {
    document,
    location: { hash: "#search" },
  });
  assert.equal(spamScoped, "row");
  document.querySelector = (selector) => {
    if (selector === 'input[name="q"], input[aria-label="Search mail"]') return { value: `${contentQuery} in: spam` };
    if (selector === "h2.hP") return { textContent: "Hello Bea" };
    return null;
  };
  const spamSpaced = vm.runInNewContext(`(${searchHasResultInPage.toString()})("a@gmail.com", "Hello Bea", ${JSON.stringify(contentQuery)})`, {
    document,
    location: { hash: "#search" },
  });
  assert.equal(spamSpaced, "row");
  document.querySelector = (selector) => {
    if (selector === 'input[name="q"], input[aria-label="Search mail"]') return { value: `in: inbox ${contentQuery}` };
    if (selector === "h2.hP") return { textContent: "Hello Bea" };
    return null;
  };
  const inboxSpaced = vm.runInNewContext(`(${searchHasResultInPage.toString()})("a@gmail.com", "Hello Bea", ${JSON.stringify(contentQuery)})`, {
    document,
    location: { hash: "#search" },
  });
  assert.equal(inboxSpaced, "row");
  document.querySelector = (selector) => {
    if (selector === 'input[name="q"], input[aria-label="Search mail"]') return { value: `${contentQuery} in: drafts` };
    if (selector === "h2.hP") return { textContent: "Hello Bea" };
    return null;
  };
  const otherScope = vm.runInNewContext(`(${searchHasResultInPage.toString()})("a@gmail.com", "Hello Bea", ${JSON.stringify(contentQuery)})`, {
    document,
    location: { hash: "#search" },
  });
  assert.equal(otherScope, "");
  const point = vm.runInNewContext(`(${exactThreadPointInPage.toString()})("a@gmail.com", "Hello Bea")`, { document });
  assert.equal(point.y, 152);
  const opened = vm.runInNewContext(`(${openedSubjectMatchesInPage.toString()})("Hello Bea")`, { document });
  assert.equal(opened, true);
  document.querySelector = (selector) => (selector === "h2.hP" ? { textContent: "Weekly update" } : null);
  const wrong = vm.runInNewContext(`(${openedSubjectMatchesInPage.toString()})("Hello Bea")`, { document });
  assert.equal(wrong, false);

  function spamButton(label, top) {
    return {
      nodeType: 1,
      label,
      rect: { width: 140, height: 28, left: 20, top },
      getAttribute(name) {
        return name === "aria-label" || name === "data-tooltip" ? this.label : "";
      },
      get innerText() {
        return this.label;
      },
      getBoundingClientRect() {
        return this.rect;
      },
      scrollIntoView() {
        this.scrolled = true;
      },
    };
  }
  const reportSpam = spamButton("Report spam", 40);
  const reportNotSpam = spamButton("Report not spam", 80);
  const reply = spamButton("Reply", 200);
  const spamDocument = {
    body: { innerText: "This message is in Spam." },
    querySelectorAll(selector) {
      return String(selector).includes("button") ? [reportSpam, reportNotSpam, reply] : [];
    },
  };
  const spamWindow = { getComputedStyle: () => ({ visibility: "visible", display: "block" }) };
  const notSpamPoint = vm.runInNewContext(`(${reportNotSpamPointInPage.toString()})()`, {
    document: spamDocument,
    window: spamWindow,
  });
  assert.equal(notSpamPoint.y, 94);
  assert.equal(reportNotSpam.scrolled, true);
  assert.equal(reportSpam.scrolled, undefined);
  spamDocument.body.innerText = "Conversation unmarked as spam.";
  assert.equal(vm.runInNewContext(`(${notSpamClearedInPage.toString()})()`, {
    document: spamDocument,
    window: spamWindow,
  }), true);
  spamDocument.body.innerText = "This message is in Spam.";
  assert.equal(vm.runInNewContext(`(${notSpamClearedInPage.toString()})()`, {
    document: spamDocument,
    window: spamWindow,
  }), false);
});

test("gmail account rows keep the full name", () => {
  assert.equal(
    pickAccountName(["gaia.l.a.mail", "0", "Ada Lovelace", "ada@gmail.com", "https://lh3.googleusercontent.com/a/photo", 0, 1, 0, 1, "100"]),
    "Ada Lovelace"
  );
  assert.equal(
    pickAccountName(["gaia.l.a.mail", "0", "Ada", "ada@gmail.com", "", 0, 0, 0, 0, "0", "Ada", "Lovelace"]),
    "Ada Lovelace"
  );
  assert.equal(pickAccountName(["gaia.l.a.mail", "0", "https://example.com", "ada@gmail.com"]), "");
  assert.equal(senderNameKey("Ada@gmail.com", "Ada Lovelace"), "ada@gmail.com-Ada");
  assert.deepEqual(rememberSenderName({ "ada@gmail.com-Old": "Old" }, "ada@gmail.com", "Ada Lovelace"), {
    "ada@gmail.com-Ada": "Ada",
  });
  assert.equal(senderNameFor({ "ada@gmail.com-Ada": "Ada" }, "ada@gmail.com", "Ada Lovelace"), "Ada");
  assert.equal(firstPersonalName("Marko Petrovic"), "Marko");
  assert.equal(firstPersonalName("Stojanović Tringa"), "Stojanović");
  assert.equal(firstPersonalName("  Uzi   Thomas "), "Uzi");
  const label = "Google Account: Ada Lovelace\n(ada@gmail.com)";
  assert.equal(nameFromAccountLabel(label, "ada@gmail.com"), "Ada Lovelace");
  assert.equal(nameFromAccountLabel(label, "other@gmail.com"), "");
  const named = attachAccountNames(
    [{ index: 0, email: "ada@gmail.com" }, { index: 1, email: "ben@gmail.com" }],
    [["gaia.l.a.mail", "1", "Ben", "ben@gmail.com", "", 0, 0, 0, 0, "0", "Ben", "Okonkwo"]],
    [label]
  );
  assert.deepEqual(named, [
    { index: 0, email: "ada@gmail.com", name: "Ada Lovelace" },
    { index: 1, email: "ben@gmail.com", name: "Ben Okonkwo" },
  ]);
});

test("a browser with ten signed-in Gmail accounts is not cut down to two", () => {
  const rows = Array.from({ length: 10 }, (_, index) => [
    "gaia.l.a",
    1,
    `User ${index}`,
    `user${index}@gmail.com`,
    "",
    1,
    1,
    0,
    0,
    1,
    "User",
    String(index),
  ]);
  const payload = JSON.stringify(["ogb.l.a.mail", rows]);
  const listed = accountsFromListPayloads([
    JSON.stringify(["ogb", rows.slice(0, 2)]),
    ")]}'\n" + payload,
  ]);
  assert.equal(listed.length, 10);
  assert.deepEqual(listed[0], { index: 0, email: "user0@gmail.com" });
  assert.deepEqual(listed[9], { index: 9, email: "user9@gmail.com" });
  const wrapped = accountsFromListPayloads([JSON.stringify(["owner@gmail.com", rows])]);
  assert.equal(wrapped.length, 10);
  assert.equal(wrapped[0].email, "user0@gmail.com");
  assert.equal(accountsFromListRows(rows).length, 10);
  const merged = mergeMailboxAccounts(
    [
      { index: 0, email: "user0@gmail.com" },
      { index: 1, email: "user1@gmail.com" },
    ],
    listed
  );
  assert.equal(merged.length, 10);
  assert.deepEqual(merged.map((account) => account.email), rows.map((row) => row[3]));
  const hinted = mailboxesFromHints([
    { href: "https://mail.google.com/mail/u/7/#inbox", email: "user7@gmail.com", authuser: "", label: "" },
    { href: "https://accounts.google.com/AccountChooser?Email=user3%40gmail.com&continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F3%2F", email: "", authuser: "3", label: "" },
    { href: "", email: "user4@gmail.com", authuser: "", label: "Google Account: User 4 (user4@gmail.com)" },
  ]);
  assert.deepEqual(hinted, [
    { index: 7, email: "user7@gmail.com" },
    { index: 3, email: "user3@gmail.com" },
    { index: null, email: "user4@gmail.com" },
  ]);
  const withSwitcher = mergeMailboxAccounts(hinted, listed);
  assert.equal(withSwitcher.length, 10);
  assert.equal(withSwitcher.find((account) => account.email === "user3@gmail.com").index, 3);
  assert.equal(withSwitcher.find((account) => account.email === "user7@gmail.com").index, 7);
  assert.ok(withSwitcher.some((account) => account.email === "user4@gmail.com"));
  assert.deepEqual(mailboxesFromHints([{
    href: "https://accounts.google.com/AccountChooser?Email=user5%40gmail.com&continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F",
    email: "",
    authuser: "",
    label: "",
  }]), [{ index: null, email: "user5@gmail.com" }]);
  const partial = accountsFromListPayloads([JSON.stringify(["ogb", rows.slice(0, 2)])]);
  const fromChooser = rows.map((row) => ({ index: null, email: row[3] }));
  const combined = mergeMailboxAccounts(fromChooser, partial);
  assert.equal(combined.length, 10);
  assert.deepEqual(combined.map((account) => account.email), rows.map((row) => row[3]));
  assert.equal(MAILBOX_PROBE_LIMIT >= 30, true);
  const sharedId = "<id>tag:google.com,2004:rss</id>";
  const keptFeeds = mailboxesFromFeeds([
    { index: 0, head: `<feed><title>Gmail - Inbox for one@gmail.com</title>${sharedId}` },
    { index: 1, head: `<feed><title>Gmail - Inbox for two@gmail.com</title>${sharedId}` },
    { index: 2, redirected: true },
  ]);
  assert.deepEqual(keptFeeds, [
    { index: 0, email: "one@gmail.com" },
    { index: 1, email: "two@gmail.com" },
  ]);
  assert.equal(feedProbeSettled([
    { index: 0, head: `<feed><title>Gmail - Inbox for one@gmail.com</title>${sharedId}` },
    { index: 1, head: `<feed><title>Gmail - Inbox for two@gmail.com</title>${sharedId}` },
    { index: 2, missing: true },
  ]), true);
  assert.equal(feedProbeSettled([{ index: 0, missing: true }]), false);
  const expiredGap = mailboxesFromFeeds([
    { index: 0, head: `<feed><title>Gmail - Inbox for one@gmail.com</title>${sharedId}` },
    { index: 1, redirected: true },
    { index: 2, head: `<feed><title>Gmail - Inbox for two@gmail.com</title>${sharedId}` },
  ]);
  assert.deepEqual(expiredGap, [
    { index: 0, email: "one@gmail.com" },
    { index: 2, email: "two@gmail.com" },
  ]);
  assert.equal(feedProbeSettled([
    { index: 0, head: `<feed><title>Gmail - Inbox for one@gmail.com</title>${sharedId}` },
    { index: 1, redirected: true },
    { index: 2, head: `<feed><title>Gmail - Inbox for two@gmail.com</title>${sharedId}` },
    { index: 3, missing: true },
    { index: 4, missing: true },
    { index: 5, missing: true },
  ]), true);
  const withSender = `<feed><title>Gmail - Inbox for one@gmail.com</title>${sharedId}<entry><author><email>stranger@gmail.com</email></author></entry></feed>`;
  assert.equal(atomMailboxFromFeed(withSender.split(/<entry/i)[0]), "one@gmail.com");
  assert.equal(atomMailboxFromFeed(withSender), "one@gmail.com");
  assert.deepEqual(withKnownIndex([
    { index: null, email: "later@gmail.com" },
    { index: 0, email: "first@gmail.com" },
    { index: 1, email: "second@gmail.com" },
  ]), [
    { index: 0, email: "first@gmail.com" },
    { index: 1, email: "second@gmail.com" },
  ]);
  const many = Array.from({ length: 12 }, (_, index) => ({ index, email: `user${index}@gmail.com` }));
  const kept = combineDetectedMailboxes(many, many.slice(0, 2), many.slice(0, 2));
  assert.equal(kept.length, 12);
  assert.equal(kept[11].email, "user11@gmail.com");
});

test("an expired Gmail session does not hide the next signed-in account", async () => {
  const feeds = {
    0: "<feed><title>Gmail - Inbox for one@gmail.com</title></feed>",
    1: "login",
    2: "login",
    3: "login",
    4: "login",
    5: "login",
    6: "<feed><title>Gmail - Inbox for two@gmail.com</title></feed>",
  };
  const result = await vm.runInNewContext(`(${probeAllInPage.toString()})(12)`, {
    fetch: async (url) => {
      const text = String(url);
      const index = Number((text.match(/\/mail\/u\/(\d+)/) || [])[1]);
      if (!text.includes("/mail/u/")) return { ok: false, url: text, text: async () => "" };
      const row = feeds[index];
      if (row === "login") {
        return { ok: true, url: "https://accounts.google.com/ServiceLogin", text: async () => "<html>Sign in</html>" };
      }
      if (!row) return { ok: false, url: text, text: async () => "" };
      return { ok: true, url: `https://mail.google.com/mail/u/${index}/feed/atom`, text: async () => row };
    },
    document: { querySelectorAll: () => [] },
    AbortSignal: { timeout() { return undefined; } },
  });
  assert.deepEqual(mailboxesFromFeeds(result.feeds).map((account) => account.email), [
    "one@gmail.com",
    "two@gmail.com",
  ]);
  assert.deepEqual(signedInMailboxes(result.feeds, [
    { index: 1, email: "expired@gmail.com" },
    { index: 5, email: "signedout@gmail.com" },
  ]).map((account) => account.email), [
    "one@gmail.com",
    "two@gmail.com",
  ]);
  assert.ok(result.feeds.some((feed) => feed.index === 1 && (feed.missing || feed.redirected)));
  assert.ok(result.feeds.some((feed) => feed.index > 2));
});

test("extension still loads the shared templates first", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.content_scripts[0].js, ["shared/email-content.js", "content.js"]);
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  assert.equal(content.includes("const emailContentByLanguage"), false);
  assert.match(content, /globalThis\.emailContentByLanguage/);
  assert.equal(isLoginUrl("https://accounts.google.com/v3/signin"), true);
  assert.equal(isLoginUrl("https://mail.google.com/mail/u/0/#inbox"), false);
  assert.equal(plainFromHtml("Hello &amp; Jane<br><br>Line"), "Hello & Jane\n\nLine");
});

test("analyse reads delivery reports and saves the client address and first name", async () => {
  assert.equal(analyseSentQuery("2026-11-01", "2026-11-10"), "in:sent after:2026/11/1 before:2026/11/11");
  assert.equal(analyseSentQuery("2026-11-10", "2026-11-01"), "");
  const missing = parseDeliveryReport("Hi Ada, thanks for your note.");
  assert.equal(missing, null);
  const address = parseDeliveryReport(`
    Address not found
    Your message wasn't delivered to ada.lovelace@client.com because the address couldn't be found.
    550 5.1.1 The email account that you tried to reach does not exist.
    To: Ada Lovelace <ada.lovelace@client.com>
    Hi Ada,
  `, { email: "mailer-daemon@googlemail.com", name: "Mail Delivery Subsystem" });
  assert.equal(address.label, "Address not found");
  assert.equal(address.email, "ada.lovelace@client.com");
  assert.equal(address.firstName, "Ada");
  const full = parseDeliveryReport("Mailbox full. Your message to Sam Lee <sam.lee@other.com> couldn't be delivered. 552 5.2.2 over quota.");
  assert.equal(full.label, "Mailbox full");
  assert.equal(full.email, "sam.lee@other.com");
  assert.equal(full.firstName, "Sam");
  const blocked = parseDeliveryReport("Message blocked. Your message to info@vendor.com was blocked. 550 5.7.1 Message rejected.");
  assert.equal(blocked.email, "info@vendor.com");
  assert.equal(blocked.firstName, "");
  assert.equal(blocked.label, "Blocked");
  const named = parseDeliveryReport("Final-Recipient: rfc822; jane.doe@acme.com\nStatus: 5.1.1\n550 5.1.1 User unknown");
  assert.equal(named.email, "jane.doe@acme.com");
  assert.equal(named.firstName, "Jane");
  assert.match(validateAnalyseInput({ accounts: [], from: "", limit: 0 }).join(" "), /Gmail account/);
  assert.match(validateAnalyseInput({
    accounts: [{ email: "ada@gmail.com", envId: "1" }],
    from: "2026-11-10",
    to: "2026-11-01",
    limit: 40,
  }).join(" "), /end date/);
  const { runner, store } = buildRunner({
    gmail: {
      async analyseSentThreads() {
        return {
          opened: ["thread-1"],
          exhausted: true,
          seen: ["thread-1"],
          reports: [{
            email: "mailer-daemon@googlemail.com",
            name: "Mail Delivery Subsystem",
            subject: "Delivery Status Notification (Failure)",
            threadId: "thread-1",
            body: "Your message wasn't delivered to pat@client.com because the address couldn't be found. 550 5.1.1 User unknown. Hi Pat,",
          }],
        };
      },
    },
  });
  store.data.contacts = [{ name: "Keep", email: "keep@example.com", company: "Keep" }];
  const campaign = createAnalyseCampaign({
    from: "2026-11-01",
    to: "2026-11-10",
    limit: 40,
    accounts: [account("a", "Alpha", "Ada")],
  });
  assert.equal(campaign.kind, "analyse");
  assert.equal(campaignView(campaign).kind, "analyse");
  runner.start(campaign);
  await runner.loopPromise;
  assert.equal(runner.campaign.status, "done");
  assert.equal(runner.campaign.sentTotal, 1);
  assert.equal(runner.campaign.counts["Address not found"], 1);
  assert.equal(store.data.contacts[0].email, "keep@example.com");
  assert.equal(store.data.analysis.contacts[0].email, "pat@client.com");
  assert.equal(store.data.analysis.contacts[0].firstName, "Pat");
  const again = mergeSavedAnalysis(store.data.analysis, {
    counts: { Blocked: 1 },
    contacts: [{ email: "pat@client.com", firstName: "", type: "blocked", gmail: "ada@gmail.com" }],
  });
  assert.equal(again.contacts[0].firstName, "Pat");
  assert.equal(again.contacts[0].label, "Blocked");
});

test("refused MoreLogin port explains that the app is not running", async () => {
  await assert.rejects(
    () => postJson("http://127.0.0.1:1/api/env/page", {}, {}, 1500),
    /Cannot reach MoreLogin|timed out/
  );
});
