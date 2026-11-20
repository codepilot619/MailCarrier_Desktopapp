const fs = require("fs");
const path = require("path");

const root = "C:\\Program Files\\Google\\Chrome\\Application\\153.0.8010.37";
const files = [
  path.join(root, "Locales", "en-US.pak"),
  path.join(root, "resources.pak"),
].filter((file) => fs.existsSync(file));

function contexts(buffer, encoding) {
  const text = buffer.toString(encoding).replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ");
  const out = [];
  const re = /(?<![A-Za-z])Yes(?![A-Za-z]).{0,80}/g;
  let match;
  while ((match = re.exec(text)) && out.length < 12) {
    out.push(text.slice(Math.max(0, match.index - 40), match.index + 500).replace(/\s+/g, " "));
  }
  return out;
}

for (const file of files) {
  const buffer = fs.readFileSync(file);
  const hits = [
    ...contexts(buffer, "utf8"),
    ...contexts(buffer, "utf16le"),
  ];
  console.log("\n==", path.basename(file), buffer.length, "hits", hits.length);
  hits.forEach((line) => console.log(line));
}
