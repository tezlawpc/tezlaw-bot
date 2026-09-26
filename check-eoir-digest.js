/**
 * check-eoir-digest.js
 *
 * JJ: "1. eoir email comes in digest, if there is notice auto save the
 * client's folder."
 *
 * The Dropbox half already worked. This covers the digest half, and — more
 * importantly — the line between the two paths:
 *
 *   receipt  (Accepted / Service)  → no Zara read, no ping, one digest line
 *   anything else                  → Zara reads it, JJ is pinged immediately
 *
 * The dangerous failure is a hearing notice landing in the digest, so most of
 * these checks are about what must NOT be digested: an "Entered" document (the
 * court issued an order or a notice), a rejected filing, a template that has
 * drifted, an A-number the witnesses disagree on, and a court sender that
 * merely shares usdoj.gov with the receipt robots.
 *
 * Real DOJ bodies, verbatim from jj@tezlawfirm.com's EOIR folder.
 */
const Module = require("module");
const path = require("path");

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name +
    (ok ? "" : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
}
function ok(name, cond, detail = "") {
  if (!cond) failures++;
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || !detail ? "" : "  → " + detail));
}

process.env.TELEGRAM_TOKEN = "tg";
process.env.JJ_TELEGRAM_ID = "1";
process.env.PUBLIC_BASE_URL = "https://bot.example.com";

// ── A court_mail table, in memory ────────────────────────────
const T = { mail: [] };
const fakeDb = { query: async (sql, v = []) => {
  const q = sql.replace(/\s+/g, " ").trim();
  if (/^(CREATE|ALTER)/i.test(q)) return { rows: [] };
  if (/FROM court_mail WHERE notify_mode = 'digest' AND digest_at IS NULL/.test(q)) {
    const rows = T.mail.filter(m => m.notify_mode === "digest" && !m.digest_at);
    // ORDER BY client_key NULLS LAST, received_at
    rows.sort((a, b) =>
      (a.client_key == null) - (b.client_key == null) ||
      String(a.client_key || "").localeCompare(String(b.client_key || "")) ||
      new Date(a.received_at) - new Date(b.received_at));
    return { rows: rows.map(r => ({ ...r })) };
  }
  if (/^UPDATE court_mail SET digest_at = NOW\(\) WHERE id = ANY/.test(q)) {
    for (const id of v[0]) { const m = T.mail.find(x => x.id === id); if (m) m.digest_at = new Date(); }
    return { rows: [] };
  }
  return { rows: [] };
} };

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./db" || request === path.join(__dirname, "..", "db")) return fakeDb;
  return realLoad.apply(this, arguments);
};

const CM = require("../court-mail");
const EOIR = require("../eoir-parse");

// ── Real EOIR bodies ─────────────────────────────────────────
const ACCEPTED = {
  subject: "EOIR - ZHAO - 329 - Accepted - Supplemental Ev - RMV",
  from: "eRop@usdoj.gov",
  attachments: [],
  text: "",
  html: '<div><p>The Executive Office for Immigration Review (EOIR) has reviewed and approved your uploaded document. The following document is now included in the electronic Record of Proceedings (eROP): </p><ul><li>eFiled Document Name: 208817329 ZHAO ZHIWEN Travel History.pdf<br /></li><li>Document Category: Supplemental Evidence<br /></li><li>Document Sub Category: Evidence Part 05 <br /></li><li>Uploaded On: 09/24/2026<br /></li><li>Tracking Number: 000-063-619-459<br /></li></ul><ul><li>A-Number: 208-817-329<br /></li><li>Alien Name: ZHAO, ZHIWEN<br /></li><li>Charging Document Date: 09/23/2025<br /></li><li>Case Type: RMV<br /><br /></li><li>Other Information: N/A<br /></li></ul></div>',
};
const SERVICE = {
  subject: "EOIR - LU - 009 - Service - Supplemental Ev - RMV",
  from: "eFiling-DHSPortal@usdoj.gov",
  attachments: [],
  text: "",
  html: '<div><p>The Executive Office for Immigration Review (EOIR) has received an electronic upload of the document referenced below.</p><ul><li>eFiled Document Name: SUPPLEMENTAL EVIDENCE SET IV xinglong zheng et al.pdf<br /></li><li>Document Category: Supplemental Evidence<br /></li><li>Document Sub Category: Evidence Part 09 <br /></li><li>Uploaded On: 09/25/2026<br /></li><li>Tracking Number: 000-063-750-790<br /></li></ul><ul><li>A-Number: 240-996-009<br /></li><li>Alien Name: LU, FUYING<br /></li><li>Case Type: RMV<br /></li><li>Other Information: N/A<br /></li></ul></div>',
};
const ENTERED_ORDER = {
  subject: "EOIR - LU - 009 - Entered - Orders - RMV",
  from: "eRop@usdoj.gov",
  attachments: [{ filename: "2026092523270039_240996009.pdf", contentType: "application/octet-stream", content: Buffer.from("x") }],
  text: "",
  html: '<div><p>The Executive Office for Immigration Review (EOIR) has uploaded the following document in the electronic Record of Proceedings (eROP).</p><ul><li>eFiled Document Name: Order_7264403.pdf<br /></li><li>Document Category: Orders<br /></li><li>Document Sub Category: Order - Motion Order Generic (MOG)<br /></li><li>Uploaded On: 09/25/2026<br /></li><li>Tracking Number: 000-063-747-716<br /></li></ul><ul><li>A-Number: 240-996-009<br /></li><li>Alien Name: LU, FUYING<br /></li><li>Case Type: RMV<br /></li><li>Detained: No<br /></li></ul></div>',
};
const REJECTED = {
  subject: "EOIR - GAO - 502 - Rejected - Supplemental Ev - RMV",
  from: "eRop@usdoj.gov",
  attachments: [{ filename: "20240830161721162_246619502.pdf", contentType: "application/octet-stream", content: Buffer.from("x") }],
  text: "",
  html: '<div><p>EOIR has reviewed and rejected the document referenced below.</p><ul><li>eFiled Document Name: GAO GUANXUN PROOF OF BIOMETRIC.docx.pdf<br /></li><li>Document Category: Supplemental Evidence<br /></li><li>Uploaded On: 08/30/2024<br /></li></ul><ul><li>A-Number: 246-619-502<br /></li><li>Noncitizen Name: GAO, GUANXUN<br /></li><li>Case Type: RMV<br /></li></ul><p>Rejection Reasons: </p><ul><li>Duplicate Submission</li></ul></div>',
};
const ROW = { received_at: "2026-09-25T23:48:10.000Z" };

