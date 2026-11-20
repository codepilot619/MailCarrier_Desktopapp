const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

require("./stage-installer");

const desktopRoot = path.join(__dirname, "..");
const preferred = path.join(desktopRoot, "dist");
const version = require("../package.json").version;
const setupName = `Mail-Carrier-Setup-${version}.exe`;

function canReplace(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stuckProbe = path.join(dir, "write-probe.txt");
  if (fs.existsSync(stuckProbe)) {
    try {
      fs.rmSync(stuckProbe);
    } catch (error) {
      return false;
    }
  }
  const probe = path.join(dir, `.replace-probe-${process.pid}`);
  fs.writeFileSync(probe, "ok");
  try {
    fs.rmSync(probe);
    return true;
  } catch (error) {
    return false;
  }
}

let output = preferred;
if (!canReplace(preferred)) {
  output = path.join(process.env.LOCALAPPDATA || require("os").tmpdir(), "MailCarrierBuild");
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  console.log(`Building the installer in ${output}`);
  console.log(`${preferred} cannot replace files, so the setup file will be copied there after the build.`);
}

const result = spawnSync(
  process.execPath,
  [
    path.join(desktopRoot, "node_modules", "electron-builder", "cli.js"),
    "--win",
    "nsis",
    "--x64",
    `-c.directories.output=${output}`,
  ],
  {
    cwd: desktopRoot,
    stdio: "inherit",
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  },
);

if (result.status !== 0) process.exit(result.status || 1);

const built = path.join(output, setupName);
if (!fs.existsSync(built)) {
  console.error(`Installer was not created at ${built}`);
  process.exit(1);
}

if (path.resolve(output) !== path.resolve(preferred)) {
  fs.mkdirSync(preferred, { recursive: true });
  const copied = path.join(preferred, setupName);
  fs.copyFileSync(built, copied);
  console.log(`Installer: ${copied}`);
} else {
  console.log(`Installer: ${built}`);
}
