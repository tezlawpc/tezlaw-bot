/**
 * check-esign-upload.js
 *
 * JJ: "i want a upload signatory document and sent document for esign just
 * like dropbox esign function."
 *
 * esign-pdf.js lets the firm upload any PDF (or a scan), say who signs, put
 * signature / initials / date / name / text / checkbox fields on the pages,
 * and send it. This pins the parts that must not drift:
 *
 *   1. what may be uploaded, and what it becomes
 *   2. the fields and signers a browser sends are never trusted
 *   3. WHERE a mark lands — on upright, sideways and upside-down pages,
 *      with a crop box that does not start at the corner
 *   4. what a signer must fill in before a signature is accepted
 *   5. the wiring: routes, the vendored PDF viewer, the page's security
 *      policy, the two tests of "can the PDF font write this" agreeing
 *
 * The database side (draft → prepared → sent → signed → filed) is exercised
 * against a real Postgres by scripts/dbcheck.js.
 */
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const { PDFDocument, StandardFonts, degrees } = require("pdf-lib");

let failed = 0;
function check(name, fn) {
  try {
    const r = typeof fn === "function" ? fn() : fn;
    if (r && typeof r.then === "function") return r.then(v => report(name, v), e => report(name, false, e));
    report(name, r);
  } catch (e) { report(name, false, e); }
}
function report(name, okay, err) {
  if (okay) console.log("  ok   " + name);
  else { failed++; console.log("  FAIL " + name + (err ? " — " + err.message : "")); }
}
async function refuses(promiseOrFn, pattern, status) {
  try { await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn); return false; }
  catch (e) { return pattern.test(e.message) && (status == null || e.status === status); }
}

const pdf = require("../esign-pdf");
const read = f => fs.readFileSync(path.join(REPO, f), "utf8");

// A 1×1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PNG_URL = "data:image/png;base64," + PNG.toString("base64");

