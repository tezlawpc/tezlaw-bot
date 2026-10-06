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
//  Daily 9:20    Search Console: sitemap errors; posts 1–3 weeks old that
//                Google still hasn't indexed
//  Every 2 h     New Google reviews (both offices) with a suggested reply
//                that keeps client confidentiality; rating drops
//
//  Env: WP_URL, WP_USER, WP_APP_PASSWORD, TELEGRAM_TOKEN, JJ_TELEGRAM_ID
//  Optional: GSC_SERVICE_ACCOUNT_JSON, GOOGLE_PLACES_API_KEY, GOOGLE_PLACE_IDS,
//            SITE_WATCH_DISABLED=1
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
  console.log("[site-watch] " + text.split("\n")[0]);
  await require("./tg-route").send("social", text);
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
    if (!/"LegalService"/.test(home.body)) problems.push(["snippet", "No law-firm schema on the homepage. It comes from the block “TEZ structured data (JSON-LD)”, which looks switched off: WordPress → Snippets → TEZ structured data (JSON-LD) → Active."]);
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
      // The file opens with the firm's name: "# TEZ Law Firm" since October 2026,
      // "# Tez Law P.C." before. Either is the real file.
      if (ll.status !== 200 || !/^#\s*tez law/i.test(ll.body)) problems.push(["llms", "llms.txt (the AI-assistant guide) is missing."]);
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

  try { lines.push("", ...(await searchConsoleWeekly())); } catch (e) { lines.push("", "Google Search Console: error — " + e.message); }
  try { lines.push(...(await reviewsWeekly())); } catch (e) {}

  const stale = await stalePracticePages();
  if (stale.length) lines.push("", `Practice pages with facts older than ${STALE_DAYS} days (fees, rules, cutoffs may have changed):`, ...stale.slice(0, 10).map(s => "• " + s));

  await tell(lines.join("\n"));
}


