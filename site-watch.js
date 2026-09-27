// ============================================================
//  site-watch.js — Tez Law website & publishing watchdog
//  Sends JJ a Telegram alert when something on tezlawfirm.com or the
//  content pipeline needs attention. Quiet when everything is fine:
//  every alert is de-duplicated and "back to normal" is reported once.
//
//  Every 15 min  Site down / PHP critical error / slow / accidentally set
//                to "noindex" / robots.txt blocking Google / SEO snippet
//                switched off (schema, llms.txt, sitemap missing)
//  Daily 7:40    SSL certificate expiring; new WordPress administrator;
//                plugins installed, removed, switched on or off
//  Daily 9:00    Rule 7.1 scan of every post/page changed in the last day
//                (including edits made by hand in WordPress); posts held as
//                drafts; WeChat / social drafts waiting > 24 h; autoposter
//                silent for 2+ days; new monthly Visa Bulletin out
//  Monday 8:30   Weekly web digest + practice pages with stale "As of" dates
//
//  Env: WP_URL, WP_USER, WP_APP_PASSWORD, TELEGRAM_TOKEN, JJ_TELEGRAM_ID
//  Optional: SITE_WATCH_DISABLED=1
// ============================================================

const axios = require("axios");
const tls   = require("tls");
const db    = require("./db");

const SITE  = (process.env.WP_URL || "https://tezlawfirm.com").replace(/\/+$/, "");
const HOST  = SITE.replace(/^https?:\/\//, "");
const AUTH  = () => Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString("base64");
const UA    = { "User-Agent": "TezSiteWatch/1.0 (+https://tezlawfirm.com)" };

// Plugins whose status change matters (anything else is reported too, at lower priority)
const CRITICAL_PLUGINS = ["Yoast SEO", "WPCode Lite", "Code Snippets"];
const RISKY_PLUGINS    = ["WP File Manager"];
// Practice pages carrying "As of <Month YYYY>" items (page IDs on tezlawfirm.com)
const PRACTICE_PAGE_IDS = [340, 621, 649, 756, 765, 770, 876, 777, 786, 791, 900, 905, 798, 896, 685, 1466, 730, 2263, 2264, 2265, 2266, 2267];
const STALE_DAYS = 60;

// ── Telegram (plain text: a formatting error must never swallow an alert) ──
async function tell(text) {
  const token = process.env.TELEGRAM_TOKEN, chat = process.env.JJ_TELEGRAM_ID;
  console.log("[site-watch] " + text.split("\n")[0]);
  if (!token || !chat) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chat, text: text.substring(0, 4000), disable_web_page_preview: true }, { timeout: 15000 });
  } catch (e) { console.error("[site-watch] telegram failed:", e.message); }
}

