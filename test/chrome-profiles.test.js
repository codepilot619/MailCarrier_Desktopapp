const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ChromeDebugError,
  ChromeProfiles,
  profileLabel,
  readChromeProfiles,
  readDebugEndpoint,
  removeUnusedJunction,
  writeDebuggingPref,
} = require("../lib/chrome-profiles");
const { allowWatcherScript } = require("../lib/chrome-allow");
const { debuggerSocketUrl, isProtocolTimeout, openAnotherSocket, queueKey, shouldRetryPortConnect, PROTOCOL_TIMEOUT_MS, PORT_PROTOCOL_TIMEOUT_MS } = require("../lib/browser-session");
const { desktopTypeSource } = require("../lib/virtual-desktop");

function writeProfile(root, directory, info, accounts) {
  const dir = path.join(root, directory);
  fs.mkdirSync(dir, { recursive: true });
  if (accounts) {
    fs.writeFileSync(path.join(dir, "Preferences"), JSON.stringify({ account_info: accounts }));
  }
  return info;
}

test("profile names match the Chrome menu", () => {
  assert.equal(profileLabel({ name: "Ron", gaia_given_name: "David" }), "David (Ron)");
  assert.equal(profileLabel({ name: "Ivan", gaia_given_name: "Ivan" }), "Ivan");
  assert.equal(profileLabel({ name: "用户1" }), "用户1");
});

test("saved Chrome profiles become Gmail rows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-chrome-"));
  const cache = {
    "Profile 2": writeProfile(root, "Profile 2", { name: "Ron", gaia_given_name: "David", user_name: "ron@gmail.com" }, [
      { email: "ron@gmail.com", full_name: "David Ron", given_name: "David" },
    ]),
    "Profile 10": writeProfile(root, "Profile 10", { name: "Tajon", gaia_given_name: "Tajon", user_name: "tajon@gmail.com" }, []),
    "Guest Profile": { name: "Guest" },
    "System Profile": { name: "System" },
  };
  fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({ profile: { info_cache: cache } }));
  const profiles = readChromeProfiles(root);
  assert.deepEqual(profiles.map((profile) => profile.envName), ["David (Ron)", "Tajon"]);
  assert.equal(profiles[0].envId, "chrome:Profile 2");
  assert.equal(profiles[0].groupName, "Chrome");
  assert.deepEqual(profiles[0].hintAccounts, [{ index: 0, email: "ron@gmail.com", name: "David Ron" }]);
  assert.equal(profiles[1].hintAccounts[0].email, "tajon@gmail.com");
});

function safeClient(options) {
  return new ChromeProfiles({
    chromePath: "chrome.exe",
    retireLink: async () => {},
    junctionChromeIsRunning: async () => false,
    endpointOpen: async () => true,
    delay: async () => {},
    quitChrome: async () => {},
    writeDebuggingPref: () => {},
    listHttpPages: async () => [],
    ...options,
  });
}

function usesRealProfile(args) {
  return args.some((arg) => /user-data-dir|remote-debugging-port|remote-allow-origins/i.test(String(arg)));
}

test("browser connect uses a longer CDP protocol timeout", () => {
  assert.equal(PROTOCOL_TIMEOUT_MS >= 600000, true);
  assert.equal(isProtocolTimeout(new Error("Network.enable timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.")), true);
  assert.equal(PORT_PROTOCOL_TIMEOUT_MS < PROTOCOL_TIMEOUT_MS, true);
  assert.equal(shouldRetryPortConnect(new Error("ECONNREFUSED"), 0, 8), true);
  assert.equal(shouldRetryPortConnect(new Error("Network.enable timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed."), 0, 8), false);
  assert.equal(shouldRetryPortConnect(new Error("ECONNREFUSED"), 7, 8), false);
  assert.equal(isProtocolTimeout(new Error("something else")), false);
});