// ─────────────────────────────────────────────────────────────
//  7. Google Search Console (service account, read-only)
//     Env: GSC_SERVICE_ACCOUNT_JSON (the key file's JSON, raw or base64)
//     The service account's email must be added in Search Console →
//     Settings → Users and permissions (Restricted is enough).
// ─────────────────────────────────────────────────────────────
const crypto = require("crypto");
let gToken = null;
function serviceAccount() {
  const raw = process.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try { return JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")); }
  catch (e) { console.error("[site-watch] GSC_SERVICE_ACCOUNT_JSON is not valid JSON"); return null; }
}
async function googleToken() {
  if (gToken && gToken.exp > Date.now() + 60000) return gToken.token;
  const sa = serviceAccount();
  if (!sa) return null;
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const r = await axios.post("https://oauth2.googleapis.com/token",
    new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 20000 });
  gToken = { token: r.data.access_token, exp: Date.now() + (r.data.expires_in || 3600) * 1000 };
  return gToken.token;
}
async function gsc(method, url, body) {
  const token = await googleToken();
  if (!token) return null;
  const r = await axios({ method, url, data: body, headers: { Authorization: `Bearer ${token}` }, timeout: 30000, validateStatus: () => true });
  if (r.status === 403) {
    const sa = serviceAccount();
    await alertOnce("gsc-403", `🔍 Search Console refused access (403). Add ${sa && sa.client_email} as a user in Search Console → Settings → Users and permissions (Restricted), and make sure the Search Console API is enabled in Google Cloud.`, 72);
    return null;
  }
  if (r.status >= 300) throw new Error(`GSC ${r.status}: ${JSON.stringify(r.data).substring(0, 200)}`);
  return r.data;
}
async function gscSite() {
  const cached = await getState("gsc:site");
  if (cached) return cached;
  const d = await gsc("get", "https://www.googleapis.com/webmasters/v3/sites");
  if (!d) return null;
  const sites = (d.siteEntry || []).filter(x => /tezlawfirm\.com/.test(x.siteUrl) && x.permissionLevel !== "siteUnverifiedUser");
  const pick = sites.find(x => x.siteUrl.startsWith("sc-domain:")) || sites[0];
  if (!pick) { await alertOnce("gsc-nosite", "🔍 The Search Console key works, but it can't see tezlawfirm.com yet. Add the service account email as a user on the tezlawfirm.com property.", 72); return null; }
  await setState("gsc:site", pick.siteUrl);
  return pick.siteUrl;
}
const ymd = d => d.toISOString().slice(0, 10);
async function gscTotals(site, start, end, dimension) {
  const body = { startDate: ymd(start), endDate: ymd(end), rowLimit: dimension ? 5 : 1 };
  if (dimension) body.dimensions = [dimension];
  const d = await gsc("post", `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, body);
  return (d && d.rows) || [];
}
async function inspectUrl(site, url) {
  const d = await gsc("post", "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", { inspectionUrl: url, siteUrl: site, languageCode: "en-US" });
  const r = d && d.inspectionResult && d.inspectionResult.indexStatusResult;
  return r ? { verdict: r.verdict, state: r.coverageState || "", lastCrawl: r.lastCrawlTime || null } : null;
}

// Daily: sitemap errors + are last week's new posts in Google yet?
async function checkSearchConsole() {
  if (!serviceAccount()) return;
  const site = await gscSite();
  if (!site) return;

  const sm = await gsc("get", `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps`);
  const bad = ((sm && sm.sitemap) || []).filter(x => Number(x.errors) > 0);
  if (bad.length) await alertOnce("gsc-sitemap", `🔍 Google reports errors in your sitemap:\n${bad.map(x => `• ${x.path}: ${x.errors} error(s), ${x.warnings || 0} warning(s)`).join("\n")}\nSearch Console → Sitemaps for details.`, 72);

  // Posts published 7–21 days ago that Google still hasn't indexed (checked once each)
  const seen = await getState("gsc:inspected", {});
  const after = new Date(Date.now() - 21 * 86400000).toISOString(), before = new Date(Date.now() - 7 * 86400000).toISOString();
  let posts = [];
  try { posts = (await wpJson(`/wp/v2/posts?after=${after}&before=${before}&status=publish&per_page=50&_fields=id,link,title`)).data; } catch (e) {}
  const notIndexed = [];
  let n = 0;
  for (const p of posts) {
    if (seen[p.id] || n >= 25) continue;
    n++;
    const r = await inspectUrl(site, p.link);
    if (!r) continue;
    seen[p.id] = r.verdict;
    if (r.verdict !== "PASS") notIndexed.push(`• ${p.title.rendered.replace(/&#8211;|&#8212;/g, "–").replace(/&#8217;|&#8216;/g, "’").replace(/&amp;/g, "&").replace(/&[^;\s]+;/g, " ").substring(0, 70)} — ${r.state || r.verdict}`);
  }
  await setState("gsc:inspected", Object.fromEntries(Object.entries(seen).slice(-500)));
  if (notIndexed.length) await tell(`🔍 Posts published 1–3 weeks ago that Google has NOT indexed:\n${notIndexed.slice(0, 10).join("\n")}\n\n"Crawled/Discovered – currently not indexed" usually means Google sees the page as thin or too similar to others. Consider merging or improving these, or use Search Console → URL Inspection → Request indexing.`);
}

// Weekly: search traffic summary + practice pages index status
async function searchConsoleWeekly() {
  if (!serviceAccount()) return ["Google Search Console: not connected yet (add GSC_SERVICE_ACCOUNT_JSON on Render)."];
  const site = await gscSite();
  if (!site) return ["Google Search Console: key works but tezlawfirm.com isn't shared with it yet."];
  const lines = [];
  const end = new Date(Date.now() - 3 * 86400000), start = new Date(end - 6 * 86400000);
  const pEnd = new Date(start - 86400000), pStart = new Date(pEnd - 6 * 86400000);
  const [cur] = await gscTotals(site, start, end), [prev] = await gscTotals(site, pStart, pEnd);
  const pct = (a, b) => b ? `${a >= b ? "+" : ""}${Math.round((a - b) / b * 100)}%` : "n/a";
  if (cur) {
    lines.push(`Google search (${ymd(start)} → ${ymd(end)}): ${cur.clicks} clicks (${pct(cur.clicks, prev ? prev.clicks : 0)}), ${cur.impressions} impressions (${pct(cur.impressions, prev ? prev.impressions : 0)}), avg position ${cur.position.toFixed(1)}`);
    if (prev && prev.clicks >= 20 && cur.clicks < prev.clicks * 0.7) lines.push(`⚠️ Clicks fell ${Math.round((1 - cur.clicks / prev.clicks) * 100)}% week over week — check Search Console for a ranking or indexing drop.`);
  } else lines.push("Google search: no data for the week yet.");
  const q = await gscTotals(site, start, end, "query");
  if (q.length) lines.push("Top searches: " + q.map(r => `"${r.keys[0]}" (${r.clicks}/${r.impressions})`).join(", "));
  const pg = await gscTotals(site, start, end, "page");
  if (pg.length) lines.push("Top pages: " + pg.map(r => `${r.keys[0].replace(/^https?:\/\/[^/]+/, "") || "/"} (${r.clicks})`).join(", "));

  // Are the practice pages indexed?
  const missing = [];
  for (const id of [10, ...PRACTICE_PAGE_IDS]) {
    try {
      const link = id === 10 ? SITE + "/" : (await wpJson(`/wp/v2/pages/${id}?_fields=link`)).data.link;
      const r = await inspectUrl(site, link);
      if (r && r.verdict !== "PASS") missing.push(`${link.replace(/^https?:\/\/[^/]+/, "")} (${r.state})`);
    } catch (e) {}
  }
  lines.push(missing.length ? `Practice pages NOT in Google: ${missing.join("; ")}` : "All practice pages are indexed in Google.");
  return lines;
}

// ─────────────────────────────────────────────────────────────
//  8. Google reviews (Places API — New)
//     Env: GOOGLE_PLACES_API_KEY; optional GOOGLE_PLACE_IDS (comma list)
//     New review → Telegram with stars, text and a suggested reply that
//     never confirms the reviewer was a client (Bus. & Prof. Code 6068(e),
//     Rule 1.6 — confidentiality applies even when replying to reviews).
// ─────────────────────────────────────────────────────────────
async function placeIds() {
  if (process.env.GOOGLE_PLACE_IDS) return process.env.GOOGLE_PLACE_IDS.split(",").map(x => x.trim()).filter(Boolean);
  const cached = await getState("reviews:places");
  if (cached && cached.length) return cached;
  const key = process.env.GOOGLE_PLACES_API_KEY;
  const found = [];
  for (const q of ["Tez Law 4141 S Nogales St West Covina CA", "Tez Law 4343 Von Karman Ave Newport Beach CA"]) {
    try {
      const r = await axios.post("https://places.googleapis.com/v1/places:searchText", { textQuery: q, maxResultCount: 1 },
        { headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress" }, timeout: 20000 });
      const p = r.data.places && r.data.places[0];
      if (p && /tez/i.test(p.displayName && p.displayName.text) && !found.some(f => f.id === p.id)) found.push({ id: p.id, name: p.displayName.text, address: p.formattedAddress });
    } catch (e) { console.error("[site-watch] place search:", e.response?.status || e.message); }
  }
  if (found.length) {
    await setState("reviews:places", found.map(f => f.id));
    await tell(`⭐ Google review alerts are on for:\n${found.map(f => `• ${f.name} — ${f.address}`).join("\n")}${found.length < 2 ? "\n\nOnly one office was found on Google Maps. If the other office has its own Business Profile, send me its link." : ""}`);
  } else await alertOnce("reviews-noplace", "⭐ Review alerts: I couldn't find the Tez Law listings on Google Maps with the API key. Set GOOGLE_PLACE_IDS on Render.", 72);
  return found.map(f => f.id);
}
async function suggestReply(review, business) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return "";
  let model = "claude-haiku-4-5-20251001";
  try { model = require("./zara-core").TIERS.fast.anthropic; } catch (e) {}
  const prompt = `Draft a short public reply from ${business} (a California law firm) to this Google review. Reply in the same language as the review.
Rules: never confirm or deny that the reviewer is or was a client, never mention any case, matter, fact, fee or outcome (California attorney confidentiality: Bus. & Prof. Code 6068(e), Rule 1.6). Do not argue. Do not offer anything of value. 2-4 sentences. For a positive review: thank them warmly. For a negative one: say the firm takes feedback seriously and invite them to call 626-678-8677 to discuss privately. Sign "— Tez Law P.C." Return only the reply text.

Stars: ${review.rating}
Review: ${(review.text && review.text.text) || "(no text)"}`;
  try {
    const r = await axios.post("https://api.anthropic.com/v1/messages", { model, max_tokens: 300, messages: [{ role: "user", content: prompt }] },
      { headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 30000 });
    return (r.data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  } catch (e) { return ""; }
}
async function checkReviews() {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return;
  for (const id of await placeIds()) {
    try {
      const r = await axios.get(`https://places.googleapis.com/v1/places/${id}`, {
        headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "id,displayName,rating,userRatingCount,reviews,googleMapsUri" }, timeout: 20000 });
      const p = r.data, name = (p.displayName && p.displayName.text) || "Tez Law";
      const prev = await getState("reviews:" + id);
      const reviews = p.reviews || [];
      const now = { count: p.userRatingCount || 0, rating: p.rating || 0, seen: reviews.map(x => x.name) };
      if (prev) {
        const fresh = reviews.filter(x => !prev.seen.includes(x.name) && Date.now() - new Date(x.publishTime).getTime() < 14 * 86400000);
        for (const rv of fresh) {
          const stars = "★".repeat(rv.rating || 0) + "☆".repeat(5 - (rv.rating || 0));
          const reply = await suggestReply(rv, "Tez Law P.C.");
          await tell(`${rv.rating <= 3 ? "⚠️ " : "⭐ "}New Google review — ${name}\n${stars}  by ${(rv.authorAttribution && rv.authorAttribution.displayName) || "a reviewer"}\n\n"${((rv.text && rv.text.text) || "(no text)").substring(0, 900)}"\n${reply ? `\nSuggested reply (review before posting):\n${reply}\n` : ""}\nReply on Google: ${rv.googleMapsUri || p.googleMapsUri || "business.google.com/reviews"}`);
        }
        const added = now.count - prev.count;
        if (added > fresh.length && added > 0) await tell(`⭐ ${name} received ${added - fresh.length} more Google review(s) that the API doesn't show yet. Open: ${p.googleMapsUri || "business.google.com/reviews"}`);
        if (prev.rating && now.rating && now.rating < prev.rating - 0.05) await tell(`📉 ${name}'s Google rating dropped from ${prev.rating.toFixed(1)} to ${now.rating.toFixed(1)}.`);
      }
      await setState("reviews:" + id, now);
    } catch (e) { console.error("[site-watch] reviews:", e.response?.status || e.message); }
  }
}
async function reviewsWeekly() {
  if (!process.env.GOOGLE_PLACES_API_KEY) return ["Google reviews: not connected yet (add GOOGLE_PLACES_API_KEY on Render)."];
  const ids = (await getState("reviews:places")) || (process.env.GOOGLE_PLACE_IDS || "").split(",").filter(Boolean);
  const out = [];
  for (const id of ids) { const s = await getState("reviews:" + id); if (s) out.push(`${s.rating ? s.rating.toFixed(1) : "–"}★ from ${s.count} reviews`); }
  return out.length ? ["Google reviews: " + out.join(" · ")] : [];
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
  cron.schedule("20 9 * * *", guard("search-console", checkSearchConsole), tz);
  cron.schedule("5 8-21/2 * * *", guard("reviews", checkReviews), tz);
  console.log("🛰️ Site watch scheduled: health every 15 min · security 7:40 · content 9:00 · Search Console 9:20 · reviews every 2 h (8–9 PT) · weekly Mon 8:30");

  // First start: record baselines quietly (so existing admins/plugins aren't reported as "new") and say hello once
  setTimeout(guard("baseline", async () => {
    const hello = await getState("hello");
    await checkSecurity(); await checkSSL(); await checkVisaBulletin(); await checkReviews();
    if (!hello) {
      await setState("hello", { at: Date.now() });
      await tell("🛰️ Site watch is on. I'll message you only when tezlawfirm.com or the publishing pipeline needs attention, plus a short report every Monday.");
    }
  }), 60 * 1000);
}

module.exports = { startSiteWatch, checkSiteHealth, checkSSL, checkSecurity, checkContent, checkVisaBulletin, weeklyDigest, checkSearchConsole, searchConsoleWeekly, checkReviews, tell };