// ── Small persistent state (one row per key) ──
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = db.query(`CREATE TABLE IF NOT EXISTS site_watch_state (
      key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ DEFAULT NOW())`).catch(e => { tableReady = null; throw e; });
  }
  return tableReady;
}
async function getState(key, fallback = null) {
  await ensureTable();
  const r = await db.query(`SELECT value FROM site_watch_state WHERE key = $1`, [key]);
  return r.rows.length ? r.rows[0].value : fallback;
}
async function setState(key, value) {
  await ensureTable();
  await db.query(`INSERT INTO site_watch_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, JSON.stringify(value)]);
}
// Alert at most once per `hours` for the same key
async function alertOnce(key, text, hours = 24) {
  const last = await getState("sent:" + key);
  if (last && Date.now() - last.at < hours * 3600 * 1000) return false;
  await tell(text);
  await setState("sent:" + key, { at: Date.now() });
  return true;
}

async function get(path, opts = {}) {
  const url = path.startsWith("http") ? path : SITE + path;
  const t0 = Date.now();
  const res = await axios.get(url, {
    timeout: opts.timeout || 25000, validateStatus: () => true, maxRedirects: 5,
    headers: { ...UA, ...(opts.auth ? { Authorization: `Basic ${AUTH()}` } : {}) },
    responseType: "text", transformResponse: [d => d],
  });
  return { status: res.status, body: String(res.data || ""), ms: Date.now() - t0, headers: res.headers };
}
async function wpJson(path) {
  const r = await get("/wp-json" + path, { auth: true });
  if (r.status === 401 || r.status === 403) {
    await alertOnce("wp-auth", `🔑 WordPress rejected Zara's login (HTTP ${r.status}).\nThe autoposter and site checks can't reach tezlawfirm.com until the application password is fixed.\nWordPress → Users → Profile → Application Passwords → create a new one, then update WP_APP_PASSWORD on Render.`, 12);
    throw new Error("wp auth " + r.status);
  }
  if (r.status !== 200) throw new Error(`wp ${path} HTTP ${r.status}`);
  return { data: JSON.parse(r.body), headers: r.headers };
}

// ─────────────────────────────────────────────────────────────
//  1. Site health (every 15 minutes)
// ─────────────────────────────────────────────────────────────
async function checkSiteHealth() {
  const problems = [];
  let home;
  try { home = await get("/?sw=" + Date.now()); }
  catch (e) { home = { status: 0, body: "", ms: 0, error: e.message }; }

  if (home.status !== 200) problems.push(["down", `Homepage is not loading (${home.status ? "HTTP " + home.status : home.error || "no response"}).`]);
  else {
    if (/There has been a critical error|Fatal error:|Parse error:/i.test(home.body)) problems.push(["php", "Homepage shows a PHP / WordPress critical error."]);
    if (/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(home.body)) problems.push(["noindex", "Homepage is set to NOINDEX — Google will drop the whole site. Check Settings → Reading → 'Discourage search engines' and Yoast."]);
    if (!/"LegalService"/.test(home.body)) problems.push(["snippet", "The Tez SEO pack snippet looks switched off (no law-firm schema on the homepage). WPCode may have disabled it after an error: Code Snippets → Tez SEO pack → Active."]);
    if (home.ms > 8000) problems.push(["slow", `Homepage took ${(home.ms / 1000).toFixed(1)} s to load.`]);
  }
  try {
    const robots = await get("/robots.txt");
    if (robots.status === 200 && /^\s*Disallow:\s*\/\s*$/im.test(robots.body)) problems.push(["robots", "robots.txt is blocking the whole site from search engines (Disallow: /)."]);
  } catch (e) { /* robots unreachable is covered by 'down' */ }
  if (home.status === 200) {
    try {
      const sm = await get("/sitemap_index.xml");
      if (sm.status !== 200 || !/page-sitemap/.test(sm.body)) problems.push(["sitemap", `Sitemap is broken (HTTP ${sm.status}). Google uses it to find new posts.`]);
    } catch (e) { problems.push(["sitemap", "Sitemap did not load."]); }
    try {
      const ll = await get("/llms.txt");
      if (ll.status !== 200 || !/^# Tez Law/.test(ll.body)) problems.push(["llms", "llms.txt (the AI-assistant guide) is missing."]);
    } catch (e) { /* minor */ }
  }

  // Samples for the weekly uptime figure
  const samples = await getState("health:samples", []);
  samples.push({ t: Date.now(), ok: home.status === 200 && !problems.some(p => p[0] === "php") });
  await setState("health:samples", samples.filter(s => Date.now() - s.t < 8 * 86400000));

  // Report changes only. "down" and "php" need two failed checks in a row (no alerts for a blip).
  const prev = await getState("health:problems", {});
  const now = {};
  for (const [key, text] of problems) now[key] = { text, count: (prev[key]?.count || 0) + 1, alerted: prev[key]?.alerted || false };
  const toAlert = Object.entries(now).filter(([k, v]) => !v.alerted && (!["down", "php", "slow"].includes(k) || v.count >= 2));
  if (toAlert.length) {
    await tell(`🚨 tezlawfirm.com needs attention:\n\n${toAlert.map(([, v]) => "• " + v.text).join("\n")}\n\n${SITE}`);
    for (const [k] of toAlert) now[k].alerted = true;
  }
  const recovered = Object.keys(prev).filter(k => prev[k].alerted && !now[k]);
  if (recovered.length) await tell(`✅ Fixed on tezlawfirm.com: ${recovered.map(k => prev[k].text.split(".")[0]).join("; ")}.`);
  await setState("health:problems", now);
}

// ─────────────────────────────────────────────────────────────
//  2. SSL certificate (daily)
// ─────────────────────────────────────────────────────────────
function certDaysLeft(host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect(443, host, { servername: host, timeout: 15000 }, () => {
      const c = s.getPeerCertificate(); s.end();
      if (!c || !c.valid_to) return reject(new Error("no certificate"));
      resolve(Math.floor((new Date(c.valid_to) - Date.now()) / 86400000));
    });
    s.on("error", reject); s.on("timeout", () => { s.destroy(); reject(new Error("tls timeout")); });
  });
}
async function checkSSL() {
  try {
    const days = await certDaysLeft(HOST);
    await setState("ssl:days", days);
    if (days <= 21) await alertOnce("ssl", `🔒 The SSL certificate for ${HOST} expires in ${days} day(s). If it lapses, browsers show a security warning and visitors leave. Check auto-renew in your hosting panel (cPanel → SSL/TLS Status).`, 24);
  } catch (e) { console.error("[site-watch] ssl:", e.message); }
}

// ─────────────────────────────────────────────────────────────
//  3. Security: administrators and plugins (daily)
// ─────────────────────────────────────────────────────────────
async function checkSecurity() {
  // Administrators
  try {
    const { data } = await wpJson("/wp/v2/users?roles=administrator&context=edit&per_page=100&_fields=id,username,name,email,registered_date");
    const admins = data.map(u => ({ id: u.id, username: u.username, name: u.name, email: u.email }));
    const prev = await getState("sec:admins");
    if (prev) {
      const added = admins.filter(a => !prev.some(p => p.id === a.id));
      const removed = prev.filter(p => !admins.some(a => a.id === p.id));
      if (added.length) await tell(`🛡️ NEW WordPress administrator on tezlawfirm.com:\n${added.map(a => `• ${a.username} (${a.name}, ${a.email})`).join("\n")}\n\nIf you didn't create it, remove it now: WordPress → Users, and change your password.`);
      if (removed.length) await tell(`🛡️ WordPress administrator removed: ${removed.map(a => a.username).join(", ")}.`);
    }
    await setState("sec:admins", admins);
  } catch (e) { console.error("[site-watch] admins:", e.message); }

  // Plugins
  try {
    const { data } = await wpJson("/wp/v2/plugins?_fields=plugin,name,status,version");
    const plugins = data.map(p => ({ plugin: p.plugin, name: p.name, status: p.status, version: p.version }));
    const prev = await getState("sec:plugins");
    if (prev) {
      const lines = [];
      for (const p of plugins) {
        const o = prev.find(x => x.plugin === p.plugin);
        if (!o) lines.push(`• Installed: ${p.name} (${p.status})`);
        else if (o.status !== p.status) lines.push(`• ${p.name}: ${o.status} → ${p.status}${CRITICAL_PLUGINS.includes(p.name) && p.status !== "active" ? "  ⚠️ SEO features depend on this" : ""}`);
      }
      for (const o of prev) if (!plugins.some(p => p.plugin === o.plugin)) lines.push(`• Removed: ${o.name}`);
      if (lines.length) await tell(`🧩 Plugin changes on tezlawfirm.com:\n${lines.join("\n")}\n\nIf you or your web person didn't do this, check WordPress → Plugins.`);
    }
    await setState("sec:plugins", plugins);
  } catch (e) { console.error("[site-watch] plugins:", e.message); }
}

