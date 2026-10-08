// The advertising rules (ad-rules.js, ad-cleanup.js, ad-archive.js and the
// pieces of social posts, cards, videos, follow-up texts and the blog author
// box they govern). No network, no database: a stand-in db answers the few
// statements the cleanup and archive make.
const path = require("path");
const ROOT = path.join(__dirname, "..");
process.chdir(ROOT);
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log("  ok   " + label); } else { fail++; console.log("  FAIL " + label); } };

// ── stand-in database ──
const T = { runs: [], items: [], archive: [] };
const fakeDb = { query: async (q, a = []) => {
  q = q.replace(/\s+/g, " ").trim();
  if (/^CREATE /.test(q)) return { rows: [] };
  if (/^INSERT INTO ad_cleanup_runs/.test(q)) { const id = T.runs.length + 1; T.runs.push({ id, status: "planning", summary: null }); return { rows: [{ id }] }; }
  if (/^UPDATE ad_cleanup_runs SET status = 'planned', summary/.test(q)) { const r = T.runs.find(x => x.id === a[0]); r.status = "planned"; r.summary = JSON.parse(a[1]); return { rows: [] }; }
  if (/^UPDATE ad_cleanup_runs SET status = 'applying'/.test(q)) { T.runs.find(x => x.id === a[0]).status = "applying"; return { rows: [] }; }
  if (/^UPDATE ad_cleanup_runs SET status = 'applied'/.test(q)) { const r = T.runs.find(x => x.id === a[0]); r.status = "applied"; Object.assign(r.summary, JSON.parse(a[1])); return { rows: [] }; }
  if (/^UPDATE ad_cleanup_runs SET status = 'undone'/.test(q)) { T.runs.find(x => x.id === a[0]).status = "undone"; return { rows: [] }; }
  if (/^UPDATE ad_cleanup_runs SET status = '(failed|planned)', error/.test(q)) { const r = T.runs.find(x => x.id === a[0]); r.status = q.includes("'failed'") ? "failed" : "planned"; r.error = a[1]; return { rows: [] }; }
  if (/^SELECT \* FROM ad_cleanup_runs WHERE id/.test(q)) return { rows: T.runs.filter(x => x.id === a[0]) };
  if (/^INSERT INTO ad_cleanup_items/.test(q)) {
    const page = q.includes("'pages'") || a.length === 12;
    const it = page
      ? { id: T.items.length + 1, run_id: a[0], wp_type: "pages", wp_id: a[1], slug: a[2], title: a[3], link: a[4], action: a[5], before_hash: a[6], before_content: a[7], after_content: a[8], new_title: a[9], old_title: a[10], changes: JSON.parse(a[11]), result: null }
      : { id: T.items.length + 1, run_id: a[0], wp_type: "posts", wp_id: a[1], slug: a[2], title: a[3], link: a[4], action: "update", before_hash: a[5], before_content: a[6], after_content: a[7], new_title: null, old_title: null, changes: JSON.parse(a[8]), result: null };
    T.items.push(it); return { rows: [] };
  }
  if (/^SELECT \* FROM ad_cleanup_items WHERE run_id = \$1 AND result IS NULL/.test(q)) return { rows: T.items.filter(x => x.run_id === a[0] && x.result === null) };
  if (/^SELECT \* FROM ad_cleanup_items WHERE run_id = \$1 AND result IN/.test(q)) return { rows: T.items.filter(x => x.run_id === a[0] && ["changed", "drafted"].includes(x.result)) };
  if (/^UPDATE ad_cleanup_items SET result = \$2/.test(q)) { T.items.find(x => x.id === a[0]).result = a[1]; return { rows: [] }; }
  if (/^UPDATE ad_cleanup_items SET result = 'undone'/.test(q)) { T.items.find(x => x.id === a[0]).result = "undone"; return { rows: [] }; }
  if (/^INSERT INTO ad_archive/.test(q)) { T.archive.push({ post_id: a[0], channel: a[1], file: a[8], ext: a[9], dropbox_path: a[11] }); return { rows: [] }; }
  if (/^UPDATE ad_archive SET file = NULL/.test(q)) return { rows: [] };
  throw new Error("stand-in db: unexpected " + q.slice(0, 80));
} };
require.cache[require.resolve(path.join(ROOT, "db.js"))] = { id: "db", filename: "db", loaded: true, exports: fakeDb };