async function sample({ rotations = [0], crop = null, pages = null } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const r of (pages ? Array(pages).fill(0) : rotations)) {
    const p = doc.addPage([700, 900]);
    if (r) p.setRotation(degrees(r));
    if (crop) p.setCropBox(...crop);
    p.drawText("Agreement", { x: 100, y: 800, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

// Where a point of PDF space appears on screen (from the top-left of the
// displayed page), written out independently of esign-pdf.js: this is the
// transform a PDF viewer applies for /Rotate.
function toScreen(box, rot, x, y) {
  const x0 = box.x, y0 = box.y, x1 = box.x + box.width, y1 = box.y + box.height;
  if (rot === 90) return { X: y - y0, Y: x - x0 };
  if (rot === 180) return { X: x1 - x, Y: y - y0 };
  if (rot === 270) return { X: y1 - y, Y: x1 - x };
  return { X: x - x0, Y: y1 - y };
}
const near = (a, b) => Math.abs(a - b) < 0.01;

(async () => {
  console.log("\nUpload a document and send it for signature\n");

  console.log("── 1. What may be uploaded ─────────────────────");
  const plainPdf = await sample();
  const n1 = await pdf.normalize(plainPdf);
  check("a PDF is kept byte for byte", () => n1.kind === "pdf" && Buffer.compare(n1.pdf, plainPdf) === 0);
  check("…and its pages are measured as they are displayed", () => n1.pages.length === 1 && n1.pages[0].w === 700 && n1.pages[0].h === 900);
  const turned = await pdf.normalize(await sample({ rotations: [90, 270, 180], crop: [40, 50, 612, 792] }));
  check("a sideways page is measured sideways (crop box, then /Rotate)", () =>
    turned.pages[0].w === 792 && turned.pages[0].h === 612 && turned.pages[0].rotation === 90 &&
    turned.pages[1].rotation === 270 && turned.pages[2].w === 612 && turned.pages[2].h === 792);
  const pic = await pdf.normalize(PNG);
  check("a photo or scan becomes a one-page PDF", () => pic.kind === "png" && pic.pages.length === 1 && pdf.sniff(pic.pdf) === "pdf");
  check("a Word file is refused, with what to do instead", await refuses(pdf.normalize(Buffer.from("PK\u0003\u0004 not a pdf at all, a zip")), /Save As/, 415));
  check("an empty upload is refused", await refuses(pdf.normalize(Buffer.alloc(0)), /No file/));
  check("a broken PDF is refused in plain words", await refuses(pdf.normalize(Buffer.from("%PDF-1.7\nthis is not really a pdf")), /could not be read/));
  check("more pages than the limit is refused", await refuses(pdf.normalize(await sample({ pages: pdf.MAX_PAGES + 1 })), /pages/));

  console.log("\n── 2. Nothing from the browser is trusted ──────");
  const signers = pdf.cleanSigners([
    { name: "  Li   Wang ", email: "li@example.com", phone: "(626) 555-0100", sign_order: 1 },
    { name: "JJ Zhang", email: "", phone: "", sign_order: 2, role: "admin", token: "x" }]);
  check("signers get their spots from the server, in order (s1, s2 …)", () => signers.map(s => s.role).join() === "s1,s2" && !("token" in signers[1]));
  check("…names tidied, the phone in international form", () => signers[0].name === "Li Wang" && signers[0].phone === "+16265550100" && signers[1].email === null);
  check("a signer with no name is refused", () => { try { pdf.cleanSigners([{ name: "" }]); return false; } catch (e) { return /name/.test(e.message); } });
  check("a bad email is refused", () => { try { pdf.cleanSigners([{ name: "Li Wang", email: "li@" }]); return false; } catch (e) { return /email/.test(e.message); } });
  check("no signers at all is refused", () => { try { pdf.cleanSigners([]); return false; } catch (e) { return /at least one/.test(e.message); } });
  check("more signers than the limit is refused", () => {
    try { pdf.cleanSigners(Array(pdf.MAX_SIGNERS + 1).fill({ name: "Some One" })); return false; } catch (e) { return /signers/.test(e.message); }
  });
  const fields = pdf.cleanFields([
    { type: "signature", signer: 0, page: 0, x: 0.2, y: 0.5, w: 0.3, h: 0.05, id: "evil", required: false },
    { type: "text", signer: 1, page: 0, x: 0.95, y: 0.99, w: 0.3, h: 0.05, label: "  <b>Address</b> " },
    { type: "checkbox", signer: 0, page: 0, x: -3, y: 0.1, w: 0.02, h: 0.02 }], 2, 1);
  check("field ids are the server's, not the browser's", () => fields.map(f => f.id).join() === "f1,f2,f3");
  check("a signature can never be made optional", () => fields[0].required === true);
  check("a text box is required unless marked; a checkbox optional unless marked", () => fields[1].required === true && fields[2].required === false);
  check("a field pushed off the page is pulled back onto it", () => fields[1].x + fields[1].w <= 1.00001 && fields[1].y + fields[1].h <= 1.00001 && fields[2].x === 0);
  check("a label cannot carry markup", () => fields[1].label === "bAddress/b" || !/[<>]/.test(fields[1].label));
  for (const [what, bad, pattern] of [
    ["an unknown kind of field", { type: "script", signer: 0, page: 0, x: 0, y: 0, w: 0.1, h: 0.1 }, /unknown kind/],
    ["a field for a signer who does not exist", { type: "date", signer: 5, page: 0, x: 0, y: 0, w: 0.1, h: 0.1 }, /signers/],
    ["a field on a page that does not exist", { type: "date", signer: 0, page: 9, x: 0, y: 0, w: 0.1, h: 0.1 }, /page/],
    ["a field with no position", { type: "date", signer: 0, page: 0 }, /position/],
  ]) check(what + " is refused", () => { try { pdf.cleanFields([bad], 2, 1); return false; } catch (e) { return pattern.test(e.message); } });
  check("too many fields is refused", () => {
    try { pdf.cleanFields(Array(pdf.MAX_FIELDS + 1).fill({ type: "date", signer: 0, page: 0, x: 0, y: 0, w: 0.1, h: 0.1 }), 1, 1); return false; }
    catch (e) { return /fields/.test(e.message); }
  });
  const packet = { signers: [{ role: "s1", name: "Li Wang", status: "sent" }, { role: "s2", name: "JJ Zhang", status: "waiting" }],
    fields: [{ id: "f1", role: "s1", type: "signature", page: 0, x: .1, y: .1, w: .2, h: .05, required: true, label: null },
             { id: "f2", role: "s1", type: "text", page: 0, x: .1, y: .2, w: .2, h: .03, required: true, label: "Address" },
             { id: "f3", role: "s1", type: "checkbox", page: 0, x: .1, y: .3, w: .02, h: .02, required: true, label: null },
             { id: "f4", role: "s1", type: "initials", page: 0, x: .1, y: .4, w: .05, h: .03, required: true, label: null },
             { id: "f5", role: "s1", type: "name", page: 0, x: .1, y: .5, w: .2, h: .03, required: true, label: null },
             { id: "f6", role: "s2", type: "text", page: 0, x: .5, y: .2, w: .2, h: .03, required: true, label: "Private note" }],
    pages: [{ w: 612, h: 792, rotation: 0 }] };
  check("it cannot be sent until every signer has somewhere to sign", () => {
    try { pdf.readyToSend(packet); return false; } catch (e) { return /JJ Zhang has no signature field/.test(e.message); }
  });
  check("…and can once they do", () => {
    pdf.readyToSend({ ...packet, fields: packet.fields.concat([{ id: "f7", role: "s2", type: "signature", page: 0 }]) }); return true;
  });
  const view = pdf.viewFor(packet, packet.signers[0]);
  check("a signer gets their own fields in full", () => view.fields.filter(f => f.mine).length === 5 && view.needs.signature && view.needs.initials);
  check("…and of other signers' only where they are — no id, no label", () => {
    const o = view.fields.filter(f => !f.mine);
    return o.length === 1 && !("id" in o[0]) && !("label" in o[0]) && !JSON.stringify(o).includes("Private note");
  });

  console.log("\n── 3. Where a mark lands ───────────────────────");
  for (const rot of [0, 90, 180, 270]) {
    const doc = await PDFDocument.load(await sample({ rotations: [rot], crop: [40, 50, 612, 792] }));
    const page = doc.getPages()[0];
    const box = page.getCropBox();
    const flipped = rot === 90 || rot === 270;
    const W = flipped ? box.height : box.width, H = flipped ? box.width : box.height;
    const f = { x: 0.2, y: 0.7, w: 0.3, h: 0.05 };
    const at = pdf.place(page, f);
    // The four corners of upright content (w wide, h tall) drawn from `at`.
    const corner = (dx, dy) => { const p = pdf.offset(at, dx, dy); return toScreen(box, rot, p.x, p.y); };
    const bl = corner(0, 0), br = corner(at.w, 0), tl = corner(0, at.h), tr = corner(at.w, at.h);
    check(`a page turned ${rot}°: the box drawn is the box placed`, () =>
      near(tl.X, f.x * W) && near(tl.Y, f.y * H) && near(br.X, (f.x + f.w) * W) && near(br.Y, (f.y + f.h) * H));
    check(`…and reads upright (left to right, bottom to top) on screen`, () =>
      near(bl.Y, br.Y) && br.X > bl.X && near(bl.X, tl.X) && tl.Y < bl.Y && near(tr.X, br.X));
  }
  const three = await sample({ rotations: [0, 90, 270], crop: [40, 50, 612, 792] });
  const signedAt = new Date("2026-10-04T19:00:00Z");
  const stamped = await pdf.stamp({
    id: 1, pdf: three,
    signers: [{ id: 1, role: "s1", status: "signed", name: "Li Wang", typed_name: "王丽", signed_at: signedAt, signature_png: PNG, initials_png: PNG,
      field_values: { values: { t1: "123 Main St", t2: "阿卡迪亚", c1: true }, images: { __name: PNG.toString("base64"), t2: PNG.toString("base64") } } },
              { id: 2, role: "s2", status: "sent", name: "JJ Zhang" }],
    fields: [
      { id: "s", role: "s1", type: "signature", page: 0, x: .2, y: .6, w: .3, h: .05 }, { id: "i", role: "s1", type: "initials", page: 1, x: .8, y: .9, w: .08, h: .05 },
      { id: "d", role: "s1", type: "date", page: 0, x: .6, y: .6, w: .15, h: .03 }, { id: "n", role: "s1", type: "name", page: 2, x: .2, y: .7, w: .3, h: .03 },
      { id: "t1", role: "s1", type: "text", page: 1, x: .2, y: .3, w: .3, h: .03 }, { id: "t2", role: "s1", type: "text", page: 2, x: .2, y: .3, w: .3, h: .03 },
      { id: "c1", role: "s1", type: "checkbox", page: 0, x: .1, y: .4, w: .02, h: .016 },
      { id: "zz", role: "s2", type: "signature", page: 0, x: .2, y: .8, w: .3, h: .05 }, { id: "gone", role: "s1", type: "date", page: 7, x: 0, y: 0, w: .1, h: .1 }],
  });
  const after = await PDFDocument.load(stamped);
  check("every kind of field is stamped, on upright and sideways pages, without losing a page", () =>
    after.getPageCount() === 3 && stamped.length > three.length);
  check("the date a signer signed is written the American way, in Pacific time", () => pdf.dateOf(signedAt) === "10/04/2026");

  console.log("\n── 4. What a signer must fill in ───────────────");
  const me = packet.signers[0];
  const tryIt = (o) => { try { return pdf.checkSubmission(packet, me, o); } catch (e) { return e; } };
  const full = { typed_name: "Li Wang", initials: PNG_URL, values: { f2: "123 Main St", f3: true } };
  check("everything filled in is accepted", () => { const r = tryIt(full); return !(r instanceof Error) && r.saved.values.f2 === "123 Main St" && r.saved.values.f3 === true && Buffer.isBuffer(r.initials); });
  check("a required text box left empty is refused", () => /Fill in/.test(tryIt({ ...full, values: { f3: true } }).message || ""));
  check("a required checkbox left unticked is refused", () => /Tick/.test(tryIt({ ...full, values: { f2: "x" } }).message || ""));
  check("missing initials are refused", () => /initials/.test(tryIt({ ...full, initials: null }).message || ""));
  check("initials that are not a PNG are refused", () => /initials/.test(tryIt({ ...full, initials: "data:image/svg+xml;base64,AAAA" }).message || ""));
  check("someone else's field cannot be filled in", () => { const r = tryIt({ ...full, values: { ...full.values, f6: "mine now" } }); return !(r instanceof Error) && !("f6" in r.saved.values); });
  check("an answer in Chinese needs its picture (the PDF fonts cannot write it)", () =>
    tryIt({ ...full, values: { f2: "阿卡迪亚市", f3: true } }) instanceof Error);
  check("…and is accepted with it", () => { const r = tryIt({ ...full, values: { f2: "阿卡迪亚市", f3: true }, images: { f2: PNG_URL } }); return !(r instanceof Error) && !!r.saved.images.f2; });
  check("a name in Chinese on a name field needs its picture too", () => tryIt({ ...full, typed_name: "王丽" }) instanceof Error);
  check("…and is accepted with it", () => { const r = tryIt({ ...full, typed_name: "王丽", images: { __name: PNG_URL } }); return !(r instanceof Error) && !!r.saved.images.__name; });
  check("an oversized picture is refused", () => {
    const big = "data:image/png;base64," + Buffer.concat([PNG, Buffer.alloc(500 * 1024)]).toString("base64");
    return /too large/.test(tryIt({ ...full, typed_name: "王丽", images: { __name: big } }).message || "");
  });
  check("a typographic apostrophe is ordinary text (O\u2019Brien signs without a picture)", () => pdf.plain("O\u2019Brien \u2014 caf\u00e9") && !pdf.plain("\u738b"));
  check("a template document keeps a Chinese name's picture when one is sent, and never fails without", () =>
    pdf.nameImage("王丽", { __name: PNG_URL }).images.__name && pdf.nameImage("王丽", null) === null && pdf.nameImage("Li Wang", { __name: PNG_URL }) === null);

  console.log("\n── 5. The wiring ───────────────────────────────");
  const routes = read("esign-routes.js"), esign = read("esign.js"), signJs = read("public/esign-sign.js"), prepJs = read("public/esign-prepare.js");
  for (const r of ["/uploads`", "/documents`", "/packets/:id/pdf`", "/packets/:id/prepare`", "/packets/:id/discard`"]) {
    check(`the staff API has ${r.replace("`", "")}`, () => routes.includes("${P}" + r));
  }
  check("…all of them behind the sign-in, and writing ones closed to view-only accounts", () =>
    /app\.post\(`\$\{P\}\/uploads`, \.\.\.A, canWrite/.test(routes) && /app\.post\(`\$\{P\}\/packets\/:id\/prepare`, \.\.\.A, canWrite, packetGuard/.test(routes) &&
    /app\.get\(`\$\{P\}\/packets\/:id\/pdf`, \.\.\.A, packetGuard/.test(routes));
  check("a document that belongs to no client is its sender's (and an admin's or manager's)", () =>
    /return seesAll\(req\) \|\| mine\(req, p\);/.test(routes));
  check("the signer can read the document through their own link only", () => routes.includes('app.get("/api/public/esign/:token/pdf"'));
  check("the signing page's policy lets the PDF viewer's worker run, and nothing from elsewhere", () =>
    /script-src 'self'; worker-src 'self' blob:/.test(routes) && !/unsafe-eval/.test(routes) && /frame-ancestors 'none'/.test(routes));
  check("the two staff pages exist, for firm roles only", () =>
    routes.includes('app.get("/admin/esign", roles') && routes.includes('app.get("/admin/esign/prepare/:id", roles') && !/requireRole\([^)]*consultant/.test(routes));
  const vend = path.join(REPO, "public", "vendor", "pdfjs");
  check("the PDF viewer is in the repo, both halves", () => fs.statSync(path.join(vend, "pdf.min.mjs")).size > 100000 && fs.statSync(path.join(vend, "pdf.worker.min.mjs")).size > 500000);
  check("…with the character maps Chinese PDFs need, and the standard fonts", () =>
    fs.readdirSync(path.join(vend, "cmaps")).length > 100 && fs.readdirSync(path.join(vend, "standard_fonts")).length > 10);
  check("both pages load the viewer from this server, at one version", () => {
    const v = s => (s.match(/PDFJS_V = "([\d.]+)"/) || [])[1];
    return v(signJs) && v(signJs) === v(prepJs) && signJs.includes('"/static/vendor/pdfjs/"') && prepJs.includes('"/static/vendor/pdfjs/"');
  });
  check("the page and the server agree on what the PDF fonts can write", () => {
    const rx = s => (s.match(/\/\^\[\\x20-\\x7E[^\]]+\]\*\$\//) || [])[0];
    return rx(signJs) && rx(signJs) === rx(read("esign-pdf.js"));
  });
  const cs = require("../client-script");
  check("the new page script is protected against a flattened upload", () => cs.CLIENT_BUNDLES.includes("esign-prepare.js"));
  check("the sidebar has E-Signature, for everyone who can see clients", () => /href="\/admin\/esign" class="nav-link[^"]*" data-perm="clients\.read"/.test(read("hearing-notes.js")));
  check("a client's page and a matter's page offer the upload", () => /\/admin\/esign\?/.test(read("public/esign-admin.js")));
  check("text messages go through Twilio's API, not a package that is not installed", () => !/require\("twilio"\)/.test(esign));
  check("the signing request wears the firm's email design", () => /require\("\.\/tez-email"\)/.test(esign) && /mail\.wrap\(/.test(esign));
  const mail = require("../tez-email");
  const html = mail.wrap({ heading: "A <b>heading</b>", body: "<p>x</p>", button: { href: "https://example.com/?a=1&b=2", label: "Review and sign" }, note: "n" });
  check("…which escapes what it is given, and puts dark ink on the orange button", () =>
    html.includes("A &lt;b&gt;heading&lt;/b&gt;") && html.includes("a=1&amp;b=2") && /background:#FF7B00[^>]*>\s*<a [^>]*color:#1E1B1A/.test(html) &&
    html.includes("/static/brand/tez-lockup-email.png") && fs.existsSync(path.join(REPO, "public", "brand", "tez-lockup-email.png")));

  await new Promise(r => setTimeout(r, 20));
  console.log(failed ? `\n${failed} FAILED\n` : "\nALL UPLOAD-AND-SIGN CHECKS PASSED\n");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
