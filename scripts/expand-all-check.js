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
    const snapshot = () => ({
      groups: [...document.querySelectorAll("#profile-list .tree-group:not(.hidden-group)")].map((group) => ({
        label: group.querySelector(".group-label")?.textContent || "",
        open: group.open,
      })),
      profiles: [...document.querySelectorAll("#profile-list .profile-node")].map((node) => ({
        name: node.querySelector(".profile-title")?.childNodes[0]?.textContent || "",
        open: node.classList.contains("is-open"),
        branchHidden: Boolean(node.querySelector(".gmail-branch")?.hidden),
        label: node.querySelector(".twisty-btn")?.getAttribute("aria-label") || "",
        rows: node.querySelectorAll(".gmail-row").length,
      })),
      hidden: [...document.querySelectorAll("#profile-list .hidden-group")].map((group) => ({
        label: group.querySelector(".group-label")?.textContent || "",
        open: group.open,
      })),
      buttonsEnabled: {
        expand: document.getElementById("expand-all")?.disabled === false,
        collapse: document.getElementById("collapse-all")?.disabled === false,
      },
    });
    const initial = snapshot();
    document.getElementById("collapse-all").click();
    const collapsed = snapshot();
    renderProfiles();
    const collapsedAfterRender = snapshot();
    document.getElementById("expand-all").click();
    const expanded = snapshot();
    document.querySelector(".hide-profile").click();
    const hiddenBefore = snapshot().hidden;
    document.getElementById("expand-all").click();
    const hiddenAfterExpand = snapshot().hidden;
    document.getElementById("collapse-all").click();
    const hiddenAfterCollapse = snapshot().hidden;
    const moreloginCollapsed = snapshot();
    state.settings.browserSource = "chrome";
    renderProfiles();
    document.getElementById("expand-all").click();
    const chromeExpanded = snapshot();
    document.getElementById("collapse-all").click();
    const chromeCollapsed = snapshot();
    renderProfiles();
    const chromeCollapsedAfterRender = snapshot();
    return { initial, collapsed, collapsedAfterRender, expanded, hiddenBefore, hiddenAfterExpand, hiddenAfterCollapse, moreloginCollapsed, chromeExpanded, chromeCollapsed, chromeCollapsedAfterRender };
  })()`);
  console.log(JSON.stringify(result, null, 2));
  app.exit(0);
});