console.log("\n── What gets read without Zara ──────────────────");
{
  const r = CM.eoirReading(ACCEPTED, ROW);
  ok("an Accepted receipt is read from the template", !!r);
  check("  …classified as a receipt", r && r.kind, "receipt");
  check("  …is court mail", r && r.is_court_mail, true);
  check("  …not urgent", r && r.urgent, false);
  check("  …nothing to calendar", r && [r.hearings.length, r.deadlines.length, r.suggested.length], [0, 0, 0]);
  check("  …no busywork invented", r && r.action_items, []);
  check("  …carries the A-number for matching", r && r.a_numbers, ["208-817-329"]);
  check("  …and the name for matching", r && r.party_names, ["ZHAO, ZHIWEN"]);
  ok("  …title names the client", r && /ZHAO, ZHIWEN/.test(r.title), r && r.title);
  ok("  …summary says what happened", r && /accepted the filing into the record/i.test(r.summary), r && r.summary);
  ok("  …keeps the parsed fields for the page", r && r.eoir && r.eoir.source === "eoir-parse");
  check("  …tracking number kept", r && r.eoir.tracking_number, "000-063-619-459");
}
{
  const r = CM.eoirReading(SERVICE, ROW);
  ok("a Service receipt is read from the template", !!r);
  ok("  …summary says DHS uploaded it", r && /DHS uploaded/i.test(r.summary), r && r.summary);
  check("  …A-number from the body, not the subject", r && r.a_numbers, ["240-996-009"]);
}

console.log("\n── What must NOT be digested ────────────────────");
check("an Entered order goes to Zara instead", CM.eoirReading(ENTERED_ORDER, ROW), null);
check("a Rejected filing goes to Zara instead", CM.eoirReading(REJECTED, ROW), null);
check("an unrecognised status goes to Zara",
  CM.eoirReading({ ...ACCEPTED, subject: "EOIR - ZHAO - 329 - Withdrawn - Supplemental Ev - RMV" }, ROW), null);
check("a body with no A-Number goes to Zara",
  CM.eoirReading({ ...ACCEPTED, html: "<div><p>Something else entirely.</p></div>" }, ROW), null);
check("a template that has drifted goes to Zara",
  CM.eoirReading({ ...ACCEPTED, html: ACCEPTED.html.replace("Other Information", "Hearing Location") }, ROW), null);
check("an A-number the witnesses disagree on goes to Zara",
  CM.eoirReading({ ...ACCEPTED, attachments: [{ filename: "2026_111111111.pdf", content: Buffer.from("x") }] }, ROW), null);
check("a Proofpoint-encrypted stub goes to Zara",
  CM.eoirReading({ ...ACCEPTED, html: "", text: "This is a secure message.\nClick here by 2024-06-07 to read your message.\nAfter that, open the attachment." }, ROW), null);
// The receipt robots are two addresses, not all of usdoj.gov. ECAS sends real
// hearing notices from the same domain and must never be digested.
check("ECAS hearing notices are not receipt senders", EOIR.isEoirSender("ECAS-Notification@usdoj.gov"), false);
check("the two receipt senders are", [EOIR.isEoirSender("eRop@usdoj.gov"), EOIR.isEoirSender("eFiling-DHSPortal@usdoj.gov")], [true, true]);
// The mail reader's attachments carry `filename`; Graph's carry `name`. Reading
// only one made the A-number cross-check dead code in the live path.
check("the attachment cross-check reads mailparser's `filename`",
  EOIR.attachmentName({ filename: "2026_240996009.pdf" }), "2026_240996009.pdf");
