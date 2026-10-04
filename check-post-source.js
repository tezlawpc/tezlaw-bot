/**
 * check-post-source.js
 *
 * JJ: "post creator doesn't allow me to upload documents. add it in."
 *
 * The Post Creator now takes a document (a decision, an order, a notice) or
 * an article JJ wrote himself. A document a lawyer uploads is, as often as
 * not, from a client's file, and this page publishes to the public website —
 * so what is pinned here is mostly what must NOT happen:
 *
 *   · the writer is told to leave private people out, and that is the default
 *   · that instruction is checked, not trusted: an A-number, a case number or
 *     a party's name that reaches the draft holds it as a WordPress draft
 *   · a document-sourced draft is never published by the one-click button
 *   · JJ's own article is not reworded
 *   · nothing from an uploaded file reaches the site except plain post markup
 *   · a scan is refused instead of written around
 *   · the upload is not stored
 *   · social drafts are queued only for a post that is actually live
 *
 *   node scripts/check-post-source.js
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, fn) {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || r === undefined; if (r && r !== true) detail = String(r); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}

const ps = require("../post-source");
const root = path.join(__dirname, "..");
const admin = fs.readFileSync(path.join(root, "admin.js"), "utf8");
const panel = fs.readFileSync(path.join(root, "admin-panel.js"), "utf8");

const ORDER = `UNITED STATES DISTRICT COURT, CENTRAL DISTRICT OF CALIFORNIA
Case No. 5:26-cv-01234-ABC
Wei Chen, Petitioner, v. Warden, Adelanto ICE Processing Center, Respondent. A-number 246-810-121.
ORDER GRANTING PETITION FOR WRIT OF HABEAS CORPUS
Petitioner has been detained for eleven months without a bond hearing. Respondents shall provide a bond hearing within fourteen days. IT IS SO ORDERED.
` + "Further procedural history. ".repeat(20);

(async () => {
  console.log("Reading a file");
  const txt = await ps.extract(Buffer.from(ORDER), "order.txt");
  check("a text file is read", () => txt.ok && txt.chars > 400 && !txt.truncated);
  const long = await ps.extract(Buffer.from("word ".repeat(20000)), "long.txt");
  check("a long document is cut, and says so", () => long.ok && long.truncated && long.text.length === ps.MAX_SOURCE_CHARS && /first 60,000/.test(long.warning));
  const bad = await ps.extract(Buffer.from("x"), "sheet.xlsx");
  check("an unsupported type is refused in plain words", () => !bad.ok && /PDF, a Word file/.test(bad.error));
  const old = await ps.extract(Buffer.from("x"), "brief.doc");
  check("an old .doc says how to fix it", () => !old.ok && /save as \.docx/.test(old.error));
  const empty = await ps.extract(Buffer.alloc(0), "a.pdf");
  check("an empty upload is refused", () => !empty.ok);
  const big = await ps.extract(Buffer.alloc(ps.MAX_BYTES + 1), "big.txt");
  check("an oversize upload is refused, with the limit named", () => !big.ok && /15 MB/.test(big.error));
  let scanMsg = null;
  try {
    require.resolve("pdf-parse");
    // A PDF with no text layer: one empty page.
    const blank = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n164\n%%EOF");
    scanMsg = await ps.extract(blank, "scan.pdf");
    check("a PDF with no text layer is refused, not written around",
      () => !scanMsg.ok && /scan|No readable text|Could not read/.test(scanMsg.error) || JSON.stringify(scanMsg));
  } catch (e) { console.log("  skip a scanned PDF (pdf-parse not installed here)"); }

  console.log("\nWhat the writer is told");
  const ctx = ps.sourceContext({ name: "order.txt", text: ORDER });
  check("leaving private people out is the default", () => /PRIVACY — mandatory/.test(ctx) && /Do NOT name or identify any private person/.test(ctx));
  check("facts about the matter come only from the document", () => /must come from the text below/.test(ctx));
  check("it is not a victory announcement", () => /not a victory announcement/.test(ctx) && /does not predict or guarantee/.test(ctx));
  check("the rules come before the document text", () => ctx.indexOf("RULES FOR USING IT") < ctx.indexOf("BEGIN DOCUMENT TEXT"));
  check("the file name — often the client's name — is not handed to the writer",
    () => !ps.sourceContext({ name: "Chen Wei bond order.pdf", text: "y" }).includes("Chen Wei") &&
          !ps.topicFor({ topic: "", name: "Chen Wei bond order.pdf" }).includes("Chen"));
  check("names are kept only when JJ says so", () => /confirmed this is a public decision/.test(ps.sourceContext({ name: "x", text: "y", anonymize: false })));
  check("…and even then not A-numbers or home addresses", () => /still leave out A-numbers/.test(ps.sourceContext({ name: "x", text: "y", anonymize: false })));
  check("a cut-off document is flagged to the writer", () => /cut off for length/.test(ps.sourceContext({ name: "x", text: "y", truncated: true })));

  console.log("\nThe privacy check on the draft");
  const clean = "<p>A federal court in California ordered a bond hearing within fourteen days for a detained petitioner.</p>";
  check("a clean draft passes", () => ps.privacyFlags(ORDER, clean).length === 0 || ps.privacyFlags(ORDER, clean).join(" | "));
  const leaky = ps.privacyFlags(ORDER, "<p>Wei Chen (A246810121) won case 5:26-cv-01234-ABC.</p>");
  check("a party's name is caught", () => leaky.some(f => /Name: Wei Chen/.test(f)) || leaky.join(" | "));
  check("an A-number is caught however it is punctuated", () => leaky.some(f => /A-number/.test(f)));
  check("a case number is caught", () => leaky.some(f => /Case number/.test(f)));
  check("the warden and the agency are not treated as private people",
    () => !ps.privacyFlags(ORDER, "<p>The Warden of the Adelanto ICE Processing Center must comply.</p>").length);
  check("the firm's own phone line is not a leak",
    () => !ps.privacyFlags("Call 626-678-8677 or (909) 555-1212", "<p>Call 626-678-8677</p>").length);
  check("an official sued in an official capacity is not flagged",
    () => !ps.privacyFlags("WEI CHEN, Petitioner, v. MERRICK GARLAND, Attorney General", "<p>Merrick Garland</p>").length);
  check("a flagged draft is held as a draft by the route",
    () => /privacyFlags\([\s\S]{0,200}\);\s*if \(privacy\.length\) post\.status = "draft";/.test(admin));

  console.log("\nJJ's own article");
  const footer = () => "<FOOTER>";
  const own = ps.postFromOwnText({
    title: "", practiceArea: "Immigration Law", footer,
    text: "Bond Hearings After Eleven Months\n\nMany people held in immigration detention wait a long time before any judge looks at whether they should be released. This article explains what a bond hearing is.\n\nWhat a bond hearing decides\n\nThe judge decides flight risk & danger, not the case itself.\n\n- bring proof of address\n- bring family letters\n\nA closing paragraph that says what to do next and where the rule comes from, in plain words.",
  });
  check("the first line becomes the title", () => own.title === "Bond Hearings After Eleven Months");
  check("the wording is his, untouched",
    () => own.content.includes("wait a long time before any judge looks at whether they should be released."));
  check("a short line on its own becomes a heading", () => own.content.includes("<h2>What a bond hearing decides</h2>"));
  check("dashes become a list", () => /<ul><li>bring proof of address<\/li><li>bring family letters<\/li><\/ul>/.test(own.content));
  check("an ampersand is escaped, not dropped", () => own.content.includes("flight risk &amp; danger"));
  check("the standard footer is added", () => own.content.endsWith("<FOOTER>"));
  check("the category is one the site already has", () => own.category === "Immigration");
  check("real estate files under an existing category, not a new one",
    () => ps.postFromOwnText({ title: "T", practiceArea: "Real Estate", text: "x".repeat(250) }).category === "Business Law");
  check("no AI is involved in this path", () => {
    const i = admin.indexOf('if (mode === "as_written")'); const j = admin.indexOf("if (!topic && !doc)", i);
    return i > 0 && j > i && !/generatePost|askClaude/.test(admin.slice(i, j));
  });
  check("too short to be an article is refused", () => { try { ps.postFromOwnText({ title: "T", text: "short" }); return false; } catch (e) { return /too short/.test(e.message); } });
  check("no title anywhere is refused", () => { try { ps.postFromOwnText({ title: "", html: "<p>" + "long paragraph ".repeat(40) + "</p>" }); return false; } catch (e) { return /title/.test(e.message); } });

  console.log("\nNothing but post markup reaches the site");
  const dirty = ps.sanitizeHtml('<h1 class="x">T</h1><p style="c" onclick="x()">a<script>alert(1)</script><img src=x onerror=1> <a href="javascript:alert(1)">bad</a> <a href="https://uscis.gov/x" target="_blank">ok</a></p><iframe src="x"></iframe>');
  check("scripts, images, frames and attributes are gone", () => !/script|img|iframe|onclick|style=|class=|javascript:/i.test(dirty) || dirty);
  check("a web link survives with only its address", () => dirty.includes('<a href="https://uscis.gov/x">ok</a>'));
  check("a Word title style becomes a section heading", () => dirty.startsWith("<h2>T</h2>"));

  console.log("\nThe routes and the page");
  check("there is an upload route", () => /router\.post\("\/api\/post\/extract", requireAuth/.test(admin));
  check("the upload is read in memory and not written to a table or to disk", () => {
    const i = admin.indexOf('router.post("/api/post/extract"'); const j = admin.indexOf("router.post(", i + 10);
    return !/INSERT INTO|writeFile|client_documents|dropbox/i.test(admin.slice(i, j));
  });
  check("with a document, the web search is off unless asked for", () => /useSearch: doc \? useSearch === true : useSearch !== false/.test(admin));
  check("anonymise is on unless explicitly turned off", () => /anonymize: anonymize !== false/.test(admin));
  check("publishing queues social drafts for JJ's approval", () => /api\/post\/publish[\s\S]*queueForSource\(/.test(admin));
  check("…only for a post that is live", () => /results\.find\(r => r\.langTag === tag && r\.status === "publish"\)/.test(admin));
  check("a failure there cannot undo the publish", () => /catch \(socErr\)/.test(admin));
  check("the page has the file box", () => /id="postFile"/.test(admin) && /onchange="onPostFile\(this\)"/.test(admin));
  check("…and says the file is not kept", () => /not stored/.test(admin));
  check("leave-out-names is ticked by default", () => /id="postAnon" checked/.test(admin));
  check("one click never publishes a document-sourced or self-written post",
    () => /if \(payload\.source \|\| payload\.mode === 'as_written'\) \{[\s\S]{0,200}return previewManualPost\(\);/.test(panel));
  check("server errors are shown to JJ, not swallowed", () => /data\.error \|\| \('Server error '/.test(panel));
  check("the preview hides the author footer's CSS", () => /indexOf\('<style>\.tez-ab\{'\)/.test(panel));

  console.log("\n" + (failures ? `${failures} FAILED` : "all post-source checks passed"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("check crashed:", e); process.exit(1); });
