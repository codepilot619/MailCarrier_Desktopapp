const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const contentPath = path.join(root, "content.js");
const targetPath = path.join(root, "shared", "email-content.js");
const src = fs.readFileSync(contentPath, "utf8");

if (!src.includes("const emailContentByLanguage = {")) {
  console.log("Templates are already in shared/email-content.js");
  process.exit(0);
}

const objectStart = src.indexOf("const emailContentByLanguage = {");
const comment = "// Email subjects and templates by language (en default)\r\n";
const commentLf = "// Email subjects and templates by language (en default)\n";
let cutStart = objectStart;
if (src.lastIndexOf(comment, objectStart) === objectStart - comment.length) {
  cutStart = objectStart - comment.length;
} else if (src.lastIndexOf(commentLf, objectStart) === objectStart - commentLf.length) {
  cutStart = objectStart - commentLf.length;
}

const funcMatch = src.slice(objectStart).search(/\r?\nfunction getEmailContent\(\)/);
if (funcMatch < 0) throw new Error("Could not find getEmailContent()");
const funcStart = objectStart + funcMatch;
const randomStart = src.indexOf("function getRandomSubject()");
if (randomStart < 0) throw new Error("Could not find getRandomSubject()");

let block = src.slice(objectStart, funcStart).trim();
block = block.replace(/^const emailContentByLanguage/, "var emailContentByLanguage");
if (!block.endsWith(";")) block += ";";
if (!block.includes("zh:") || !block.includes("hi:") || !block.includes("de:")) {
  throw new Error("Template extraction missed a language");
}

const footer = `
globalThis.emailContentByLanguage = emailContentByLanguage;

function escapeHtmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function applyPlaceholders(text, contact, senderName) {
  return String(text ?? "")
    .replace(/\\[Name\\]/g, senderName || "")
    .replace(/\\[Company\\]/g, contact?.company || "");
}

function personalizeEmail(language, contact, senderName) {
  const library = globalThis.emailContentByLanguage;
  const content = library[language] || library.en;
  const company = contact?.company || "";
  const recipient = contact?.name || "";
  const subject = applyPlaceholders(
    content.subjects[Math.floor(Math.random() * content.subjects.length)],
    { company },
    senderName || ""
  );
  const message = applyPlaceholders(
    content.templates[Math.floor(Math.random() * content.templates.length)],
    { company },
    senderName || ""
  );
  const greetingLine = recipient ? content.greeting + " " + recipient + "," : content.greeting + ",";
  const bodyText = greetingLine + "\\n\\n" + message;
  const bodyHtml = escapeHtmlText(bodyText).replace(/\\n/g, "<br>");
  return { subject, bodyText, bodyHtml };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    emailContentByLanguage,
    applyPlaceholders,
    personalizeEmail,
  };
}
`;

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.writeFileSync(targetPath, block + "\n" + footer);

const replacement = `// Subjects and templates are loaded from shared/email-content.js before this script.
function getEmailContent() {
  const library = globalThis.emailContentByLanguage
    || (typeof emailContentByLanguage === "undefined" ? null : emailContentByLanguage);
  if (!library) {
    throw new Error("Email templates did not load. Reload the extension.");
  }
  return library[selectedLanguage] || library.en;
}

`;

const updated = src.slice(0, cutStart) + replacement + src.slice(randomStart);
if (updated.includes("const emailContentByLanguage")) {
  throw new Error("content.js still contains the template object");
}
fs.writeFileSync(contentPath, updated);
console.log("Wrote", targetPath);
console.log("content.js bytes", updated.length);
