const { ChromeProfiles } = require("../lib/chrome-profiles");
const { detectGmailAccounts } = require("../lib/gmail");

async function main() {
  const chrome = new ChromeProfiles();
  const listed = await chrome.list();
  if (listed.error) throw new Error(listed.error);
  console.log(`COUNT ${listed.profiles.length}`);
  console.log(listed.profiles.map((profile) => profile.envName).join(" | "));
  const wanted = ["Profile 2", "Profile 10"];
  let opened = false;
  try {
    for (const directory of wanted) {
      const session = await chrome.ensureProfile(directory);
      opened = true;
      const found = await detectGmailAccounts(session.debugPort, {
        targetId: session.targetId,
        browserWSEndpoint: session.browserWSEndpoint,
      });
      const summary = (found.accounts || []).map((account) => String(account.index)).join(",") || "none";
      console.log(`READ ${directory} login=${Boolean(found.needsLogin)} accounts=${(found.accounts || []).length} indexes=${summary}`);
    }
  } finally {
    if (opened) console.log("LEFT_CHROME_OPEN");
  }
}

main().catch((error) => {
  console.error("LIVE_FAIL", error.message);
  process.exitCode = 1;
});
