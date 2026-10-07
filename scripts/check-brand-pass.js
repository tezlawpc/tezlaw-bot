/**
 * check-brand-pass.js
 *
 * JJ: "yes restyle them all and see if missed any of them."
 *
 * What was still outside the TEZ brand after the admin, the consultant
 * portal and the sign-in pages had been done:
 *   · every email the firm sends (the signing request was walnut-and-gold;
 *     most others were bare text)
 *   · the older signing page (/sign/<token>) and the newer one (/sign/e/…)
 *   · the "utility" colours every admin page had picked up — neutral greys,
 *     Material red/green/amber, a bright blue for links and buttons
 *   · the Matter Manager (its own check: check-matters-in-tara.js)
 *
 * This pins the parts that are wiring, and FAILS if one of the retired
 * palettes comes back. For the utility colours it only counts and reports:
 * a new page in the wrong grey is worth knowing about, not worth stopping a
 * deploy for.
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const REPO = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(REPO, f), "utf8");

let failed = 0;
const pending = [];
function check(name, fn) {
  const done = (ok, err) => { if (ok) console.log("  ok   " + name); else { failed++; console.log("  FAIL " + name + (err ? " — " + err.message : "")); } };
  try {
    const r = fn();
    if (r && typeof r.then === "function") pending.push(r.then(v => done(!!v), e => done(false, e)));
    else done(!!r);
  } catch (e) { done(false, e); }
}

(async () => {
  console.log("\nThe brand, everywhere it was missing\n");

  console.log("── 1. Email ────────────────────────────────────");
  const mail = require("../tez-email");
  const html = mail.wrap({ heading: "Please review & sign", body: mail.paragraphs("Line one\nLine two\n\nOpen https://tezlawfirm.com/x?a=1&b=2."), button: { href: "https://tezlawfirm.com/sign/e/abc", label: "Review and sign" }, note: "A <note>" });
  check("one wrapper for every email: charcoal band, orange rule, the lockup as a picture", () =>
    /bgcolor="#2B2523"/.test(html) && /border-bottom:3px solid #FF7B00/.test(html) && /<img src="[^"]+\/static\/brand\/tez-lockup-email\.png"[^>]*alt="TEZ Law Firm"/.test(html));
  check("the wordmark is the artwork — the picture is in the repo", () => fs.statSync(path.join(REPO, "public", "brand", "tez-lockup-email.png")).size > 2000);
  check("tables and inline styles only (mail apps strip the rest)", () => !/<style/i.test(html) && !/<svg/i.test(html) && !/class=/.test(html));
  check("what it is given is escaped; a web address becomes a link", () =>
    html.includes("Please review &amp; sign") && html.includes("A &lt;note&gt;") && html.includes('<a href="https://tezlawfirm.com/x?a=1&amp;b=2"') && html.includes("Line one<br>Line two"));
  check("the button is dark ink on Seal Orange", () => /background:#FF7B00;[^"]*"><a [^>]*color:#1E1B1A/.test(html));
  check("the public name in the footer, the legal name small beneath it", () => /TEZ Law Firm<\/span>/.test(html) && />Tez Law P\.C\.<\/span>/.test(html));
  for (const [file, what] of [["esign.js", "the signing request"], ["esign-pdf.js", "the signed copy"], ["signin-code.js", "the sign-in code"], ["notify.js", "case alerts"], ["paralegal.js", "the paralegal's notes"]]) {
    check(`${what} uses it (${file})`, () => /require\("\.\/tez-email"\)/.test(read(file)) && /\.wrap\(/.test(read(file)));
  }
  check("no email is sent as “Tez Law P.C.” to a client: the public name is TEZ Law Firm", () =>
    !/from:\s*`"Tez Law P\.C\."/.test(read("esign.js") + read("notify.js") + read("signin-code.js")));
  check("new blog posts carry the public name: the legal name appears once, where the writer is told both", () => {
    const a = read("autoposter.js");
    return (a.match(/Tez Law P\.C\./g) || []).length === 1 && /TEZ Law Firm \(legal name Tez Law P\.C\.\)/.test(a) && /\| TEZ Law Firm"/.test(a);
  });
  check("the writer is told all four offices, and that Flushing is immigration only", () =>
    /offices in West Covina, City of Industry and Newport Beach, and an office in Flushing, New York that handles immigration matters only/.test(read("autoposter.js")));
  check("the WeChat signature is Simplified Chinese under the public name", () => {
    const w = read("wechat-publish.js");
    return /TEZ律师事务所 · 626-678-8677/.test(w) && /房地产 · 商业诉讼 · 遗产规划/.test(w) && !/[產業訴遺僅參聯繫體]/.test(w);
  });
  check("JJ’s title is Founding Attorney everywhere: no server file says “managing attorney”", () => {
    const old = new RegExp("managing" + " attorney", "i");
    const skip = new Set(["node_modules", ".git"]);
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!skip.has(e.name)) walk(full); continue; }
        if (!/\.(js|json|html|md|txt|ejs)$/i.test(e.name) || e.name === "package-lock.json" || full === __filename) continue;
        if (old.test(fs.readFileSync(full, "utf8"))) hits.push(path.relative(REPO, full));
      }
    };
    walk(REPO);
    if (hits.length) throw new Error("still in: " + hits.join(", "));
    return true;
  });
  for (const f of ["intake.js", "web-intake.js", "analytics.js"]) {
    check(`${f}: its email is in the firm's colours`, () => !/#0C1C36|#B79C62|#3E2818|#B8891E/i.test(read(f)));
  }

  console.log("\n── 2. The app's own “send for signature” ───────");
  const appApi = read("app-api.js");
  check("it no longer calls a mail module that was never in the repo, or a package that is not installed", () =>
    !/require\("\.\/email-sender"\)/.test(appApi) && !/require\("twilio"\)/.test(appApi) && (appApi.match(/sendSigningLink\(/g) || []).length === 2);
  // Run sendSigningLink with a captured mailer and a captured Twilio call.
  const sent = [], texts = [];
  const orig = Module._load;
  Module._load = function (r, ...rest) {
    if (r === "nodemailer") return { createTransport: () => ({ sendMail: async m => { sent.push(m); } }) };
    if (r === "axios") return { post: async (url, body) => { texts.push({ url, body: String(body) }); return { data: {} }; } };
    return orig.call(this, r, ...rest);
  };
  const env = { ...process.env };
  Object.assign(process.env, { SMTP_HOST: "smtp.example", SMTP_USER: "office@tezlawfirm.com", SMTP_PASS: "x", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_PHONE_NUMBER: "+16265550000" });
  delete require.cache[require.resolve("../esign")];
  const es = require("../esign");
  const a = await es.sendSigningLink({ via: "email", name: "Li <Wang>", email: "li@example.com", title: "Retainer", url: "https://x/sign/tok", days: 14 });
  const b = await es.sendSigningLink({ via: "sms", phone: "(626) 555-0100", title: "Retainer", url: "https://x/sign/tok" });
  const c = await es.sendSigningLink({ via: "email", email: "", title: "Retainer", url: "https://x/sign/tok" });
  Module._load = orig;
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  check("an emailed link goes out in the firm's design, the name escaped", () =>
    a.status === "email_sent" && sent.length === 1 && /TEZ Law Firm/.test(sent[0].from) && sent[0].html.includes("Li &lt;Wang&gt;") &&
    sent[0].html.includes('href="https://x/sign/tok"') && /Hello Li <Wang>/.test(sent[0].text));
  check("a texted link goes through Twilio's API to the number in international form", () =>
    b.status === "sms_sent" && texts.length === 1 && /api\.twilio\.com/.test(texts[0].url) && /To=%2B16265550100/.test(texts[0].body));
  check("with nowhere to send it, it says so instead of failing", () => c.status === "not_sent" && c.error === null);

  console.log("\n── 3. The signing pages ────────────────────────");
  const server = read("server.js"), routes = read("esign-routes.js");
  const oldPage = server.slice(server.indexOf('app.get("/sign/:token"'), server.indexOf("// ── Triage Dashboard"));
  check("the older page (/sign/<token>) carries the shield and the firm's type", () =>
    /require\("\.\/tez-theme"\)\.SHIELD/.test(oldPage) && /require\("\.\/tez-theme"\)\.FONTS/.test(oldPage) && /Cormorant Garamond/.test(oldPage) && /Montserrat/.test(oldPage));
  check("…its heading is not the wordmark retyped", () => !/<h1>Tez Law P\.C\.<\/h1>/.test(oldPage) && /<title>Sign Document — TEZ Law Firm<\/title>/.test(oldPage));
  check("…and a signer may zoom the page", () => !/user-scalable=no/.test(oldPage));
  check("the newer page (/sign/e/<token>) is built from the same theme", () =>
    /theme\.CSS/.test(routes) && /theme\.SHIELD/.test(routes) && !/#3E2818|#F5EBD3|#B8891E|Cinzel/i.test(routes));
  const signJs = read("public/esign-sign.js");
  check("…and speaks Simplified Chinese as well as English", () => /zh: \{/.test(signJs) && signJs.includes("安全文件签署") && signJs.includes("完成并签署"));
  check("…with no Traditional characters in it", () => !/[簽檔資訊號碼聯絡電話這個為與於請將從來時說對會還沒後開關學國際點擊確認]/.test(signJs.replace(/[\u0000-\u007f]/g, "")) || !/[簽檔資訊號碼聯絡電話這個為與於將從來時說對會還沒後開關學國際點擊確認]/.test(signJs));

  console.log("\n── 4. The retired palettes stay retired ────────");
  const SKIP = new Set(["node_modules", ".git", "scripts", "assets", "vendor"]);
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out); else if (/\.(js|html)$/.test(e.name)) out.push(full);
    }
    return out;
  };
  // The audit portal is a separate product for another client, in its own colours; the two unused pages are not served.
  const NOT_OURS = new Set(["audit-ui.js", "audit-notify.js", "audit-taxonomy.js", "matters-parse.html", "paralegal-dashboard.html"]);
  const files = walk(REPO).filter(f => !NOT_OURS.has(path.basename(f)));
  const hits = (re) => files.filter(f => re.test(fs.readFileSync(f, "utf8"))).map(f => path.relative(REPO, f));
  for (const [name, re] of [
    ["navy and gold (#0C1C36, #B79C62)", /#0C1C36|#B79C62/i],
    ["walnut, gold and parchment (#3E2818, #5A3B22, #B8891E, #F5EBD3, #FBF3DE, #D4C4A0)", /#3E2818|#5A3B22|#B8891E|#F5EBD3|#FBF3DE|#D4C4A0/i],
    ["oxblood on newsprint (#7a1d1d, #f4f1ea)", /#7a1d1d|#f4f1ea/i],
    ["the old display faces (Cinzel, IM Fell, Inter Tight, JetBrains Mono)", /Cinzel|IM Fell|Inter Tight|JetBrains Mono/],
  ]) {
    const found = hits(re);
    check(`no ${name}` + (found.length ? ` — in ${found.slice(0, 5).join(", ")}` : ""), () => found.length === 0);
  }

  // Not a failure: a count, so a drift is seen.
  const UTILITY = /(?:color|background|border[a-z-]*)\s*:\s*[^;"'`]*?(#0061FF|#c62828|#2e7d32|#1976d2|#7c4dff|#4caf50|#f44336)\b/gi;
  const drift = files.map(f => [path.relative(REPO, f), (fs.readFileSync(f, "utf8").match(UTILITY) || []).length]).filter(x => x[1]);
  console.log(drift.length
    ? "  note  utility colours styling a page (use the brand's instead — tez-theme.js has them): " + drift.map(x => `${x[0]}×${x[1]}`).join(", ")
    : "  ok   no page is styled in the old utility colours (bright blue, Material red and green)");

  await Promise.all(pending);
  console.log(failed ? `\n${failed} FAILED\n` : "\nALL BRAND CHECKS PASSED\n");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
