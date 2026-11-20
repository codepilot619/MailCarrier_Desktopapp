const { spawn } = require("child_process");
const path = require("path");
const electronPath = require("electron");

const child = spawn(electronPath, ["."], {
  cwd: path.join(__dirname, ".."),
  env: { ...process.env, MAIL_CARRIER_SMOKE: "1" },
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code == null ? 1 : code);
});