test("browser sessions queue separately per debug endpoint", () => {
  assert.equal(queueKey({ debugPort: "9222" }), "port:9222");
  assert.equal(queueKey({ browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/1" }), "ws:ws://127.0.0.1:9222/devtools/browser/1");
  assert.notEqual(queueKey({ debugPort: "9222" }), queueKey({ debugPort: "9333" }));
  assert.equal(
    debuggerSocketUrl("ws://localhost:1111/devtools/browser/abc", "2222"),
    "ws://127.0.0.1:2222/devtools/browser/abc"
  );
});

test("the second Chrome profile is not read from the first profile window", async () => {
  const pages = [
    { id: "first-window", type: "page", url: "https://mail.google.com/mail/u/0/#inbox", title: "Inbox - ada@gmail.com - Gmail" },
  ];
  const endpoint = { port: "9334", browserWSEndpoint: "ws://127.0.0.1:9334/devtools/browser/abc" };
  const client = safeClient({
    readEndpoint: () => endpoint,
    quitChrome: async () => {
      throw new Error("should use the Chrome that is already open");
    },
    readProfiles: () => [
      { profileDirectory: "Default", hintAccounts: [{ email: "ada@gmail.com" }] },
      { profileDirectory: "Profile 2", hintAccounts: [{ email: "bea@gmail.com" }] },
    ],
    listHttpPages: async () => pages.map((page) => ({ ...page })),
    spawnChrome(args) {
      assert.equal(args.includes("--profile-directory=Profile 2"), true);
      pages.push({ id: "second-window", type: "page", url: "https://mail.google.com/mail/u/0/#inbox?compose=new", title: "" });
    },
    listPages: async () => pages.map((page) => ({ ...page })),
  });
  const session = await client.ensureProfile("Profile 2");
  assert.equal(session.targetId, "second-window");
});

test("every open Chrome window is available when the profile list is refreshed", async () => {
  const endpoint = { port: "9334", browserWSEndpoint: "ws://127.0.0.1:9334/devtools/browser/abc" };
  const client = safeClient({
    readEndpoint: () => endpoint,
    readProfiles: () => [
      { profileDirectory: "Default", envId: "chrome:Default", hintAccounts: [{ email: "ada@gmail.com" }] },
      { profileDirectory: "Profile 2", envId: "chrome:Profile 2", hintAccounts: [{ email: "bea@gmail.com" }] },
      { profileDirectory: "Profile 3", envId: "chrome:Profile 3", hintAccounts: [{ email: "cara@gmail.com" }] },
    ],
    listHttpPages: async () => [
      { id: "first-window", type: "page", url: "https://mail.google.com/mail/u/0/#inbox", title: "Inbox - ada@gmail.com - Gmail" },
      { id: "second-window", type: "page", url: "https://mail.google.com/mail/u/0/#inbox", title: "Inbox - bea@gmail.com - Gmail" },
    ],
  });
  const listed = await client.list();
  assert.equal(listed.profiles[0].running, true);
  assert.equal(listed.profiles[0].targetId, "first-window");
  assert.equal(listed.profiles[1].running, true);
  assert.equal(listed.profiles[1].debugPort, "9334");
  assert.equal(listed.profiles[2].running, false);
  assert.equal(listed.profiles[2].debugPort, "");
});

test("warming up the next Gmail in one profile reuses its tab", async () => {
  const pages = [];
  let spawns = 0;
  let lists = 0;
  const endpoint = { port: "9334", browserWSEndpoint: "ws://127.0.0.1:9334/devtools/browser/abc" };
  const client = safeClient({
    readEndpoint: () => endpoint,
    showInbox: async () => {},
    spawnChrome(args) {
      spawns += 1;
      const marker = args.find((arg) => String(arg).includes("mail.google.com"));
      pages.push({ id: "profile-tab", type: "page", url: String(marker), title: "Inbox - ada@gmail.com - Gmail" });
    },
    listPages: async () => {
      lists += 1;
      if (lists > 1) throw new Error("tab list failed");
      return pages.map((page) => ({ ...page }));
    },
    listHttpPages: async () => pages.map((page) => ({ ...page })),
  });
  const first = await client.ensureProfile("Default", 0);
  const second = await client.ensureProfile("Default", 1);
  assert.equal(spawns, 1);
  assert.equal(first.targetId, "profile-tab");
  assert.equal(second.targetId, "profile-tab");
});

test("a lost profile tab is reused instead of opening another", async () => {
  const pages = [];
  let spawns = 0;
  let hideFromList = false;
  const endpoint = { port: "9334", browserWSEndpoint: "ws://127.0.0.1:9334/devtools/browser/abc" };
  const client = safeClient({
    readEndpoint: () => endpoint,
    showInbox: async () => {},
    spawnChrome() {
      spawns += 1;
      pages.push({ id: "profile-tab", type: "page", url: "https://mail.google.com/mail/u/0/#inbox", title: "" });
    },
    listPages: async () => (hideFromList ? [] : pages.map((page) => ({ ...page }))),
    listHttpPages: async () => pages.map((page) => ({ ...page })),
  });
  await client.ensureProfile("Default", 0);
  hideFromList = true;
  client.targets.delete("Default");
  const again = await client.ensureProfile("Default", 3);
  assert.equal(spawns, 1);
  assert.equal(again.targetId, "profile-tab");
});

test("an already open second Chrome profile is read from its own window", async () => {
  const endpoint = { port: "9334", browserWSEndpoint: "ws://127.0.0.1:9334/devtools/browser/abc" };
  const client = safeClient({
    readEndpoint: () => endpoint,
    readProfiles: () => [
      { profileDirectory: "Default", hintAccounts: [{ email: "ada@gmail.com" }] },
      { profileDirectory: "Profile 2", hintAccounts: [{ email: "bea@gmail.com" }] },
    ],
    listHttpPages: async () => [
      { id: "first-window", type: "page", url: "https://mail.google.com/mail/u/0/#inbox", title: "Inbox - ada@gmail.com - Gmail" },
      { id: "second-window", type: "page", url: "https://mail.google.com/mail/u/0/#inbox", title: "Inbox - bea@gmail.com - Gmail" },
    ],
    spawnChrome() {
      throw new Error("should use the already open Profile 2 window");
    },
  });
  const session = await client.ensureProfile("Profile 2");
  assert.equal(session.targetId, "second-window");
});

test("the Allow watcher only presses the remote debugging button", () => {
  const script = allowWatcherScript(90000);
  assert.match(script, /Allow remote debugging\?/);
  assert.match(script, /Current\.Name -eq 'Allow'/);
  assert.match(script, /ControlType\.Button/);
  assert.match(script, /InvokePattern/);
  assert.match(script, /DoDefaultAction/);
  assert.match(script, /WindowAlive/);
  assert.match(script, /SendMessage/);
  assert.match(script, /Click-Allow/);
  assert.match(script, /Click-ProfileYes/);
  assert.match(script, /Click-ExactButton \$button \$hwnd 'Yes'/);
  assert.equal(script.includes("MoveToSecond"), false);
  assert.equal(script.includes("SetCursorPos"), false);
  assert.equal(script.includes("mouse_event"), false);
  assert.equal(script.includes("SetForegroundWindow"), false);
  assert.equal(script.includes("Turn off in settings"), false);
  assert.equal(script.includes("Remove-RemoteSettingsModal"), false);
  assert.equal(script.includes("TreeScope]::Children, $winCond"), false);
});

test("one debugging connection stays up while its Allow dialog is open", () => {
  assert.equal(openAnotherSocket("open", true, 5000, 0), false);
  assert.equal(openAnotherSocket("failed", false, 5000, 0), false);
  assert.equal(openAnotherSocket("failed", true, 1000, 5000), false);
  assert.equal(openAnotherSocket("failed", true, 5000, 5000), true);
});

test("desktop placement keeps the visible desktop still", () => {
  const source = desktopTypeSource();
  assert.match(source, /MoveViewToDesktop/);
  assert.match(source, /CreateDesktop/);
  assert.match(source, /StayOn/);
  assert.match(source, /ProcessName, "chrome"/);
  assert.equal(source.includes("SwitchDesktopAndMoveForegroundView(current"), false);
  assert.equal(source.includes("manager.SwitchDesktop"), false);
});

test("the debug endpoint is read from Chrome's own profile folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-port-"));
  fs.writeFileSync(path.join(root, "DevToolsActivePort"), "41000\n/devtools/browser/abc-1\n");
  assert.deepEqual(readDebugEndpoint(root), {
    port: "41000",
    browserWSEndpoint: "ws://127.0.0.1:41000/devtools/browser/abc-1",
  });
  fs.writeFileSync(path.join(root, "DevToolsActivePort"), "nope\n");
  assert.equal(readDebugEndpoint(root), null);
});

