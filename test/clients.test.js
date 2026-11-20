const test = require("node:test");
const assert = require("node:assert/strict");
const {
  dueSequence,
  leftOffEmails,
  rememberBounce,
  rememberFollowup,
  rememberReply,
  rememberSend,
  sequenceAccounts,
  todayWarmupLimit,
  withoutLeftOff,
} = require("../lib/clients");

test("a client record keeps the send, the follow-up, the reply, and the bounce", () => {
  let book = rememberSend({}, {
    email: "Ann@Client.com",
    name: "Ann",
    company: "Acme",
    gmail: "ada@gmail.com",
  }, 1_000);
  book = rememberFollowup(book, { email: "ann@client.com", gmail: "ada@gmail.com" }, 2_000);
  book = rememberReply(book, { email: "ann@client.com", subject: "Re: hello" }, 3_000);
  assert.equal(book["ann@client.com"].name, "Ann");
  assert.equal(book["ann@client.com"].gmail, "ada@gmail.com");
  assert.equal(book["ann@client.com"].followups, 1);
  assert.equal(book["ann@client.com"].repliedAt, 3_000);
  book = rememberBounce(book, { email: "ann@client.com", type: "address", label: "Address not found" }, 4_000);
  assert.equal(book["ann@client.com"].bouncedAt, 4_000);
  assert.equal(book["ann@client.com"].repliedAt, 3_000);
});

test("a temporary delivery problem stays on the list", () => {
  const book = rememberBounce({}, { email: "ann@client.com", type: "temporary", label: "Temporary problem" }, 50);
  const filtered = withoutLeftOff([{ email: "ann@client.com", name: "Ann" }], book);
  assert.equal(filtered.dropped, 0);
  assert.equal(filtered.contacts.length, 1);
});

test("a bounced address is left off the client list and the follow-up", () => {
  const book = rememberBounce({}, { email: "ann@client.com", type: "domain", label: "Domain not found" }, 50);
  const filtered = withoutLeftOff([
    { email: "ann@client.com", name: "Ann" },
    { email: "ben@client.com", name: "Ben" },
  ], book);
  assert.equal(filtered.dropped, 1);
  assert.deepEqual(filtered.contacts.map((contact) => contact.email), ["ben@client.com"]);
  assert.deepEqual(leftOffEmails(book), ["ann@client.com"]);
});

test("a reply is left off the follow-up and stays on the client list", () => {
  const book = rememberReply(rememberSend({}, { email: "ann@client.com", gmail: "ada@gmail.com" }, 1), {
    email: "ann@client.com",
  }, 2);
  const filtered = withoutLeftOff([{ email: "ann@client.com" }], book);
  assert.equal(filtered.dropped, 0);
  assert.deepEqual(leftOffEmails(book), ["ann@client.com"]);
  assert.equal(dueSequence(book, [{ days: 1, body: "Hi" }], 10_000).length, 0);
});

test("the follow-up sequence is due from the sending Gmail after its days", () => {
  const sentAt = Date.parse("2026-11-01T00:00:00");
  let book = rememberSend({}, { email: "ann@client.com", gmail: "ada@gmail.com" }, sentAt);
  const steps = [{ days: 3, body: "First" }, { days: 7, body: "Second" }];
  assert.equal(dueSequence(book, steps, sentAt + 2 * 86400000).length, 0);
  const due = dueSequence(book, steps, sentAt + 3 * 86400000);
  assert.equal(due.length, 1);
  assert.equal(due[0].step, 1);
  assert.equal(due[0].body, "First");
  const accounts = sequenceAccounts([
    { email: "ada@gmail.com", senderName: "Ada", limit: 20, envId: "1" },
    { email: "bea@gmail.com", senderName: "Bea", limit: 20, envId: "2" },
  ], book, steps, sentAt + 3 * 86400000);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].email, "ada@gmail.com");
  assert.equal(accounts[0].followupQuery, "in:sent (to:ann@client.com)");
  assert.equal(accounts[0].followupBody, "First");
  const capped = sequenceAccounts([
    { email: "ada@gmail.com", senderName: "Ada", limit: 20, limitByTab: { contacts: 20, followup: 1 }, envId: "1" },
  ], book, steps, sentAt + 3 * 86400000);
  assert.equal(capped[0].limit, 1);
  book = rememberFollowup(book, { email: "ann@client.com", gmail: "ada@gmail.com" }, sentAt + 3 * 86400000);
  const second = dueSequence(book, steps, sentAt + 7 * 86400000);
  assert.equal(second[0].step, 2);
  assert.equal(second[0].body, "Second");
});

test("the warm-up max rises each day and stops at the cap", () => {
  const plan = { startLimit: 5, dailyStep: 5, cap: 12, startedAt: "2026-11-01" };
  assert.equal(todayWarmupLimit(plan, Date.parse("2026-11-01T12:00:00")), 5);
  assert.equal(todayWarmupLimit(plan, Date.parse("2026-11-02T12:00:00")), 10);
  assert.equal(todayWarmupLimit(plan, Date.parse("2026-11-04T12:00:00")), 12);
});
