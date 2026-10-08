// ============================================================
//  ad-cleanup.js — bring the published site in line with the ad rules
//
//  The October 2026 review of tezlawfirm.com (TEZ Advertising Compliance
//  Review) found older material still live that the rules do not allow:
//
//   · "free consultation" on most posts from Apr–Sep 2026 and on the old
//     visa pages, though some consultations carry a fee (Rule 7.1;
//     B&P § 6157.1);
//   · claims about results, skill and record — "high approval rates",
//     "95% Success Rate", "4000+ Clients", "proven track record",
//     "settlements and verdicts", "over a decade of experience",
//     "aggressive representation" (B&P § 6157.2(a)(5), § 6158, § 6158.1);
//   · Spanish help offered in a way that reads as the attorney speaking
//     Spanish (Rule 7.1, Comment [5]);
//   · Zara offered as "Chat with Zara 24/7" without saying it is automated.
//
//  This finds every instance, shows JJ exactly what would change, and only
//  then changes it — through Zara's WordPress login, the same one the
//  autoposter publishes with.
//
//   1. Dry run (/admin/ad-cleanup → "Check the site"): reads every
//      published post and page in raw form, works out each change, and
//      stores the plan. Nothing on the site changes.
//   2. Apply: for each planned item, reads the post again and changes it only
//      if it is byte for byte what the plan was made from — an edit made
//      since is never overwritten. The text before the change is kept here,
//      and WordPress keeps its own revision too.
//   3. Undo: puts back the text kept in step 2.
//   4. Every month (1st, 8:10 Pacific) the same check runs by itself and
//      tells JJ in Telegram if anything has drifted out of line. It never
//      applies anything on its own.
//
//  What changes, per post:
//   · the old author footer is replaced by today's (autoposter
//     getStaticFooter: firm, attorney, bar number, office city, the
//     past-results line);
//   · the "Why Choose Tez Law P.C." section is removed — it is where the
//     experience and advocacy claims live;
//   · any other sentence making one of those claims is removed (the whole
//     list item, if that is all it said);
//   · "free" is taken out of every consultation offer ("a free consultation"
//     → "a consultation", "consulta gratuita" → "consulta", 免费咨询 → 咨询);
//   · "Puede hablar español", "Hablamos español" and "· Español" in a
//     language list are removed: they read as the attorney speaking Spanish
//     (the new author box says Spanish help is from office staff instead).
//
//  Pages: the five 2024 visa pages (/niw/, /eb-1-visa/ … /eb-5-visa/) are
//  set back to draft, because their claims ("95% Success Rate", "4000+
//  Clients", "high approval rates", service in Hindi and Vietnamese, five
//  reviews with no disclaimer) are the page. The booking page's title loses
//  "Free". Other pages get only the word-level changes.
// ============================================================

const crypto = require("crypto");
const db = require("./db");

const WP = () => String(process.env.WP_URL || "https://tezlawfirm.com").replace(/\/+$/, "");
const AUTH = () => "Basic " + Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString("base64");
const sha = (s) => crypto.createHash("sha256").update(String(s || "")).digest("hex");