test("an unused profile link is removed and the real folder stays", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-link-"));
  const target = path.join(root, "User Data");
  const link = path.join(root, "MailCarrierChromeLink");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "keep.txt"), "ok");
  fs.symlinkSync(target, link, "junction");
  assert.equal(await removeUnusedJunction(link, target, async () => false), true);
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "ok");
});

test("a profile link stays while that Chrome is open", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-live-link-"));
  const target = path.join(root, "User Data");
  const link = path.join(root, "MailCarrierChromeLink");
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, "junction");
  assert.equal(await removeUnusedJunction(link, target, async () => true), false);
  assert.equal(fs.existsSync(link), true);
  fs.rmdirSync(link);
});

test("a debug server that does not start pauses sending once", async () => {
  const spawned = [];
  const client = safeClient({
    debugWaitMs: 0,
    readEndpoint: () => null,
    spawnChrome(args) {
      spawned.push(args);
    },
  });
  await assert.rejects(() => client.ensureProfile("Default"), (error) => {
    assert.equal(error instanceof ChromeDebugError, true);
    assert.equal(error.fatal, true);
    return true;
  });
  assert.equal(spawned.length, 1);
  assert.equal(usesRealProfile(spawned[0]), false);
});

test("the debugging switch is saved without changing the Chrome profile list", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mail-carrier-state-"));
  const filePath = path.join(root, "Local State");
  fs.writeFileSync(filePath, JSON.stringify({
    profile: { info_cache: { "Profile 2": { name: "Vito" } } },
    devtools: { remote_debugging: { allowed: true } },
  }));
  assert.equal(writeDebuggingPref(root), true);
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(data.devtools.remote_debugging["user-enabled"], true);
  assert.equal(data.devtools.remote_debugging.allowed, true);
  assert.equal(data.profile.info_cache["Profile 2"].name, "Vito");
  assert.equal(writeDebuggingPref(root), false);
  assert.equal(new ChromeDebugError().fatal, true);
});