// ─────────────────────────────────────────────────────────────
//  4. Content: Rule 7.1 scan, held drafts, approvals, autoposter pulse
// ─────────────────────────────────────────────────────────────
function textOnly(html) {
  let s = String(html || "");
  try { s = require("./autoposter").stripFooter(s); } catch (e) {}
  return s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
}
async function checkContent() {
  const since = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
  let complianceIssues;
  try { complianceIssues = require("./autoposter").complianceIssues; } catch (e) { complianceIssues = () => []; }

  // Rule 7.1 — anything published or edited in the last day, by the bot or by hand
  const flagged = [];
  for (const type of ["posts", "pages"]) {
    try {
      const { data } = await wpJson(`/wp/v2/${type}?modified_after=${since}&status=publish&per_page=100&context=edit&_fields=id,link,title,content`);
      for (const p of data) {
        const issues = complianceIssues(textOnly(p.content.raw) + " " + (p.title.raw || ""));
        if (issues.length) flagged.push(`• ${p.title.raw.substring(0, 70)}\n  ${issues[0]}\n  ${SITE}/wp-admin/post.php?post=${p.id}&action=edit`);
      }
    } catch (e) { console.error(`[site-watch] 7.1 scan ${type}:`, e.message); }
  }
  if (flagged.length) await alertOnce("r71:" + flagged.join("").length, `⚖️ Rule 7.1 check — live content with wording the State Bar cautions against:\n\n${flagged.slice(0, 8).join("\n\n")}${flagged.length > 8 ? `\n\n…and ${flagged.length - 8} more` : ""}`, 20);

  // Posts the autoposter held as drafts
  try {
    const { data } = await wpJson(`/wp/v2/posts?status=draft&per_page=50&context=edit&_fields=id,title,modified_gmt`);
    const old = data.filter(p => Date.now() - new Date(p.modified_gmt + "Z").getTime() > 24 * 3600 * 1000);
    if (old.length) await alertOnce("drafts", `📝 ${old.length} post draft(s) waiting for your review for over a day:\n${old.slice(0, 6).map(p => `• ${p.title.raw.substring(0, 70)}\n  ${SITE}/wp-admin/post.php?post=${p.id}&action=edit`).join("\n")}\n\nApprove (Publish) or trash them so the blog keeps moving.`, 48);
  } catch (e) { console.error("[site-watch] drafts:", e.message); }

  // WeChat and social drafts waiting for approval
  try {
    const q = async (sql) => { try { return (await db.query(sql)).rows[0]; } catch (e) { return null; } };
    const wc = await q(`SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest FROM wechat_posts WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours'`);
    const so = await q(`SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest FROM social_posts WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours'`);
    const parts = [];
    if (wc && wc.n) parts.push(`• ${wc.n} WeChat 公众号 article(s)`);
    if (so && so.n) parts.push(`• ${so.n} social post(s) (LinkedIn / Facebook / Instagram / Moments)`);
    if (parts.length) await alertOnce("approvals", `📣 Waiting for your approval for over a day:\n${parts.join("\n")}\n\nOld drafts lose their news value — approve or skip them in Telegram.`, 48);
  } catch (e) { console.error("[site-watch] approvals:", e.message); }

  // Autoposter pulse: nothing published for 2 days
  try {
    const after = new Date(Date.now() - 50 * 3600 * 1000).toISOString();
    const { headers } = await wpJson(`/wp/v2/posts?after=${after}&status=publish&per_page=1&_fields=id`);
    const n = parseInt(headers["x-wp-total"] || "0", 10);
    if (n === 0) await alertOnce("autoposter-silent", `🤖 No new blog posts in 2 days. The autoposter may be stuck (Render logs → "AUTO-POSTER"), or there was simply no news. You can start a run from the admin panel → "Run Auto-Poster Now".`, 48);
  } catch (e) { console.error("[site-watch] pulse:", e.message); }
}

