const { app, BrowserWindow } = require("electron");
const path = require("path");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  const result = await win.webContents.executeJavaScript(`(() => {
    window.confirm = () => true;
    const before = {
      groups: document.querySelectorAll(".tree-group:not(.hidden-group)").length,
      profiles: document.querySelectorAll(".profile-node").length,
      openEmail: document.querySelector(".profile-node.is-open .account-email")?.textContent || "",
      closedHidden: document.querySelector(".profile-node:not(.is-open) .gmail-branch")?.hidden === true,
      summary: document.querySelector(".profile-meta")?.textContent || "",
    };
    document.querySelector(".profile-node:not(.is-open) .twisty-btn").click();
    const expanded = document.querySelectorAll(".profile-node.is-open").length;
    document.querySelector(".hide-profile").click();
    const after = {
      profiles: document.querySelectorAll(".profile-node").length,
      hidden: document.querySelector(".hidden-group .group-label")?.textContent || "",
      hiddenName: document.querySelector(".hidden-row .profile-title")?.textContent || "",
    };
    document.querySelector(".show-profile").click();
    const restored = document.querySelectorAll(".profile-node").length;
    return { before, expanded, after, restored };
  })()`);
  console.log(JSON.stringify(result));
  await win.webContents.capturePage().then((image) => {
    require("fs").writeFileSync(path.join(__dirname, "..", "tree-check.png"), image.toPNG());
  });
  app.exit(0);
});