test("debugging is turned on in the real Chrome profile", async () => {
  const pages = [];
  const spawned = [];
  let quit = 0;
  let pref = 0;
  const client = safeClient({
    readEndpoint: () => (pref
      ? { port: "9334", browserWSEndpoint: "ws://127.0.0.1:9334/devtools/browser/abc" }
      : null),
    quitChrome: async () => {
      quit += 1;
    },
    writeDebuggingPref: () => {
      pref += 1;
    },
    spawnChrome(args) {
      spawned.push(args);
      const marker = args.find((arg) => String(arg).includes("mail.google.com"));
      if (marker) pages.push({ id: "tab-4", type: "page", url: String(marker) });
    },
    listPages: async () => pages.map((page) => ({ ...page })),
  });
  const session = await client.ensureProfile("Profile 2");
  assert.equal(quit, 1);
  assert.equal(pref, 1);
  assert.equal(session.targetId, "tab-4");
  assert.equal(session.browserWSEndpoint, "ws://127.0.0.1:9334/devtools/browser/abc");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].includes("--profile-directory=Profile 2"), true);
  assert.equal(usesRealProfile(spawned[0]), false);
  const again = await client.ensureProfile("Profile 2");
  assert.equal(again.targetId, "tab-4");
  assert.equal(quit, 1);
});

test("only the Chrome window Mail Carrier opened is closed", async () => {
  const closed = [];
  const pages = [];
  let seq = 0;
  const endpoint = { port: "9334", browserWSEndpoint: "ws://127.0.0.1:9334/devtools/browser/abc" };
  const client = safeClient({
    readEndpoint: () => endpoint,
    spawnChrome(args) {
      const marker = args.find((arg) => String(arg).includes("mail.google.com"));
      seq += 1;
      pages.push({ id: `tab-${seq}`, type: "page", url: String(marker) });
    },
    listPages: async () => pages.map((page) => ({ ...page })),
    closePage: async (targetId) => {
      closed.push(targetId);
      const index = pages.findIndex((page) => page.id === targetId);
      if (index >= 0) pages.splice(index, 1);
    },
  });
  const first = await client.ensureProfile("Default");
  const second = await client.ensureProfile("Profile 2");
  assert.equal(await client.closeOwned("Default"), true);
  assert.deepEqual(closed, [first.targetId]);
  assert.equal(client.targets.has("Default"), false);
  assert.equal(client.targets.has("Profile 2"), true);
  const reopened = await client.ensureProfile("Default");
  assert.notEqual(reopened.targetId, first.targetId);
  assert.equal(await client.closeOwned(""), true);
  assert.equal(client.targets.size, 0);
  assert.equal(closed.includes(second.targetId), true);
  assert.equal(closed.includes(reopened.targetId), true);
});