check("…and Graph's `name`", EOIR.attachmentName({ name: "2026_240996009.pdf" }), "2026_240996009.pdf");

console.log("\n── The digest ───────────────────────────────────");
function queue(rows) {
  T.mail = rows.map((r, i) => ({
    id: i + 1, received_at: r.at || "2026-09-25T20:00:00.000Z", subject: r.subject || "EOIR",
    status: r.status || "done", client_key: r.client_key || null, note: null,
    notify_mode: "digest", digest_at: null,
    reading: { eoir: { status: r.status_txt || "Accepted", category: r.category || "Supplemental Evidence",
      a_number: r.a_number || null, name: r.name || null, document_name: r.doc || null } },
  }));
}

(async () => {
  {
    T.mail = [];
    const r = await CM.sendDigest({ send: async () => true });
    check("nothing queued sends nothing", [r.sent, r.items], [false, 0]);
  }
  {
    queue([
      { name: "ZHAO, ZHIWEN", a_number: "208-817-329", client_key: "n-zhao-zhiwen", doc: "Passport.pdf" },
      { name: "ZHAO, ZHIWEN", a_number: "208-817-329", client_key: "n-zhao-zhiwen", doc: "Travel History.pdf" },
      { name: "LU, FUYING", a_number: "240-996-009", client_key: "n-lu-fuying", status_txt: "Service", doc: "Evidence.pdf" },
    ]);
    const sent = [];
    const r = await CM.sendDigest({ send: async t => { sent.push(t); return true; } });
    check("one message for three receipts", [r.sent, r.items, r.messages], [true, 3, 1]);
    check("grouped by client, not one line each", r.clients, 2);
    ok("  …the client's name heads their group", /ZHAO, ZHIWEN \(208-817-329\)/.test(sent[0]), sent[0]);
    ok("  …each receipt names its document", /Travel History\.pdf/.test(sent[0]) && /Passport\.pdf/.test(sent[0]));
    ok("  …says the documents are already filed", /filed to each client's Dropbox folder/i.test(sent[0]));
    ok("  …no false alarm about unmatched mail", !/could not be matched/.test(sent[0]));
    check("everything reported is stamped", T.mail.every(m => !!m.digest_at), true);
  }
  {
    const r = await CM.sendDigest({ send: async () => true });
    check("a second run does not report them again", [r.sent, r.items], [false, 0]);
  }
  {
    // A receipt nobody could place still needs assigning — but in the digest,
    // not as an interruption.
    queue([{ name: "WANG, BAOHONG", a_number: null, client_key: null, status: "needs_review" }]);
    const sent = [];
    const r = await CM.sendDigest({ send: async t => { sent.push(t); return true; } });
    check("an unplaced receipt is counted", r.unplaced, 1);
    ok("  …flagged in its line", /not filed — needs assigning/.test(sent[0]), sent[0]);
    ok("  …with a link to assign it", /https:\/\/bot\.example\.com\/admin\/court-mail/.test(sent[0]));
    ok("  …and no malformed #mail- anchor", !/#mail-(\s|$)/.test(sent[0]));
  }
  {
    // Telegram truncates one long message, so a busy day is split rather than cut.
    queue(Array.from({ length: 120 }, (_, i) => ({
      name: `CLIENT ${String(i).padStart(3, "0")}`, a_number: `2${String(i).padStart(2, "0")}-000-00${i % 10}`,
      client_key: `c-${i}`, doc: `A Reasonably Long Document Name ${i}.pdf`,
    })));
    const sent = [];
    const r = await CM.sendDigest({ send: async t => { sent.push(t); return true; } });
    ok("a heavy day is split across messages", r.messages > 1, `messages=${r.messages}`);
    ok("  …none of them would be truncated", sent.every(s => s.length <= 3900), String(sent.map(s => s.length)));
    ok("  …each is numbered", sent.every((s, i) => s.includes(`(${i + 1}/${sent.length})`)));
    check("  …all 120 stamped", T.mail.filter(m => m.digest_at).length, 120);
  }
  {
    // A Telegram outage must not silently swallow a day of receipts.
    queue([{ name: "HE, XIAOLONG", a_number: "245-133-950", client_key: "n-he-xiaolong" }]);
    const r = await CM.sendDigest({ send: async () => false });
    check("a failed send reports failure", r.sent, false);
    check("  …and leaves them queued for next time", T.mail.every(m => !m.digest_at), true);
    const r2 = await CM.sendDigest({ send: async () => true });
    check("  …so the next run picks them up", [r2.sent, r2.items], [true, 1]);
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL EOIR DIGEST CHECKS PASSED\n");
  process.exit(failures ? 1 : 0);
})();
