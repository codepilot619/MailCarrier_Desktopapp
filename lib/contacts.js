const EMAIL_KEYS = ["email", "email address", "e-mail"];
const NAME_KEYS = ["first name", "name", "full name"];
const COMPANY_KEYS = ["company name for emails", "company name", "company"];

function cell(row, keys) {
  const wanted = new Set(keys);
  for (const [key, value] of Object.entries(row || {})) {
    if (!wanted.has(String(key).trim().toLowerCase())) continue;
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function mapContactRows(rows) {
  let skipped = 0;
  const contacts = [];
  for (const row of rows || []) {
    const email = cell(row, EMAIL_KEYS);
    if (!email) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      skipped += 1;
      continue;
    }
    contacts.push({
      name: cell(row, NAME_KEYS),
      email,
      company: cell(row, COMPANY_KEYS),
    });
  }
  return { contacts, skipped };
}

function parseContactFile(filePath) {
  const XLSX = require("xlsx");
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { contacts: [], skipped: 0 };
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
  return mapContactRows(rows);
}

module.exports = { mapContactRows, parseContactFile };