test("the selected profile window opens before debugging is allowed", async () => {
  const order = [];
  const pages = [];
  let lists = 0;
  const endpoint = { port: "9334", browserWSEndpoint: "ws://127.0.0.1:9334/devtools/browser/abc" };
  const client = safeClient({
    readEndpoint: () => endpoint,
    quitChrome: async () => {
      throw new Error("should use the Chrome that is already open");
    },
    spawnChrome(args) {
      order.push("spawn");
      const marker = args.find((arg) => String(arg).includes("mail.google.com"));
      pages.push({ id: "tab-selected", type: "page", url: String(marker) });
      assert.equal(args.includes("--profile-directory=Profile 2"), true);
      assert.match(String(marker), /mail\.google\.com\/mail\/u\/0\/#inbox\?compose=new/);
    },
    listPages: async () => {
      lists += 1;
      order.push("list");
      if (lists === 1) throw new Error("Chrome did not allow debugging");
      return pages.map((page) => ({ ...page }));
    },
  });
  const session = await client.ensureProfile("Profile 2");
  assert.equal(session.targetId, "tab-selected");
  assert.equal(order[0], "spawn");
  assert.equal(spawnedCount(order), 1);
});

function spawnedCount(order) {
  return order.filter((step) => step === "spawn").length;
}

test("after Allow the selected Gmail inbox is opened", async () => {
  let lists = 0;
  const opened = [];
  const endpoint = { port: "9334", browserWSEndpoint: "ws://127.0.0.1:9334/devtools/browser/abc" };
  const client = safeClient({
    readEndpoint: () => endpoint,
    spawnChrome(args) {
      const marker = args.find((arg) => String(arg).includes("mail.google.com"));
      assert.match(String(marker), /mail\.google\.com\/mail\/u\/2\/#inbox\?compose=new/);
    },
    listPages: async () => {
      lists += 1;
      if (lists === 1) throw new Error("Chrome did not allow debugging");
      return [
        { id: "old-inbox", type: "page", url: "https://mail.google.com/mail/u/0/#inbox" },
        { id: "tab-send", type: "page", url: "https://mail.google.com/mail/u/2/#inbox" },
      ];
    },
    showInbox: async (session, gmailIndex) => {
      opened.push([session.targetId, gmailIndex]);
    },
  });
  const session = await client.ensureProfile("Profile 2", 2);
  assert.equal(session.targetId, "tab-send");
  assert.deepEqual(opened, [["tab-send", 2]]);
});

test("an already open Chrome is used without a second profile folder", async () => {
  const pages = [];
  const spawned = [];
  const endpoint = { port: "9334", browserWSEndpoint: "ws://127.0.0.1:9334/devtools/browser/abc" };
  const client = safeClient({
    readEndpoint: () => endpoint,
    quitChrome: async () => {
      throw new Error("should use the Chrome that is already open");
    },
    chromeIsRunning: async () => {
      throw new Error("should use the Chrome that is already open");
    },
    spawnChrome(args) {
      spawned.push(args);
      const marker = args.find((arg) => String(arg).includes("mail.google.com"));
      pages.push({ id: "tab-9", type: "page", url: String(marker) });
    },
    listPages: async () => pages.map((page) => ({ ...page })),
  });
  const session = await client.ensureProfile("Profile 2");
  assert.equal(session.debugPort, "9334");
  assert.equal(session.browserWSEndpoint, endpoint.browserWSEndpoint);
  assert.equal(session.targetId, "tab-9");
  const again = await client.ensureProfile("Profile 2");
  assert.equal(again.targetId, "tab-9");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].includes("--profile-directory=Profile 2"), true);
  assert.equal(usesRealProfile(spawned[0]), false);
});

test("Chrome starts on its real profile without a debug port", async () => {
  let reads = 0;
  const pages = [];
  const spawned = [];
  const client = safeClient({
    debugWaitMs: 1000,
    readEndpoint: () => {
      reads += 1;
      if (reads < 2) return null;
      return { port: "41000", browserWSEndpoint: "ws://127.0.0.1:41000/devtools/browser/abc" };
    },
    chromeIsRunning: async () => false,
    spawnChrome(args) {
      spawned.push(args);
      const marker = args.find((arg) => String(arg).includes("mail.google.com"));
      if (marker) pages.push({ id: "tab-3", type: "page", url: String(marker) });
    },
    listPages: async () => pages.map((page) => ({ ...page })),
  });
  const session = await client.ensureProfile("Default");
  assert.equal(session.targetId, "tab-3");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].includes("--profile-directory=Default"), true);
  assert.equal(usesRealProfile(spawned[0]), false);
});

test("the old linked Chrome is not launched over the real profile", async () => {
  let spawned = 0;
  const client = safeClient({
    junctionChromeIsRunning: async () => true,
    retireLink: async () => {
      throw new Error("should not remove the link while Chrome is using it");
    },
    spawnChrome() {
      spawned += 1;
    },
  });
  await assert.rejects(() => client.ensureProfile("Profile 2"), /will not force-close Chrome/);
  assert.equal(spawned, 0);
});
