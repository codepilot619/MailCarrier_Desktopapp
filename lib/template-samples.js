const SUBJECTS = [
  "[Name] — interested in joining [Company]",
  "A remote role at [Company]",
  "Could I help [Company], [Recipient]?",
  "Full stack developer available for [Company]",
  "[Recipient], I would like to work with [Company]",
  "Following [Company] — [Name]",
];

const BODIES = [
  [
    "Hello [Recipient],",
    "",
    "I am [Name], a full stack developer with a background in AI and software development. I have been following [Company] and would like to help the team on a full-time remote basis.",
    "",
    "I have attached my resume. I would be glad to talk about where I could contribute.",
    "",
    "Best regards,",
    "[Name]",
  ].join("\n"),
  [
    "Hello [Recipient],",
    "",
    "My name is [Name]. I build web applications from the first version through to release, and I am looking for a remote role with a team like [Company].",
    "",
    "If you are adding a developer, I would like to hear what you need.",
    "",
    "Best regards,",
    "[Name]",
  ].join("\n"),
  [
    "Hello [Recipient],",
    "",
    "I am [Name]. I work with both the interface and the backend, and I have been looking at [Company] because the work matches what I want to do next.",
    "",
    "I am available for a full-time remote position and can start soon. My resume is attached.",
    "",
    "Thank you for your time.",
    "",
    "Best regards,",
    "[Name]",
  ].join("\n"),
  [
    "Hello [Recipient],",
    "",
    "I wanted to introduce myself. I am [Name], and I am looking for a remote full stack role where I can stay with one product and help it grow. [Company] is one of the teams I would like to join.",
    "",
    "Would you be open to a short call?",
    "",
    "Best regards,",
    "[Name]",
  ].join("\n"),
];

const REPLIES = [
  [
    "Hi [Recipient],",
    "",
    "Thanks for writing to [Company]. I read your note and I will keep it in mind.",
    "",
    "Best regards,",
    "[Name]",
  ].join("\n"),
  [
    "Hi [Recipient],",
    "",
    "Thank you for the email. I do not have an opening to share right now, but I will write if that changes at [Company].",
    "",
    "Best regards,",
    "[Name]",
  ].join("\n"),
  [
    "Hi [Recipient],",
    "",
    "Thanks for getting in touch. I appreciate you thinking of [Company], and I will come back to you if there is a fit.",
    "",
    "Good luck,",
    "[Name]",
  ].join("\n"),
];

const FOLLOWUPS = [
  [
    "Hi,",
    "",
    "I am following up on the email I sent earlier. I am still interested and happy to share more about my work whenever it is useful.",
    "",
    "Best regards,",
    "[Name]",
  ].join("\n"),
  [
    "Hi,",
    "",
    "Just checking that my earlier note reached you. I would like to help if you are still looking for a developer.",
    "",
    "Best regards,",
    "{sender}",
  ].join("\n"),
  [
    "Hi,",
    "",
    "I know inboxes get busy. My offer to work remotely still stands, and I can send more detail if that would help.",
    "",
    "Thank you,",
    "[Name]",
  ].join("\n"),
];

const SAMPLE_LISTS = {
  subject: { name: "subjects", header: "Subject", rows: SUBJECTS, multiline: false },
  body: { name: "bodies", header: "Body", rows: BODIES, multiline: true },
  reply: { name: "warmup-replies", header: "Reply", rows: REPLIES, multiline: true },
  followup: { name: "follow-ups", header: "Follow-up", rows: FOLLOWUPS, multiline: true },
};

const SAMPLE_GROUPS = {
  message: ["subject", "body"],
  reply: ["reply"],
  followup: ["followup"],
};

function csvField(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}

function sampleFileText(kind, ext) {
  const list = SAMPLE_LISTS[kind];
  if (!list) return "";
  if (ext === "csv") {
    return `\uFEFF${[list.header, ...list.rows.map(csvField)].join("\r\n")}\r\n`;
  }
  if (list.multiline) return `${list.rows.join("\n---\n")}\n`;
  return `${list.rows.join("\n")}\n`;
}

function sampleTemplateFiles(group) {
  const kinds = SAMPLE_GROUPS[group];
  if (!kinds) return [];
  const files = [];
  for (const kind of kinds) {
    const list = SAMPLE_LISTS[kind];
    files.push({ kind, name: `${list.name}.txt`, text: sampleFileText(kind, "txt") });
    files.push({ kind, name: `${list.name}.csv`, text: sampleFileText(kind, "csv") });
  }
  return files;
}

module.exports = {
  SAMPLE_LISTS,
  sampleFileText,
  sampleTemplateFiles,
};