// ── What a post may no longer say ───────────────────────────
//
// Sentence rules: a sentence that matches one is removed. They are written
// about the FIRM ("our track record", "we fight aggressively"), so a news
// sentence about someone else ("legal experts say", "aggressive enforcement")
// is left alone.
const SENTENCE_RULES = [
  { id: "results", re: /\b(?:our|we\s+have\s+an?|we\s+have|high)\s+(?:approval|success|win)\s+rates?\b|\d+\s*%\s*(?:success|approval|win)\s+rate/i },
  { id: "results", re: /\b(?:our|we\s+have\s+a|with\s+a)\s+(?:proven\s+)?track\s+record\b|\bTrack\s+Record\s+of\s+Success\b/i },
  { id: "results", re: /\bProven\s+Advocacy\b|\bproven\s+(?:results?|record|success)\b/i },
  { id: "results", re: /\bsettlements\s+and\s+verdicts\b|\bwon\s+asylum\s+cases\b/i },
  { id: "results", re: /\b(?:we|we['’]ve|we\s+have|our\s+(?:team|firm|attorneys?|lawyers?))\b[^.!?<]{0,30}\bsuccessfully\s+(?:defended|secured|obtained|won|helped)\b/i },
  { id: "experience", re: /\b(?:over|more\s+than)\s+(?:a\s+)?decades?\s+of\s+experience\b/i },
  { id: "experience", re: /\b(?:our|let\s+our)\s+(?:highly\s+)?experienced\b|\bexperienced\s+(?:immigration\s+|legal\s+)?team\b|\bseasoned\s+attorneys\b/i },
  { id: "experience", re: /\baggressive\s+(?:legal\s+)?(?:advocacy|representation)\b|\bwe\s+(?:fight|move|advocate)\s+aggressively\b|\bfight\s+aggressively\b/i },
  { id: "experience", re: /\bfight\s+for\s+the\s+best\s+(?:possible\s+)?(?:outcome|result)|\bthe\s+best\s+possible\s+outcomes?\s+for\s+(?:you|every|each)/i },
  { id: "experience", re: /\bnationwide\s+immigration\s+team\b|\bWe\s+find\s+and\s+fix\s+them\s+first\b|\bexpert\s+legal\s+representation\b|\bour\s+(?:legal\s+)?experts?\b/i },
  { id: "experience", re: /\bmejor\s+resultado\s+(?:posible\s+)?para\s+(?:cada|usted|ti)\b|\btrayectoria\s+(?:comprobada|probada)\b|\brepresentaci[oó]n\s+agresiva\b|\bequipo\s+(?:de\s+inmigraci[oó]n\s+)?experimentado\b/i },
  { id: "experience", re: /最佳结果|最好的结果|最佳結果|最好的結果|(?:我们|我們|本所)[^。！？<]{0,15}(?:经验丰富|經驗豐富)/ },
  { id: "referral", re: /\bin\s+partnership,\s+can\s+connect\s+you\b|\boffers\s+services\s+through\s+a\s+trusted\s+personal\s+injury\s+attorney\b/i },
];

const WHY_CHOOSE = /Why\s+Choose\s+(?:Tez|TEZ)\b|Por\s+Qu[eé]\s+Elegir\s+(?:a\s+)?(?:Tez|TEZ)\b|(?:为什么|為什麼|为何|為何)选择\s*(?:Tez|TEZ)|(?:为什么|為什麼|为何|為何)選擇\s*(?:Tez|TEZ)/;

// Word-level replacements: [id, pattern, replacement].
const WORD_RULES = [
  ["free", /\b([Aa])\s+free\s+(?=initial\s+consultation)/g, "$1n "],
  ["free", /\bfree\s+(?=(?:initial\s+)?consultations?\b)/gi, ""],
  ["free", /\b(consultas?(?:\s+inicial(?:es)?)?)\s+(?:gratuitas?|gratis)\b/gi, "$1"],
  ["free", /免费(?=(?:初步)?咨询)/g, ""],
  ["free", /免費(?=(?:初步)?諮詢)/g, ""],
  ["spanish", /\s*·\s*(?:Puede\s+hablar\s+español|Hablamos\s+español|Se\s+habla\s+español)/gi, ""],
  ["spanish", /(English)\s*·\s*Español\b(?!\s*\()/g, "$1"],
  ["zara", /Chat with Zara(?! \((?:AI|automated))/g, "Chat with Zara (AI assistant)"],
];

// The 2024 visa pages: their claims are the page. Back to draft.
const DRAFT_PAGES = ["niw", "eb-1-visa", "eb-2-visa", "eb-3-visa", "eb-5-visa"];
const PAGE_TITLES = { "schedule-free-consultation": "Schedule a Consultation" };
const PAGE_PHRASES = [
  ["experts", /one of our legal experts will be in touch/gi, "someone from our office will be in touch"],
];

// ── The transform ───────────────────────────────────────────

function textOf(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
}

function detectLang(html) {
  const t = textOf(html);
  const cjk = (t.match(/[一-鿿]/g) || []).length;
  if (cjk > 80 && cjk / Math.max(1, t.length) > 0.2) return "zh";
  const es = (t.match(/\b(?:de|la|los|las|que|para|con|una|del|por|su|sus|es)\b/gi) || []).length;
  const en = (t.match(/\b(?:the|and|for|that|with|your|you|is|are|this|of)\b/gi) || []).length;
  return es > en * 1.2 ? "es" : "en";
}

// Split a block's inner HTML into sentences without cutting inside a tag or
// at an abbreviation ("Tez Law P.C.", "U.S.", "Esq.").
const ABBREV = /(?:^|[\s(>])(?:P\.C|U\.S|U\.S\.A|Esq|Inc|Mr|Mrs|Ms|Dr|No|St|Jr|Sr|vs|e\.g|i\.e|etc|[A-Z])\.$/;
function sentences(inner) {
  const out = [];
  let cur = "", inTag = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    cur += c;
    if (c === "<") { inTag = true; continue; }
    if (c === ">") { inTag = false; continue; }
    if (inTag || !/[.!?。！？]/.test(c)) continue;
    if (c === "." && ABBREV.test(cur.replace(/<[^>]*>/g, ""))) continue;
    // take closing quotes, brackets and closing tags with the sentence
    let j = i + 1;
    for (;;) {
      if (j < inner.length && /["'”’)\]]/.test(inner[j])) { j++; continue; }
      const close = inner.slice(j).match(/^<\/(?:a|strong|b|em|i|span)>/);
      if (close) { j += close[0].length; continue; }
      break;
    }
    if (j >= inner.length || /\s/.test(inner[j]) || /[。！？]/.test(c)) {
      cur += inner.slice(i + 1, j); out.push(cur); cur = ""; i = j - 1;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function matchesSentenceRule(text) {
  for (const r of SENTENCE_RULES) if (r.re.test(text)) return r.id;
  return null;
}

/** Remove the "Why Choose Tez Law" section: its heading through the next heading of the same or higher level. */
function dropWhyChoose(html, changes) {
  let s = html;
  for (let guard = 0; guard < 5; guard++) {
    const m = s.match(new RegExp("<h([2-4])[^>]*>(?:(?!</h\\1>)[\\s\\S])*?(?:" + WHY_CHOOSE.source + ")(?:(?!</h\\1>)[\\s\\S])*?</h\\1>"));
    if (!m) break;
    const lvl = Number(m[1]);
    const start = m.index;
    const after = start + m[0].length;
    const next = s.slice(after).search(new RegExp(`<h[1-${lvl}][\\s>]`));
    const end = next < 0 ? s.length : after + next;
    changes.push({ rule: "why-choose", before: textOf(s.slice(start, end)).slice(0, 400), after: "" });
    s = s.slice(0, start) + s.slice(end);
  }
  return s;
}

/** Remove claim sentences inside <p> and <li> blocks; drop the block if nothing real is left. */
function dropClaimSentences(html, changes) {
  return html.replace(/<(p|li)(\s[^>]*)?>([\s\S]*?)<\/\1>/g, (whole, tag, attrs, inner) => {
    if (/<(?:p|li|ul|ol|div|h\d)[\s>]/i.test(inner)) return whole;            // nested structure: leave it
    if (!SENTENCE_RULES.some(r => r.re.test(textOf(inner)))) return whole;
    const parts = sentences(inner);
    const keep = [], dropped = [];
    for (const p of parts) (matchesSentenceRule(textOf(p)) ? dropped : keep).push(p);
    if (!dropped.length) {
      // The claim spans sentence boundaries we could not split: drop the block.
      changes.push({ rule: "claim", before: textOf(inner).slice(0, 400), after: "" });
      return "";
    }
    const rest = keep.join("").replace(/^\s+/, "");
    const restText = textOf(rest);
    const labelOnly = !restText || (/[:：]\s*$/.test(restText)) || (restText.length < 30 && !/[.!?。！？]/.test(restText));
    changes.push({ rule: matchesSentenceRule(textOf(dropped.join(" "))) || "claim", before: textOf(dropped.join(" ")).slice(0, 400), after: labelOnly ? "" : "(rest of the paragraph kept)" });
    return labelOnly ? "" : `<${tag}${attrs || ""}>${rest}</${tag}>`;
  });
}

function wordRules(html, changes, rules = WORD_RULES) {
  let s = html;
  for (const [id, re, rep] of rules) {
    const ms = [...s.matchAll(re)];
    if (!ms.length) continue;
    const next = s.replace(re, rep);
    if (next === s) continue;
    for (const m of ms) {
      const a = Math.max(0, m.index - 40), b = Math.min(s.length, m.index + m[0].length + 40);
      const snip = s.slice(a, b);
      changes.push({ rule: id, before: textOf(snip), after: textOf(snip.replace(new RegExp(re.source, re.flags), rep)) });
    }
    s = next;
  }
  return s;
}

/** Split off the old author footer, if there is one: { body, footer, rest } or null. */
function splitFooter(html) {
  const ap = require("./autoposter");
  const body = ap.stripFooter(html);
  if (body.length === html.length) return null;
  const tail = html.slice(body.length);
  const a = tail.indexOf("</aside>");
  if (a < 0) return null;
  let rest = tail.slice(a + 8);
  const disc = rest.match(/^\s*(?:<\/p>\s*)?<p[^>]*font-size:\s*12px[^>]*>[\s\S]*?<\/p>/i);
  if (disc) rest = rest.slice(disc[0].length);
  return { body, footer: tail.slice(0, tail.length - rest.length), rest };
}

/**
 * Work out the new content of one post. Pure: no network.
 * Returns { content, changes: [{ rule, before, after }] }.
 */
function transformPost(raw, { title = "", lang = null } = {}) {
  const changes = [];
  const parts = splitFooter(raw);
  let body = parts ? parts.body : raw;
  const L = lang || detectLang(body);

  body = dropWhyChoose(body, changes);
  body = dropClaimSentences(body, changes);
  body = wordRules(body, changes);

  let content = body;
  if (parts) {
    const fresh = require("./autoposter").getStaticFooter(title, L);
    if (fresh.trim() !== parts.footer.trim()) changes.push({ rule: "footer", before: "old author box and disclaimer", after: `today's author box (${L})` });
    content = body + fresh + parts.rest;
  }
  return { content: changes.length ? content : raw, changes, lang: L };
}

/** Work out what happens to one page. Pure. Returns { action, content?, title?, changes }. */
function transformPage(page) {
  const slug = page.slug;
  const changes = [];
  if (DRAFT_PAGES.includes(slug)) {
    changes.push({ rule: "unpublish", before: `published: ${page.link}`, after: "draft (claims of success rates, client counts, track record; reviews with no disclaimer)" });
    return { action: "draft", changes };
  }
  const out = { action: "none", changes };
  if (PAGE_TITLES[slug] && textOf(page.title) !== PAGE_TITLES[slug]) {
    changes.push({ rule: "free", before: textOf(page.title), after: PAGE_TITLES[slug] });
    out.title = PAGE_TITLES[slug];
  }
  const raw = page.content;
  let c = wordRules(raw, changes, WORD_RULES.concat(PAGE_PHRASES));
  if (c !== raw) out.content = c;
  if (out.title || out.content !== undefined) out.action = "update";
  return out;
}

// ── WordPress ───────────────────────────────────────────────

async function wp(method, path, body = null) {
  const axios = require("axios");
  const r = await axios({ method, url: WP() + "/wp-json" + path, data: body,
    headers: { Authorization: AUTH(), "Content-Type": "application/json", "User-Agent": "TEZ Law Firm ad-cleanup" },
    timeout: 60000, validateStatus: () => true });
  if (r.status === 401 || r.status === 403) throw new Error(`WordPress refused Zara's login (HTTP ${r.status})`);
  if (r.status >= 300) throw new Error(`WordPress ${method} ${path}: HTTP ${r.status}`);
  return { data: r.data, headers: r.headers };
}

async function fetchAll(type) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const { data, headers } = await wp("get", `/wp/v2/${type}?status=publish&per_page=50&page=${page}&context=edit&_fields=id,slug,link,title,content,modified_gmt`);
    for (const p of data) out.push({ type, id: p.id, slug: p.slug, link: p.link, title: (p.title && (p.title.raw ?? p.title.rendered)) || "", content: (p.content && (p.content.raw ?? "")) || "", modified: p.modified_gmt });
    const pages = Number(headers["x-wp-totalpages"] || 1);
    if (page >= pages) break;
  }
  return out;
}

async function fetchOne(type, id) {
  const { data: p } = await wp("get", `/wp/v2/${type}/${id}?context=edit&_fields=id,slug,link,title,content,status,modified_gmt`);
  return { type, id: p.id, slug: p.slug, link: p.link, status: p.status, title: (p.title && (p.title.raw ?? "")) || "", content: (p.content && (p.content.raw ?? "")) || "" };
}

// ── The plan, stored ────────────────────────────────────────

let ready = null;
function initTables() {
  ready = ready || db.query(`
    CREATE TABLE IF NOT EXISTS ad_cleanup_runs (
      id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), status TEXT NOT NULL DEFAULT 'planning',
      summary JSONB, error TEXT, applied_at TIMESTAMPTZ, undone_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS ad_cleanup_items (
      id SERIAL PRIMARY KEY, run_id INTEGER REFERENCES ad_cleanup_runs(id) ON DELETE CASCADE,
      wp_type TEXT, wp_id INTEGER, slug TEXT, title TEXT, link TEXT, action TEXT,
      before_hash TEXT, before_content TEXT, after_content TEXT, new_title TEXT, old_title TEXT,
      changes JSONB, result TEXT, applied_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS ad_cleanup_items_run ON ad_cleanup_items(run_id);`).catch(e => { ready = null; throw e; });
  return ready;
}

let busy = false;

async function plan({ fetch = fetchAll } = {}) {
  await initTables();
  if (busy) throw new Error("A check or an apply is already running");
  busy = true;
  const run = (await db.query(`INSERT INTO ad_cleanup_runs (status) VALUES ('planning') RETURNING id`)).rows[0].id;
  try {
    const posts = await fetch("posts");
    const pages = await fetch("pages");
    const counts = {};
    let items = 0;
    for (const p of posts) {
      const t = transformPost(p.content, { title: p.title });
      if (!t.changes.length) continue;
      for (const c of t.changes) counts[c.rule] = (counts[c.rule] || 0) + 1;
      items++;
      await db.query(`INSERT INTO ad_cleanup_items (run_id, wp_type, wp_id, slug, title, link, action, before_hash, before_content, after_content, changes)
        VALUES ($1,'posts',$2,$3,$4,$5,'update',$6,$7,$8,$9::jsonb)`,
        [run, p.id, p.slug, p.title, p.link, sha(p.content), p.content, t.content, JSON.stringify(t.changes)]);
    }
    for (const p of pages) {
      const t = transformPage(p);
      if (t.action === "none") continue;
      for (const c of t.changes) counts[c.rule] = (counts[c.rule] || 0) + 1;
      items++;
      await db.query(`INSERT INTO ad_cleanup_items (run_id, wp_type, wp_id, slug, title, link, action, before_hash, before_content, after_content, new_title, old_title, changes)
        VALUES ($1,'pages',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [run, p.id, p.slug, p.title, p.link, t.action, sha(p.content), p.content, t.content === undefined ? null : t.content, t.title || null, p.title, JSON.stringify(t.changes)]);
    }
    const summary = { posts: posts.length, pages: pages.length, items, counts };
    await db.query(`UPDATE ad_cleanup_runs SET status = 'planned', summary = $2::jsonb WHERE id = $1`, [run, JSON.stringify(summary)]);
    return { run, ...summary };
  } catch (e) {
    await db.query(`UPDATE ad_cleanup_runs SET status = 'failed', error = $2 WHERE id = $1`, [run, e.message]);
    throw e;
  } finally { busy = false; }
}

async function apply(runId, { fetchItem = fetchOne, write = wp, pause = 250 } = {}) {
  await initTables();
  if (busy) throw new Error("A check or an apply is already running");
  const run = (await db.query(`SELECT * FROM ad_cleanup_runs WHERE id = $1`, [runId])).rows[0];
  if (!run || run.status !== "planned") throw new Error(`Run ${runId} is not a plan waiting to be applied`);
  busy = true;
  await db.query(`UPDATE ad_cleanup_runs SET status = 'applying' WHERE id = $1`, [runId]);
  const tally = { changed: 0, skipped: 0, failed: 0 };
  try {
    const items = (await db.query(`SELECT * FROM ad_cleanup_items WHERE run_id = $1 AND result IS NULL ORDER BY id`, [runId])).rows;
    for (const it of items) {
      let result;
      try {
        const now = await fetchItem(it.wp_type, it.wp_id);
        if (sha(now.content) !== it.before_hash) result = "skipped: changed since the check";
        else if (it.action === "draft") { await write("post", `/wp/v2/pages/${it.wp_id}`, { status: "draft" }); result = "drafted"; }
        else {
          const body = {};
          if (it.after_content !== null && it.after_content !== undefined) body.content = it.after_content;
          if (it.new_title) body.title = it.new_title;
          await write("post", `/wp/v2/${it.wp_type}/${it.wp_id}`, body);
          result = "changed";
        }
      } catch (e) { result = "failed: " + e.message; }
      tally[result.startsWith("skipped") ? "skipped" : result.startsWith("failed") ? "failed" : "changed"]++;
      await db.query(`UPDATE ad_cleanup_items SET result = $2, applied_at = NOW() WHERE id = $1`, [it.id, result]);
      if (pause) await new Promise(r => setTimeout(r, pause));
    }
    await db.query(`UPDATE ad_cleanup_runs SET status = 'applied', applied_at = NOW(), summary = summary || $2::jsonb WHERE id = $1`, [runId, JSON.stringify({ applied: tally })]);
    return tally;
  } catch (e) {
    await db.query(`UPDATE ad_cleanup_runs SET status = 'planned', error = $2 WHERE id = $1`, [runId, e.message]);
    throw e;
  } finally { busy = false; }
}

async function undo(runId, { write = wp } = {}) {
  await initTables();
  if (busy) throw new Error("A check or an apply is already running");
  busy = true;
  const tally = { restored: 0, failed: 0 };
  try {
    const items = (await db.query(`SELECT * FROM ad_cleanup_items WHERE run_id = $1 AND result IN ('changed','drafted') ORDER BY id`, [runId])).rows;
    for (const it of items) {
      try {
        if (it.action === "draft") await write("post", `/wp/v2/pages/${it.wp_id}`, { status: "publish" });
        else {
          const body = { content: it.before_content };
          if (it.new_title) body.title = it.old_title;
          await write("post", `/wp/v2/${it.wp_type}/${it.wp_id}`, body);
        }
        await db.query(`UPDATE ad_cleanup_items SET result = 'undone' WHERE id = $1`, [it.id]);
        tally.restored++;
      } catch (e) { tally.failed++; }
    }
    await db.query(`UPDATE ad_cleanup_runs SET status = 'undone', undone_at = NOW() WHERE id = $1`, [runId]);
    return tally;
  } finally { busy = false; }
}

// ── The page JJ uses ────────────────────────────────────────

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const RULE_LABEL = {
  footer: "Old author box replaced with today's", "why-choose": "\"Why Choose Tez Law P.C.\" section removed",
  results: "Results or success claim removed", experience: "Experience or skill claim removed", claim: "Claim removed",
  referral: "Personal-injury referral wording removed", free: "\"Free\" taken out of a consultation offer",
  spanish: "Spanish line removed (it read as the attorney speaking Spanish)", zara: "Zara marked as an automated assistant",
  unpublish: "Page set back to draft", experts: "\"Legal experts\" wording changed",
};

async function latest() {
  await initTables();
  const run = (await db.query(`SELECT * FROM ad_cleanup_runs ORDER BY id DESC LIMIT 1`)).rows[0] || null;
  const items = run ? (await db.query(`SELECT id, wp_type, wp_id, title, link, action, changes, result FROM ad_cleanup_items WHERE run_id = $1 ORDER BY wp_type DESC, wp_id DESC`, [run.id])).rows : [];
  return { run, items };
}

function renderPage({ run, items }) {
  const s = (run && run.summary) || {};
  const counts = Object.entries(s.counts || {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(RULE_LABEL[k] || k)}</td><td style="text-align:right">${v}</td></tr>`).join("");
  const rows = items.map(it => {
    const ch = (it.changes || []).map(c => `<li><b>${esc(RULE_LABEL[c.rule] || c.rule)}</b>${c.before ? `: <span style="color:#8a2b0f">${esc(c.before)}</span>` : ""}${c.after && c.rule !== "footer" ? ` → <span style="color:#1d6b33">${esc(c.after)}</span>` : ""}</li>`).join("");
    return `<details style="border-top:1px solid #e8e3dc;padding:6px 0"><summary><span style="color:#6e645d">${esc(it.wp_type === "pages" ? "Page" : "Post")} ${it.wp_id}</span> · ${esc(it.title || it.link)} <span style="color:#6e645d">(${(it.changes || []).length} change${(it.changes || []).length === 1 ? "" : "s"}${it.result ? " · " + esc(it.result) : ""})</span></summary><p><a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.link)}</a></p><ul>${ch}</ul></details>`;
  }).join("");
  const status = !run ? "No check has been run yet." :
    run.status === "planning" ? "Checking the site… this page refreshes itself." :
    run.status === "planned" ? `Check #${run.id}: ${s.items} item(s) would change, out of ${s.posts} posts and ${s.pages} pages. Nothing has been changed yet.` :
    run.status === "applying" ? "Applying… this page refreshes itself." :
    run.status === "applied" ? `Check #${run.id} applied: ${JSON.stringify(s.applied || {})}. WordPress keeps the earlier version of every post too.` :
    run.status === "undone" ? `Check #${run.id} was undone.` : `Check #${run.id} failed: ${esc(run.error || "")}`;
  const busyNow = run && (run.status === "planning" || run.status === "applying");
  return `
<div style="max-width:980px;font-family:Montserrat,Arial,sans-serif;color:#2b2523">
<h1 style="font-family:'Cormorant Garamond',Georgia,serif">Advertising cleanup</h1>
<p>Brings older posts and pages on tezlawfirm.com in line with the October 2026 advertising review: no "free" consultation, no claims about results or experience, Spanish help shown as office-staff help, Zara marked as automated. First check, then read the list, then apply.</p>
<p style="background:#faf8f5;border-left:4px solid #ff7b00;padding:10px 14px">${status}</p>
<p>
 <button onclick="act('plan')" ${busyNow ? "disabled" : ""}>Check the site (changes nothing)</button>
 ${run && run.status === "planned" ? `<button onclick="act('apply', ${run.id})" style="margin-left:8px">Apply check #${run.id}</button>` : ""}
 ${run && run.status === "applied" ? `<button onclick="act('undo', ${run.id})" style="margin-left:8px">Undo check #${run.id}</button>` : ""}
</p>
${counts ? `<table style="border-collapse:collapse;margin:8px 0 16px">${counts}</table>` : ""}
${rows}
</div>
<script>
async function act(what, id) {
  if (what === 'apply' && !confirm('Change ' + ${JSON.stringify(String(s.items || 0))} + ' posts and pages on tezlawfirm.com now?')) return;
  if (what === 'undo' && !confirm('Put every changed post and page back the way it was?')) return;
  const r = await fetch('/admin/ad-cleanup/' + what, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ run: id || null }) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) alert(j.error || 'Failed'); else location.reload();
}
${busyNow ? "setTimeout(() => location.reload(), 5000);" : ""}
</script>`;
}

/**
 * The monthly check: the same dry run as the button, on the first of each
 * month at 8:10 Pacific. It changes nothing. If anything on the site has
 * drifted out of line — a page edited by hand, an old post someone revived —
 * JJ hears about it and decides on the page.
 */
async function monthlyCheck(tell, opts = {}) {
  if (busy) return null;
  const r = await plan(opts);
  if (r.items > 0) await tell(`⚖️ Monthly advertising check: ${r.items} post(s)/page(s) on tezlawfirm.com no longer match the ad rules (${Object.entries(r.counts).map(([k, v]) => `${RULE_LABEL[k] || k}: ${v}`).join("; ")}). Review and apply at /admin/ad-cleanup.`);
  return r;
}

function mount(app) {
  const auth = require("./auth");
  const guard = auth.requireRole("admin");
  initTables().catch(e => console.error("[ad-cleanup] tables:", e.message));
  const tell = (t) => { try { return require("./site-watch").tell(t); } catch (e) { return null; } };
  if (process.env.WP_APP_PASSWORD && process.env.AD_MONTHLY_CHECK !== "off") {
    import("node-cron").catch(() => ({ default: require("node-cron") })).then(({ default: cron }) => {
      cron.schedule("10 8 1 * *", () => monthlyCheck(tell).catch(e => tell(`⚖️ Monthly advertising check failed: ${e.message}`)), { timezone: "America/Los_Angeles" });
    }).catch(e => console.error("[ad-cleanup] schedule:", e.message));
  }

  app.get("/admin/ad-cleanup", guard, async (req, res) => {
    try { res.send(require("./hearing-notes").renderAdminChrome({ title: "Advertising cleanup", body: renderPage(await latest()), activeItem: null })); }
    catch (e) { res.status(500).send(`<h1>Error</h1><p>${esc(e.message)}</p>`); }
  });
  app.post("/admin/ad-cleanup/:what", guard, async (req, res) => {
    if (req.get("X-Requested-With") !== "fetch") return res.status(400).json({ ok: false, error: "bad request" });
    const what = req.params.what, run = Number((req.body || {}).run) || null;
    if (busy) return res.json({ ok: false, error: "A check or an apply is already running" });
    if (what === "plan") {
      plan().then(r => tell(`🧹 Advertising cleanup check #${r.run}: ${r.items} post(s)/page(s) would change. Review at /admin/ad-cleanup before applying.`))
        .catch(e => tell(`🧹 Advertising cleanup check failed: ${e.message}`));
      return res.json({ ok: true });
    }
    if (what === "apply" && run) {
      apply(run).then(t => tell(`🧹 Advertising cleanup #${run} applied: ${t.changed} changed, ${t.skipped} skipped (edited since the check), ${t.failed} failed.`))
        .catch(e => tell(`🧹 Advertising cleanup #${run} stopped: ${e.message}`));
      return res.json({ ok: true });
    }
    if (what === "undo" && run) {
      undo(run).then(t => tell(`🧹 Advertising cleanup #${run} undone: ${t.restored} restored, ${t.failed} failed.`))
        .catch(e => tell(`🧹 Undo of #${run} failed: ${e.message}`));
      return res.json({ ok: true });
    }
    res.status(400).json({ ok: false, error: "unknown action" });
  });
}

module.exports = {
  mount, plan, apply, undo, latest, renderPage, monthlyCheck,
  transformPost, transformPage, splitFooter, sentences, detectLang, textOf,
  SENTENCE_RULES, WORD_RULES, DRAFT_PAGES, PAGE_TITLES,
};