(async () => {
  delete process.env.SPANISH_STAFF;
  const R = require(path.join(ROOT, "ad-rules"));

  console.log("\n── Spanish help is offered as office-staff help, never as the attorney's (Rule 7.1, Comment [5])");
  const D = { en: "EN", es: "ES" };
  ok(R.spanishReady(), "Spanish help can be offered without a job title");
  ok(/personal de la oficina \(no es abogado\)/.test(R.spanishLine("es")) && /Nuestros abogados atienden en inglés, mandarín y shanghainés/.test(R.spanishLine("es")), "Spanish line: office staff, not an attorney; the attorneys' own languages");
  ok(/office staff \(not an attorney\)/.test(R.spanishChip("en")) && /办公室工作人员（非律师）/.test(R.spanishChip("zh")), "English and Chinese pieces say the same in their own language");
  ok(/^ES\nAtención en español: personal de la oficina/.test(R.videoDisclaimer("es", D)) && R.videoDisclaimer("en", D) === "EN", "the Spanish video's closing card says so; other videos are unchanged");
  process.env.SPANISH_STAFF = JSON.stringify({ en: "Case Manager", zh: "案件经理", es: "gerente de casos" });
  ok(/gerente de casos \(no es abogado\)/.test(R.spanishLine("es")) && R.spanishChip("zh").includes("案件经理"), "a title, if one is ever set, is used instead of 'office staff'");
  delete process.env.SPANISH_STAFF;

  console.log("\n── The post screen catches the review's claims, and only about the firm");
  const S = require(path.join(ROOT, "social-posts"));
  const bad = (t) => !S.screen(t).ok;
  ok(bad("Schedule a free consultation at tezlawfirm.com"), "free consultation");
  ok(bad("Programe una consulta gratuita hoy"), "consulta gratuita");
  ok(bad("欢迎预约免费咨询"), "免费咨询");
  ok(bad("Our experts can help with your filing"), "our experts");
  ok(bad("We pride ourselves on our high approval rates"), "approval rates");
  ok(bad("Our track record speaks for itself"), "track record");
  ok(bad("With over a decade of experience in immigration"), "decade of experience");
  ok(bad("We fight aggressively for every client"), "aggressive about the firm");
  ok(bad("Board certified specialist in immigration"), "specialist");
  ok(!bad("Legal experts say the rule faces challenges in court"), "news quoting legal experts passes");
  ok(!bad("USCIS approval rates fell in the second quarter"), "news about approval rates passes");
  ok(!bad("The administration has taken aggressive steps on enforcement"), "news about aggressive enforcement passes");

  console.log("\n── Videos in all three languages");
  const V = require(path.join(ROOT, "video-voice"));
  const langs = () => String(process.env.SOCIAL_VIDEO_LANGS || "zh,en,es").split(",").map(x => x.trim())
    .filter((l, i, a) => V.LANGS.includes(l) && a.indexOf(l) === i).filter(l => l !== "es" || R.spanishReady());
  ok(langs().join(",") === "zh,en,es", "default languages: zh,en,es");
  const spSrc = require("fs").readFileSync(path.join(ROOT, "social-posts.js"), "utf8");

  console.log("\n── Cards and videos");
  const smSrc = require("fs").readFileSync(path.join(ROOT, "social-media.js"), "utf8");
  ok(/const foot = "tezlawfirm\.com · 626-678-8677 · " \+ require\("\.\/ad-rules"\)\.OFFICE_CITY;/.test(smSrc) && R.OFFICE_CITY === "West Covina, CA", "card footer names West Covina, CA (B&P § 6157.2(b))");
  ok(!/"English · 普通话 · Español"/.test(smSrc), "English video footer no longer offers Spanish");
  const M = require(path.join(ROOT, "social-media"));
  const png = M.card({ eyebrow: "Immigration", title: "A title", points: ["One point"], lang: "en" });
  ok(Buffer.isBuffer(png) && png.length > 10000, "a card still renders");

  console.log("\n── The blog author box");
  const AP = require(path.join(ROOT, "autoposter"));
  for (const l of ["en", "zh", "es"]) {
    const f = AP.getStaticFooter("T", l);
    ok(!/Español \(support\)/.test(f) && /[(（](?:not an attorney|非律师|no abogado)[)）]/.test(f) && /West Covina, California/.test(f) && !/free consultation|consulta gratuita|免费咨询/i.test(f), `${l}: Spanish shown as office staff, office city named, no free consultation`);
  }

  console.log("\n── The blog gate and the daily site scan");
  const ci = (t) => AP.complianceIssues(t).length > 0;
  ok(ci("Contact us for a free consultation today.") && ci("Our track record speaks for itself.") && ci("With over a decade of experience, we help.") && ci("预约免费咨询"), "free consultation, track record, years of experience and 免费咨询 hold a post as a draft");
  ok(!ci("Legal experts say the rule will be challenged. USCIS approval rates fell. The administration's track record on fees is mixed."), "news about others does not");
  ok(AP.complianceIssues("Schedule a free consultation. Book a free consultation.").filter(x => /free consultation/.test(x)).length === 1, "each kind of problem is listed once");
  const apSrc = require("fs").readFileSync(path.join(ROOT, "autoposter.js"), "utf8");
  ok(/No claims about the firm's experience, record or skill/.test(apSrc) && /Do not offer help in any language other than English, Mandarin or Shanghainese/.test(apSrc), "the blog writer is told the same rules up front");

  console.log("\n── Follow-up texts");
  const dripSrc = require("fs").readFileSync(path.join(ROOT, "drip.js"), "utf8");
  const tpl = dripSrc.slice(dripSrc.indexOf("const DRIP_TEMPLATES"), dripSrc.indexOf("function getTemplate"));
  const msgs = [...tpl.matchAll(/message: "([^"]+)"/g)].map(m => m[1]);
  ok(msgs.length === 8, "eight messages");
  ok(msgs.every(m => !/free|speciali|reviewing your|miss yours|urgent|deadline|protect your case/i.test(m)), "no free consultation, specialist, 'reviewing your case' or deadline pressure");
  ok(msgs.filter(m => /automated assistant/.test(m)).length === 4, "Zara says she is automated in the first two of each set");
  ok(msgs.filter(m => /West Covina, CA/.test(m)).length === 2 && msgs.filter(m => /STOP/.test(m)).length === 4, "first message names the city; first and last offer STOP");

  console.log("\n── Site cleanup: posts");
  const C = require(path.join(ROOT, "ad-cleanup"));
  const oldFooter = AP.getStaticFooter("x", "en").replace("Schedule a consultation", "📞 Free Consultation").replace("<style>.tez-ab{", "<style>.tez-ab{ ");
  const v1 = '<style>.tez-ab{display:flex}</style>\n<aside class="tez-ab" aria-label="About the author"><div><div class="tez-ab-ctas"><a class="tez-cta1">📞 Free Consultation — 626-678-8677</a></div><div class="tez-ab-chat">💬 Chat with Zara 24/7</div><em>我們也會說中文 · Puede hablar español</em></div></aside>\n<p style="font-size:12px;color:#666;margin-top:20px;"><em>Disclaimer: Results may vary.</em></p>\n<p><script type="application/ld+json">{"@type":"Article"}</script></p>';
  const post =
    '<p>The rule changes on <strong>October 16</strong>. Legal experts say it will be challenged. The administration\'s track record on fees is mixed.</p>\n' +
    '<p>If you have questions, contact <a href="https://tezlawfirm.com/contact/">Tez Law P.C.</a> today for a free consultation and let our experienced team help you. U.S. employers should act early.</p>\n' +
    '<ul><li><strong>Proven Advocacy:</strong> We fight aggressively for our clients.</li><li>File Form I-129 on time.</li></ul>\n' +
    '<h2>Why Choose Tez Law P.C.</h2>\n<p>Tez Law P.C., based in West Covina, represents clients nationwide with over a decade of experience.</p>\n<h3>Our approach</h3><p>We win.</p>\n' +
    '<h2>Frequently Asked Questions</h2>\n<div class="faq-item"><h3>Is it free?</h3><p>Ask for a free initial consultation or call.</p></div>\n' + v1;
  const t = C.transformPost(post, { title: "A post" });
  const txt = C.textOf(t.content);
  ok(!/Why Choose|Our approach|We win|over a decade/.test(txt), "the Why Choose section goes, through its sub-headings, up to the next H2");
  ok(/Frequently Asked Questions/.test(txt), "the FAQ after it stays");
  ok(!/free consultation|free initial consultation|Free Consultation/i.test(txt) && /Ask for an initial consultation/.test(txt), "every 'free' consultation loses 'free'");
  ok(!/let our experienced team/.test(txt) && /U\.S\. employers should act early\./.test(txt), "the claim sentence goes; the next sentence (after U.S.) stays");
  ok(!/Proven Advocacy|fight aggressively/.test(txt) && /File Form I-129 on time\./.test(txt), "a list item that was only the claim goes; the others stay");
  ok(/Legal experts say it will be challenged\./.test(txt) && /administration's track record on fees is mixed/.test(txt), "news sentences about others stay");
  ok(/<script type="application\/ld\+json">\{"@type":"Article"\}<\/script>/.test(t.content), "the structured data after the footer stays");
  ok(t.content.includes(AP.getStaticFooter("A post", "en")) && !/Puede hablar|Chat with Zara 24\/7|Results may vary/.test(t.content), "the old author box and its disclaimer are replaced by today's");
  ok(t.changes.some(c => c.rule === "footer") && t.changes.some(c => c.rule === "why-choose") && t.changes.some(c => c.rule === "free"), "the changes are listed for review");
  const clean = AP.getStaticFooter("Clean", "en");
  const same = C.transformPost("<p>Plain news.</p>\n" + clean, { title: "Clean" });
  ok(same.changes.length === 0 && same.content === "<p>Plain news.</p>\n" + clean, "a post already in line is left byte for byte as it is");
  ok(C.sentences("Contact <a>Tez Law P.C.</a> today. Next one.").length === 2, "no split inside 'Tez Law P.C.'");
  const zh = C.transformPost("<p>立即联系我们，预约免费咨询。</p><p>我們提供清晰的法律指導——並為每位客戶爭取最佳結果。另一句。</p>", { title: "z" });
  ok(/预约咨询/.test(zh.content) && !/最佳結果/.test(zh.content) && /另一句/.test(zh.content), "Chinese: 免费 removed, the 最佳結果 sentence removed, the rest kept");
  const es = C.transformPost("<p>Programe una consulta gratuita hoy mismo.</p>", { title: "e" });
  ok(/una consulta hoy mismo/.test(es.content), "Spanish: 'consulta gratuita' → 'consulta'");

  console.log("\n── Site cleanup: pages");
  ok(C.transformPage({ slug: "eb-5-visa", title: "EB-5", content: "x" }).action === "draft", "an old visa page goes back to draft");
  const sch = C.transformPage({ slug: "schedule-free-consultation", title: "Schedule Free Consultation", content: "<p>Book</p>" });
  ok(sch.action === "update" && sch.title === "Schedule a Consultation" && sch.content === undefined, "the booking page loses 'Free' in its title only");
  const zhp = C.transformPage({ slug: "zh", title: "首页", content: '<div>普通话 · 上海话 · English · Español</div><a>Chat with Zara</a>' });
  ok(/普通话 · 上海话 · English<\/div>/.test(zhp.content) && /Chat with Zara \(AI assistant\)/.test(zhp.content), "language list loses Español; Zara marked as AI");
  const ty = C.transformPage({ slug: "thank-you", title: "Thank you", content: "<p>one of our legal experts will be in touch with you shortly.</p>" });
  ok(/someone from our office will be in touch/.test(ty.content), "thank-you page: no 'legal experts'");
  ok(C.transformPage({ slug: "about-us", title: "About", content: "<p>Clean.</p>" }).action === "none", "a clean page is not touched");

  console.log("\n── Check, apply, undo");
  const site = {
    posts: [{ type: "posts", id: 11, slug: "a", link: "L/a", title: "A", content: post },
            { type: "posts", id: 12, slug: "b", link: "L/b", title: "B", content: "<p>Plain.</p>" },
            { type: "posts", id: 13, slug: "c", link: "L/c", title: "C", content: "<p>Call for a free consultation.</p>" }],
    pages: [{ type: "pages", id: 21, slug: "niw", link: "L/niw", title: "NIW", content: "<p>95% Success Rate</p>" },
            { type: "pages", id: 22, slug: "schedule-free-consultation", link: "L/s", title: "Schedule Free Consultation", content: "<p>Book</p>" }],
  };
  const r = await C.plan({ fetch: async (type) => site[type].map(x => ({ ...x })) });
  ok(r.items === 4 && r.posts === 3 && r.pages === 2, "the check plans 4 items out of 3 posts and 2 pages");
  ok(site.posts[0].content === post, "the check changes nothing");
  const writes = [];
  site.posts[2].content = "<p>Edited by JJ since the check: call for a free consultation.</p>";
  const tally = await C.apply(r.run, { pause: 0,
    fetchItem: async (type, id) => ({ ...site[type].find(x => x.id === id) }),
    write: async (m, p, body) => { writes.push([p, body]); return { data: {} }; } });
  ok(tally.changed === 3 && tally.skipped === 1 && tally.failed === 0, "apply: 3 changed, the one edited since the check skipped");
  ok(writes.some(([p, b]) => p === "/wp/v2/pages/21" && b.status === "draft") && writes.some(([p, b]) => p === "/wp/v2/pages/22" && b.title === "Schedule a Consultation" && !("content" in b)), "the visa page drafted; the booking page retitled, content untouched");
  ok(writes.some(([p, b]) => p === "/wp/v2/posts/11" && !/free consultation/i.test(b.content)), "the post written without 'free consultation'");
  await C.apply(r.run, { pause: 0, fetchItem: async () => { throw new Error("x"); }, write: async () => ({}) }).then(() => ok(false, "a run applies once only"), () => ok(true, "a run applies once only"));
  const back = [];
  const u = await C.undo(r.run, { write: async (m, p, body) => { back.push([p, body]); return {}; } });
  ok(u.restored === 3 && back.some(([p, b]) => p === "/wp/v2/pages/21" && b.status === "publish") && back.some(([p, b]) => p === "/wp/v2/posts/11" && b.content === post) && back.some(([p, b]) => p === "/wp/v2/pages/22" && b.title === "Schedule Free Consultation"), "undo puts back the text, the status and the title");
  const told = [];
  const m1 = await C.monthlyCheck(async (t) => told.push(t), { fetch: async (type) => site[type].map(x => ({ ...x })) });
  ok(m1 && m1.items > 0 && told.length === 1 && /Monthly advertising check: \d+ post/.test(told[0]) && /\/admin\/ad-cleanup/.test(told[0]), "the monthly check reports drift in Telegram and applies nothing");
  ok(/Check the site \(changes nothing\)/.test(C.renderPage(await (async () => ({ run: T.runs[0], items: T.items }))())), "the admin page renders");

  console.log("\n── A copy of every ad (B&P § 6159.1)");
  const A = require(path.join(ROOT, "ad-archive"));
  const ups = [];
  const dbx = { uploadFile: async ({ path: p, buffer }) => { ups.push(p); return { path_display: p }; } };
  const k1 = await A.keep({ row: { id: 5, channel: "video", text: "t" }, buffer: Buffer.from("mp4"), ext: "mp4", done: { youtube: {} } }, { dbx });
  ok(k1.ok && ups.some(p => /\/TEZ Ad Archive\/\d{4}\/\d{4}-\d\d-\d\d_video_5\.mp4$/.test(p)) && ups.some(p => p.endsWith("_video_5.txt")), "video: file and words in the Dropbox archive");
  const k2 = await A.keep({ row: { id: 6, channel: "video" }, buffer: Buffer.from("mp4"), ext: "mp4" }, { dbx: null });
  ok(!k2.ok, "video with no Dropbox: reported not kept, so the stored copy stays");
  const k3 = await A.keep({ row: { id: 7, channel: "facebook", text: "t" }, buffer: Buffer.from("png"), ext: "png" }, { dbx: null });
  ok(k3.ok && T.archive.find(x => x.post_id === 7).file, "card with no Dropbox: kept in the table");
  ok(spSrc.includes('if (kept.ok) await db.query(`UPDATE social_posts SET media_file = NULL'), "the posted video is let go only once archived");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
