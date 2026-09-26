/**
 * check-court-mail.js
 *
 * JJ: "forward all court emails to this email and do the tasks as needed."
 * He chose a mailbox the platform checks (no SendGrid), and "do it, then
 * tell me": file, calendar with a verify flag, Telegram him, and keep what
 * it cannot match for review.
 *
 * Pinned with real MIME emails (nodemailer's composer) through the real
 * mail parser, and a fake mailbox, database, Dropbox and Zara.
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { JSDOM } = require("jsdom");
const REPO = path.join(__dirname, "..");

let failures = 0;
function check(name, fn) {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || r === undefined; if (r && r !== true) detail = String(r); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}
async function throwsA(name, fn, re) {
  let ok = false, detail = "did not throw";
  try { await fn(); } catch (e) { ok = re.test(e.message); detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok ? "" : "  → " + detail));
}

process.env.GMAIL_EMAIL = "tezlaw.courtmail@gmail.com";
process.env.GMAIL_APP_PASSWORD = "app-pass";
process.env.TELEGRAM_TOKEN = "tg"; process.env.JJ_TELEGRAM_ID = "1";
delete process.env.COURT_MAIL_USER; delete process.env.COURT_MAIL_PASS; delete process.env.COURT_MAIL_FORWARDERS;

const AUTH_OK = { "Authentication-Results": "mx.google.com; dkim=pass header.i=@tezlawfirm.com header.s=selector1; spf=pass (google.com: domain of jj@tezlawfirm.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=jj@tezlawfirm.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=tezlawfirm.com" };
function mime(opts) {
  const MC = require("nodemailer/lib/mail-composer");
  return new Promise((res, rej) => new MC(opts).compile().build((e, m) => e ? rej(e) : res(m)));
}

// ── Fakes ────────────────────────────────────────────────────
const T = { mail: [], state: {}, notices: [] };
let seq = 1;
const fakeDb = { query: async (sql, v = []) => {
  const q = sql.replace(/\s+/g, " ").trim();
  if (/^CREATE /.test(q)) return { rows: [] };
  if (/^SELECT value FROM court_mail_state/.test(q)) return { rows: T.state[v[0]] !== undefined ? [{ value: T.state[v[0]] }] : [] };
  if (/^INSERT INTO court_mail_state/.test(q)) { T.state[v[0]] = v[1]; return { rows: [] }; }
  if (/^INSERT INTO court_mail /.test(q)) {
    if (T.mail.some(m => m.message_id === v[0])) return { rows: [] };
    const r = { id: seq++, message_id: v[0], uid: v[1], received_at: v[2], from_addr: v[3], subject: v[4], raw: v[5], status: "new", actions: [] };
    T.mail.push(r); return { rows: [{ id: r.id }] };
  }
  if (/^SELECT \* FROM court_mail WHERE id = \$1/.test(q)) return { rows: T.mail.filter(m => m.id === v[0]).map(m => ({ ...m })) };
  // forClient(): every email matched to one client, newest first.
  if (/FROM court_mail WHERE client_key = \$1/.test(q)) {
    return { rows: T.mail.filter(m => m.client_key === v[0]).map(m => ({ ...m })).reverse() };
  }
  if (/^UPDATE court_mail SET status = 'working'/.test(q)) {
    const m = T.mail.find(x => x.id === v[0] && x.status !== "working"); if (m) m.status = "working"; return { rows: m ? [{ id: m.id }] : [] };
  }
  if (/^UPDATE court_mail SET original_from/.test(q)) { T.mail.find(m => m.id === v[0]).original_from = v[1]; return { rows: [] }; }
  if (/^UPDATE court_mail SET reading/.test(q)) { T.mail.find(m => m.id === v[0]).reading = JSON.parse(v[1]); return { rows: [] }; }
  if (/^UPDATE court_mail SET status = 'ignored'/.test(q)) { Object.assign(T.mail.find(m => m.id === v[0]), { status: "ignored", note: v[1] || "Not court or agency mail." }, /raw = NULL/.test(q) ? { raw: null } : {}); return { rows: [] }; }
  if (/^UPDATE court_mail SET status = 'needs_review'/.test(q)) { Object.assign(T.mail.find(m => m.id === v[0]), { status: "needs_review", note: v[1] }); return { rows: [] }; }
  if (/^UPDATE court_mail SET status = 'done'/.test(q)) {
    Object.assign(T.mail.find(m => m.id === v[0]), { status: "done", case_id: v[1], client_key: v[2], matched_by: v[3], actions: JSON.parse(v[4]), note: v[5], handled_by: v[6] }); return { rows: [] };
  }
  if (/^UPDATE court_mail SET status = 'error'/.test(q)) { const m = T.mail.find(x => x.id === v[0]); Object.assign(m, { status: "error", error: v[1], retries: (m.retries || 0) + 1 }); return { rows: [] }; }
  if (/^UPDATE court_mail SET status = 'handled'/.test(q)) { Object.assign(T.mail.find(m => m.id === v[0]), { status: "handled", handled_by: v[1] }); return { rows: [] }; }
  if (/^UPDATE court_mail SET actions/.test(q)) { const m = T.mail.find(x => x.id === v[0]); m.actions = JSON.parse(v[1]); if (v.length > 2) { m.case_id = v[2]; m.client_key = v[3]; } return { rows: [] }; }
  if (/FROM court_mail (WHERE status = \$1 )?ORDER BY/.test(q)) return { rows: T.mail.filter(m => !v.length || m.status === v[0]).map(m => ({ ...m, raw: undefined })) };
  if (/^SELECT id FROM court_mail WHERE status = 'new'/.test(q)) return { rows: T.mail.filter(m => m.status === "new").map(m => ({ id: m.id })) };
  if (/^SELECT status, COUNT/.test(q)) {
    const c = {}; T.mail.forEach(m => { c[m.status] = (c[m.status] || 0) + 1; });
    return { rows: Object.entries(c).map(([status, n]) => ({ status, n })) };
  }
  if (/^SELECT subject, raw FROM court_mail/.test(q)) return { rows: T.mail.filter(m => m.id === v[0]) };
  if (/FROM civil_cases WHERE case_number IS NOT NULL/.test(q)) return { rows: [
    { id: 223, case_name: "Jing Liu v. James Turco, et al.", case_number: "2:26-cv-01671", client_key: "contact-liu" },
    { id: 224, case_name: "Chen v. Wu", case_number: "25STCV01234", client_key: "contact-chen" }] };
  if (/to_char\(hearing_date/.test(q)) return { rows: calls.hearings.filter(h => h.caseId === v[0] && !h.deleted).map(h => ({ d: h.data.hearing_date })) };
  if (/to_char\(due_date/.test(q)) return { rows: calls.deadlines.filter(d => d.caseId === v[0] && !d.deleted).map(d => ({ d: d.due_date, description: d.description })) };
  if (/FROM deadlines WHERE/.test(q)) return { rows: calls.clientDeadlines.filter(d => d.a_number === v[0] && d.due_date === v[2]).map(d => ({ id: d.id })) };
  if (/FROM civil_hearings WHERE case_id/.test(q)) return { rows: calls.hearings.filter(h => h.id && !h.deleted).map(h => ({ hearing_date: h.data.hearing_date, hearing_type: h.data.hearing_type })) };
  if (/FROM client_hearing_notices WHERE client_key/.test(q)) return { rows: T.notices.filter(n => n.client_key === v[0] && n.date === v[1] && !n.dismissed).map(n => ({ id: n.id })) };
  if (/^INSERT INTO client_hearing_notices/.test(q)) { const n = { id: seq++, client_key: v[0], path: v[3], date: String(v[5]).slice(0, 10), type: v[7], judge: v[10] }; T.notices.push(n); return { rows: [{ id: n.id }] }; }
  if (/^UPDATE client_hearing_notices SET dismissed_at/.test(q)) { T.notices.find(n => n.id === v[0]).dismissed = true; return { rows: [] }; }
  return { rows: [] };
} };

let failNextHearing = false;
const calls = { hearings: [], deadlines: [], notes: [], uploads: [], dbx: [], folders: [], clientDeadlines: [], cancelled: [], telegram: [], think: 0 };
const PROFILES = [
  { key: "contact-liu", client_name: "Jing Liu" },
  { key: "a-201555444", client_name: "Mei Chen", a_number: "A201-555-444" },
  // A real case: in the client list by name, no A-number on file, so a
  // notice carrying only an A-number could never reach him.
  { key: "n-tang-jie", client_name: "Tang, Jie" },
  // Two clients one word apart, so a loose name match would pick wrongly.
  { key: "n-tang-jie-min", client_name: "Tang, Jie Min" },
  { key: "n-zhao-wei-a", client_name: "Zhao, Wei" },
  { key: "n-zhao-wei-b", client_name: "Zhao, Wei" },
];
const stubs = {
  "./db": fakeDb,
  "./civil-litigation": {
    addManualDeadline: async (id, d) => { const x = { id: seq++, caseId: id, ...d }; calls.deadlines.push(x); return x; },
    listDeadlines: async (id) => calls.deadlines.filter(d => d.caseId === id && !d.deleted).map(d => ({ due_date: d.due_date, description: d.description })),
    logEvent: async (id, e) => { calls.notes.push({ id, ...e }); return {}; },
    deleteDeadline: async (id) => { calls.deadlines.find(d => d.id === id).deleted = true; },
  },
  "./civil-hearings": {
    addHearing: async (caseId, data) => { if (failNextHearing) { failNextHearing = false; throw new Error("database hiccup"); } const x = { id: seq++, caseId, data }; calls.hearings.push(x); return { id: x.id }; },
    deleteHearing: async (id) => { calls.hearings.find(h => h.id === id).deleted = true; },
  },
  "./civil-upload": { uploadToCase: async (id, files, o) => {
    calls.uploads.push({ id, names: files.map(f => f.originalname), o });
    return { ok: true, uploaded: files.map(f => ({ name: f.originalname, saved_as: f.originalname, path: "/Cases/x/" + f.originalname, folder_label: /\.eml$/.test(f.originalname) ? "Correspondence" : "Orders & Rulings" })), failed: [] };
  } },
  "./dropbox-integration": { isConfigured: () => true,
    resolveClientFolder: async ({ clientKey }) => clientKey === "a-201555444" ? "/Clients/Chen, Mei (A201555444)" : null,
    createFolder: async p => { calls.folders.push(p); }, uploadFile: async ({ path: p }) => { calls.dbx.push(p); return { path_display: p }; }, clearListCache: () => {} },
  // searchClients is the real one, over these profiles — a stub with its own
  // idea of matching would pass while the page found nobody.
  "./client-profiles": {
    aggregateClients: async () => PROFILES,
    searchClients: async (q, n) => require("../client-search").rankClients(PROFILES, q, n),
    getClientByKey: async k => PROFILES.find(p => p.key === k) || null,
  },
  "./deadline-tracker": { createManual: async d => { const id = seq++; calls.clientDeadlines.push({ id, ...d }); return id; }, markCancelled: async id => { calls.cancelled.push(id); } },
  "./hearing-notices": { initTable: async () => {} },
  "./civil-snapshot": { findMatters: async q => /turco/i.test(q) ? [{ id: 223, case_name: "Jing Liu v. James Turco, et al.", case_number: "2:26-cv-01671" }] : [] },
};
let attText = "";
const realExtract = require("../civil-intake-extract");
stubs["./civil-intake-extract"] = { ...realExtract, textFromBuffer: async () => attText };
const realAxios = require("axios");
const orig = Module._load;
Module._load = function (r, ...rest) {
  if (stubs[r]) return stubs[r];
  if (r === "axios") return { ...realAxios, post: async (url, body) => { if (/telegram/.test(url)) calls.telegram.push(body.text); return { data: {} }; } };
  return orig.call(this, r, ...rest);
};
const cm = require("../court-mail");

// Zara, scripted per email.
let zara = null;
const think = async (message) => { calls.think++; return { text: JSON.stringify(zara(message)) }; };

// A mailbox with a few messages.
const fetched = [];
function fakeImap(messages, validity = 7, uidNext = null) {
  return {
    mailbox: { uidValidity: validity, uidNext },
    connect: async () => {}, logout: async () => {},
    getMailboxLock: async () => ({ release: () => {} }),
    search: async () => messages.map(m => m.uid),
    fetch: async function* (range, query) {
      fetched.push({ range, source: !!(query && query.source) });
      const from = /^(\d+):\*$/.test(range) ? Number(range.split(":")[0]) : null;
      const list = from !== null ? messages.filter(m => m.uid >= from) : messages.filter(m => String(range).split(",").includes(String(m.uid)));
      const out = list.length ? list : (from !== null ? messages.slice(-1) : []);   // "N:*" always returns the newest
      for (const m of out) yield { uid: m.uid, source: m.source, envelope: { from: [{ address: m.from }], subject: m.subject, messageId: m.mid, date: new Date() } };
    },
  };
}

(async () => {
  console.log("\n── Who is trusted ──────────────────────────────");
  check("CM/ECF, state courts, e-service, EOIR and USCIS senders are court mail", () =>
    ["cacd_ecfmail@cacd.uscourts.gov", "noreply@lacourt.org", "efilingmail@tylerhost.net", "ECAS-Notification@usdoj.gov", "USCIS-Notices@uscis.dhs.gov", "service@onelegal.com"]
      .every(a => cm.isCourtSender(a)) || "missed one");
  check("…a random sender is not", () => !cm.isCourtSender("deals@shopping.com") && !cm.isCourtSender("someone@gmail.com"));
  check("the firm's own addresses may forward", () => cm.isForwarder("JJ Zhang <jj@tezlawfirm.com>") && cm.isForwarder("paralegal@tezlawfirm.com"));
  check("…a look-alike domain may not", () => !cm.isForwarder("jj@tezlawfirm.com.evil.io") && !cm.isForwarder("jj@nottezlawfirm.com"));
  check("…nor a quoted trick address", () => !cm.isForwarder('"jj@tezlawfirm.com"@evil.com') && !cm.isForwarder('"jj@tezlawfirm.com" <evil@x.com>'));
  check("…nor an address that merely contains the mailbox's", () => !cm.isForwarder("xtezlaw.courtmail@gmail.com") && !cm.isForwarder("tezlaw.courtmail@gmail.com.evil.io"));
  check("look-alike court domains are not courts", () => ["n@mycourtnotice.xyz", "a@courtney.me", "x@efile-alerts.ru", "y@notonelegal.com", "z@uscourts.gov.evil.io"].every(a => !cm.isCourtSender(a)) || "one got through");
  const hl = line => [{ key: "authentication-results", line: "Authentication-Results: " + line }];
  check("a sender the mail server verified (DMARC) is trusted", () => cm.senderVerified(hl("mx.google.com; dmarc=pass (p=NONE) header.from=tezlawfirm.com"), "jj@tezlawfirm.com"));
  check("…or DKIM-signed by that domain, or aligned SPF", () =>
    cm.senderVerified(hl("mx.google.com; dkim=pass header.i=@cacd.uscourts.gov"), "cacd_ecfmail@cacd.uscourts.gov") &&
    cm.senderVerified(hl("mx.google.com; spf=pass smtp.mailfrom=jj@tezlawfirm.com"), "jj@tezlawfirm.com"));
  check("a forged sender is not verified", () => !cm.senderVerified(hl("mx.google.com; dkim=none; spf=softfail smtp.mailfrom=evil.com; dmarc=fail header.from=tezlawfirm.com"), "jj@tezlawfirm.com"));
  check("…and a pass the forger wrote further down does not count — only the mail server's own, on top", () =>
    !cm.senderVerified([{ key: "authentication-results", line: "mx.google.com; dmarc=fail header.from=tezlawfirm.com" },
                        { key: "authentication-results", line: "fake; dmarc=pass header.from=tezlawfirm.com" }], "jj@tezlawfirm.com"));
  check("…nor a pass for a different domain", () => !cm.senderVerified(hl("mx.google.com; dmarc=pass header.from=evil.com"), "jj@tezlawfirm.com"));
  check("the mailbox defaults to the Gmail the platform already sends from", () => cm.config().user === "tezlaw.courtmail@gmail.com" && cm.config().host === "imap.gmail.com" && cm.config().configured);
  check("the court's own address is found inside a forwarded email", () =>
    cm.originalSender("FYI\n\n---------- Forwarded message ---------\nFrom: <cacd_ecfmail@cacd.uscourts.gov>\nDate: Mon\n") === "cacd_ecfmail@cacd.uscourts.gov");
  check("case numbers match however they are written", () =>
    cm.caseKey("2:26-cv-01671-CAS-KS") === cm.caseKey("2:26-cv-01671") && cm.caseKey("25 STCV 01234") === cm.caseKey("25STCV01234") &&
    cm.caseKey("2:26-cv-01671") !== cm.caseKey("2:26-cv-01672"));
  check("dates are real days", () => cm.isDay("2026-10-14") && !cm.isDay("2026-02-30") && !cm.isDay("10/14/2026"));
  check("a quote must SAY the date — in any usual form", () =>
    cm.quoteSaysDate("hearing on October 14, 2026 at 8:30", "2026-10-14") && cm.quoteSaysDate("Hearing Date: 10/14/2026", "2026-10-14") &&
    cm.quoteSaysDate("set for Oct. 14th, 2026", "2026-10-14") && cm.quoteSaysDate("14-OCT-2026 09:00", "2026-10-14"));
  check("…and not a neighbouring one", () => !cm.quoteSaysDate("Notice of Hearing", "2027-01-05") && !cm.quoteSaysDate("on October 1, 2026", "2026-10-14") &&
    !cm.quoteSaysDate("on October 14, 2026", "2026-10-01"));
  check("a thin case number matches nothing", () => cm.caseKey("TBD").length < 6 && cm.caseKey("----") === "");
  check("A-numbers match with or without dashes, and 8-digit ones", () => cm.aDigits("A201-555-444") === "201555444" && cm.aDigits("A 12-345-678") === "012345678");

  console.log("\n── Reading: only what the document says ────────");
  const cleaned = cm.cleanReading({ is_court_mail: true, kind: "order", title: "Minute Order", case_numbers: ["2:26-cv-01671"],
    hearings: [{ date: "2026-10-14", time: "8:30 AM", type: "Motion hearing", evidence: "hearing on October 14, 2026 at 8:30 a.m." },
               { date: "2026-11-01", type: "Trial", evidence: "trial is set for November 1" }],
    deadlines: [{ date: "2026-09-30", description: "Opposition due", evidence: "" }] },
    "The Court sets a hearing on October 14, 2026 at 8:30 a.m. in Courtroom 8D.");
  check("a date quoted from the document is kept", () => cleaned.hearings.length === 1 && cleaned.hearings[0].date === "2026-10-14");
  check("a date the document does not say is dropped, and listed", () => cleaned.deadlines.length === 0 && cleaned.dropped.length === 2);
  const c2 = cm.cleanReading({ is_court_mail: true, hearings: [{ date: "2026-10-14", type: "Motion", evidence: "hearing on October 14, 2026 is VACATED" }],
    deadlines: [{ date: "2026-09-23", description: "Opposition", computed: true, rule: "CCP 1005(b)", evidence: "hearing on October 14, 2026 is VACATED" },
                { date: "2027-01-05", description: "Reply", evidence: "Notice of Hearing" }] },
    "Notice of Hearing. The hearing on October 14, 2026 is VACATED.");
  check("a vacated hearing is not calendared", () => c2.hearings.length === 0 && c2.dropped.some(d => /vacated/.test(d)));
  check("a deadline Zara calculated, or one the quote does not state, is only a suggestion", () => c2.deadlines.length === 0 && c2.suggested.length === 2);

  console.log("\n── Collecting from the mailbox ─────────────────");
  const nef = await mime({ from: "JJ Zhang <jj@tezlawfirm.com>", to: "tezlaw.courtmail@gmail.com", subject: "FW: Activity in Case 2:26-cv-01671-CAS-KS Liu v. Turco Minute Order", headers: AUTH_OK,
    text: "---------- Forwarded message ---------\nFrom: cacd_ecfmail@cacd.uscourts.gov\n\nNOTICE OF ELECTRONIC FILING. Case 2:26-cv-01671-CAS-KS. MINUTE ORDER: The Court sets a hearing on the Motion to Dismiss for October 14, 2026 at 10:00 a.m. Opposition due September 30, 2026.",
    attachments: [{ filename: "Minute Order.pdf", content: Buffer.from("%PDF-1.4") }] });
  const eoir = await mime({ from: "paralegal@tezlawfirm.com", to: "x", subject: "FW: ECAS Hearing Notice", headers: AUTH_OK,
    text: "From: ECAS-Notification@usdoj.gov\nNOTICE OF IN-PERSON HEARING IN REMOVAL PROCEEDINGS. A-Number: 201-555-444. Your individual hearing is scheduled for March 3, 2027 at 1:00 PM before IJ Rodriguez, Los Angeles - Olive St.",
    attachments: [{ filename: "Hearing Notice.pdf", content: Buffer.from("%PDF-1.4") }] });
  const unknown = await mime({ from: "jj@tezlawfirm.com", to: "x", subject: "FW: NEF 5:25-cv-09999", headers: AUTH_OK, text: "NOTICE OF ELECTRONIC FILING in 5:25-cv-09999. Order to show cause hearing on December 2, 2026." });
  const spam = await mime({ from: "promo@shopping.com", to: "x", subject: "Deadline: your coupon expires", text: "Hearing on sale prices October 1, 2026!" });
  const newsletter = await mime({ from: "jj@tezlawfirm.com", to: "x", subject: "FW: bar newsletter", headers: AUTH_OK, text: "Monthly bar association newsletter. Nothing about any case." });
  const box = [
    { uid: 11, mid: "<nef@cacd>", from: "jj@tezlawfirm.com", subject: "FW: Activity in Case", source: nef },
    { uid: 12, mid: "<eoir@ecas>", from: "paralegal@tezlawfirm.com", subject: "FW: ECAS Hearing Notice", source: eoir },
    { uid: 13, mid: "<unk@ecf>", from: "jj@tezlawfirm.com", subject: "FW: NEF 5:25-cv-09999", source: unknown },
    { uid: 14, mid: "<spam@x>", from: "promo@shopping.com", subject: "coupon", source: spam },
    { uid: 15, mid: "<news@x>", from: "jj@tezlawfirm.com", subject: "newsletter", source: newsletter },
  ];
  let ids = await cm.collect({ imap: fakeImap(box) });
  check("the first check keeps the last week's court mail", () => ids.length === 4 && T.state.last_uid === "15");
  check("…and never downloads anything else in the inbox", () =>
    !T.mail.some(m => m.from_addr === "promo@shopping.com") && fetched.filter(f => f.source).every(f => !String(f.range).split(",").includes("14")));
  ids = await cm.collect({ imap: fakeImap(box) });
  check("the next check reads nothing twice", () => ids.length === 0);
  box.push({ uid: 16, mid: "<nef@cacd>", from: "jj@tezlawfirm.com", subject: "same email again", source: nef });
  ids = await cm.collect({ imap: fakeImap(box) });
  check("the same email forwarded twice is stored once", () => ids.length === 0 && T.state.last_uid === "16");

  console.log("\n── A federal minute order on a civil matter ────");
  zara = () => ({ is_court_mail: true, agency: "federal_court", kind: "minute_order", title: "Minute Order — hearing on Motion to Dismiss",
    summary: "The court set the motion to dismiss for hearing; opposition due September 30.",
    case_numbers: ["2:26-cv-01671-CAS-KS"], a_numbers: [], court: "C.D. Cal.",
    hearings: [{ date: "2026-10-14", time: "10:00 AM", type: "Motion hearing", judge: "Hon. Christina A. Snyder", evidence: "Motion to Dismiss for October 14, 2026 at 10:00 a.m." }],
    deadlines: [{ date: "2026-09-30", description: "Opposition to Motion to Dismiss due", rule: "L.R. 7-9", computed: false, evidence: "Opposition due September 30, 2026" }],
    action_items: ["Draft opposition"], urgent: true });
  let row = await cm.processMail(T.mail[0].id, { think });
  check("it is matched to the civil matter by case number", () => row.status === "done" && row.case_id === 223 && /case number 2:26-cv-01671/.test(row.matched_by));
  check("the order and the email are filed to the matter's Dropbox", () => calls.uploads[0].id === 223 && calls.uploads[0].names.some(n => /\.eml$/.test(n)) && calls.uploads[0].names.includes("Minute Order.pdf"));
  check("the hearing is added, marked verify", () => calls.hearings[0].caseId === 223 && calls.hearings[0].data.hearing_date === "2026-10-14" && /verify/.test(calls.hearings[0].data.purpose));
  check("the deadline is added, high priority, marked verify, with its rule", () =>
    calls.deadlines[0].due_date === "2026-09-30" && /verify/.test(calls.deadlines[0].description) && calls.deadlines[0].priority === "high" && calls.deadlines[0].ccp_rule === "L.R. 7-9");
  check("a note goes in the case history with the to-do", () => /Court email: Minute Order/.test(calls.notes[0].title) && /Draft opposition/.test(calls.notes[0].description));
  check("JJ is told on Telegram what was done, flagged urgent, with an undo link", () =>
    /^🚨 Minute Order/.test(calls.telegram[0]) && /Added \(verify\)/.test(calls.telegram[0]) && /\/admin\/court-mail#mail-/.test(calls.telegram[0]));
  check("…every action is listed for undo", () => row.actions.filter(a => a.type === "civil_hearing").length === 1 && row.actions.filter(a => a.type === "civil_deadline").length === 1);

  console.log("\n── An EOIR hearing notice for a client ─────────");
  zara = () => ({ is_court_mail: true, agency: "eoir", kind: "hearing_notice", title: "EOIR Individual Hearing Notice", summary: "Individual hearing set.",
    case_numbers: [], a_numbers: ["201-555-444"], court: "Los Angeles - Olive St",
    hearings: [{ date: "2027-03-03", time: "1:00 PM", type: "Individual hearing", judge: "IJ Rodriguez", evidence: "scheduled for March 3, 2027 at 1:00 PM" }],
    deadlines: [{ date: "2027-02-01", description: "Evidence filing deadline (30 days before)", computed: true, rule: "Immigration Court Practice Manual 3.1(b)", evidence: "Your individual hearing is scheduled for March 3, 2027" }],
    action_items: [], urgent: false });
  row = await cm.processMail(T.mail[1].id, { think });
  check("it is matched to the client by A-number", () => row.status === "done" && row.client_key === "a-201555444");
  check("the notice is filed to the client's Dropbox, under Court Notices", () =>
    calls.folders.includes("/Clients/Chen, Mei (A201555444)/Court Notices") && calls.dbx.some(p => /Court Notices\/Hearing Notice\.pdf$/.test(p)));
  check("the hearing appears on the client's profile (Hearing Notices)", () => T.notices[0].client_key === "a-201555444" && T.notices[0].date === "2027-03-03" && /Hearing Notice\.pdf$/.test(T.notices[0].path));
  check("the calculated evidence deadline is NOT put on the list by itself — it is suggested", () =>
    calls.clientDeadlines.length === 0 && /Suggested, not added[\s\S]*2027-02-01 Evidence filing deadline/.test(row.note) && !row.actions.some(a => a.type === "client_deadline"));

  console.log("\n── What it cannot place waits for a person ─────");
  zara = () => ({ is_court_mail: true, kind: "order", title: "OSC re Dismissal", summary: "OSC hearing set.", case_numbers: ["5:25-cv-09999"],
    hearings: [{ date: "2026-12-02", type: "OSC hearing", evidence: "Order to show cause hearing on December 2, 2026" }], deadlines: [], action_items: [] });
  const tgBefore = calls.telegram.length, hBefore = calls.hearings.length;
  row = await cm.processMail(T.mail[2].id, { think });
  check("an unknown case number waits for review, nothing added", () => row.status === "needs_review" && /5:25-cv-09999/.test(row.note) && calls.hearings.length === hBefore);
  check("…and JJ is asked to assign it", () => calls.telegram.length === tgBefore + 1 && /needs you/.test(calls.telegram[calls.telegram.length - 1]));
  const thinkBefore = calls.think;
  row = await cm.processMail(T.mail[2].id, { target: { caseId: 224, label: "Chen v. Wu" }, by: "JJ" });
  check("assigned to a case, it is filed and calendared without reading it again", () =>
    row.status === "done" && row.case_id === 224 && calls.think === thinkBefore && calls.hearings.some(h => h.caseId === 224 && h.data.hearing_date === "2026-12-02"));

  await throwsA("an email already filed cannot be assigned somewhere else without undoing first", () =>
    cm.processMail(T.mail[2].id, { target: { caseId: 223 } }), /already filed and calendared/);

  console.log("\n── Forged senders ──────────────────────────────");
  const forged = await mime({ from: "JJ Zhang <jj@tezlawfirm.com>", to: "x", subject: "FW: Activity in Case 2:26-cv-01671",
    headers: { "Authentication-Results": "mx.google.com; dkim=none; spf=fail smtp.mailfrom=evil.com; dmarc=fail (p=NONE) header.from=tezlawfirm.com" },
    text: "NOTICE OF ELECTRONIC FILING. Case 2:26-cv-01671. Hearing set for January 5, 2027 at 9:00 a.m." });
  T.mail.push({ id: seq++, message_id: "<forged@x>", from_addr: "jj@tezlawfirm.com", subject: "forged", raw: forged, status: "new", actions: [] });
  zara = () => ({ is_court_mail: true, kind: "order", title: "Hearing set", summary: "x", case_numbers: ["2:26-cv-01671"],
    hearings: [{ date: "2027-01-05", type: "Hearing", evidence: "Hearing set for January 5, 2027 at 9:00 a.m." }], deadlines: [] });
  const hCount = calls.hearings.length;
  row = await cm.processMail(T.mail[T.mail.length - 1].id, { think });
  check("mail claiming to be from the firm but not verified by the mail server does nothing on its own", () =>
    row.status === "needs_review" && /could not be verified/.test(row.note) && calls.hearings.length === hCount);

  console.log("\n── A failure halfway ───────────────────────────");
  const half = await mime({ from: "jj@tezlawfirm.com", to: "x", subject: "FW: NEF 25STCV01234", headers: AUTH_OK,
    text: "Case No. 25STCV01234. Trial setting conference on February 9, 2027 at 8:30 a.m.", attachments: [{ filename: "TSC Notice.pdf", content: Buffer.from("%PDF") }] });
  T.mail.push({ id: seq++, message_id: "<half@x>", from_addr: "jj@tezlawfirm.com", subject: "half", raw: half, status: "new", actions: [] });
  const halfId = T.mail[T.mail.length - 1].id;
  zara = () => ({ is_court_mail: true, kind: "hearing_notice", title: "TSC", summary: "TSC set.", case_numbers: ["25STCV01234"],
    hearings: [{ date: "2027-02-09", time: "8:30 AM", type: "Trial setting conference", evidence: "Trial setting conference on February 9, 2027 at 8:30 a.m." }], deadlines: [] });
  failNextHearing = true;
  const upBefore = calls.uploads.length;
  await cm.processMail(halfId, { think }).catch(() => {});
  let hm = T.mail.find(m => m.id === halfId);
  check("when calendaring fails halfway, what was already done is on record", () => hm.status === "error" && hm.actions.some(a => a.type === "file"));
  await cm.processMail(halfId, { think });
  hm = T.mail.find(m => m.id === halfId);
  check("…and the retry finishes the job without filing the documents again", () =>
    hm.status === "done" && calls.uploads.length === upBefore + 1 && calls.hearings.some(h => h.caseId === 224 && h.data.hearing_date === "2027-02-09"));

  console.log("\n── What it will not touch ──────────────────────");
  const before = calls.think;
  T.mail.push({ id: seq++, message_id: "<spam@x>", from_addr: "promo@shopping.com", subject: "coupon", raw: spam, status: "new", actions: [] });
  row = await cm.processMail(T.mail[T.mail.length - 1].id, { think });
  check("mail not forwarded by the firm and not from a court is ignored — Zara never reads it", () => row.status === "ignored" && calls.think === before);
  check("…and its content is not kept", () => T.mail.find(m => m.message_id === "<spam@x>").raw === null);
  zara = () => ({ is_court_mail: false, title: "Newsletter", summary: "", hearings: [], deadlines: [] });
  row = await cm.processMail(T.mail[3].id, { think });
  check("a forwarded newsletter is recognised and ignored", () => row.status === "ignored");
  row = await cm.processMail(T.mail[0].id, { think });
  check("a finished email is not processed twice", () => calls.hearings.filter(h => h.caseId === 223).length === 1);

  console.log("\n── Undo ────────────────────────────────────────");
  const done = T.mail[0];
  const hIdx = done.actions.findIndex(a => a.type === "civil_hearing");
  await cm.undoAction(done.id, hIdx, { by: "JJ" });
  check("undo removes the hearing it added", () => calls.hearings.find(h => h.caseId === 223).deleted === true && T.mail[0].actions[hIdx].undone);
  await throwsA("…and cannot undo it twice", () => cm.undoAction(done.id, hIdx), /Already undone/);
  const fIdx = done.actions.findIndex(a => a.type === "file");
  await throwsA("filed documents are not deleted by Undo", () => cm.undoAction(done.id, fIdx), /not removed from Dropbox/);
  const chIdx = T.mail[1].actions.findIndex(a => a.type === "client_hearing");
  await cm.undoAction(T.mail[1].id, chIdx);
  check("undo on a client's hearing takes it off their profile", () => T.notices[0].dismissed === true);

  T.state = {};
  const emptyIds = await cm.collect({ imap: fakeImap([], 99, 500) });
  check("a first run on a quiet week starts from the newest message — it never replays the whole mailbox", () => emptyIds.length === 0 && T.state.last_uid === "499");

  console.log("\n── The page and its API ────────────────────────");
  const app = express();
  app.use(express.json());
  let role = "paralegal";
  app.use((req, _res, next) => { req.user = { uid: 2, n: "Pat", r: role }; next(); });
  const auth = { requireRole: (...roles) => (req, res, next) => roles.includes(req.user.r) ? next() : res.status(403).json({ ok: false, error: "forbidden" }) };
  require("../court-mail-routes").attach(app, auth);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const J = (p, o) => fetch(base + p, o).then(r => r.json().then(d => ({ status: r.status, d })));
  let res = await J("/admin/court-mail/api/status");
  check("the page reports the mailbox and what is waiting", () => res.d.ok && res.d.mailbox === "tezlaw.courtmail@gmail.com" && res.d.counts.done >= 3);
  res = await J("/admin/court-mail/api/list?status=done");
  check("the list shows processed mail without the raw email", () => res.d.mail.length >= 3 && res.d.mail.every(m => !m.raw));
  res = await J("/admin/court-mail/api/search?q=turco");
  check("staff can search a case to assign to", () => res.d.matters[0].id === 223);
  res = await J("/admin/court-mail/api/search?q=201555");
  check("…or a client by A-number", () => res.d.clients[0].key === "a-201555444");
  const page = await fetch(base + "/admin/court-mail").then(r => r.text()).catch(() => "");
  check("the page loads its script", () => /\/static\/court-mail-page\.js/.test(page) && /data-court-mail/.test(page));
  const eml = await fetch(base + `/admin/court-mail/api/${T.mail[0].id}/eml`);
  check("the original email downloads", () => eml.status === 200 && eml.headers.get("content-type") === "message/rfc822");
  role = "viewer";
  res = await J("/admin/court-mail/api/list");
  check("a view-only account is kept out", () => res.status === 403);
  server.close();

  console.log("\n── The page script ─────────────────────────────");
  const js = fs.readFileSync(path.join(REPO, "public", "court-mail-page.js"), "utf8");
  const dom = new JSDOM(`<!doctype html><body><div data-court-mail></div></body>`, { runScripts: "outside-only", url: "https://x/admin/court-mail" });
  const w = dom.window, posted = [];
  w.fetch = (url, o) => {
    posted.push({ url, body: o && o.body });
    const ok = x => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, ...x }) });
    if (/\/status$/.test(url)) return ok({ configured: true, mailbox: "tezlaw.courtmail@gmail.com", every_minutes: 3, forwarders: ["tezlawfirm.com"], counts: { needs_review: 1, done: 2 } });
    if (/\/list/.test(url)) return ok({ mail: [{ id: 9, status: "needs_review", subject: "FW: NEF", reading: { title: "OSC re Dismissal", summary: "OSC hearing set.", action_items: [] }, note: "No matter or client matched (5:25-cv-09999).", actions: [] }] });
    if (/\/search/.test(url)) return ok({ matters: [{ id: 224, case_name: "Chen v. Wu", case_number: "25STCV01234" }], clients: [] });
    return ok({});
  };
  w.eval(js);
  await new Promise(r => setTimeout(r, 40));
  const d = w.document;
  check("it tells staff where to forward court email", () => /Forward court emails to tezlaw\.courtmail@gmail\.com/.test(d.body.textContent));
  check("it opens on what needs a person", () => /OSC re Dismissal/.test(d.body.textContent) && /needs you/.test(d.body.textContent));
  [...d.querySelectorAll("button")].find(b => /Assign to a case or client/.test(b.textContent)).click();
  const q = d.querySelector("input[type=text]");
  q.value = "chen"; q.dispatchEvent(new w.Event("input"));
  await new Promise(r => setTimeout(r, 350));
  [...d.querySelectorAll("button")].find(b => /Chen v\. Wu/.test(b.textContent)).click();
  await new Promise(r => setTimeout(r, 30));
  const assign = posted.find(p => /\/9\/assign$/.test(p.url));
  check("assigning posts the chosen case", () => assign && JSON.parse(assign.body).case_id === 224);

  console.log("\n── Matching a client by name ───────────────────");
  // JJ: "its not finding clients still … but i can find this client in tara."
  // An EOIR notice for a detained respondent carried an A-number and a name.
  // The client was in the list under his name with no A-number on file, so
  // matching on numbers alone could never reach him.
  const byName = await cm.matchReading({
    case_numbers: [], a_numbers: ["246-254-704"], party_names: ["TANG, JIE"],
  });
  check("a client with no A-number on file is still found, by name", () =>
    byName && byName.clientKey === "n-tang-jie", JSON.stringify(byName));
  check("…and the reason says it was the name", () => /name/i.test(byName.by));

  const reversed = await cm.matchReading({ case_numbers: [], a_numbers: [], party_names: ["jie tang"] });
  check("the comma, the order and the capitals do not matter", () =>
    reversed && reversed.clientKey === "n-tang-jie", JSON.stringify(reversed));

  const tooLoose = await cm.matchReading({
    case_numbers: [], a_numbers: [], party_names: ["Tang"],
  });
  check("a surname alone assigns nothing", () => tooLoose === null, JSON.stringify(tooLoose));

  const twoPeople = await cm.matchReading({
    case_numbers: [], a_numbers: [], party_names: ["Zhao, Wei"],
  });
  check("two clients with the same name is ambiguous, not a guess", () =>
    twoPeople && /2 clients are named/.test(twoPeople.ambiguous || ""), JSON.stringify(twoPeople));

  const notMin = await cm.matchReading({
    case_numbers: [], a_numbers: [], party_names: ["Tang, Jie Min"],
  });
  check("an extra name word picks the other client, not the shorter one", () =>
    notMin && notMin.clientKey === "n-tang-jie-min", JSON.stringify(notMin));

  const byNumber = await cm.matchReading({
    case_numbers: [], a_numbers: ["201-555-444"], party_names: ["Someone Else"],
  });
  check("an A-number still wins when the client has one", () =>
    byNumber && byNumber.clientKey === "a-201555444", JSON.stringify(byNumber));

  const near = await cm.suggestClients({ party_names: ["Tang"] });
  check("an unmatched notice still offers the near misses", () =>
    near.some(c => c.client_name === "Tang, Jie"), JSON.stringify(near.map(c => c.client_name)));

  console.log("\n── The client's own page ───────────────────────");
  // JJ: "these notices with or without attachments should be in client
  // profile as well." An EOIR eFiling receipt carries no hearing and no
  // deadline, so nothing about it ever reached the client's page.
  // The exact case JJ reported: an EOIR eFiling confirmation. No hearing, no
  // deadline, one filed document — and previously nothing on the profile.
  T.mail.push({
    id: 9001, client_key: "a-201555444", received_at: "2026-09-25T17:00:00Z",
    subject: "EOIR eFiling Confirmation", status: "done",
    reading: {
      title: "EOIR eFiling Confirmation — Motion for Counsel to Appear by Webex",
      summary: "EOIR confirms receipt and is evaluating it for the record.",
      kind: "confirmation",
      action_items: ["Monitor EOIR Case Portal for the evaluation outcome"],
    },
    actions: [{ type: "file", label: "Filed Motion.pdf → Court Notices", path: "/Clients/Chen/Court Notices/Motion.pdf" }],
    matched_by: "A-number A201-555-444",
  });

  const mine = await cm.forClient("a-201555444");
  check("every email matched to the client is listed", () => mine.length >= 2, String(mine.length));
  check("newest first", () => mine[0].id === 9001, JSON.stringify(mine.map(m => m.id)));
  check("each one carries what it was about", () => mine.every(m => m.title && m.url));

  const efiling = mine.find(m => m.id === 9001);
  check("a confirmation with no hearing and no deadline still appears", () =>
    efiling && efiling.hearings.length === 0 && efiling.deadlines.length === 0);
  check("…with its summary, so the page says what it was", () =>
    /evaluating it for the record/.test(efiling.summary || ""));
  check("…the document it filed", () =>
    efiling.documents.length === 1 && /Motion\.pdf/.test(efiling.documents[0].label));
  check("…and what is left to do about it", () =>
    efiling.action_items.some(t => /Case Portal/.test(t)));
  check("an undone action is not still listed", () => {
    const withHearing = T.mail.find(m => (m.actions || []).some(a => a.type === "client_hearing" && a.undone));
    if (!withHearing) return true;
    const row = mine.find(m => m.id === withHearing.id);
    return row && row.hearings.length === 0;
  });
  const theirs = await cm.forClient("contact-liu");
  check("another client's mail is not included", () =>
    theirs.every(m => m.id !== mine[0].id));
  const none = await cm.forClient("");
  check("no client key returns nothing", () => none.length === 0);

  console.log("\n── Wiring ──────────────────────────────────────");
  const srv = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
  const nav = fs.readFileSync(path.join(REPO, "hearing-notes.js"), "utf8");
  check("the server mounts the page and starts checking the mailbox", () => /require\("\.\/court-mail-routes"\)\.attach\(app, auth\)/.test(srv) && /require\("\.\/court-mail"\)\.start\(\)/.test(srv));
  check("Court Mail is in the sidebar", () => /href="\/admin\/court-mail"[\s\S]{0,200}Court Mail/.test(nav));
  const cs = require("../client-script");
  check("the page script is protected against a flattened upload — and is not named like the server module", () =>
    cs.CLIENT_BUNDLES.includes("court-mail-page.js") && !cs.CLIENT_BUNDLES.includes("court-mail.js"));
  check("the client profile asks for its court mail", () =>
    /\/court-mail"\)[\s\S]{0,400}forClient/.test(srv));
  const prof = fs.readFileSync(path.join(REPO, "client-profiles.js"), "utf8");
  check("…and the profile has somewhere to show it", () =>
    /id="court-mail-section"/.test(prof) && /loadCourtMail\(\)/.test(prof));

  console.log("\n" + (failures ? `${failures} FAILED` : "ALL COURT-MAIL CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