// ─────────────────────────────────────────────────────────────
//  5. New monthly Visa Bulletin (feeds the EB-5 / EB-1/2/3 / family pages)
// ─────────────────────────────────────────────────────────────
async function checkVisaBulletin() {
  try {
    const r = await get("https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html", { timeout: 30000 });
    if (r.status !== 200) return;
    const m = r.body.match(/Visa Bulletin For (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})/i);
    if (!m) return;
    const latest = `${m[1]} ${m[2]}`;
    const prev = await getState("vb:latest");
    if (prev && prev !== latest) {
      await tell(`🗓️ The ${latest} Visa Bulletin is out.\nUpdate the "What has changed lately" items on the EB-5, EB-1, EB-2, EB-3 and family-based pages, and consider a post on China-born cutoff dates.\nhttps://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html`);
    }
    await setState("vb:latest", latest);
  } catch (e) { console.error("[site-watch] visa bulletin:", e.message); }
}

// ─────────────────────────────────────────────────────────────
//  6. Weekly digest (Monday) + stale practice-page facts
// ─────────────────────────────────────────────────────────────
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
async function stalePracticePages() {
  const stale = [];
  for (const id of PRACTICE_PAGE_IDS) {
    try {
      const { data } = await wpJson(`/wp/v2/pages/${id}?context=edit&_fields=id,title,content`);
      const dates = [...String(data.content.raw).matchAll(/As of (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{4})/gi)]
        .map(m => new Date(parseInt(m[2], 10), MONTHS[m[1].toLowerCase()], 15));
      const newest = dates.length ? Math.max(...dates) : null;
      if (newest && Date.now() - newest > STALE_DAYS * 86400000) stale.push(`${data.title.raw} (latest update ${new Date(newest).toLocaleDateString("en-US", { month: "short", year: "numeric" })})`);
    } catch (e) { /* skip page */ }
  }
  return stale;
}
async function weeklyDigest() {
  const lines = ["📊 Weekly web report — tezlawfirm.com", ""];
  try {
    const after = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data } = await wpJson(`/wp/v2/posts?after=${after}&status=publish&per_page=100&context=edit&_fields=id,meta`);
    const by = {};
    for (const p of data) { const l = (p.meta && p.meta.tez_lang) || "en"; const k = l.startsWith("zh") ? "中文" : l === "es" ? "Español" : "English"; by[k] = (by[k] || 0) + 1; }
    lines.push(`Posts published: ${data.length}${data.length ? " (" + Object.entries(by).map(([k, v]) => `${k} ${v}`).join(", ") + ")" : ""}`);
    const d = await wpJson(`/wp/v2/posts?status=draft&per_page=1&_fields=id`);
    const drafts = parseInt(d.headers["x-wp-total"] || "0", 10);
    if (drafts) lines.push(`Drafts waiting for review: ${drafts}`);
  } catch (e) { lines.push("Posts: could not read WordPress (" + e.message + ")"); }

  const samples = (await getState("health:samples", [])).filter(s => Date.now() - s.t < 7 * 86400000);
  if (samples.length) lines.push(`Uptime: ${(100 * samples.filter(s => s.ok).length / samples.length).toFixed(2)}% (${samples.length} checks)`);
  const ssl = await getState("ssl:days");
  if (ssl !== null) lines.push(`SSL certificate: ${ssl} days left`);
  const open = Object.values(await getState("health:problems", {}));
  lines.push(open.length ? `Open issues: ${open.map(v => v.text.split(".")[0]).join("; ")}` : "Open issues: none");

  const plugins = await getState("sec:plugins", []);
  const risky = plugins.filter(p => RISKY_PLUGINS.includes(p.name));
  if (risky.length) lines.push(`Security: ${risky.map(p => p.name).join(", ")} is installed — it has a history of serious vulnerabilities; remove it if unused.`);

  const stale = await stalePracticePages();
  if (stale.length) lines.push("", `Practice pages with facts older than ${STALE_DAYS} days (fees, rules, cutoffs may have changed):`, ...stale.slice(0, 10).map(s => "• " + s));

  await tell(lines.join("\n"));
}

