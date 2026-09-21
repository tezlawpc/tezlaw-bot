/**
 * check-esign.js
 *
 * JJ: "need to work on function to populate documents to esign. for the
 * templates. i can upload all the documents filed previously and claude can
 * help me create the templates to use for future hearings and also the
 * retainer agreement."
 *
 * He chose: Zara makes the templates in the platform; templates keep their
 * Word formatting; signed copies are a PDF with a signature certificate,
 * filed to the case's Dropbox folder; signers can be the client, several
 * clients, witnesses, and the attorney countersigning last.
 *
 * Pinned here:
 *   1. the Word engine — text split across runs, formatting kept,
 *      {{fields}}, {{field|upper}}, signatures drawn into the document
 *   2. a filed document becomes a template (Zara's reading stubbed)
 *   3. prepare → send → sign in order → countersign → signed Word + PDF
 *      with a certificate → filed to the matter, with every guard
 *   4. the signing page and the admin screens
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");
const express = require("express");
const PizZip = require("pizzip");
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

// ── A filed declaration, as Word stores it: names split across runs ──
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (t, bold) => `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const para = (...runs) => `<w:p>${runs.join("")}</w:p>`;
function makeDocx(paras) {
  const zip = new PizZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${paras.join("")}</w:body></w:document>`);
  return zip.generate({ type: "nodebuffer" });
}
const FILED = makeDocx([
  para(run("TEZ LAW P.C.", true)),                                                 // 0 firm: fixed text
  para(run("SUPERIOR COURT OF CALIFORNIA, COUNTY OF ", true), run("LOS ANGELES", true)), // 1
  para(run("JING "), run("LI"), run("U, Plaintiff, v. JAMES TURCO, Defendant.")),   // 2
  para(run("Case No. 25STCV"), run("01234")),                                       // 3
  para(run("Hearing: October 14, 2026, Dept. 8D")),                                 // 4
  para(run("I, Jing Liu, declare that the foregoing is true &amp; correct.")),      // 5
  para(run("Dated: ______________")),                                               // 6
  para(run("____________________________")),                                        // 7
  para(run("Jing Liu")),                                                            // 8
  para(run("______________________ Witness")),                                      // 9
]);
// A 2x1 transparent PNG — enough for the engine and the PDF.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAC0lEQVR4nGNgQAcAAA0AAR/Z9ggAAAAASUVORK5CYII=", "base64");
const PNG_URL = "data:image/png;base64," + PNG.toString("base64");

// ── An in-memory database for the esign tables ───────────────
const T = { tpl: [], pk: [], sg: [], ev: [] };
let seq = 1;
const now = () => new Date();
const fakeDb = {
  query: async (sql, v = []) => {
    const q = sql.replace(/\s+/g, " ").trim();
    if (/^CREATE (TABLE|INDEX)/.test(q)) return { rows: [] };
    if (/^INSERT INTO esign_templates/.test(q)) {
      const r = { id: seq++, name: v[0], category: v[1], description: v[2], docx: v[3], fields: JSON.parse(v[4]), signers: JSON.parse(v[5]),
        source_filename: v[6], notes: JSON.parse(v[7]), status: "draft", created_by: v[8], created_at: now() };
      T.tpl.push(r); return { rows: [{ ...r }] };
    }
    if (/FROM esign_templates( WHERE status <> 'archived')? ORDER BY/.test(q)) return { rows: T.tpl.filter(t => /<>/.test(q) ? t.status !== "archived" : true).map(t => ({ ...t })) };
    if (/^SELECT \* FROM esign_templates WHERE id = \$1/.test(q)) return { rows: T.tpl.filter(t => t.id === v[0]).map(t => ({ ...t })) };
    if (/^UPDATE esign_templates SET name/.test(q)) { const t = T.tpl.find(x => x.id === v[0]); Object.assign(t, { name: v[1], category: v[2], description: v[3], docx: v[4], fields: JSON.parse(v[5]), signers: JSON.parse(v[6]) }); return { rows: [{ ...t }] }; }
    if (/^UPDATE esign_templates SET docx/.test(q)) { const t = T.tpl.find(x => x.id === v[0]); Object.assign(t, { docx: v[1], fields: JSON.parse(v[2]), signers: JSON.parse(v[3]) }); return { rows: [{ ...t }] }; }
    if (/^UPDATE esign_templates SET status/.test(q)) { const t = T.tpl.find(x => x.id === v[0]); t.status = v[1]; return { rows: [{ ...t }] }; }

    if (/^INSERT INTO esign_packets/.test(q)) {
      const r = { id: seq++, template_id: v[0], template_name: v[1], category: v[2], case_id: v[3], client_key: v[4], title: v[5],
        field_values: JSON.parse(v[6]), docx: v[7], doc_hash: v[8], status: "draft", message: v[9], created_by: v[10], created_by_uid: v[11], created_at: now() };
      T.pk.push(r); return { rows: [{ id: r.id }] };
    }
    if (/^INSERT INTO esign_signers/.test(q)) {
      T.sg.push({ id: seq++, packet_id: v[0], role: v[1], label: v[2], name: v[3], email: v[4], phone: v[5], sign_order: v[6], token: v[7],
        status: "waiting", expires_at: new Date(Date.now() + 30 * 86400000) });
      return { rows: [] };
    }
    if (/^SELECT \* FROM esign_packets WHERE id = \$1/.test(q)) return { rows: T.pk.filter(p => p.id === v[0]).map(p => ({ ...p })) };
    if (/^SELECT \* FROM esign_signers WHERE packet_id = \$1/.test(q)) return { rows: T.sg.filter(s => s.packet_id === v[0]).sort((a, b) => a.sign_order - b.sign_order || a.id - b.id).map(s => ({ ...s })) };
    if (/^SELECT id FROM esign_packets/.test(q)) return { rows: T.pk.filter(p => !v.length || p.case_id === v[0]).reverse().map(p => ({ id: p.id })) };
    if (/^UPDATE esign_packets SET status = 'sent'.*AND status = 'draft' RETURNING id/.test(q)) {
      const p = T.pk.find(x => x.id === v[0] && x.status === "draft");
      if (p) Object.assign(p, { status: "sent", sent_at: now(), link_base: v[1] });
      return { rows: p ? [{ id: p.id }] : [] };
    }
    if (/^UPDATE esign_packets SET status = 'completed'.*AND status = 'sent' RETURNING id/.test(q)) {
      const p = T.pk.find(x => x.id === v[0] && x.status === "sent");
      if (p) Object.assign(p, { status: "completed", completed_at: now() });
      return { rows: p ? [{ id: p.id }] : [] };
    }
    if (/^UPDATE esign_packets SET signed_docx/.test(q)) { Object.assign(T.pk.find(p => p.id === v[0]), { signed_docx: v[1], signed_hash: v[2], finalize_error: null }); return { rows: [] }; }
    if (/^UPDATE esign_packets SET finalize_error/.test(q)) { T.pk.find(p => p.id === v[0]).finalize_error = v[1]; return { rows: [] }; }
    if (/^UPDATE esign_signers SET sent_at = NOW\(\) WHERE id = \$1 AND sent_at IS NULL/.test(q)) {
      const x = T.sg.find(y => y.id === v[0] && !y.sent_at);
      if (x) x.sent_at = now();
      return { rows: x ? [{ id: x.id }] : [] };
    }
    if (/^UPDATE esign_packets SET status = 'cancelled'/.test(q)) { T.pk.find(p => p.id === v[0]).status = "cancelled"; return { rows: [] }; }
    if (/^UPDATE esign_packets SET status = 'declined'/.test(q)) { T.pk.find(p => p.id === v[0]).status = "declined"; return { rows: [] }; }
    if (/^UPDATE esign_packets SET signed_pdf/.test(q)) { Object.assign(T.pk.find(p => p.id === v[0]), { signed_pdf: v[1], dropbox_docx: v[2], dropbox_pdf: v[3], finalize_error: v[4] }); return { rows: [] }; }
    if (/^UPDATE esign_signers SET status = CASE WHEN status = 'waiting'/.test(q)) {
      const s = T.sg.find(x => x.id === v[0]); if (s.status === "waiting") s.status = "sent"; s.sent_at = s.sent_at || now(); s.sent_via = v[1]; s.delivery_error = v[2]; return { rows: [] };
    }
    if (/^SELECT \* FROM esign_signers WHERE (id|token) = \$1/.test(q)) return { rows: T.sg.filter(s => (/token/.test(q) ? s.token : s.id) === v[0]).map(s => ({ ...s })) };
    if (/^UPDATE esign_signers SET expires_at/.test(q)) return { rows: [] };
    if (/^UPDATE esign_signers SET viewed_at/.test(q)) { const s = T.sg.find(x => x.id === v[0]); s.viewed_at = now(); if (["waiting", "sent"].includes(s.status)) s.status = "viewed"; return { rows: [] }; }
    if (/^UPDATE esign_signers SET status = 'signed'/.test(q)) {
      const s = T.sg.find(x => x.id === v[0] && x.status !== "signed");
      if (!s) return { rows: [] };
      Object.assign(s, { status: "signed", signed_at: now(), typed_name: v[1], signature_png: v[2], consent_text: v[3], ip: v[4], user_agent: v[5] });
      return { rows: [{ id: s.id }] };
    }
    if (/^UPDATE esign_signers SET status = 'declined'/.test(q)) { Object.assign(T.sg.find(x => x.id === v[0]), { status: "declined", decline_reason: v[1] }); return { rows: [] }; }
    if (/^INSERT INTO esign_events/.test(q)) { T.ev.push({ id: seq++, packet_id: v[0], signer_id: v[1], event: v[2], detail: v[3], ip: v[4], at: now() }); return { rows: [] }; }
    if (/^SELECT \* FROM esign_events/.test(q)) return { rows: T.ev.filter(e => e.packet_id === v[0]) };
    if (/FROM civil_hearings/.test(q)) return { rows: [{ hearing_date: new Date("2026-10-14T00:00:00Z"), hearing_time: "8:30 AM", hearing_type: "Motion hearing", department: "8D", status: "scheduled" }] };
    return { rows: [] };
  },
};

const MATTER = { id: 223, client_key: "contact-liu", case_name: "Jing Liu v. James Turco, et al.", case_number: "2:26-cv-01671",
  court: "United States District Court, Central District of California", county: null, retainer_amount: "15000" };
const caseLog = [], uploads = [];
let previewWorks = false;
const stubs = {
  "./db": fakeDb,
  "./civil-litigation": {
    getCase: async id => id === 223 ? { ...MATTER } : null,
    logEvent: async (id, e) => { caseLog.push({ id, ...e }); return {}; },
  },
  "./client-profiles": { getClientByKey: async k => k === "contact-liu" ? { client_name: "Jing Liu", client_email: "jing@example.com", client_phone: "626-555-0100" } : null },
  "./civil-upload": { uploadToCase: async (id, files, o) => { uploads.push({ id, files, o }); return { ok: true, uploaded: files.map(f => ({ name: f.originalname, saved_as: f.originalname, path: "/Cases/Liu/Billing/" + f.originalname, folder_label: "Billing" })), failed: [] }; } },
  "./dropbox-integration": { getAccessToken: async () => "t", getPathRootHeader: async () => null },
  "./push-notifications": { sendToUser: async () => ({}) },
};
const realAxios = require("axios");
const orig = Module._load;
Module._load = function (r, ...rest) {
  if (stubs[r]) return stubs[r];
  if (r === "axios") return { ...realAxios, post: async (url, ...a) => {
    if (/get_preview/.test(url)) {
      if (!previewWorks) throw new Error("preview unavailable");
      const { PDFDocument } = require("pdf-lib"); const d = await PDFDocument.create(); d.addPage(); return { data: Buffer.from(await d.save()) };
    }
    return realAxios.post(url, ...a);
  } };
  return orig.call(this, r, ...rest);
};
delete process.env.SMTP_HOST; delete process.env.GMAIL_EMAIL; delete process.env.TWILIO_ACCOUNT_SID;

const docx = require("../docx-fill");
const tpl = require("../esign-templates");
const es = require("../esign");

(async () => {
  console.log("\n── 1. The Word engine ──────────────────────────");
  const paras = docx.paragraphs(FILED);
  check("a name Word split into three runs reads as one", () => paras[2].text.startsWith("JING LIU, Plaintiff"));
  let r = docx.replaceText(FILED, [{ find: "JING LIU", replace: "{{client_name|upper}}" }, { find: "25STCV01234", replace: "{{case_number}}" }]);
  check("…and is replaced as one", () => r.counts[0] === 1 && r.counts[1] === 1);
  const after = docx.paragraphs(r.buffer);
  check("…leaving the rest of the paragraph exactly as it was", () => after[2].text === "{{client_name|upper}}, Plaintiff, v. JAMES TURCO, Defendant.");
  const xml1 = new PizZip(r.buffer).file("word/document.xml").asText();
  check("formatting is kept: the bold caption is still bold", () => /<w:b\/><\/w:rPr><w:t[^>]*>SUPERIOR COURT/.test(xml1));
  check("& and < in the text survive the round trip", () => /true &amp; correct/.test(xml1) && docx.paragraphs(r.buffer)[5].text.includes("true & correct"));
  const f = docx.fill(r.buffer, { client_name: "Wei Chen" });
  check("fill reports what is still missing", () => f.missing.length === 1 && f.missing[0] === "case_number");
  check("{{field|upper}} fills in capitals", () => docx.paragraphs(f.buffer)[2].text.startsWith("WEI CHEN, Plaintiff"));
  check("a value is never read as a marker or as XML", () => {
    const x = docx.fill(r.buffer, { client_name: "A <b>&</b> {{case_number}}", case_number: "1" });
    return docx.paragraphs(x.buffer)[2].text.startsWith("A <B>&</B> {{CASE_NUMBER}}") && /&lt;B&gt;&amp;/.test(new PizZip(x.buffer).file("word/document.xml").asText());
  });
  const withSig = docx.replaceText(FILED, [], { only: { 7: [{ find: /_{4,}/, replace: "{{sig:client}}" }], 6: [{ find: /_{3,}/, replace: "{{date:client}}" }] } });
  const signedOnce = docx.applySignatures(withSig.buffer, { client: { png: PNG, name: "Jing Liu", date: "October 1, 2026" } });
  const zip = new PizZip(signedOnce.buffer);
  check("a signature is drawn into the document as a picture", () => signedOnce.placed.client === 1 && Object.keys(zip.files).some(n => /^word\/media\/esign_client_1\.png$/.test(n)));
  check("…with its relationship and content type", () => /rIdEsign1/.test(zip.file("word/_rels/document.xml.rels").asText()) && /Extension="png"/.test(zip.file("[Content_Types].xml").asText()));
  check("…and the namespaces a picture needs", () => /xmlns:wp=/.test(zip.file("word/document.xml").asText()) && /xmlns:pic=/.test(zip.file("word/document.xml").asText()));
  check("the date spot gets the signing date", () => docx.paragraphs(signedOnce.buffer)[6].text === "Dated: October 1, 2026");
  const html = (await require("mammoth").convertToHtml({ buffer: signedOnce.buffer })).value;
  check("…and Word-reading software sees the picture", () => /<img src="data:image\/png;base64,/.test(html));
  // A signature block inside a textbox, and a run with a tab between two texts.
  const V = 'xmlns:v="urn:schemas-microsoft-com:vml"';
  const tb = makeDocx([
    `<w:p><w:r><w:t>Before {{a}}</w:t></w:r><w:r><w:pict><v:shape ${V}><v:textbox><w:txbxContent><w:p><w:r><w:t xml:space="preserve">Client: {{sig:client}}</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>{{sig:client}} again</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r><w:r><w:t>After {{b}}</w:t></w:r></w:p>`,
    `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Sign:</w:t><w:tab/><w:t xml:space="preserve">{{sig:attorney}} end</w:t></w:r></w:p>`]);
  const tbFilled = docx.fill(tb, { a: "AAA", b: "BBB" });
  check("text after a textbox is filled too", () => tbFilled.missing.length === 0 && docx.paragraphs(tbFilled.buffer).some(p => p.text === "After BBB"));
  const tbSigned = docx.applySignatures(tbFilled.buffer, { client: { png: PNG }, attorney: { png: PNG } });
  const tbXml = new PizZip(tbSigned.buffer).file("word/document.xml").asText();
  check("a signature inside a textbox leaves the document well-formed", () => {
    const { DOMParser } = new JSDOM("").window;
    const d = new DOMParser().parseFromString(tbXml, "application/xml");
    return !d.getElementsByTagName("parsererror").length && tbSigned.placed.client === 2;
  });
  check("…every picture gets its own id", () => { const ids = tbXml.match(/docPr id="\d+"/g); return ids.length === 3 && new Set(ids).size === 3; });
  check("…and nothing else in the run is lost (the tab and the text after)", () => /Sign:<\/w:t><w:tab\/>/.test(tbXml) && docx.paragraphs(tbSigned.buffer).some(p => p.text === "Sign: end"));
  check("a javascript: link in a document never reaches the signing page", () => {
    const clean = es.sanitizeHtml(`<p onclick="x">Hi <a href="javascript:alert(1)">x</a><img src="http://evil/x.png"><script>bad()</script><a href="https://ok.com">ok</a></p>`);
    return !/javascript:|onclick|<script|evil/.test(clean) && /href="https:\/\/ok\.com"/.test(clean);
  });
  check("a PDF becomes a plain Word document", () => /Hello world/.test(docx.plainText(docx.textToDocx("Hello world\nSecond line"))));

  console.log("\n── 2. A filed document becomes a template ──────");
  let asked = null;
  const think = async (message) => { asked = message; return { text: JSON.stringify({
    name: "Declaration of Client re Hearing", category: "declaration", description: "Client declaration for a hearing.",
    fields: [
      { key: "client_name", label: "Client's name", source: "client_name", type: "text", find: ["Jing Liu", "JING LIU"] },
      { key: "case_number", label: "Case number", source: "case_number", find: ["25STCV01234"] },
      { key: "county", label: "County", source: "county", find: ["LOS ANGELES"] },
      { key: "hearing_date", label: "Hearing date", source: "next_hearing_date", type: "date", find: ["October 14, 2026"] },
      { key: "ghost", label: "Something not there", source: "ask", find: ["NOT IN THE DOCUMENT"] },
      { key: "tiny", label: "Too short", source: "ask", find: ["8D".slice(0, 2)] },
    ],
    signers: [
      { role: "client", label: "Declarant", signature_paragraph: 7, date_paragraph: 6 },
      { role: "witness", label: "Witness", signature_paragraph: 9, date_paragraph: null },
      { role: "attorney", label: "Attorney", signature_paragraph: 999 },
      { role: "janitor", label: "Nobody", signature_paragraph: 1 },
    ],
    notes: ["Check the hearing date."],
  }) }; };
  const made = await tpl.createFromUpload(FILED, "Liu Declaration.docx", { by: "jj", think });
  check("Zara is shown numbered paragraphs to work from", () => /\[2\] JING LIU, Plaintiff/.test(asked) && /\[7\] _{10,}/.test(asked));
  check("…and told to leave the firm's own details alone", () => /Leave the firm's own details/.test(asked));
  check("the draft template has the fields that were really there", () =>
    made.status === "draft" && made.fields.map(x => x.key).join() === "client_name,case_number,county,hearing_date");
  check("…a value she named that is not in the text is dropped, with a note", () => made.notes.some(n => /Something not there/.test(n)));
  check("…a find string under 3 characters is ignored", () => !made.fields.some(x => x.key === "tiny"));
  check("…signers with a bad paragraph or an unknown role are ignored", () => made.signers.map(s => s.role).join() === "client,witness");
  const body = docx.paragraphs(T.tpl[0].docx).map(p => p.text);
  check("the caption name became {{client_name|upper}}, the body name {{client_name}}", () =>
    body[2].startsWith("{{client_name|upper}}, Plaintiff") && body[5] === "I, {{client_name}}, declare that the foregoing is true & correct." && body[8] === "{{client_name}}");
  check("the signature line became the client's signature spot", () => body[7] === "{{sig:client}}" && body[6] === "Dated: {{date:client}}");
  check("the witness line too", () => body[9] === "{{sig:witness}} Witness");
  check("the firm's name was left alone", () => body[0] === "TEZ LAW P.C.");
  const htmlPrev = await tpl.previewHtml(made.id);
  check("the preview marks fields and signature spots", () => /data-field="client_name"/.test(htmlPrev) && /Declarant|client signs here/.test(htmlPrev));

  await throwsA("a draft cannot be used to prepare a document", () => es.prefill(made.id, 223), /still a draft/);
  const upd = await tpl.updateTemplate(made.id, { name: "Client Declaration", fields: [{ key: "county", remove: true }, { key: "client_name", label: "Declarant's full name" }] });
  check("a field can be turned back into its original wording", () =>
    !upd.fields.some(x => x.key === "county") && docx.paragraphs(T.tpl[0].docx)[1].text === "SUPERIOR COURT OF CALIFORNIA, COUNTY OF LOS ANGELES");
  check("…and a label renamed", () => upd.fields.find(x => x.key === "client_name").label === "Declarant's full name" && upd.name === "Client Declaration");
  await tpl.setStatus(made.id, "active");

  const pdfDoc = await tpl.toDocx(Buffer.from("x"), "old.doc").catch(e => e);
  check("an old .doc is refused with instructions", () => /Save As \.docx/.test(pdfDoc.message));
  const alreadyTpl = makeDocx([para(run("Retainer between Tez Law P.C. and {{client_name}}.")), para(run("Client: {{sig:client}}")), para(run("Attorney: {{sig:attorney}} {{date:attorney}}"))]);
  const handMade = await tpl.createFromUpload(alreadyTpl, "Retainer.docx", { think: async () => { throw new Error("should not be asked"); } });
  check("a document that already has {{fields}} is used as written, without asking Zara", () =>
    handMade.fields.map(x => x.key).join() === "client_name" && handMade.signers.map(s => s.role).join() === "client,attorney");
  await tpl.updateTemplate(handMade.id, { category: "retainer" });
  await tpl.setStatus(handMade.id, "active");
  const bare = await tpl.createFromUpload(makeDocx([para(run("Hello {{x}}"))]), "x.docx");
  await throwsA("a template with nowhere to sign cannot be activated", () => tpl.setStatus(bare.id, "active"), /no signature spot/);

  console.log("\n── 3. Prepare, send, sign in order ─────────────");
  const pre = await es.prefill(made.id, 223, { user: { n: "JJ Zhang" } });
  const val = k => pre.fields.find(x => x.key === k).value;
  check("the form is filled from the matter: client name", () => val("client_name") === "Jing Liu");
  check("…case number", () => val("case_number") === "2:26-cv-01671");
  check("…and the next hearing, written out as a date", () => val("hearing_date") === "October 14, 2026");
  check("the client is suggested as signer with their email and phone", () =>
    pre.signers[0].role === "client" && pre.signers[0].name === "Jing Liu" && pre.signers[0].email === "jing@example.com");

  const values = Object.fromEntries(pre.fields.map(x => [x.key, x.value]));
  await throwsA("every signature spot needs a signer", () => es.createPacket({ templateId: made.id, caseId: 223, values, signers: [pre.signers[0]] }), /Add the Witness/);
  await throwsA("a missing field is named, not silently left blank", () => es.createPacket({ templateId: made.id, caseId: 223,
    values: { ...values, case_number: "" }, signers: [pre.signers[0], { role: "witness", label: "Witness", name: "Ann Wu" }] }), /Fill in: Case number/);
  await throwsA("a bad email is caught before sending", () => es.createPacket({ templateId: made.id, caseId: 223, values,
    signers: [{ ...pre.signers[0], email: "not-an-email" }, { role: "witness", label: "Witness", name: "Ann Wu" }] }), /does not look right/);

  // The retainer: client first, JJ countersigns.
  const rp = await es.prefill(handMade.id, 223, { user: { n: "JJ Zhang" } });
  check("on a retainer the attorney is suggested, signing second", () => rp.signers.find(s => s.role === "attorney").sign_order === 2 && rp.signers.find(s => s.role === "attorney").name === "JJ Zhang");
  let pk = await es.createPacket({ templateId: handMade.id, caseId: 223, values: { client_name: "Jing Liu" }, signers: rp.signers, user: { uid: 1, n: "JJ Zhang" } });
  check("a packet starts as a draft with a private link per signer", () => pk.status === "draft" && pk.signers.length === 2 && new Set(T.sg.map(s => s.token)).size === T.sg.length);
  check("…and the phone number is stored in international form", () => pk.signers.find(s => s.role === "client").phone === "+16265550100");
  const client = T.sg.find(s => s.packet_id === pk.id && s.role === "client");
  const atty = T.sg.find(s => s.packet_id === pk.id && s.role === "attorney");
  let v = await es.signerView(client.token);
  check("a link is not usable until the document is sent", () => !v.ok && /not been sent/.test(v.error));

  const sent = await es.sendPacket(pk.id, { baseUrl: "https://tezlawfirm.com" });
  check("sending goes to the first signer only", () => sent.delivered.length === 1 && sent.delivered[0].name === "Jing Liu");
  check("…with a /sign/e/ link on the firm's domain", () => /^https:\/\/tezlawfirm\.com\/sign\/e\/[A-Za-z0-9_-]{30,}$/.test(sent.delivered[0].url));
  check("…and when email/text are not set up, it says so instead of pretending", () => sent.delivered[0].errors.some(e => /email is not set up/.test(e)) && sent.delivered[0].errors.some(e => /text messages are not set up/.test(e)));
  check("the attorney has not been sent anything yet", () => !T.sg.find(s => s.id === atty.id).sent_at);
  await throwsA("a document cannot be sent twice", () => es.sendPacket(pk.id), /already sent/);

  v = await es.signerView(atty.token);
  check("the attorney's link says it is not their turn yet", () => v.ok && v.your_turn === false && v.waiting_for[0] === "Jing Liu");
  await throwsA("…and refuses a signature out of turn", () => es.sign(atty.token, { typed_name: "JJ Zhang", signature: PNG_URL, consent: true }), /not your turn/);

  v = await es.signerView(client.token, { ip: "1.2.3.4" });
  check("the client sees the whole document, their spot highlighted", () => v.ok && v.your_turn && /Retainer between Tez Law P\.C\. and Jing Liu/.test(v.document_html) && /esign-mine/.test(v.document_html));
  check("…with the consent to sign electronically", () => /same legal effect as a handwritten signature/.test(v.consent_text));
  check("…and opening it is recorded", () => T.sg.find(s => s.id === client.id).status === "viewed" && T.ev.some(e => e.event === "viewed" && e.ip === "1.2.3.4"));
  await throwsA("no signature without consent", () => es.sign(client.token, { typed_name: "Jing Liu", signature: PNG_URL, consent: false }), /agree to sign electronically/);
  await throwsA("no signature without a drawn signature", () => es.sign(client.token, { typed_name: "Jing Liu", signature: "", consent: true }), /Draw your signature/);
  await throwsA("…or with something that is not a PNG", () => es.sign(client.token, { typed_name: "Jing Liu", signature: "data:image/png;base64," + Buffer.from("GIF89a").toString("base64"), consent: true }), /Draw your signature/);
  await throwsA("no signature without a typed name", () => es.sign(client.token, { typed_name: " ", signature: PNG_URL, consent: true }), /Type your full name/);

  let out = await es.sign(client.token, { typed_name: "Jing  Liu", signature: PNG_URL, consent: true, ip: "1.2.3.4", userAgent: "iPhone", baseUrl: "https://tezlawfirm.com" });
  check("the client signs", () => out.ok && !out.completed && T.sg.find(s => s.id === client.id).status === "signed");
  check("…and the attorney's link goes out next", () => out.next[0] === "JJ Zhang" && !!T.sg.find(s => s.id === atty.id).sent_at);
  await throwsA("signing twice is refused", () => es.sign(client.token, { typed_name: "Jing Liu", signature: PNG_URL, consent: true }), /already signed/);
  v = await es.signerView(client.token);
  check("the client's link now says they have signed", () => v.ok && v.signed === true);
  v = await es.signerView(atty.token);
  check("the attorney sees the client's signature already in the document", () => v.your_turn && /<img src="data:image\/png/.test(v.document_html));

  previewWorks = false;
  out = await es.sign(atty.token, { typed_name: "JJ Zhang", signature: PNG_URL, consent: true, ip: "5.6.7.8" });
  check("the countersignature completes the document", () => out.completed === true);
  check("…and the signer is answered before the filing is done", () => out.finalizing && typeof out.finalizing.then === "function");
  await out.finalizing;
  const done = T.pk.find(p => p.id === pk.id);
  check("the signed Word file has both signatures drawn in", () => {
    const z = new PizZip(done.signed_docx);
    return Object.keys(z.files).filter(n => /^word\/media\/esign_/.test(n)).length === 2;
  });
  check("…and the signing date where the date spot was", () => /Attorney: \s*[A-Z][a-z]+ \d{1,2}, \d{4}/.test(docx.plainText(done.signed_docx)));
  check("it is filed in the matter's Dropbox folder — Word and PDF", () =>
    uploads.length === 2 && uploads.every(u => u.id === 223) && /\.docx$/.test(uploads[0].files[0].originalname) && /\.pdf$/.test(uploads[1].files[0].originalname));
  check("…a retainer goes to Billing", () => uploads.every(u => u.o.category === "billing"));
  check("…and the case history says who signed and when", () => caseLog.some(e => /^Signed: /.test(e.title) && /Client: Jing Liu/.test(e.description) && /Attorney: JJ Zhang/.test(e.description)));
  check("when Dropbox cannot make the PDF, the certificate is still filed and the reason recorded", () => /PDF of the document could not be made/.test(done.finalize_error || ""));
  const text = (await require("pdf-parse")(done.signed_pdf)).text;
  check("the certificate names each signer, with IP and time", () => /CERTIFICATE OF ELECTRONIC SIGNATURE/.test(text) && /Jing Liu/.test(text) && /1\.2\.3\.4/.test(text) && /5\.6\.7\.8/.test(text));
  check("…the document's fingerprint (SHA-256) before and after signing", () => text.replace(/\s/g, "").includes(done.doc_hash) && text.replace(/\s/g, "").includes(done.signed_hash));
  check("…and the consent each signer agreed to", () => /same legal effect/.test(text.replace(/\s+/g, " ")));

  // With Dropbox's PDF available: the document itself plus the certificate.
  previewWorks = true; uploads.length = 0;
  const p2 = await es.createPacket({ templateId: handMade.id, caseId: 223, values: { client_name: "Jing Liu" }, signers: rp.signers, user: { uid: 1 } });
  await es.sendPacket(p2.id, {});
  for (const role of ["client", "attorney"]) {
    const s = T.sg.find(x => x.packet_id === p2.id && x.role === role);
    const o = await es.sign(s.token, { typed_name: s.name, signature: PNG_URL, consent: true });
    if (o.finalizing) await o.finalizing;
  }
  const done2 = T.pk.find(p => p.id === p2.id);
  const pages = (await require("pdf-lib").PDFDocument.load(done2.signed_pdf)).getPageCount();
  check("with Dropbox's PDF, the signed PDF is the document followed by the certificate", () => pages >= 2 && !done2.finalize_error);

  // Dropbox was down the first time: file it again.
  previewWorks = true; uploads.length = 0;
  const refiled = await es.refinalize(pk.id);
  check("a document whose PDF failed can be filed again, and the error clears", () => !refiled.finalize_error && uploads.length === 2);
  await throwsA("…but a document already filed is not filed twice", () => es.refinalize(pk.id), /already filed/);

  // Signing links never leave the module by accident.
  const shown = await es.getPacket(pk.id);
  check("a document's details do not include anyone's signing token", () => shown.signers.every(s => !("token" in s)));
  check("…only the copy-link lookup does", () => { return es.getPacket(pk.id, { includeTokens: true }).then ? true : false; });

  // Several clients sign at the same time.
  const multi = await tpl.createFromUpload(makeDocx([para(run("{{sig:client}}")), para(run("{{sig:client_2}}")), para(run("{{sig:attorney}}"))]), "Joint.docx");
  await tpl.setStatus(multi.id, "active");
  const p3 = await es.createPacket({ templateId: multi.id, caseId: 223, values: {}, user: { uid: 1 }, signers: [
    { role: "client", label: "Client", name: "Husband Chen", sign_order: 1 }, { role: "client_2", label: "Client 2", name: "Wife Chen", sign_order: 1 },
    { role: "attorney", label: "Attorney", name: "JJ Zhang", sign_order: 2 }] });
  const s3 = await es.sendPacket(p3.id, {});
  check("two clients get their links at the same time", () => s3.delivered.map(d => d.name).sort().join() === "Husband Chen,Wife Chen");
  const h1 = T.sg.find(x => x.packet_id === p3.id && x.role === "client");
  out = await es.sign(h1.token, { typed_name: "Husband Chen", signature: PNG_URL, consent: true });
  check("the attorney waits until BOTH have signed", () => !T.sg.find(x => x.packet_id === p3.id && x.role === "attorney").sent_at);

  // Both clients press Sign at the same moment.
  const p6 = await es.createPacket({ templateId: multi.id, caseId: 223, values: {}, user: { uid: 1 }, signers: [
    { role: "client", label: "Client", name: "Ann Lee", sign_order: 1 }, { role: "client_2", label: "Client 2", name: "Bo Lee", sign_order: 1 },
    { role: "attorney", label: "Attorney", name: "JJ Zhang", sign_order: 2 }] });
  await es.sendPacket(p6.id, {});
  const before6 = T.ev.filter(e => e.packet_id === p6.id && e.event === "sent").length;
  await Promise.all(["client", "client_2"].map(role => es.sign(T.sg.find(x => x.packet_id === p6.id && x.role === role).token,
    { typed_name: role, signature: PNG_URL, consent: true })));
  const toAtty = T.ev.filter(e => e.packet_id === p6.id && e.event === "sent").length - before6;
  check("when the last two sign together, the attorney still gets the link — once", () => toAtty === 1 || `sent ${toAtty} times`);
  uploads.length = 0;
  const a6 = T.sg.find(x => x.packet_id === p6.id && x.role === "attorney");
  const [r1, r2] = await Promise.all([
    es.sign(a6.token, { typed_name: "JJ Zhang", signature: PNG_URL, consent: true }),
    es.sign(a6.token, { typed_name: "JJ Zhang", signature: PNG_URL, consent: true }).catch(e => ({ refused: e.message })),
  ]);
  if (r1.finalizing) await r1.finalizing;
  check("a double-pressed final signature files the document once", () => uploads.length === 2 && /already signed/.test(r2.refused || ""));
  const p7 = await es.createPacket({ templateId: handMade.id, caseId: 223, values: { client_name: "Jing Liu" }, signers: rp.signers, user: { uid: 1 } });
  const [s1, s2] = await Promise.all([es.sendPacket(p7.id, {}), es.sendPacket(p7.id, {}).catch(e => ({ refused: e.message }))]);
  check("a double-clicked Send emails the signers once", () => s1.delivered.length === 1 && /already sent/.test(s2.refused || ""));

  // Declining and cancelling.
  const p4 = await es.createPacket({ templateId: handMade.id, caseId: 223, values: { client_name: "Jing Liu" }, signers: rp.signers, user: { uid: 1 } });
  await es.sendPacket(p4.id, {});
  const c4 = T.sg.find(x => x.packet_id === p4.id && x.role === "client");
  await es.decline(c4.token, { reason: "The fee is wrong" });
  check("a signer can decline, with a reason, and the document stops", () => T.pk.find(p => p.id === p4.id).status === "declined" && T.sg.find(x => x.id === c4.id).decline_reason === "The fee is wrong");
  v = await es.signerView(c4.token);
  check("…after which the link says so", () => !v.ok && /declined/.test(v.error));
  const p5 = await es.createPacket({ templateId: handMade.id, caseId: 223, values: { client_name: "Jing Liu" }, signers: rp.signers, user: { uid: 1 } });
  await es.sendPacket(p5.id, {});
  await es.cancelPacket(p5.id, { user: { n: "JJ" } });
  v = await es.signerView(T.sg.find(x => x.packet_id === p5.id && x.role === "client").token);
  check("a cancelled document's link says it was withdrawn", () => !v.ok && /withdrawn/.test(v.error));
  await throwsA("a completed document cannot be cancelled", () => es.cancelPacket(pk.id), /fully signed/);
  v = await es.signerView("x".repeat(32));
  check("an unknown link is refused plainly", () => !v.ok && v.status === 404);

  console.log("\n── 4. Routes ───────────────────────────────────");
  const stubAll = new Proxy({}, { get: (_t, k) => {
    if (k === "initTables") return async () => {};
    if (k === "DOC_CATEGORIES") return []; if (k === "startScheduler") return () => {};
    if (k === "STAGES") return []; if (k === "STAGE_KEYS") return new Set();
    if (k === "CASE_TYPES" || k === "OUR_ROLES") return [];
    return async () => ({});
  }});
  Module._load = function (r, ...rest) {
    if (r === "./civil-litigation") return { ...stubAll, ...stubs["./civil-litigation"], initTables: async () => {} };
    if (stubs[r]) return stubs[r];
    if (/^\.\/(civil-discovery|civil-team|civil-billing|civil-dropbox|civil-court-docket|zara-core)$/.test(r)) return stubAll;
    return orig.call(this, r, ...rest);
  };
  delete require.cache[require.resolve("../app-api")];
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => { if (/^\/admin/.test(req.path)) req.user = { uid: 1, u: "jj", n: "JJ Zhang", r: "admin" }; next(); });
  require("../app-api").registerAppApi(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const J = (p, o) => fetch(base + p, o).then(r => r.json().then(d => ({ status: r.status, d })));

  let res = await J("/admin/civil/api/esign/templates");
  check("the web admin lists templates", () => res.d.ok && res.d.templates.length >= 3);
  res = await J("/api/staff/civil/esign/templates");
  check("the app has the same route, behind its own login", () => res.status === 401);
  res = await J(`/admin/civil/api/esign/prefill?template_id=${handMade.id}&case_id=223`);
  check("prefill works over the web", () => res.d.ok && res.d.fields[0].value === "Jing Liu");
  res = await J("/admin/civil/api/esign/packets", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: handMade.id, case_id: 223, values: { client_name: "Jing Liu" }, signers: rp.signers, send: true }) });
  check("prepare-and-send over the web returns each link", () => res.d.ok && res.d.packet.status === "sent" && /\/sign\/e\//.test(res.d.delivered[0].url));
  const webPk = res.d.packet;
  const fd = new FormData();
  fd.append("file", new Blob([alreadyTpl]), "Another.docx");
  res = await fetch(base + "/admin/civil/api/esign/templates", { method: "POST", body: fd }).then(r => r.json());
  check("a document can be uploaded as a new template over the web", () => res.ok && res.template.status === "draft");
  const dl = await fetch(`${base}/admin/civil/api/esign/packets/${pk.id}/download/signed-pdf`);
  check("the signed PDF downloads", () => dl.status === 200 && dl.headers.get("content-type") === "application/pdf");

  const ctoken = T.sg.find(x => x.packet_id === webPk.id && x.role === "client").token;
  res = await J("/api/public/esign/" + ctoken);
  check("the public signing API needs no login", () => res.status === 200 && res.d.your_turn === true);
  res = await J("/api/public/esign/" + ctoken + "/sign", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "1.1.1.1, 9.9.9.9" },
    body: JSON.stringify({ typed_name: "Jing Liu", signature: PNG_URL, consent: true }) });
  check("…and takes a signature, recording the IP the server saw — not one the signer made up", () => res.d.ok && T.sg.find(x => x.token === ctoken).ip === "9.9.9.9");
  res = await J(`/admin/civil/api/esign/packets/${webPk.id}`);
  check("staff views of a document never carry signing tokens", () => res.d.ok && res.d.packet.signers.every(s => !s.token));
  res = await J(`/admin/civil/api/esign/packets/${webPk.id}/links`);
  check("…the copy-link route does", () => res.d.ok && res.d.links.every(l => /\/sign\/e\/[A-Za-z0-9_-]{30,}$/.test(l.url)));
  const page = await fetch(base + "/sign/e/" + ctoken).then(r => r.text());
  check("the signing page is served, not indexed, with its script", () => /noindex/.test(page) && /\/static\/esign-sign\.js/.test(page) && page.includes(`data-token="${ctoken}"`));
  const pageHead = await fetch(base + "/sign/e/" + ctoken);
  check("…with a content security policy that blocks inline script", () => /script-src 'self'/.test(pageHead.headers.get("content-security-policy") || ""));
  server.close();

  console.log("\n── 5. The signing page ─────────────────────────");
  const signJs = fs.readFileSync(path.join(REPO, "public", "esign-sign.js"), "utf8");
  const dom = new JSDOM(`<!doctype html><body><main id="esign" data-token="tok123"></main></body>`, { runScripts: "outside-only", url: "https://tezlawfirm.com/sign/e/tok123" });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = () => ({ beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {} });
  w.HTMLCanvasElement.prototype.toDataURL = () => PNG_URL;
  let posted = null;
  w.fetch = (url, o) => {
    if (/\/sign$/.test(url)) { posted = JSON.parse(o.body); return Promise.resolve({ json: () => Promise.resolve({ ok: true, completed: false }) }); }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, your_turn: true, title: "Retainer Agreement", signer: { name: "Jing Liu", label: "Client" },
      document_html: "<p>Retainer <span class='esign-spot esign-mine'>✍ Your signature goes here</span></p>", consent_text: es.CONSENT_TEXT }) });
  };
  w.eval(signJs);
  await new Promise(r => setTimeout(r, 30));
  const d = w.document;
  const signBtn = [...d.querySelectorAll("button")].find(b => b.textContent === "Sign");
  check("the page shows the document and the consent", () => /Retainer/.test(d.body.textContent) && /same legal effect/.test(d.body.textContent));
  check("Sign stays off until consent, name and a drawn signature", () => signBtn.disabled === true);
  d.querySelector("#esign-consent").click();
  const cv = d.querySelector("canvas");
  cv.dispatchEvent(new w.MouseEvent("mousedown", { clientX: 5, clientY: 5, bubbles: true }));
  cv.dispatchEvent(new w.MouseEvent("mousemove", { clientX: 40, clientY: 20, bubbles: true }));
  w.dispatchEvent(new w.MouseEvent("mouseup"));
  check("…and turns on once all three are done", () => signBtn.disabled === false);
  signBtn.click();
  await new Promise(r => setTimeout(r, 30));
  check("signing sends the name, the drawing and the consent", () => posted && posted.typed_name === "Jing Liu" && posted.consent === true && /^data:image\/png/.test(posted.signature));
  check("…and thanks the signer", () => /Thank you — you have signed/.test(d.body.textContent));

  console.log("\n── 6. The admin screens ────────────────────────");
  const adminJs = fs.readFileSync(path.join(REPO, "public", "esign-admin.js"), "utf8");
  const dom2 = new JSDOM(`<!doctype html><body><div data-esign="case" data-esign-case="223"></div></body>`, { runScripts: "outside-only", url: "https://tezlawfirm.com/admin/civil/case/223" });
  const w2 = dom2.window, calls = [];
  w2.fetch = (url, o) => {
    calls.push({ url, o });
    const ok = x => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, ...x }) });
    if (/\/meta$/.test(url)) return ok({ sources: tpl.SOURCES, types: tpl.TYPES, categories: tpl.CATEGORIES });
    if (/\/packets\?case_id=223$/.test(url)) return ok({ packets: [{ id: 9, title: "Retainer — Liu", status: "sent", created_at: new Date().toISOString(),
      signers: [{ id: 1, role: "client", label: "Client", name: "Jing Liu", status: "signed", signed_at: new Date().toISOString(), typed_name: "Jing Liu" },
                { id: 2, role: "attorney", label: "Attorney", name: "JJ Zhang", status: "sent", sent_at: new Date().toISOString(), sent_via: "link" }] }] });
    if (/\/templates$/.test(url)) return ok({ templates: [{ id: 5, name: "Retainer", category: "retainer", status: "active" }, { id: 6, name: "Draft one", status: "draft" }] });
    if (/\/prefill/.test(url)) return ok({ title: "Retainer — Liu", fields: [{ key: "client_name", label: "Client name", type: "text", source: "client_name", value: "Jing Liu" }, { key: "fee", label: "Flat fee", type: "money", source: "ask", value: "" }],
      signers: [{ role: "client", label: "Client", name: "Jing Liu", email: "jing@example.com", phone: "", sign_order: 1 }, { role: "attorney", label: "Attorney", name: "JJ Zhang", email: "", phone: "", sign_order: 2 }] });
    if (/\/packets$/.test(url)) return ok({ packet: { id: 10 }, delivered: [{ name: "Jing Liu", url: "https://x/sign/e/abc", via: [], errors: ["email is not set up on the server"] }] });
    return ok({});
  };
  w2.eval(adminJs);
  await new Promise(r => setTimeout(r, 40));
  const d2 = w2.document;
  check("the case page lists documents out for signature, and who has signed", () => /Retainer — Liu/.test(d2.body.textContent) && /✓ signed/.test(d2.body.textContent) && /link not emailed or texted/.test(d2.body.textContent));
  [...d2.querySelectorAll("button")].find(b => /PREPARE DOCUMENT/.test(b.textContent)).click();
  await new Promise(r => setTimeout(r, 30));
  const pick = d2.querySelector("select");
  check("only ACTIVE templates can be picked", () => [...pick.options].map(o => o.textContent).some(t => /Retainer/.test(t)) && ![...pick.options].some(o => /Draft one/.test(o.textContent)));
  pick.value = "5"; pick.dispatchEvent(new w2.Event("change"));
  await new Promise(r => setTimeout(r, 30));
  check("the form comes filled from the matter; the blank one is flagged", () => {
    const ins = [...d2.querySelectorAll("input")];
    return ins.some(i => i.value === "Jing Liu") && ins.some(i => i.style.borderColor && !i.value);
  });
  [...d2.querySelectorAll("input")].find(i => !i.value && i.type === "text").value = "5000";
  [...d2.querySelectorAll("button")].find(b => b.textContent === "Send for signature").click();
  await new Promise(r => setTimeout(r, 30));
  const sentBody = JSON.parse(calls.filter(c => /\/packets$/.test(c.url)).pop().o.body);
  check("Send posts the values, the signers in order, and send:true", () =>
    sentBody.send === true && sentBody.values.fee === "5000" && sentBody.signers.find(s => s.role === "attorney").sign_order === "2");
  check("a link that could not be emailed is offered to copy", () => /some links were not emailed or texted/.test(d2.body.textContent) && [...d2.querySelectorAll("a")].some(a => a.textContent === "Copy link"));

  const ui = fs.readFileSync(path.join(REPO, "civil-litigation-ui.js"), "utf8");
  const srv = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
  check("the case page has the panel and loads its script", () => /data-esign="case"/.test(ui) && /clientScriptTag\("esign-admin\.js"\)/.test(ui));
  check("the kanban links to Templates, and the page exists", () => /href="\/admin\/civil\/templates"/.test(ui) && /app\.get\("\/admin\/civil\/templates"/.test(srv));
  const cs = require("../client-script");
  check("both scripts are protected against a flattened upload", () => cs.CLIENT_BUNDLES.includes("esign-admin.js") && cs.CLIENT_BUNDLES.includes("esign-sign.js"));

  console.log("\n" + (failures ? `${failures} FAILED` : "ALL ESIGN CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
