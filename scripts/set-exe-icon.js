const fs = require("fs");
const path = require("path");
const ResEdit = require("resedit");

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

async function setExeIcon(context) {
  if (context.electronPlatformName !== "win32") return;
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const iconPath = path.join(__dirname, "..", "build", "icon.ico");
  const data = fs.readFileSync(exePath);
  const executable = ResEdit.NtExecutable.from(data);
  const resource = ResEdit.NtExecutableResource.from(executable);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));

  for (let index = resource.entries.length - 1; index >= 0; index -= 1) {
    const type = resource.entries[index].type;
    if (type === RT_ICON || type === RT_GROUP_ICON) resource.entries.splice(index, 1);
  }
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resource.entries,
    1,
    1033,
    iconFile.icons.map((item) => item.data),
  );

  const version = context.packager.appInfo.version.split(".").map((part) => Number(part) || 0);
  while (version.length < 4) version.push(0);
  const [major, minor, micro, revision] = version;
  const productName = context.packager.appInfo.productName;
  const versionInfo = ResEdit.Resource.VersionInfo.fromEntries(resource.entries)[0];
  if (versionInfo) {
    const language = versionInfo.getAllLanguagesForStringValues()[0] || { lang: 1033, codepage: 1200 };
    versionInfo.setFileVersion(major, minor, micro, revision, language.lang);
    versionInfo.setProductVersion(major, minor, micro, revision, language.lang);
    const current = versionInfo.getStringValues(language);
    versionInfo.setStringValues(language, {
      ...current,
      FileDescription: productName,
      ProductName: productName,
      InternalName: productName,
      OriginalFilename: `${productName}.exe`,
      CompanyName: productName,
    });
    versionInfo.outputToResourceEntries(resource.entries);
  }

  resource.outputResource(executable);
  fs.writeFileSync(exePath, Buffer.from(executable.generate()));
}

module.exports = setExeIcon;