// ─────────────────────────────────────────────────────────────
//  Scheduler
// ─────────────────────────────────────────────────────────────
function guard(label, fn) {
  return async () => { try { await fn(); } catch (e) { console.error(`[site-watch] ${label}:`, e.message); } };
}
async function startSiteWatch() {
  if (process.env.SITE_WATCH_DISABLED === "1") { console.log("[site-watch] disabled"); return; }
  const { default: cron } = await import("node-cron").catch(() => ({ default: require("node-cron") }));
  const tz = { timezone: "America/Los_Angeles" };
  cron.schedule("*/15 * * * *", guard("health", checkSiteHealth), tz);
  cron.schedule("40 7 * * *", guard("daily-security", async () => { await checkSSL(); await checkSecurity(); }), tz);
  cron.schedule("0 9 * * *", guard("daily-content", async () => { await checkContent(); await checkVisaBulletin(); }), tz);
  cron.schedule("30 8 * * 1", guard("weekly", weeklyDigest), tz);
  console.log("🛰️ Site watch scheduled: health every 15 min · security 7:40 · content 9:00 · weekly Mon 8:30 (PT)");

  // First start: record baselines quietly (so existing admins/plugins aren't reported as "new") and say hello once
  setTimeout(guard("baseline", async () => {
    const hello = await getState("hello");
    await checkSecurity(); await checkSSL(); await checkVisaBulletin();
    if (!hello) {
      await setState("hello", { at: Date.now() });
      await tell("🛰️ Site watch is on. I'll message you only when tezlawfirm.com or the publishing pipeline needs attention, plus a short report every Monday.");
    }
  }), 60 * 1000);
}

module.exports = { startSiteWatch, checkSiteHealth, checkSSL, checkSecurity, checkContent, checkVisaBulletin, weeklyDigest, tell };
