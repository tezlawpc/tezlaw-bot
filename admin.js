// ============================================================
//  admin.js — Tez Law P.C. | Zara Admin Panel
//  Telegram-authenticated admin interface
//
//  Features:
//  - Telegram login (JJ approves access via bot message)
//  - Live system prompt editor (edit + save to DB, no GitHub needed)
//  - Recent intakes table
//  - Analytics history viewer
//  - Manual analytics trigger
//  - Platform stats
//  - Distress/urgency log
// ============================================================

const express    = require("express");
const crypto     = require("crypto");
const axios      = require("axios");
const { Pool }   = require("pg");
const fs         = require("fs");
const path       = require("path");
const db         = require("./db");
// nodemailer loaded lazily in sendAuthEmail to avoid crash if not installed

// Research module (Phase 1) — optional, gracefully degrades if not deployed
let researchRouter = null;
try {
  researchRouter = require("./research-engine");
  console.log("[admin] ✅ Research module loaded");
} catch (err) {
  console.log("[admin] ⚠️  Research module not available:", err.message);
}

const router = express.Router();

// ── Config ────────────────────────────────────────────────
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const ANALYTICS_LOG        = process.env.ANALYTICS_LOG || "/var/data/analytics_history.json";
const JJ_TELEGRAM_ID       = process.env.JJ_TELEGRAM_ID; // JJ's personal Telegram user ID

// DB-backed session store (survives Render redeploys)
// Pending auth requests: in-memory only (5 min TTL, no persistence needed)
const pendingAuths = new Map();

async function initSessionTable() {
  try {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token VARCHAR(128) PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Clean up expired sessions on startup
    const deleted = await getPool().query(
      `DELETE FROM admin_sessions WHERE expires_at < NOW()`
    );
    if (deleted.rowCount > 0) {
      console.log(`🧹 Cleaned ${deleted.rowCount} expired admin sessions`);
    }
    console.log("✅ Admin sessions table ready");
  } catch (err) {
    console.error("Session table init error:", err.message);
  }
}

// ── DB pool ───────────────────────────────────────────────
let pool = null;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

// ── Session helpers ───────────────────────────────────────
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  try {
    await getPool().query(
      `INSERT INTO admin_sessions (token, user_id, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET expires_at = $3`,
      [token, userId, expiresAt]
    );
  } catch (err) {
    console.error("createSession DB error:", err.message);
  }
  return token;
}

async function validateSession(token) {
  if (!token) return false;
  try {
    const r = await getPool().query(
      `SELECT user_id FROM admin_sessions WHERE token=$1 AND expires_at > NOW()`,
      [token]
    );
    return r.rows.length > 0;
  } catch (err) {
    console.error("validateSession DB error:", err.message);
    return false;
  }
}

async function deleteSession(token) {
  try {
    await getPool().query(`DELETE FROM admin_sessions WHERE token=$1`, [token]);
  } catch (err) {
    console.error("deleteSession DB error:", err.message);
  }
}

function audit(req, action, target, oldVal, newVal) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "unknown";
  db.logAudit("jj", action, target, oldVal, newVal, ip).catch(() => {});
}

async function requireAuth(req, res, next) {
  const token = req.cookies?.admin_token || req.headers["x-admin-token"];
  if (await validateSession(token)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
  res.redirect("/admin/login");
}

// ── Telegram auth flow ────────────────────────────────────
// Step 1: Browser hits /admin/login → generates a pending auth code
// Step 2: Sends JJ a Telegram message with Approve/Deny buttons
// Step 3: JJ taps Approve → bot callback sets session → browser polls and redirects

async function sendAuthRequest(requestId) {
  const { TELEGRAM_TOKEN, JJ_TELEGRAM_ID } = process.env;
  if (!TELEGRAM_TOKEN || !JJ_TELEGRAM_ID) return false;

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: JJ_TELEGRAM_ID,
      text: `🔐 Admin Panel Login Request\n\nSomeone is requesting access to the Zara Admin Panel.\n\nTime: ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT\n\nApprove this login?`,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `admin_approve:${requestId}` },
          { text: "❌ Deny",    callback_data: `admin_deny:${requestId}` },
        ]]
      }
    });
    return true;
  } catch (err) {
    console.error("sendAuthRequest error:", err.message);
    return false;
  }
}

// Called from server.js Telegram callback handler
async function handleAdminCallback(callbackData, callbackQueryId) {
  const [action, requestId] = callbackData.split(":");
  if (!["admin_approve", "admin_deny"].includes(action)) return false;

  const pending = pendingAuths.get(requestId);
  if (!pending || Date.now() > pending.expiresAt) {
    return { answer: "❌ This request has expired." };
  }

  if (action === "admin_approve") {
    pending.approved = true;
    pending.token = await createSession("jj");
    db.logAudit("jj","login","admin_panel",null,"approved",null).catch(()=>{});
    return { answer: "✅ Admin access approved!" };
  } else {
    pending.denied = true;
    return { answer: "❌ Access denied." };
  }
}

// ── Prompt management (stored in DB) ─────────────────────
async function initPromptTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS system_prompts (
      id SERIAL PRIMARY KEY,
      prompt TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      updated_by VARCHAR(100) DEFAULT 'admin'
    );
  `);
  await initSessionTable();
}

async function getSavedPrompt() {
  try {
    const res = await getPool().query(
      `SELECT prompt FROM system_prompts ORDER BY id DESC LIMIT 1`
    );
    return res.rows[0]?.prompt || null;
  } catch { return null; }
}

async function savePrompt(prompt) {
  await getPool().query(
    `INSERT INTO system_prompts (prompt, updated_at) VALUES ($1, NOW())`,
    [prompt]
  );
}

// ── Routes ────────────────────────────────────────────────

// Research module — mounts at /admin/api/research/*
// Inherits admin auth via requireAuth middleware
if (researchRouter) {
  router.use("/api/research", requireAuth, researchRouter);
}

// Health check — confirms admin.js loaded correctly
router.get("/health", (req, res) => {
  res.json({ status: "ok", module: "admin", time: new Date().toISOString() });
});

// Login page
router.get("/login", (req, res) => {
  res.send(loginPageHtml());
});

// Initiate Telegram auth
router.post("/api/auth/request", async (req, res) => {
  const requestId = crypto.randomBytes(16).toString("hex");
  pendingAuths.set(requestId, {
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min to approve
    approved: false,
    denied: false,
    token: null,
  });

  const sent = await sendAuthRequest(requestId);
  if (!sent) {
    return res.status(500).json({ error: "Could not send Telegram message. Check JJ_TELEGRAM_ID env var." });
  }
  res.json({ requestId });
});

// Poll for auth status
router.get("/api/auth/status/:requestId", (req, res) => {
  const pending = pendingAuths.get(req.params.requestId);
  if (!pending) return res.json({ status: "expired" });
  if (Date.now() > pending.expiresAt) {
    pendingAuths.delete(req.params.requestId);
    return res.json({ status: "expired" });
  }
  if (pending.denied) {
    pendingAuths.delete(req.params.requestId);
    return res.json({ status: "denied" });
  }
  if (pending.approved && pending.token) {
    const token = pending.token;
    pendingAuths.delete(req.params.requestId);
    return res.json({ status: "approved", token });
  }
  res.json({ status: "pending" });
});

// Logout
router.post("/api/logout", requireAuth, async (req, res) => {
  const token = req.cookies?.admin_token || req.headers["x-admin-token"];
  await deleteSession(token);
  audit(req,"logout","admin_panel",null,null);
  res.json({ ok: true });
});

// ── Protected API routes ──────────────────────────────────



// Get current system prompt
router.get("/api/prompt", requireAuth, async (req, res) => {
  const saved = await getSavedPrompt();
  res.json({ prompt: saved || req.app.locals.SYSTEM_PROMPT || "" });
});

// Save system prompt
router.post("/api/prompt", requireAuth, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt provided" });
  const oldPrompt = await getSavedPrompt();
  await savePrompt(prompt);
  req.app.locals.SYSTEM_PROMPT = prompt;
  audit(req,"prompt_edit","system_prompt",
    oldPrompt ? oldPrompt.substring(0,200) : null,
    prompt.substring(0,200));
  res.json({ ok: true, message: "Prompt updated and live immediately!" });
});

// Get recent intakes
router.get("/api/intakes", requireAuth, async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT id, platform, name, case_type, issue, contact, created_at
      FROM intakes
      ORDER BY created_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get platform stats
router.get("/api/stats", requireAuth, async (req, res) => {
  try {
    const [msgs, clients, intakes, today] = await Promise.all([
      getPool().query(`SELECT COUNT(*) as n FROM messages`),
      getPool().query(`SELECT COUNT(*) as n FROM clients`),
      getPool().query(`SELECT COUNT(*) as n FROM intakes`),
      getPool().query(`SELECT COUNT(*) as n FROM messages WHERE created_at > NOW() - INTERVAL '24 hours'`),
    ]);

    const platforms = await getPool().query(`
      SELECT platform, COUNT(*) as messages
      FROM messages
      GROUP BY platform
      ORDER BY messages DESC
    `);

    const weekIntakes = await getPool().query(`
      SELECT case_type, COUNT(*) as n
      FROM intakes
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY case_type
      ORDER BY n DESC
    `);

    res.json({
      totalMessages:  parseInt(msgs.rows[0].n),
      totalClients:   parseInt(clients.rows[0].n),
      totalIntakes:   parseInt(intakes.rows[0].n),
      messagesToday:  parseInt(today.rows[0].n),
      byPlatform:     platforms.rows,
      weekIntakeTypes: weekIntakes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get analytics history
router.get("/api/analytics", requireAuth, (req, res) => {
  try {
    const history = fs.existsSync(ANALYTICS_LOG)
      ? JSON.parse(fs.readFileSync(ANALYTICS_LOG, "utf8"))
      : {};
    res.json(history);
  } catch {
    res.json({});
  }
});

// Trigger analytics manually
router.post("/api/analytics/run", requireAuth, (req, res) => {
  res.json({ ok: true, message: "Analytics running — check jj@tezlawfirm.com in ~2 minutes." });
  const { runWeeklyAnalysis } = require("./analytics");
  runWeeklyAnalysis(true).catch(err => console.error("Admin analytics trigger error:", err.message));
});

// Get recent messages (last 100)
router.get("/api/messages", requireAuth, async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT platform, platform_id, role, content, created_at
      FROM messages
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get compliance violations
router.get("/api/compliance", requireAuth, async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT id, platform, platform_id, user_message, zara_response,
             violation_type, violation_detail, correction_sent, created_at
      FROM compliance_violations
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ── Wave 2: Conversation Scores ───────────────────────────
router.get("/api/scores", requireAuth, async (req, res) => {
  try {
    const r = await getPool().query(`
      SELECT * FROM conversation_scores ORDER BY created_at DESC LIMIT 200
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.get("/api/scores/flagged", requireAuth, async (req, res) => {
  try {
    const r = await getPool().query(`
      SELECT * FROM conversation_scores WHERE needs_review=TRUE ORDER BY created_at DESC LIMIT 100
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Wave 2: SOL Calculator ────────────────────────────────
router.get("/api/sol", requireAuth, async (req, res) => {
  try {
    const r = await getPool().query(`SELECT * FROM sol_deadlines ORDER BY deadline_date ASC LIMIT 200`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post("/api/sol", requireAuth, async (req, res) => {
  try {
    const { platformId, clientName, caseType, incidentDate, notes } = req.body;
    const { calculateDeadline } = require("./sol");
    const result = calculateDeadline(incidentDate, caseType);
    await getPool().query(
      `INSERT INTO sol_deadlines (platform_id, client_name, case_type, incident_date, deadline_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [platformId || "manual", clientName, caseType, incidentDate, result.deadline, notes || ""]
    );
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.delete("/api/sol/:id", requireAuth, async (req, res) => {
  try {
    await getPool().query(`DELETE FROM sol_deadlines WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Wave 2: Drip Campaigns ────────────────────────────────
router.get("/api/drip", requireAuth, async (req, res) => {
  try {
    const r = await getPool().query(`
      SELECT dc.*, COUNT(dm.id) as total_msgs,
             COUNT(CASE WHEN dm.status='sent' THEN 1 END) as sent_msgs
      FROM drip_campaigns dc
      LEFT JOIN drip_messages dm ON dc.id = dm.campaign_id
      GROUP BY dc.id ORDER BY dc.started_at DESC LIMIT 200
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post("/api/drip/:id/stop", requireAuth, async (req, res) => {
  try {
    await getPool().query(
      `UPDATE drip_campaigns SET status='stopped', stopped_at=NOW(), stop_reason='manual_admin'
       WHERE id=$1`, [req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Wave 2: Prompt Version History ───────────────────────
router.get("/api/prompt/history", requireAuth, async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT id, LEFT(prompt,200) as preview, updated_at, updated_by FROM system_prompts ORDER BY id DESC LIMIT 50`
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post("/api/prompt/rollback/:id", requireAuth, async (req, res) => {
  try {
    const old = await getPool().query(`SELECT prompt FROM system_prompts WHERE id=$1`, [req.params.id]);
    if (!old.rows[0]) return res.status(404).json({error:"Version not found"});
    const prompt = old.rows[0].prompt;
    await getPool().query(
      `INSERT INTO system_prompts (prompt, updated_at, updated_by) VALUES ($1, NOW(), 'rollback')`,
      [prompt]
    );
    req.app.locals.SYSTEM_PROMPT = prompt;
    audit(req, "prompt_rollback", "system_prompt", null, "rolled back to v" + req.params.id);
    res.json({ ok: true, prompt });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Serve admin panel JS ──────────────────────────────────
router.get("/panel.js", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "admin-panel.js"));
});

// ── Wave 1: Lead Pipeline ─────────────────────────────────
router.get("/api/leads", requireAuth, async (req, res) => {
  try {
    const r = await getPool().query(`SELECT *,
      EXTRACT(EPOCH FROM (NOW()-stage_changed_at))/3600 AS hours_in_stage
      FROM leads WHERE stage NOT IN ('signed','lost') ORDER BY created_at DESC LIMIT 200`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.get("/api/leads/all", requireAuth, async (req, res) => {
  try {
    const r = await getPool().query(`SELECT *,
      EXTRACT(EPOCH FROM (NOW()-stage_changed_at))/3600 AS hours_in_stage
      FROM leads ORDER BY created_at DESC LIMIT 500`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.patch("/api/leads/:id/stage", requireAuth, async (req, res) => {
  try {
    const {stage} = req.body;
    const VALID = ["new_lead","qualified","consult_scheduled","consult_held","retainer_sent","signed","lost"];
    if (!VALID.includes(stage)) return res.status(400).json({error:"Invalid stage"});
    await db.updateLeadStage(req.params.id, stage, "jj",
      (req.headers["x-forwarded-for"]||"").split(",")[0]||"unknown");
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.post("/api/leads/:id/acknowledge", requireAuth, async (req, res) => {
  try {
    await getPool().query(`UPDATE leads SET acknowledged_at=NOW() WHERE id=$1`,[req.params.id]);
    await getPool().query(`UPDATE escalation_log SET acknowledged_at=NOW() WHERE lead_id=$1 AND acknowledged_at IS NULL`,[req.params.id]);
    audit(req,"lead_acknowledged","lead:"+req.params.id,null,"acknowledged");
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Wave 1: Conflict Checks ───────────────────────────────
router.get("/api/conflicts", requireAuth, async (req, res) => {
  try {
    const r = await getPool().query(`SELECT c.*,i.name AS intake_name,i.case_type AS intake_case_type
      FROM conflict_checks c LEFT JOIN intakes i ON c.intake_id=i.id
      ORDER BY c.checked_at DESC LIMIT 100`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.patch("/api/conflicts/:id/disposition", requireAuth, async (req, res) => {
  try {
    const {disposition} = req.body;
    if (!["pending","possible","cleared","denied"].includes(disposition))
      return res.status(400).json({error:"Invalid"});
    const old = await getPool().query(`SELECT disposition FROM conflict_checks WHERE id=$1`,[req.params.id]);
    await getPool().query(`UPDATE conflict_checks SET disposition=$1,reviewed_by='jj',reviewed_at=NOW() WHERE id=$2`,[disposition,req.params.id]);
    audit(req,"conflict_review","conflict:"+req.params.id,old.rows[0]?.disposition,disposition);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Wave 1: Unanswered Questions ──────────────────────────
router.get("/api/questions", requireAuth, async (req, res) => {
  try {
    const r = await getPool().query(`SELECT * FROM unanswered_questions WHERE resolved=FALSE ORDER BY created_at DESC LIMIT 200`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.get("/api/questions/weekly", requireAuth, async (req, res) => {
  try {
    const r = await getPool().query(`SELECT question,COUNT(*) AS n,MAX(created_at) AS last_seen
      FROM unanswered_questions WHERE created_at>NOW()-INTERVAL '7 days' AND resolved=FALSE
      GROUP BY question ORDER BY n DESC LIMIT 50`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.patch("/api/questions/:id/resolve", requireAuth, async (req, res) => {
  try {
    await getPool().query(`UPDATE unanswered_questions SET resolved=TRUE,resolved_at=NOW() WHERE id=$1`,[req.params.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Wave 1: Audit Log ────────────────────────────────────
router.get("/api/audit", requireAuth, async (req, res) => {
  try {
    const r = await getPool().query(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Autoposter manual trigger ─────────────────────────────
router.post("/api/autoposter/run", requireAuth, (req, res) => {
  res.json({ ok: true, message: "Auto-poster started — watch Telegram for results in ~5 min." });
  const { runDailyScheduler } = require("./autoposter");
  runDailyScheduler().catch(err => console.error("Admin autoposter error:", err.message));
});

// ── Manual custom post ────────────────────────────────────
router.post("/api/autoposter/custom", requireAuth, async (req, res) => {
  const { topic, practiceArea, url, notes } = req.body;
  if (!topic) return res.status(400).json({ error: "Topic is required" });

  res.json({ ok: true, message: "Custom post generating — check WordPress and Telegram in ~2 min." });

  // Run async after response
  (async () => {
    try {
      const ap = require("./autoposter");

      // Build the full topic string including URL/notes if provided
      let fullTopic = topic;
      if (url)   fullTopic += "\n\nSource URL: " + url;
      if (notes) fullTopic += "\n\nAdditional context: " + notes;

      const state = ap.loadState ? ap.loadState() : {};

      // Generate the post using the same function the autoposter uses
      const post = await ap.generatePost({
        topic:         fullTopic,
        practiceArea:  practiceArea || "Legal",
        context:       url ? "Source article: " + url : "",
        useSearch:     !!url,
        sources:       [],
      });

      if (!post) {
        console.log("❌ Custom post: generatePost returned null for topic:", fullTopic.substring(0,80));
        return;
      }

      console.log("✅ Custom post generated:", post.title);

      // Publish English + Chinese + Spanish (same as daily autoposter)
      const published = await ap.publishAllLanguages(
        post,
        "✍️ *Manual Post Published via Admin Panel*",
        state
      );

      if (published > 0) {
        console.log("✅ Custom post published in", published, "language(s)");
        if (ap.saveState) ap.saveState(state);
      } else {
        console.log("⚠️ Custom post: no languages published (may be duplicate)");
      }

    } catch (err) {
      console.error("Custom post error:", err.message);
    }
  })();
});


// ── Manual Post Creator ───────────────────────────────────
router.post("/api/post/generate", requireAuth, async (req, res) => {
  try {
    const { topic, practiceArea, context, useSearch } = req.body;
    if (!topic) return res.status(400).json({ error: "Topic required" });
    const { generatePost } = require("./autoposter");
    const post = await generatePost({
      topic,
      practiceArea: practiceArea || "General",
      context: context || "",
      useSearch: useSearch !== false,
      sources: [],
    });
    if (!post) return res.status(500).json({ error: "Failed to generate post" });
    res.json({ ok: true, post });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post("/api/post/publish", requireAuth, async (req, res) => {
  try {
    const { post, topic, practiceArea, languages } = req.body;
    if (!post) return res.status(400).json({ error: "Post data required" });
    const { publishToWordPress } = require("./autoposter");

    const results = [];

    // Publish English
    const wpResult = await publishToWordPress(post);
    if (!wpResult) return res.status(500).json({ error: "WordPress publish failed" });
    results.push({ lang: "English", id: wpResult.id, url: wpResult.url });
    audit(req, "manual_post", "wordpress", null, post.title?.substring(0, 100));

    // Translate and publish if requested
    if (languages && languages !== "english") {
      const axios = require("axios");
      const Anthropic = require("@anthropic-ai/sdk");
      const client = new Anthropic();

      const langs = languages === "all"
        ? [{ code: "zh-TW", label: "Traditional Chinese (繁體中文)" }, { code: "es", label: "Spanish (Latin American)" }]
        : languages === "chinese"
        ? [{ code: "zh-TW", label: "Traditional Chinese (繁體中文)" }]
        : [{ code: "es", label: "Spanish (Latin American)" }];

      for (const lang of langs) {
        try {
          const tx = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 2000,
            messages: [{
              role: "user",
              content: `Translate this WordPress post to ${lang.label}. Keep HTML formatting. Return JSON only: {"title":"...","content":"...","metaDescription":"..."}
Title: ${post.title}
Content: ${post.content?.substring(0, 3000)}
MetaDescription: ${post.metaDescription}`
            }]
          });
          const txText = tx.content[0].text.replace(/```json|```/g, "").trim();
          const txPost = JSON.parse(txText);
          const txWp = await publishToWordPress({
            ...post,
            title: txPost.title,
            content: txPost.content,
            metaDescription: txPost.metaDescription,
          });
          if (txWp) results.push({ lang: lang.label, id: txWp.id, url: txWp.url });
        } catch(txErr) {
          console.error("Translation error:", txErr.message);
        }
      }
    }

    // Log to DB
    await getPool().query(
      `INSERT INTO manual_posts (title, practice_area, topic, published_by, wp_post_ids, created_at)
       VALUES ($1,$2,$3,'jj',$4,NOW())
       ON CONFLICT DO NOTHING`,
      [post.title, practiceArea, topic, JSON.stringify(results.map(r => r.id))]
    ).catch(() => {}); // table may not exist yet, non-fatal

    res.json({ ok: true, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get("/api/post/history", requireAuth, async (req, res) => {
  try {
    // Try DB first, fall back to empty
    const r = await getPool().query(
      `SELECT * FROM manual_posts ORDER BY created_at DESC LIMIT 50`
    ).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

// Create manual_posts table if needed
router.post("/api/post/init", requireAuth, async (req, res) => {
  try {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS manual_posts (
        id SERIAL PRIMARY KEY,
        title VARCHAR(500),
        practice_area VARCHAR(100),
        topic TEXT,
        published_by VARCHAR(50),
        wp_post_ids JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── One-time migration endpoint ──────────────────────────
router.post("/api/migrate-wave2", requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    await pool.query(`CREATE TABLE IF NOT EXISTS conversation_scores (
      id SERIAL PRIMARY KEY, platform VARCHAR(50), platform_id VARCHAR(200),
      session_start TIMESTAMP, session_end TIMESTAMP, message_count INT,
      score_accuracy INT, score_tone INT, score_disclaimer INT, score_upl_risk INT,
      score_overall INT, needs_review BOOLEAN DEFAULT FALSE, review_notes TEXT,
      summary TEXT, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sol_deadlines (
      id SERIAL PRIMARY KEY, platform_id VARCHAR(200), client_name VARCHAR(200),
      case_type VARCHAR(100), incident_date DATE, deadline_date DATE, notes TEXT,
      alerted_90 BOOLEAN DEFAULT FALSE, alerted_30 BOOLEAN DEFAULT FALSE,
      alerted_7 BOOLEAN DEFAULT FALSE, alerted_1 BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS drip_campaigns (
      id SERIAL PRIMARY KEY, platform VARCHAR(50), platform_id VARCHAR(200),
      intake_id INT, client_name VARCHAR(200), case_type VARCHAR(100),
      status VARCHAR(50) DEFAULT 'active', started_at TIMESTAMP DEFAULT NOW(),
      stopped_at TIMESTAMP, stop_reason VARCHAR(100))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS drip_messages (
      id SERIAL PRIMARY KEY, campaign_id INT REFERENCES drip_campaigns(id),
      delay_hours INT, message_text TEXT, sent_at TIMESTAMP,
      status VARCHAR(50) DEFAULT 'pending')`);
    console.log("✅ Wave 2 tables migrated via admin endpoint");
    res.json({ ok: true, message: "Wave 2 tables created successfully" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Main admin dashboard
router.get("/", requireAuth, (req, res) => {
  res.send(dashboardHtml());
});

// ── HTML Templates ────────────────────────────────────────

function loginPageHtml() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Zara Admin — Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #0C1C36; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 12px; padding: 40px; width: 100%; max-width: 400px;
            text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
    .logo { font-size: 36px; margin-bottom: 8px; }
    h1 { color: #0C1C36; font-size: 22px; margin-bottom: 4px; }
    .sub { color: #666; font-size: 13px; margin-bottom: 32px; }
    .btn { background: #B79C62; color: #0C1C36; border: none; border-radius: 8px;
           padding: 14px 28px; font-size: 15px; font-weight: bold; cursor: pointer;
           width: 100%; transition: opacity .2s; }
    .btn:hover { opacity: .85; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .status { margin-top: 20px; padding: 12px; border-radius: 8px; font-size: 14px;
              display: none; }
    .status.info { background: #e8f4ff; color: #0066cc; display: block; }
    .status.error { background: #fff0f0; color: #cc0000; display: block; }
    .status.success { background: #f0fff4; color: #006600; display: block; }
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #B79C62;
               border-top-color: transparent; border-radius: 50%; animation: spin .7s linear infinite;
               vertical-align: middle; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <img src="https://tezlawfirm.com/wp-content/uploads/2025/12/cropped-Orange_Logo-removebg-preview.png" alt="TEZ Law" style="width:100px;height:auto;margin-bottom:12px">
    <h1>Zara Admin Panel</h1>
    <p class="sub">TEZ Law P.C. — Authorized Access Only</p>
    <button class="btn" id="loginBtn" onclick="requestLogin()">
      📱 Login via Telegram
    </button>
    <div class="status" id="status"></div>
  </div>

  <script>
    let pollInterval = null;

    async function requestLogin() {
      const btn = document.getElementById('loginBtn');
      const status = document.getElementById('status');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Sending request...';
      status.className = 'status';

      try {
        const res = await fetch('/admin/api/auth/request', { method: 'POST' });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        status.className = 'status info';
        status.innerHTML = '📱 Check your Telegram — tap <strong>Approve</strong> to log in.<br><small>Request expires in 5 minutes.</small>';
        btn.innerHTML = '<span class="spinner"></span> Waiting for approval...';

        // Poll for approval
        pollInterval = setInterval(() => pollStatus(data.requestId), 2000);
      } catch (err) {
        status.className = 'status error';
        status.textContent = '❌ ' + err.message;
        btn.disabled = false;
        btn.textContent = '📱 Login via Telegram';
      }
    }

    async function pollStatus(requestId) {
      try {
        const res = await fetch('/admin/api/auth/status/' + requestId);
        const data = await res.json();
        const status = document.getElementById('status');
        const btn = document.getElementById('loginBtn');

        if (data.status === 'approved') {
          clearInterval(pollInterval);
          // Store token in cookie
          document.cookie = 'admin_token=' + data.token + '; path=/; max-age=2592000; SameSite=Strict';
          status.className = 'status success';
          status.textContent = '✅ Approved! Redirecting...';
          setTimeout(() => window.location.href = '/admin/', 800);
        } else if (data.status === 'denied') {
          clearInterval(pollInterval);
          status.className = 'status error';
          status.textContent = '❌ Access denied by JJ.';
          btn.disabled = false;
          btn.textContent = '📱 Login via Telegram';
        } else if (data.status === 'expired') {
          clearInterval(pollInterval);
          status.className = 'status error';
          status.textContent = '⏱️ Request expired. Please try again.';
          btn.disabled = false;
          btn.textContent = '📱 Login via Telegram';
        }
      } catch {}
    }
  </script>
</body>
</html>`;
}

function dashboardHtml() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Zara Admin Panel — TEZ Law P.C.</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #f0ede6; color: #0C1C36; }

    /* Sidebar */
    .sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 220px;
               background: #0C1C36; padding: 0; z-index: 100; }
    .sidebar-logo { padding: 24px 20px; border-bottom: 1px solid rgba(183,156,98,.3); }
    .sidebar-logo h2 { color: #B79C62; font-size: 18px; }
    .sidebar-logo p { color: rgba(183,156,98,.6); font-size: 11px; margin-top: 2px; }
    .nav-item { display: block; padding: 14px 20px; color: rgba(255,255,255,.7);
                cursor: pointer; border-left: 3px solid transparent; transition: all .2s;
                font-size: 14px; }
    .nav-item:hover, .nav-item.active { color: #B79C62; background: rgba(183,156,98,.1);
                                         border-left-color: #B79C62; }
    .nav-item .icon { margin-right: 10px; }

    /* Main */
    .main { margin-left: 220px; padding: 28px; min-height: 100vh; }
    .page { display: none; }
    .page.active { display: block; }

    /* Header */
    .page-header { display: flex; align-items: center; justify-content: space-between;
                   margin-bottom: 24px; }
    .page-header h1 { font-size: 22px; color: #0C1C36; }
    .logout-btn { background: none; border: 1px solid #B79C62; color: #B79C62;
                  padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .logout-btn:hover { background: #B79C62; color: #0C1C36; }

    /* Stat cards */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
                  gap: 16px; margin-bottom: 28px; }
    .stat-card { background: #fff; border-radius: 10px; padding: 20px;
                 border-left: 4px solid #B79C62; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .stat-num { font-size: 32px; font-weight: bold; color: #B79C62; }
    .stat-label { font-size: 12px; color: #666; margin-top: 4px; }

    /* Cards */
    .card { background: #fff; border-radius: 10px; padding: 24px;
            box-shadow: 0 2px 8px rgba(0,0,0,.06); margin-bottom: 20px; }
    .card h3 { font-size: 15px; margin-bottom: 16px; color: #0C1C36;
               padding-bottom: 10px; border-bottom: 2px solid #B79C62; }

    /* Prompt editor */
    .prompt-editor { width: 100%; height: 420px; font-family: monospace; font-size: 13px;
                     line-height: 1.6; padding: 14px; border: 1px solid #ddd; border-radius: 8px;
                     resize: vertical; color: #0C1C36; outline: none; }
    .prompt-editor:focus { border-color: #B79C62; }
    .save-btn { background: #B79C62; color: #0C1C36; border: none; border-radius: 8px;
                padding: 12px 28px; font-size: 14px; font-weight: bold; cursor: pointer;
                margin-top: 12px; transition: opacity .2s; }
    .save-btn:hover { opacity: .85; }
    .save-btn:disabled { opacity: .5; cursor: not-allowed; }
    .save-msg { display: inline-block; margin-left: 12px; font-size: 13px; color: #006600; }

    /* Tables */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #0C1C36; color: #B79C62; padding: 10px 12px; text-align: left; }
    td { padding: 10px 12px; border-bottom: 1px solid #f0ede6; vertical-align: top; }
    tr:hover td { background: #faf8f4; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 12px; font-size: 11px;
             font-weight: bold; }
    .badge-tg { background: #e8f4ff; color: #0066cc; }
    .badge-wa { background: #e8fff0; color: #006633; }
    .badge-web { background: #fff0e8; color: #993300; }
    .badge-wc { background: #f0e8ff; color: #660099; }
    .badge-ms { background: #e8eeff; color: #003399; }

    /* Analytics */
    .analytics-entry { border: 1px solid #e0d8c8; border-radius: 8px; padding: 16px;
                       margin-bottom: 12px; background: #faf8f4; }
    .analytics-week { font-weight: bold; color: #B79C62; margin-bottom: 8px; }
    .analytics-summary { font-size: 13px; color: #444; line-height: 1.6; white-space: pre-wrap; }

    /* Action buttons */
    .action-btn { background: #0C1C36; color: #B79C62; border: none; border-radius: 6px;
                  padding: 10px 20px; cursor: pointer; font-size: 13px; font-weight: bold;
                  transition: opacity .2s; }
    .action-btn:hover { opacity: .8; }
    .action-btn.success { background: #006600; color: #fff; }

    /* Loading */
    .loading { color: #999; font-size: 13px; padding: 20px; text-align: center; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #B79C62;
               border-top-color: transparent; border-radius: 50%;
               animation: spin .7s linear infinite; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Platform bar */
    .platform-bar { display: flex; gap: 12px; flex-wrap: wrap; }
    .platform-stat { background: #f0ede6; border-radius: 8px; padding: 12px 16px;
                     text-align: center; min-width: 100px; }
    .platform-stat .n { font-size: 22px; font-weight: bold; color: #0C1C36; }
    .platform-stat .p { font-size: 12px; color: #666; margin-top: 2px; }

    .kanban-board{display:flex;gap:12px;min-width:900px;align-items:flex-start}
    .kanban-col{flex:1;min-width:140px;background:#f5f2ec;border-radius:10px;padding:12px}
    .kanban-col-header{font-size:12px;font-weight:bold;color:#0C1C36;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid #B79C62;display:flex;justify-content:space-between;align-items:center}
    .kanban-count{background:#0C1C36;color:#B79C62;border-radius:10px;padding:1px 7px;font-size:11px}
    .lead-card{background:#fff;border-radius:8px;padding:12px;margin-bottom:8px;box-shadow:0 1px 4px rgba(0,0,0,.08);border-left:3px solid #ddd;transition:box-shadow .2s}
    .lead-card:hover{box-shadow:0 3px 10px rgba(0,0,0,.15)}
    .lead-card.stale-warn{border-left-color:#ff9900}.lead-card.stale-crit{border-left-color:#cc0000}.lead-card.unacknowledged{border-left-color:#B79C62;background:#fffdf5}
    .lead-name{font-weight:bold;font-size:13px;color:#0C1C36;margin-bottom:3px}
    .lead-meta{font-size:11px;color:#888;margin-bottom:6px}
    .lead-case{display:inline-block;font-size:10px;padding:2px 7px;border-radius:10px;background:#e8eef4;color:#0C1C36;font-weight:bold;margin-bottom:6px}
    .lead-time{font-size:10px;color:#aaa}.lead-time.warn{color:#ff9900;font-weight:bold}.lead-time.crit{color:#cc0000;font-weight:bold}
    .stage-select{width:100%;font-size:11px;padding:4px 6px;border-radius:5px;border:1px solid #ddd;margin-top:6px;background:#f9f9f9;cursor:pointer}
    .disp-pending{background:#fff3cd;color:#856404}.disp-possible{background:#f8d7da;color:#721c24}.disp-cleared{background:#d4edda;color:#155724}.disp-denied{background:#e2e3e5;color:#383d41}
    .disp-btn{font-size:11px;padding:3px 10px;border:none;border-radius:10px;cursor:pointer;font-weight:bold;margin-right:4px}
    .score-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:bold}
    .score-high{background:#d4edda;color:#155724}.score-mid{background:#fff3cd;color:#856404}.score-low{background:#f8d7da;color:#721c24}
    .needs-review{border-left-color:#cc0000!important;background:#fff8f8!important}
    @media (max-width: 768px) {
      .sidebar { width: 60px; }
      .sidebar-logo p, .nav-item span { display: none; }
      .main { margin-left: 60px; }
    }
  </style>
</head>
<body>

<div class="sidebar">
  <div class="sidebar-logo">
    <img src="https://tezlawfirm.com/wp-content/uploads/2025/12/cropped-Orange_Logo-removebg-preview.png" alt="TEZ Law" style="width:60px;height:auto;display:block;margin-bottom:8px">
    <h2>Zara</h2>
    <p>Admin Panel</p>
  </div>
  <div class="nav-item active" onclick="showPage('dashboard')" id="nav-dashboard">
    <span class="icon">📊</span><span>Dashboard</span>
  </div>
  <div class="nav-item" onclick="showPage('prompt')" id="nav-prompt">
    <span class="icon">✏️</span><span>System Prompt</span>
  </div>
  <div class="nav-item" onclick="showPage('intakes')" id="nav-intakes">
    <span class="icon">📋</span><span>Intakes</span>
  </div>
  <div class="nav-item" onclick="showPage('messages')" id="nav-messages">
    <span class="icon">💬</span><span>Messages</span>
  </div>
  <div class="nav-item" onclick="showPage('compliance')" id="nav-compliance">
    <span class="icon">⚖️</span><span>Compliance</span>
  </div>
  <div class="nav-item" onclick="showPage('analytics')" id="nav-analytics">
    <span class="icon">🤖</span><span>Analytics</span>
  </div>
  <div class="nav-item" onclick="showPage('research')" id="nav-research">
    <span class="icon">🔍</span><span>Research</span>
  </div>
  <div class="nav-item" onclick="showPage('pipeline')" id="nav-pipeline">
    <span class="icon">🏆</span><span>Pipeline</span>
  </div>
  <div class="nav-item" onclick="showPage('conflicts')" id="nav-conflicts">
    <span class="icon">⚠️</span><span>Conflicts</span>
  </div>
  <div class="nav-item" onclick="showPage('questions')" id="nav-questions">
    <span class="icon">❓</span><span>Gaps</span>
  </div>
  <div class="nav-item" onclick="showPage('audit')" id="nav-audit">
    <span class="icon">📜</span><span>Audit Log</span>
  </div>
  <div class="nav-item" onclick="showPage('post')" id="nav-post">
    <span class="icon">📝</span><span>Post Creator</span>
  </div>
  <div class="nav-item" onclick="showPage('scores')" id="nav-scores">
    <span class="icon">🎯</span><span>Conv. Scores</span>
  </div>
  <div class="nav-item" onclick="showPage('sol')" id="nav-sol">
    <span class="icon">⏳</span><span>SOL Tracker</span>
  </div>
  <div class="nav-item" onclick="showPage('drip')" id="nav-drip">
    <span class="icon">💧</span><span>Drip Campaigns</span>
  </div>
</div>

<div class="main">

  <!-- Dashboard -->
  <div class="page active" id="page-dashboard">
    <div class="page-header">
      <h1>Dashboard</h1>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
    <div class="stats-grid" id="statsGrid">
      <div class="loading"><span class="spinner"></span> Loading...</div>
    </div>
    <div class="card">
      <h3>📡 Messages by Platform</h3>
      <div class="platform-bar" id="platformBar"><div class="loading">Loading...</div></div>
    </div>
    <div class="card">
      <h3>⚖️ This Week's Intakes by Case Type</h3>
      <div id="caseTypeBar"><div class="loading">Loading...</div></div>
    </div>
  </div>

  <!-- System Prompt -->
  <div class="page" id="page-prompt">
    <div class="page-header">
      <h1>System Prompt Editor</h1>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
    <div class="card">
      <h3>✏️ Edit Zara's System Prompt</h3>
      <p style="font-size:13px;color:#666;margin-bottom:12px">
        Changes apply <strong>immediately</strong> — no GitHub or Render deploy needed.
        Each save is versioned in the database.
      </p>
      <textarea class="prompt-editor" id="promptEditor" placeholder="Loading..."></textarea>
      <div>
        <button class="save-btn" id="saveBtn" onclick="savePrompt()">💾 Save & Apply Now</button>
        <span class="save-msg" id="saveMsg"></span>
      </div>
    </div>
    <div class="card">
      <h3>🕐 Version History</h3>
      <p style="font-size:13px;color:#666;margin-bottom:12px">Every save is versioned. Click Restore to roll back instantly.</p>
      <div id="promptHistory"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>

  <!-- Intakes -->
  <div class="page" id="page-intakes">
    <div class="page-header">
      <h1>Client Intakes</h1>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
    <div class="card">
      <h3>📋 Recent Intakes (Last 50)</h3>
      <div id="intakesTable"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>

  <!-- Messages -->
  <div class="page" id="page-messages">
    <div class="page-header">
      <h1>Recent Conversations</h1>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
    <div class="card">
      <h3>💬 Last 100 Messages</h3>
      <div id="messagesTable"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>

  <!-- Compliance -->
  <div class="page" id="page-compliance">
    <div class="page-header">
      <h1>Compliance Log</h1>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
    <div class="card">
      <h3>⚖️ Flagged Responses</h3>
      <p style="font-size:13px;color:#666;margin-bottom:16px">
        Zara responses that contained definitive legal conclusions, guarantees, or UPL risk.
        A correction was automatically sent to the client for each entry.
      </p>
      <div id="complianceTable"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>

  <!-- Analytics -->
  <div class="page" id="page-analytics">
    <div class="page-header">
      <h1>Analytics</h1>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
    <div class="card">
      <h3>🤖 Run Analysis Now</h3>
      <p style="font-size:13px;color:#666;margin-bottom:16px">
        Analyzes the last 7 days of conversations and emails a report to jj@tezlawfirm.com.
      </p>
      <button class="action-btn" id="runAnalyticsBtn" onclick="runAnalytics()">
        ▶ Run Analytics Now
      </button>
      <span id="analyticsMsg" style="margin-left:12px;font-size:13px;color:#006600"></span>
    </div>
    <div class="card">
      <h3>📝 Auto-Poster</h3>
      <p style="font-size:13px;color:#666;margin-bottom:16px">Manually run the WordPress auto-poster. Will not duplicate already-published posts.</p>
      <button class="action-btn" id="runAutoposterBtn" onclick="runAutoposter()">▶ Run Auto-Poster Now</button>
      <span id="autoposterMsg" style="margin-left:12px;font-size:13px;color:#006600"></span>
    </div>
    <div class="card">
      <h3>✍️ Post Custom Topic</h3>
      <p style="font-size:13px;color:#666;margin-bottom:16px">
        Write a post on any topic or news link. Zara will research, write, and publish to WordPress with Chinese and Spanish translations — just like the daily auto-poster.
      </p>
      <div style="display:grid;gap:10px;max-width:700px">
        <div>
          <label style="font-size:12px;color:#666;display:block;margin-bottom:4px">Topic or News Headline <span style="color:#cc0000">*</span></label>
          <input id="customTopic" placeholder="e.g. New USCIS fee increases 2026, or Trump immigration enforcement update"
            style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="font-size:12px;color:#666;display:block;margin-bottom:4px">Practice Area</label>
            <select id="customArea" style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;background:#fff">
              <option value="Immigration Law">Immigration Law</option>
              <option value="Personal Injury">Personal Injury</option>
              <option value="Business Law">Business Law</option>
              <option value="Estate Planning">Estate Planning</option>
              <option value="Real Estate">Real Estate</option>
              <option value="Landlord Tenant">Landlord / Tenant</option>
              <option value="Criminal Defense">Criminal Defense</option>
              <option value="General Legal">General Legal</option>
            </select>
          </div>
          <div>
            <label style="font-size:12px;color:#666;display:block;margin-bottom:4px">Source URL (optional)</label>
            <input id="customUrl" placeholder="https://uscis.gov/news/..."
              style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px">
          </div>
        </div>
        <div>
          <label style="font-size:12px;color:#666;display:block;margin-bottom:4px">Additional Notes (optional)</label>
          <input id="customNotes" placeholder="e.g. Focus on how this affects clients in California, mention consult availability"
            style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px">
        </div>
        <div>
          <button class="action-btn" id="customPostBtn" onclick="submitCustomPost()" style="padding:10px 24px">
            ✍️ Generate &amp; Publish Post
          </button>
          <span id="customPostMsg" style="margin-left:12px;font-size:13px;color:#006600"></span>
        </div>
      </div>
    </div>
    <div class="card">
      <h3>📅 Analytics History</h3>
      <div id="analyticsHistory"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>


  <!-- Pipeline -->
  <div class="page" id="page-pipeline">
    <div class="page-header"><h1>Lead Pipeline</h1><button class="logout-btn" onclick="logout()">Logout</button></div>
    <div style="margin-bottom:12px"><label style="font-size:13px;color:#666">Show:
      <select id="pipelineFilter" onchange="loadPipeline()" style="margin-left:6px;padding:4px 8px;border-radius:6px;border:1px solid #ddd">
        <option value="active">Active only</option><option value="all">All leads</option>
      </select></label></div>
    <div id="pipelineBoard" style="overflow-x:auto"><div class="loading"><span class="spinner"></span> Loading...</div></div>
  </div>
  <!-- Conflicts -->
  <div class="page" id="page-conflicts">
    <div class="page-header"><h1>Conflict Checks</h1><button class="logout-btn" onclick="logout()">Logout</button></div>
    <div class="card"><h3>⚠️ Potential Conflicts</h3>
      <p style="font-size:13px;color:#666;margin-bottom:16px">Auto-generated when a new intake name matches an existing client.</p>
      <div id="conflictsTable"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>
  <!-- Gaps -->
  <div class="page" id="page-questions">
    <div class="page-header"><h1>Knowledge Gaps</h1><button class="logout-btn" onclick="logout()">Logout</button></div>
    <div class="card"><h3>📊 Top Gaps This Week</h3>
      <p style="font-size:13px;color:#666;margin-bottom:16px">Questions Zara failed — fix in System Prompt.</p>
      <div id="questionsWeekly"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
    <div class="card"><h3>❓ All Open Questions</h3>
      <div id="questionsTable"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>
  <!-- Audit -->
  <div class="page" id="page-audit">
    <div class="page-header"><h1>Audit Log</h1><button class="logout-btn" onclick="logout()">Logout</button></div>
    <div class="card"><h3>📜 All Admin Actions</h3>
      <p style="font-size:13px;color:#666;margin-bottom:16px">Every login, prompt edit, lead move — ABA compliance record.</p>
      <div id="auditTable"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>
  <!-- Autoposter button in Analytics page -->

  <!-- Manual Post Creator -->
  <div class="page" id="page-post">
    <div class="page-header"><h1>Post Creator</h1><button class="logout-btn" onclick="logout()">Logout</button></div>
    <div class="card">
      <h3>📝 Create a Post</h3>
      <p style="font-size:13px;color:#666;margin-bottom:20px">
        Enter a topic, paste a news link, or describe what you want to post.
        Zara will write and publish it to WordPress just like the daily autoposter.
      </p>
      <div style="display:grid;gap:14px">
        <div>
          <label style="font-size:12px;font-weight:bold;color:#0C1C36;display:block;margin-bottom:6px">Topic or News Link *</label>
          <textarea id="postTopic" placeholder="e.g. &#39;New USCIS fee increase effective January 2026&#39; or paste a URL like https://uscis.gov/news/..." 
            style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:13px;height:80px;resize:vertical;font-family:Arial"></textarea>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          <div>
            <label style="font-size:12px;font-weight:bold;color:#0C1C36;display:block;margin-bottom:6px">Practice Area</label>
            <select id="postArea" style="width:100%;padding:9px;border:1px solid #ddd;border-radius:8px;font-size:13px">
              <option value="Immigration Law">Immigration Law</option>
              <option value="Personal Injury">Personal Injury</option>
              <option value="Business Law">Business Law</option>
              <option value="Estate Planning">Estate Planning</option>
              <option value="Real Estate">Real Estate</option>
              <option value="Landlord Tenant">Landlord/Tenant</option>
              <option value="General">General Legal</option>
            </select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:bold;color:#0C1C36;display:block;margin-bottom:6px">Language</label>
            <select id="postLang" style="width:100%;padding:9px;border:1px solid #ddd;border-radius:8px;font-size:13px">
              <option value="english">English only</option>
              <option value="all">English + Chinese + Spanish</option>
              <option value="chinese">English + Chinese</option>
              <option value="spanish">English + Spanish</option>
            </select>
          </div>
          <div>
            <label style="font-size:12px;font-weight:bold;color:#0C1C36;display:block;margin-bottom:6px">Research Web</label>
            <select id="postSearch" style="width:100%;padding:9px;border:1px solid #ddd;border-radius:8px;font-size:13px">
              <option value="true">Yes — search for latest info</option>
              <option value="false">No — use topic as-is</option>
            </select>
          </div>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold;color:#0C1C36;display:block;margin-bottom:6px">Additional Context (optional)</label>
          <input id="postContext" placeholder="Any extra details, key points to include, or specific angle..." 
            style="width:100%;padding:9px;border:1px solid #ddd;border-radius:8px;font-size:13px">
        </div>
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <button class="action-btn" id="postBtn" onclick="submitManualPost()">🚀 Generate &amp; Publish</button>
          <button class="action-btn" style="background:#555" id="previewBtn" onclick="previewManualPost()">👁 Preview First</button>
          <span id="postMsg" style="font-size:13px;color:#006600"></span>
        </div>
      </div>
    </div>

    <!-- Preview panel -->
    <div class="card" id="postPreviewCard" style="display:none">
      <h3>👁 Preview — Review Before Publishing</h3>
      <div id="postPreviewContent" style="font-size:13px;line-height:1.7;color:#333;white-space:pre-wrap;max-height:400px;overflow-y:auto;padding:12px;background:#fafafa;border-radius:6px;border:1px solid #eee"></div>
      <div style="margin-top:14px;display:flex;gap:10px">
        <button class="action-btn" id="publishBtn" onclick="publishPreview()">✅ Publish Now</button>
        <button class="action-btn" style="background:#cc0000" onclick="cancelPreview()">✕ Cancel</button>
      </div>
    </div>

    <div class="card">
      <h3>📋 Recent Manual Posts</h3>
      <div id="postHistory"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>

  <!-- Conversation Scores -->
  <div class="page" id="page-scores">
    <div class="page-header"><h1>Conversation Scores</h1><button class="logout-btn" onclick="logout()">Logout</button></div>
    <div class="card">
      <h3>🚨 Needs Review</h3>
      <p style="font-size:13px;color:#666;margin-bottom:16px">Conversations flagged for low quality, UPL risk, or missing disclaimers.</p>
      <div id="scoresFlagged"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
    <div class="card">
      <h3>🎯 All Scored Conversations</h3>
      <div id="scoresAll"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>

  <!-- SOL Tracker -->
  <div class="page" id="page-sol">
    <div class="page-header"><h1>SOL Deadline Tracker</h1><button class="logout-btn" onclick="logout()">Logout</button></div>
    <div class="card">
      <h3>➕ Add Deadline Manually</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:10px;align-items:end;margin-bottom:8px">
        <div><label style="font-size:12px;color:#666">Client Name</label><br>
          <input id="solName" placeholder="Full name" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px"></div>
        <div><label style="font-size:12px;color:#666">Case Type</label><br>
          <select id="solType" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px">
            <option value="personal_injury">Personal Injury</option>
            <option value="car_accident">Car Accident</option>
            <option value="slip_and_fall">Slip & Fall</option>
            <option value="medical_malpractice">Medical Malpractice</option>
            <option value="employment">Employment</option>
            <option value="contract">Contract</option>
            <option value="immigration">Immigration</option>
            <option value="wrongful_death">Wrongful Death</option>
            <option value="fraud">Fraud</option>
            <option value="defamation">Defamation</option>
          </select></div>
        <div><label style="font-size:12px;color:#666">Incident Date</label><br>
          <input id="solDate" type="date" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px"></div>
        <div><label style="font-size:12px;color:#666">Notes</label><br>
          <input id="solNotes" placeholder="Optional notes" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px"></div>
        <button class="action-btn" onclick="addSolDeadline()" style="padding:9px 16px;white-space:nowrap">+ Add</button>
      </div>
      <div id="solResult" style="font-size:13px;margin-top:8px"></div>
    </div>
    <div class="card">
      <h3>⚖️ Active Deadlines</h3>
      <p style="font-size:12px;color:#666;margin-bottom:12px">Alerts sent via Telegram at 90 / 30 / 7 / 1 days before deadline.</p>
      <div id="solTable"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>

  <!-- Drip Campaigns -->
  <div class="page" id="page-drip">
    <div class="page-header"><h1>Drip Campaigns</h1><button class="logout-btn" onclick="logout()">Logout</button></div>
    <div class="card">
      <h3>💧 Active Campaigns</h3>
      <p style="font-size:13px;color:#666;margin-bottom:16px">Auto-started after intake. Sends follow-ups at 1hr / 24hr / 3day / 7day. Stops when client responds or signs.</p>
      <div id="dripTable"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>

  <!-- Research Dashboard -->
  <div class="page" id="page-research">
    <div class="page-header">
      <h1>🔍 Legal Research</h1>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>

    <!-- Research sub-tabs -->
    <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;border-bottom:2px solid #e0d8c8;padding-bottom:12px">
      <button class="action-btn" id="rtab-cases" onclick="showResearchTab('cases')" style="font-size:12px;padding:8px 14px">⚖️ Cases</button>
      <button class="action-btn" id="rtab-statutes" onclick="showResearchTab('statutes')" style="font-size:12px;padding:8px 14px;opacity:.6">📚 Statutes</button>
      <button class="action-btn" id="rtab-verify" onclick="showResearchTab('verify')" style="font-size:12px;padding:8px 14px;opacity:.6">✅ Verify</button>
      <button class="action-btn" id="rtab-judge" onclick="showResearchTab('judge')" style="font-size:12px;padding:8px 14px;opacity:.6">📊 Judge Intel</button>
      <button class="action-btn" id="rtab-saved" onclick="showResearchTab('saved')" style="font-size:12px;padding:8px 14px;opacity:.6">⭐ Saved</button>
    </div>

    <!-- ═══════════════════════════════════════════════════════ -->
    <!-- TAB 1: CASE LAW SEARCH                                  -->
    <!-- Left: search controls + results | Right: case detail    -->
    <!-- Plus: judge intel right rail when case is selected      -->
    <!-- ═══════════════════════════════════════════════════════ -->
    <div id="rsub-cases">
      <div style="display:grid;grid-template-columns:1fr;gap:14px" id="cases-layout">

        <!-- Search panel -->
        <div class="card" id="cases-search-panel">
          <h3>⚖️ Caselaw Search</h3>
          <p style="font-size:11px;color:#666;margin-bottom:12px">CourtListener REST v4 with caching and judge cross-reference</p>

          <div style="display:flex;gap:10px;margin-bottom:10px">
            <input id="cs-query" placeholder="e.g. asylum nexus 9th circuit, demurrer breach contract..."
              style="flex:1;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:13px"
              onkeydown="if(event.key==='Enter') runCaseSearch()">
            <button class="action-btn" onclick="runCaseSearch()">Search</button>
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;font-size:11px">
            <select id="cs-area" style="padding:6px;border:1px solid #ddd;border-radius:4px;font-size:11px">
              <option value="">All practice areas</option>
              <option value="immigration">Immigration (BIA + 9th)</option>
              <option value="pi">Personal Injury (CA)</option>
              <option value="employment">Employment</option>
              <option value="real_estate">Real Estate</option>
              <option value="estate">Estate / Probate</option>
              <option value="public_entity">Public Entity / SEC</option>
            </select>
            <select id="cs-court-level" style="padding:6px;border:1px solid #ddd;border-radius:4px;font-size:11px">
              <option value="">Any court level</option>
              <option value="scotus">SCOTUS only</option>
              <option value="federal_appeals">Federal Appeals (all circuits)</option>
              <option value="federal_district">Federal District (CA)</option>
              <option value="california_state">California state courts</option>
              <option value="immigration">BIA + AG</option>
            </select>
            <input id="cs-date-from" type="date" style="padding:6px;border:1px solid #ddd;border-radius:4px;font-size:11px" placeholder="From">
            <input id="cs-date-to" type="date" style="padding:6px;border:1px solid #ddd;border-radius:4px;font-size:11px" placeholder="To">
            <input id="cs-judge" placeholder="Judge name (optional)" style="padding:6px;border:1px solid #ddd;border-radius:4px;font-size:11px;width:160px">
          </div>

          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
            <span style="font-size:10px;color:#888;align-self:center">Quick:</span>
            ${['asylum nexus particular social group','adverse credibility BIA','demurrer breach of contract','unlawful detainer notice','anti-SLAPP motion','VAWA self petition','dog bite strict liability'].map(q =>
              `<span onclick="document.getElementById('cs-query').value='${q.replace(/'/g, "\\'")}';runCaseSearch()" style="font-size:10px;background:#f0ede6;padding:3px 8px;border-radius:10px;cursor:pointer;color:#0C1C36">${q}</span>`
            ).join('')}
          </div>

          <div id="cs-loading" style="display:none;color:#999;font-size:13px;padding:10px"><span class="spinner"></span> Searching...</div>
          <div id="cs-results"></div>
        </div>

        <!-- Case detail (initially hidden, shown when result clicked) -->
        <div id="case-detail-panel" style="display:none">
          <div style="display:grid;grid-template-columns:1fr 320px;gap:14px">
            <!-- Left: case content -->
            <div class="card">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
                <div>
                  <h3 id="cd-case-name" style="margin-bottom:4px"></h3>
                  <div id="cd-citation" style="font-size:12px;color:#B79C62;background:rgba(183,156,98,.1);display:inline-block;padding:3px 10px;border-radius:4px;margin-bottom:6px"></div>
                  <div id="cd-meta" style="font-size:11px;color:#888"></div>
                </div>
                <button onclick="closeCaseDetail()" style="background:none;border:none;font-size:18px;cursor:pointer;color:#888">✕</button>
              </div>

              <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
                <button class="action-btn" onclick="saveCurrentCase()" style="font-size:11px;padding:6px 12px">⭐ Save</button>
                <button class="action-btn" onclick="useInBrief()" style="font-size:11px;padding:6px 12px">📝 Use in Brief</button>
                <button class="action-btn" onclick="copyCurrentCite()" style="font-size:11px;padding:6px 12px;background:#f0ede6;color:#0C1C36">📋 Copy Cite</button>
                <a id="cd-cl-link" href="#" target="_blank" class="action-btn" style="font-size:11px;padding:6px 12px;background:#0C1C36;color:#B79C62;text-decoration:none">🔗 CourtListener →</a>
              </div>

              <div id="cd-fulltext" style="background:#faf8f4;border:1px solid #e0d8c8;border-radius:6px;padding:14px;max-height:500px;overflow-y:auto;font-size:13px;line-height:1.6;color:#2a2a2a;font-family:Georgia,serif"></div>

              <h4 style="margin-top:18px;margin-bottom:8px;color:#0C1C36;font-size:13px">📚 Authorities Cited</h4>
              <div id="cd-authorities" style="font-size:12px;color:#555"></div>

              <h4 style="margin-top:18px;margin-bottom:8px;color:#0C1C36;font-size:13px">📈 Cited By</h4>
              <div id="cd-citedby" style="font-size:12px;color:#555"></div>
            </div>

            <!-- Right rail: Judge Intelligence (THE MOAT, always visible) -->
            <div>
              <div class="card" style="background:linear-gradient(180deg,#0C1C36 0%, #1a2c4a 100%);color:#f5f0e0">
                <h3 style="color:#B79C62;font-size:14px;margin-bottom:6px">📊 Judge Intelligence</h3>
                <p style="font-size:10px;color:rgba(245,240,224,.7);margin-bottom:14px">Firm-curated insights from your moat database</p>

                <div style="margin-bottom:14px">
                  <div style="font-size:10px;color:rgba(245,240,224,.6);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Pick judge to analyze</div>
                  <input id="ji-judge-name" placeholder="e.g. Wardlaw, Malphrus" list="ji-judge-options"
                    style="width:100%;padding:8px;border:none;border-radius:4px;font-size:13px;background:rgba(255,255,255,.95);color:#0C1C36"
                    onkeydown="if(event.key==='Enter') runJudgeIntel()">
                  <datalist id="ji-judge-options"></datalist>
                </div>

                <button onclick="runJudgeIntel()" style="width:100%;background:#B79C62;color:#0C1C36;border:none;padding:8px;border-radius:4px;font-weight:bold;font-size:12px;cursor:pointer;margin-bottom:12px">Analyze Against Current Case</button>

                <div id="ji-results" style="font-size:11px;color:#f5f0e0">
                  <div style="background:rgba(255,255,255,.06);border-radius:4px;padding:10px;font-size:11px;line-height:1.5;color:rgba(245,240,224,.7)">
                    Type a judge name above to see:<br>
                    <ul style="margin:6px 0 0 14px;padding:0">
                      <li>Has this judge cited this case before?</li>
                      <li>Top cases this judge relies on</li>
                      <li>How this judge typically treats this authority</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ -->
    <!-- TAB 2: STATUTES                                         -->
    <!-- ═══════════════════════════════════════════════════════ -->
    <div id="rsub-statutes" style="display:none">
      <div class="card">
        <h3>📚 Statute Lookup</h3>
        <p style="font-size:11px;color:#666;margin-bottom:14px">California codes (leginfo + Justia mirror) · U.S. Code · CFR · Federal Register</p>

        <div style="display:flex;gap:6px;margin-bottom:12px;font-size:12px">
          <button onclick="setStatuteType('ca')" id="stype-ca" class="action-btn" style="padding:6px 12px;font-size:11px">CA Code</button>
          <button onclick="setStatuteType('usc')" id="stype-usc" class="action-btn" style="padding:6px 12px;font-size:11px;background:#f0ede6;color:#0C1C36">U.S. Code</button>
          <button onclick="setStatuteType('cfr')" id="stype-cfr" class="action-btn" style="padding:6px 12px;font-size:11px;background:#f0ede6;color:#0C1C36">CFR</button>
          <button onclick="setStatuteType('fr')" id="stype-fr" class="action-btn" style="padding:6px 12px;font-size:11px;background:#f0ede6;color:#0C1C36">Fed Register</button>
        </div>

        <!-- CA Code form -->
        <div id="sform-ca">
          <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
            <select id="ca-code" style="padding:9px;border:1px solid #ddd;border-radius:4px;font-size:12px;min-width:200px">
              <option value="CCP">CCP — Code of Civil Procedure</option>
              <option value="CIV">CIV — Civil Code</option>
              <option value="EVID">EVID — Evidence Code</option>
              <option value="PEN">PEN — Penal Code</option>
              <option value="PROB">PROB — Probate Code</option>
              <option value="FAM">FAM — Family Code</option>
              <option value="LAB">LAB — Labor Code</option>
              <option value="GOV">GOV — Government Code</option>
              <option value="BPC">BPC — Business & Professions</option>
              <option value="VEH">VEH — Vehicle Code</option>
              <option value="HSC">HSC — Health & Safety</option>
              <option value="WIC">WIC — Welfare & Institutions</option>
              <option value="CORP">CORP — Corporations</option>
              <option value="INS">INS — Insurance</option>
              <option value="UIC">UIC — Unemployment Insurance</option>
              <option value="EDC">EDC — Education</option>
              <option value="PUC">PUC — Public Utilities</option>
              <option value="RTC">RTC — Revenue & Taxation</option>
            </select>
            <input id="ca-section" placeholder="Section (e.g. 335.1)" style="padding:9px;border:1px solid #ddd;border-radius:4px;font-size:12px;width:140px">
            <button class="action-btn" onclick="lookupStatute()">Look up</button>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <span style="font-size:10px;color:#888;align-self:center">Quick:</span>
            ${[['CCP','335.1'],['CCP','425.16'],['CCP','430.10'],['CCP','437c'],['CIV','3342'],['CIV','3294'],['CIV','1714'],['CIV','1946.2'],['PROB','16002'],['PEN','273.5'],['BPC','16600'],['LAB','2802']].map(([c,s]) =>
              `<span onclick="document.getElementById('ca-code').value='${c}';document.getElementById('ca-section').value='${s}';lookupStatute()" style="font-size:10px;background:#f0ede6;padding:3px 8px;border-radius:10px;cursor:pointer;color:#0C1C36">${c} §${s}</span>`
            ).join('')}
          </div>
        </div>

        <!-- USC form -->
        <div id="sform-usc" style="display:none">
          <div style="display:flex;gap:8px;margin-bottom:10px">
            <input id="usc-title" placeholder="Title (e.g. 8)" style="padding:9px;border:1px solid #ddd;border-radius:4px;font-size:12px;width:120px">
            <input id="usc-section" placeholder="Section (e.g. 1158)" style="padding:9px;border:1px solid #ddd;border-radius:4px;font-size:12px;width:160px">
            <button class="action-btn" onclick="lookupStatute()">Look up</button>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <span style="font-size:10px;color:#888;align-self:center">Quick:</span>
            ${[['8','1158','asylum'],['8','1229a','removal proceedings'],['8','1101','definitions'],['28','1331','federal question jx'],['42','1983','civil rights']].map(([t,s,desc]) =>
              `<span onclick="document.getElementById('usc-title').value='${t}';document.getElementById('usc-section').value='${s}';lookupStatute()" style="font-size:10px;background:#f0ede6;padding:3px 8px;border-radius:10px;cursor:pointer;color:#0C1C36" title="${desc}">${t} USC § ${s}</span>`
            ).join('')}
          </div>
        </div>

        <!-- CFR form -->
        <div id="sform-cfr" style="display:none">
          <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
            <input id="cfr-title" placeholder="Title (e.g. 8)" style="padding:9px;border:1px solid #ddd;border-radius:4px;font-size:12px;width:120px">
            <input id="cfr-part" placeholder="Part (e.g. 208)" style="padding:9px;border:1px solid #ddd;border-radius:4px;font-size:12px;width:120px">
            <input id="cfr-section" placeholder="Section (optional)" style="padding:9px;border:1px solid #ddd;border-radius:4px;font-size:12px;width:160px">
            <button class="action-btn" onclick="lookupStatute()">Look up</button>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <span style="font-size:10px;color:#888;align-self:center">Quick:</span>
            ${[['8','208','asylum'],['8','1003','BIA appeals'],['8','236','custody'],['8','1240','removal'],['8','274a','employment'],['28','1','federal procedure']].map(([t,p,desc]) =>
              `<span onclick="document.getElementById('cfr-title').value='${t}';document.getElementById('cfr-part').value='${p}';document.getElementById('cfr-section').value='';lookupStatute()" style="font-size:10px;background:#f0ede6;padding:3px 8px;border-radius:10px;cursor:pointer;color:#0C1C36" title="${desc}">${t} CFR ${p}</span>`
            ).join('')}
          </div>
        </div>

        <!-- Federal Register form -->
        <div id="sform-fr" style="display:none">
          <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
            <input id="fr-query" placeholder="Search term" style="padding:9px;border:1px solid #ddd;border-radius:4px;font-size:12px;flex:1"
              onkeydown="if(event.key==='Enter') lookupStatute()">
            <select id="fr-type" style="padding:9px;border:1px solid #ddd;border-radius:4px;font-size:12px">
              <option value="">All types</option>
              <option value="RULE">Final Rules</option>
              <option value="PRORULE">Proposed Rules</option>
              <option value="NOTICE">Notices</option>
            </select>
            <input id="fr-from" type="date" style="padding:9px;border:1px solid #ddd;border-radius:4px;font-size:12px">
            <button class="action-btn" onclick="lookupStatute()">Search</button>
          </div>
        </div>

        <div id="stat-loading" style="display:none;color:#999;font-size:13px;padding:10px"><span class="spinner"></span> Fetching...</div>
        <div id="stat-result" style="margin-top:14px"></div>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ -->
    <!-- TAB 3: VERIFY CITATION                                  -->
    <!-- ═══════════════════════════════════════════════════════ -->
    <div id="rsub-verify" style="display:none">
      <div class="card">
        <h3>✅ Citation Verifier</h3>
        <p style="font-size:11px;color:#666;margin-bottom:14px">Check citations against CourtListener (~9M opinions) + eyecite parser. Defends against AI hallucinations.</p>

        <div style="margin-bottom:14px">
          <textarea id="vf-text" rows="6" placeholder="Paste a paragraph, brief excerpt, or single citation. eyecite will find every cite and verify each one against CourtListener."
            style="width:100%;padding:12px;border:1px solid #ddd;border-radius:6px;font-size:13px;resize:vertical;font-family:Georgia,serif"></textarea>
          <button class="action-btn" onclick="runVerifyCitation()" style="margin-top:10px">Verify All Citations</button>
        </div>

        <div id="vf-loading" style="display:none;color:#999;font-size:13px;padding:10px"><span class="spinner"></span> Parsing and verifying...</div>
        <div id="vf-results"></div>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ -->
    <!-- TAB 4: JUDGE INTELLIGENCE                               -->
    <!-- Standalone judge research workspace                     -->
    <!-- ═══════════════════════════════════════════════════════ -->
    <div id="rsub-judge" style="display:none">
      <div class="card">
        <h3>📊 Judge Intelligence Workspace</h3>
        <p style="font-size:11px;color:#666;margin-bottom:14px">Cross-reference Layer 1 judge data — what authorities a judge relies on, how they treat specific cases, what they co-cite.</p>

        <div style="display:flex;gap:8px;margin-bottom:14px">
          <input id="jw-judge" placeholder="Judge name (e.g. Wardlaw, Malphrus, Owen)" list="jw-judge-list"
            style="flex:1;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:13px"
            onkeydown="if(event.key==='Enter') runJudgeWorkspace()">
          <datalist id="jw-judge-list"></datalist>
          <select id="jw-motion" style="padding:9px;border:1px solid #ddd;border-radius:4px;font-size:12px">
            <option value="">Any motion type</option>
            <option value="Asylum">Asylum</option>
            <option value="Continuance">Continuance</option>
            <option value="Cancellation">Cancellation of Removal</option>
            <option value="Suppression">Motion to Suppress</option>
            <option value="Reopen">Motion to Reopen</option>
            <option value="Summary Judgment">Summary Judgment</option>
            <option value="Anti-SLAPP">Anti-SLAPP</option>
            <option value="Demurrer">Demurrer</option>
          </select>
          <button class="action-btn" onclick="runJudgeWorkspace()">Analyze</button>
        </div>

        <div id="jw-loading" style="display:none;color:#999;font-size:13px;padding:10px"><span class="spinner"></span> Querying moat...</div>
        <div id="jw-results"></div>
      </div>

      <div class="card" style="margin-top:14px">
        <h3>🎯 Predict Treatment</h3>
        <p style="font-size:11px;color:#666;margin-bottom:12px">Given a judge and a case you're considering citing, predict how that judge would likely treat it.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input id="pt-judge" placeholder="Judge" style="padding:9px;border:1px solid #ddd;border-radius:6px;font-size:12px;width:160px">
          <input id="pt-case" placeholder="Case name (e.g. Cardoza-Fonseca)" style="padding:9px;border:1px solid #ddd;border-radius:6px;font-size:12px;flex:1;min-width:200px">
          <input id="pt-motion" placeholder="Motion type (optional)" style="padding:9px;border:1px solid #ddd;border-radius:6px;font-size:12px;width:160px">
          <button class="action-btn" onclick="runPredictTreatment()">Predict</button>
        </div>
        <div id="pt-result" style="margin-top:14px"></div>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════ -->
    <!-- TAB 5: SAVED CASES                                      -->
    <!-- ═══════════════════════════════════════════════════════ -->
    <div id="rsub-saved" style="display:none">
      <div class="card">
        <h3>⭐ Saved Research</h3>
        <p style="font-size:11px;color:#666;margin-bottom:14px">Cases, statutes, and other research saved during searches.</p>

        <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
          <select id="saved-filter-type" onchange="loadSaved()" style="padding:8px;border:1px solid #ddd;border-radius:6px;font-size:12px">
            <option value="">All types</option>
            <option value="case">Cases</option>
            <option value="statute">Statutes</option>
            <option value="reg">Regulations</option>
          </select>
          <input id="saved-filter-tag" placeholder="Filter by tag" onkeyup="if(event.key==='Enter')loadSaved()" style="padding:8px;border:1px solid #ddd;border-radius:6px;font-size:12px;width:160px">
          <button class="action-btn" onclick="loadSaved()" style="font-size:11px">Refresh</button>
        </div>

        <div id="saved-loading" style="display:none;color:#999;font-size:13px;padding:10px"><span class="spinner"></span> Loading...</div>
        <div id="saved-results"></div>
      </div>
    </div>

  </div>

</div>

<script>
// ═══════════════════════════════════════════════════════════════════
//   RESEARCH MODULE — Phase 1.5 Admin UI
// ═══════════════════════════════════════════════════════════════════

// ── State ──────────────────────────────────────────────────
const RES_API = '/admin/api/research';
let currentCase = null;       // {cluster_id, case_name, citation, ...}
let statuteType = 'ca';       // 'ca' | 'usc' | 'cfr' | 'fr'

// ── Tab switching ──────────────────────────────────────────
function showResearchTab(tab) {
  ['cases','statutes','verify','judge','saved'].forEach(t => {
    const sub = document.getElementById('rsub-' + t);
    const btn = document.getElementById('rtab-' + t);
    if (sub) sub.style.display = (t === tab) ? 'block' : 'none';
    if (btn) btn.style.opacity = (t === tab) ? '1' : '.6';
  });
  if (tab === 'saved') loadSaved();
  if (tab === 'judge') loadJudgeList();
}

// ═══════════════════════════════════════════════════════════════════
//   CASE LAW SEARCH
// ═══════════════════════════════════════════════════════════════════

async function runCaseSearch() {
  const q = document.getElementById('cs-query').value.trim();
  if (!q || q.length < 2) return;

  const params = new URLSearchParams({ q, page_size: '15' });
  const area = document.getElementById('cs-area').value;
  const courtLevel = document.getElementById('cs-court-level').value;
  const dateFrom = document.getElementById('cs-date-from').value;
  const dateTo = document.getElementById('cs-date-to').value;
  const judge = document.getElementById('cs-judge').value.trim();

  if (area) params.append('practice_area', area);
  if (courtLevel) params.append('court_level', courtLevel);
  if (dateFrom) params.append('date_from', dateFrom);
  if (dateTo) params.append('date_to', dateTo);
  if (judge) params.append('judge', judge);

  document.getElementById('cs-loading').style.display = 'block';
  document.getElementById('cs-results').innerHTML = '';
  document.getElementById('case-detail-panel').style.display = 'none';

  try {
    const resp = await fetch(RES_API + '/search?' + params);
    if (!resp.ok) throw new Error('Search failed: ' + resp.status);
    const data = await resp.json();
    const results = data.results || [];

    document.getElementById('cs-results').innerHTML = results.length
      ? '<div style="font-size:11px;color:#888;margin-bottom:8px">Showing ' + results.length + ' of ' + (data.total || results.length) + ' results</div>'
        + results.map(r => renderResultCard(r)).join('')
      : '<p style="color:#999;font-size:13px;padding:12px">No results. Try broader terms or remove filters.</p>';
  } catch (err) {
    document.getElementById('cs-results').innerHTML = '<p style="color:#cc0000;font-size:13px;padding:12px">❌ ' + esc(err.message) + '</p>';
  } finally {
    document.getElementById('cs-loading').style.display = 'none';
  }
}

function renderResultCard(r) {
  const id = r.cluster_id || r.opinion_id;
  return '<div onclick="openCaseDetail(\\'' + id + '\\')" style="background:#faf8f4;border:1px solid #e0d8c8;border-radius:8px;padding:14px;margin-bottom:10px;cursor:pointer;transition:border-color .15s" onmouseover="this.style.borderColor=\\'#B79C62\\'" onmouseout="this.style.borderColor=\\'#e0d8c8\\'">'
    + '<div style="font-weight:bold;color:#0C1C36;margin-bottom:4px">' + esc(r.case_name || 'Unknown') + '</div>'
    + (r.citation ? '<div style="font-size:11px;color:#B79C62;background:rgba(183,156,98,.1);display:inline-block;padding:2px 8px;border-radius:4px;margin-bottom:6px">' + esc(r.citation) + '</div>' : '')
    + '<div style="font-size:11px;color:#888;margin-bottom:6px">🏛️ ' + esc(r.court_id || r.court || '') + ' · 📅 ' + esc(r.date_filed || '') + (r.judge ? ' · 👨‍⚖️ ' + esc(r.judge) : '') + (r.cite_count ? ' · 📈 cited ' + r.cite_count + 'x' : '') + '</div>'
    + (r.snippet ? '<div style="font-size:12px;color:#555;font-style:italic;border-left:2px solid #B79C62;padding-left:8px;margin-bottom:4px">"' + esc(r.snippet.substring(0, 220)) + '..."</div>' : '')
    + '</div>';
}

async function openCaseDetail(clusterId) {
  document.getElementById('cs-loading').style.display = 'block';

  try {
    const resp = await fetch(RES_API + '/case/' + clusterId);
    if (!resp.ok) throw new Error('Failed to load case');
    const data = await resp.json();

    currentCase = data;

    document.getElementById('cd-case-name').textContent = data.case_name || 'Unknown case';
    const citationStr = (data.citations || []).map(c => c.volume + ' ' + c.reporter + ' ' + c.page).join('; ');
    document.getElementById('cd-citation').textContent = citationStr || 'No citation';
    document.getElementById('cd-meta').textContent = (data.court || '') + ' · ' + (data.date_filed || '') + (data.docket_number ? ' · ' + data.docket_number : '') + (data.judges ? ' · ' + data.judges : '');
    document.getElementById('cd-cl-link').href = data.url || '#';

    // Full text
    const ft = document.getElementById('cd-fulltext');
    if (data.full_text) {
      const cleanText = data.full_text.replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim();
      ft.textContent = cleanText.substring(0, 8000) + (cleanText.length > 8000 ? '… (truncated, view full on CourtListener)' : '');
    } else {
      ft.innerHTML = '<p style="color:#999">No full text available — ' + (data.url ? '<a href="' + data.url + '" target="_blank">view on CourtListener</a>' : 'try CourtListener directly') + '</p>';
    }

    // Authorities (cited by this case)
    const auth = data.authorities || [];
    document.getElementById('cd-authorities').innerHTML = auth.length
      ? auth.slice(0, 20).map(a => '<div style="padding:4px 0;border-bottom:1px solid #f0ede6">' + esc(a.cited_opinion__cluster__case_name || a.case_name || 'Unknown') + '</div>').join('')
      : '<span style="color:#999">No authorities indexed</span>';

    // Cited by
    const cb = data.cited_by || [];
    document.getElementById('cd-citedby').innerHTML = (cb.length || data.cite_count)
      ? '<div style="margin-bottom:8px"><strong>' + (data.cite_count || cb.length) + ' citing opinions</strong></div>'
        + cb.slice(0, 10).map(c => '<div style="padding:4px 0;border-bottom:1px solid #f0ede6">' + esc(c.citing_opinion__cluster__case_name || c.case_name || 'Unknown') + '</div>').join('')
      : '<span style="color:#999">Not cited yet by other indexed opinions</span>';

    // Show detail panel
    document.getElementById('case-detail-panel').style.display = 'block';
    document.getElementById('cases-search-panel').style.display = 'none';

    // Pre-populate judge intel rail with judges_in_firm_db_who_cited
    const firmJudges = data.judges_in_firm_db_who_cited || [];
    if (firmJudges.length > 0) {
      const ji = document.getElementById('ji-results');
      ji.innerHTML = '<div style="font-size:11px;color:rgba(245,240,224,.7);margin-bottom:8px">📍 <strong>' + firmJudges.length + ' judges in firm DB</strong> have cited this case:</div>'
        + firmJudges.slice(0, 5).map(j =>
          '<div onclick="document.getElementById(\\'ji-judge-name\\').value=\\'' + j.judge_name.replace(/\\\\/g,'\\\\\\\\').replace(/\\'/g,"\\\\\\'") + '\\';runJudgeIntel()" style="background:rgba(255,255,255,.06);padding:8px;border-radius:4px;margin-bottom:6px;cursor:pointer;border-left:3px solid #B79C62">'
          + '<div style="font-weight:bold;color:#f5f0e0">' + esc(j.judge_name) + '</div>'
          + '<div style="font-size:10px;color:rgba(245,240,224,.7);margin-top:2px">cited <strong>' + j.citation_count + '×</strong>'
          + (j.positive_count > 0 ? ' · ✓ ' + j.positive_count + ' positive' : '')
          + (j.distinguishes_count > 0 ? ' · ⚠️ ' + j.distinguishes_count + ' distinguished' : '')
          + (j.negative_count > 0 ? ' · ❌ ' + j.negative_count + ' negative' : '')
          + '</div></div>'
        ).join('')
        + (firmJudges.length > 5 ? '<div style="font-size:10px;color:rgba(245,240,224,.5);margin-top:6px">+ ' + (firmJudges.length - 5) + ' more</div>' : '');
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    alert('Error loading case: ' + err.message);
  } finally {
    document.getElementById('cs-loading').style.display = 'none';
  }
}

function closeCaseDetail() {
  document.getElementById('case-detail-panel').style.display = 'none';
  document.getElementById('cases-search-panel').style.display = 'block';
  currentCase = null;
}

function copyCurrentCite() {
  if (!currentCase) return;
  const citationStr = (currentCase.citations || []).map(c => c.volume + ' ' + c.reporter + ' ' + c.page).join('; ');
  const text = currentCase.case_name + (citationStr ? ', ' + citationStr : '');
  navigator.clipboard.writeText(text).then(() => alert('Copied: ' + text));
}

async function saveCurrentCase() {
  if (!currentCase) return;
  const tags = (prompt('Tags (comma-separated, optional):') || '').split(',').map(t=>t.trim()).filter(Boolean);
  const notes = prompt('Notes (optional):') || '';

  try {
    const citationStr = (currentCase.citations || []).map(c => c.volume + ' ' + c.reporter + ' ' + c.page).join('; ');
    const resp = await fetch(RES_API + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resource_type: 'case',
        resource_id: String(currentCase.cluster_id),
        cached_title: currentCase.case_name,
        cached_citation: citationStr,
        cached_url: currentCase.url,
        notes_md: notes,
        tags
      })
    });
    if (resp.ok) alert('✅ Saved');
    else alert('❌ Save failed');
  } catch (err) {
    alert('❌ ' + err.message);
  }
}

async function useInBrief() {
  if (!currentCase) return;
  alert('Brief generator integration coming soon. Case will be passed to Layer 3 brief-generator with judge cross-reference data.');
  // TODO: surface a modal asking for motion type, judge, opposition position, then call /use-in-brief
}

// ═══════════════════════════════════════════════════════════════════
//   JUDGE INTELLIGENCE (right rail on case detail)
// ═══════════════════════════════════════════════════════════════════

async function runJudgeIntel() {
  const judgeName = document.getElementById('ji-judge-name').value.trim();
  if (!judgeName || !currentCase) return;

  const ji = document.getElementById('ji-results');
  ji.innerHTML = '<div style="font-size:11px;color:rgba(245,240,224,.7)"><span class="spinner"></span> Querying moat...</div>';

  try {
    const citationStr = (currentCase.citations || []).map(c => c.volume + ' ' + c.reporter + ' ' + c.page).join(';') || '';

    // Parallel: has-cited + top-cited
    const [hcResp, tcResp] = await Promise.all([
      fetch(RES_API + '/judge/' + encodeURIComponent(judgeName) + '/has-cited?case_name=' + encodeURIComponent(currentCase.case_name) + (citationStr ? '&citation=' + encodeURIComponent(citationStr) : '')),
      fetch(RES_API + '/judge/' + encodeURIComponent(judgeName) + '/top-cited?limit=5')
    ]);

    const hc = await hcResp.json();
    const tc = await tcResp.json();

    let html = '';

    // Has cited?
    html += '<div style="background:rgba(183,156,98,.15);border-left:3px solid #B79C62;padding:10px;border-radius:4px;margin-bottom:10px">';
    if (hc.count > 0) {
      html += '<div style="font-weight:bold;color:#B79C62;font-size:12px">✓ Cited ' + hc.count + '× before</div>';
      const treatments = (hc.citations || []).map(c => c.treatment).filter(Boolean);
      if (treatments.length) {
        const counts = {};
        treatments.forEach(t => counts[t] = (counts[t] || 0) + 1);
        html += '<div style="font-size:10px;color:rgba(245,240,224,.8);margin-top:4px">' + Object.entries(counts).map(([t,c]) => t + ': ' + c).join(' · ') + '</div>';
      }
    } else {
      html += '<div style="font-weight:bold;color:rgba(245,240,224,.8);font-size:12px">✗ Not previously cited</div><div style="font-size:10px;color:rgba(245,240,224,.6);margin-top:4px">Judge has not cited this case in firm DB</div>';
    }
    html += '</div>';

    // Top cited cases by this judge
    if ((tc.cases || []).length > 0) {
      html += '<div style="font-size:11px;color:rgba(245,240,224,.7);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Top Authorities (this judge cites)</div>';
      html += (tc.cases || []).slice(0, 5).map(c =>
        '<div style="background:rgba(255,255,255,.06);padding:7px 8px;border-radius:4px;margin-bottom:5px;font-size:11px"><strong style="color:#f5f0e0">' + esc(c.cited_case_name || '') + '</strong>'
        + (c.cited_case_citation ? '<div style="color:rgba(245,240,224,.6);font-size:10px">' + esc(c.cited_case_citation) + '</div>' : '')
        + '<div style="color:#B79C62;font-size:10px;margin-top:2px">cited ' + c.times_cited + '×</div></div>'
      ).join('');
    }

    ji.innerHTML = html || '<div style="font-size:11px;color:rgba(245,240,224,.7);padding:10px;background:rgba(255,255,255,.06);border-radius:4px">No data on this judge in firm DB</div>';
  } catch (err) {
    ji.innerHTML = '<div style="color:#f4a;font-size:11px">❌ ' + esc(err.message) + '</div>';
  }
}

// ═══════════════════════════════════════════════════════════════════
//   STATUTES TAB
// ═══════════════════════════════════════════════════════════════════

function setStatuteType(type) {
  statuteType = type;
  ['ca','usc','cfr','fr'].forEach(t => {
    const f = document.getElementById('sform-' + t);
    const b = document.getElementById('stype-' + t);
    if (f) f.style.display = (t === type) ? 'block' : 'none';
    if (b) {
      b.style.background = (t === type) ? '' : '#f0ede6';
      b.style.color = (t === type) ? '' : '#0C1C36';
    }
  });
  document.getElementById('stat-result').innerHTML = '';
}

async function lookupStatute() {
  let url;
  if (statuteType === 'ca') {
    const code = document.getElementById('ca-code').value;
    const section = document.getElementById('ca-section').value.trim();
    if (!section) return;
    url = RES_API + '/statute/ca/' + code + '/' + encodeURIComponent(section);
  } else if (statuteType === 'usc') {
    const t = document.getElementById('usc-title').value.trim();
    const s = document.getElementById('usc-section').value.trim();
    if (!t || !s) return;
    url = RES_API + '/statute/usc/' + encodeURIComponent(t) + '/' + encodeURIComponent(s);
  } else if (statuteType === 'cfr') {
    const t = document.getElementById('cfr-title').value.trim();
    const p = document.getElementById('cfr-part').value.trim();
    const s = document.getElementById('cfr-section').value.trim();
    if (!t || !p) return;
    url = RES_API + '/statute/cfr/' + encodeURIComponent(t) + '/' + encodeURIComponent(p) + (s ? '/' + encodeURIComponent(s) : '');
  } else if (statuteType === 'fr') {
    const params = new URLSearchParams();
    const q = document.getElementById('fr-query').value.trim();
    const ty = document.getElementById('fr-type').value;
    const fr = document.getElementById('fr-from').value;
    if (q) params.append('query', q);
    if (ty) params.append('type', ty);
    if (fr) params.append('from', fr);
    url = RES_API + '/federal-register?' + params;
  }

  document.getElementById('stat-loading').style.display = 'block';
  document.getElementById('stat-result').innerHTML = '';

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error((await resp.json()).error || 'Lookup failed');
    const data = await resp.json();

    if (statuteType === 'fr') {
      const docs = data.results || [];
      document.getElementById('stat-result').innerHTML = docs.length
        ? '<div style="font-size:11px;color:#888;margin-bottom:8px">' + docs.length + ' results</div>'
          + docs.slice(0, 15).map(d =>
            '<div style="background:#faf8f4;border:1px solid #e0d8c8;border-radius:6px;padding:12px;margin-bottom:8px">'
            + '<div style="font-weight:bold;color:#0C1C36;margin-bottom:3px">' + esc(d.title || '') + '</div>'
            + '<div style="font-size:10px;color:#888;margin-bottom:6px">' + esc(d.publication_date || '') + ' · ' + esc(d.type || '') + ' · ' + esc((d.agencies || []).map(a=>a.name).join(', ')) + '</div>'
            + '<div style="font-size:12px;color:#555">' + esc((d.abstract || '').substring(0, 240)) + '</div>'
            + '<a href="' + esc(d.html_url || '#') + '" target="_blank" style="font-size:11px;background:#0C1C36;color:#B79C62;padding:4px 10px;border-radius:4px;text-decoration:none;display:inline-block;margin-top:8px">📄 Read →</a>'
            + '</div>'
          ).join('')
        : '<p style="color:#999;font-size:13px">No results.</p>';
    } else {
      // CA / USC / CFR statute display
      const text = data.text || data.title_text || '(no text — try official URL)';
      const officialUrl = data.url || data.official_url || data.cornell_url || '#';
      document.getElementById('stat-result').innerHTML =
        '<div style="background:#faf8f4;border:1px solid #e0d8c8;border-radius:8px;padding:18px">'
        + '<div style="font-weight:bold;color:#B79C62;font-size:14px;margin-bottom:8px">📚 ' + esc(data.title || data.code_name || '') + '</div>'
        + (data.breadcrumbs ? '<div style="font-size:10px;color:#888;margin-bottom:10px;font-style:italic">' + esc(data.breadcrumbs) + '</div>' : '')
        + '<div style="white-space:pre-wrap;font-family:Georgia,serif;font-size:13px;color:#0C1C36;line-height:1.7;border-left:3px solid #B79C62;padding-left:14px;margin-bottom:14px">' + esc(text.substring(0, 8000)) + (text.length > 8000 ? '…' : '') + '</div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
        + (officialUrl ? '<a href="' + esc(officialUrl) + '" target="_blank" style="font-size:11px;background:#0C1C36;color:#B79C62;padding:5px 12px;border-radius:4px;text-decoration:none">🔗 Official source →</a>' : '')
        + (data.justia_url ? '<a href="' + esc(data.justia_url) + '" target="_blank" style="font-size:11px;background:#f0ede6;color:#0C1C36;padding:5px 12px;border-radius:4px;text-decoration:none">📖 Justia mirror →</a>' : '')
        + (data.cornell_url ? '<a href="' + esc(data.cornell_url) + '" target="_blank" style="font-size:11px;background:#f0ede6;color:#0C1C36;padding:5px 12px;border-radius:4px;text-decoration:none">📖 Cornell LII →</a>' : '')
        + '<button onclick="navigator.clipboard.writeText(' + JSON.stringify(text.substring(0,5000)) + ')" style="font-size:11px;background:#f0ede6;color:#0C1C36;border:none;padding:5px 12px;border-radius:4px;cursor:pointer">📋 Copy text</button>'
        + '</div>'
        + (data.note ? '<p style="font-size:10px;color:#aaa;margin-top:10px">' + esc(data.note) + '</p>' : '')
        + '</div>';
    }
  } catch (err) {
    document.getElementById('stat-result').innerHTML = '<p style="color:#cc0000;font-size:13px;padding:12px">❌ ' + esc(err.message) + '</p>';
  } finally {
    document.getElementById('stat-loading').style.display = 'none';
  }
}

// ═══════════════════════════════════════════════════════════════════
//   VERIFY CITATION
// ═══════════════════════════════════════════════════════════════════

async function runVerifyCitation() {
  const text = document.getElementById('vf-text').value.trim();
  if (!text) return;

  document.getElementById('vf-loading').style.display = 'block';
  document.getElementById('vf-results').innerHTML = '';

  try {
    const resp = await fetch(RES_API + '/verify-citation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await resp.json();

    const verified = data.verified || [];
    const extracted = data.extracted_full || [];

    let html = '<div style="background:#faf8f4;border-radius:8px;padding:14px;margin-bottom:14px"><strong>Found ' + verified.length + ' citation' + (verified.length === 1 ? '' : 's') + '</strong></div>';

    if (verified.length === 0) {
      html += '<p style="color:#999;font-size:13px;padding:12px">No citations matched in CourtListener. Either none present in the text, or none recognizable to the citation parser.</p>';
    } else {
      html += verified.map(v => {
        const found = (v.clusters || []).length > 0;
        const cluster = found ? v.clusters[0] : null;
        const bg = found ? 'rgba(39,174,96,.06)' : 'rgba(192,57,43,.06)';
        const border = found ? 'rgba(39,174,96,.3)' : 'rgba(192,57,43,.3)';
        return '<div style="background:' + bg + ';border:1px solid ' + border + ';border-radius:6px;padding:12px;margin-bottom:8px;font-size:13px">'
          + (found ? '✅ ' : '❌ ')
          + '<strong style="font-family:monospace">' + esc(v.citation || '') + '</strong>'
          + (cluster
              ? '<div style="margin-top:6px"><div>' + esc(cluster.case_name || '') + '</div>'
                + '<div style="font-size:11px;color:#888">' + esc(cluster.court || '') + ' · ' + esc(cluster.date_filed || '') + '</div>'
                + '<a href="https://www.courtlistener.com/opinion/' + cluster.id + '/" target="_blank" style="font-size:11px;color:#0C1C36;text-decoration:underline">View →</a></div>'
              : '<div style="margin-top:6px;font-size:11px;color:#cc0000">⚠️ Not found in CourtListener — verify before filing</div>'
            )
          + '</div>';
      }).join('');
    }

    if (extracted.length > 0) {
      html += '<div style="margin-top:18px;padding-top:14px;border-top:1px solid #e0d8c8"><strong style="font-size:12px">eyecite parser also found ' + extracted.length + ' citation' + (extracted.length === 1 ? '' : 's') + ':</strong>';
      html += '<div style="font-size:11px;margin-top:8px">' + extracted.slice(0, 20).map(c =>
        '<div style="padding:4px 0">'
        + '<span style="font-family:monospace">' + esc(c.cite || '') + '</span>'
        + ' <span style="color:#888;font-size:10px">[' + esc(c.type || '') + (c.year ? ', ' + c.year : '') + ']</span>'
        + (c.parenthetical ? '<div style="color:#555;font-style:italic;margin-left:14px">"' + esc(c.parenthetical) + '"</div>' : '')
        + (c.treatment && c.treatment !== 'neutral' ? '<span style="font-size:10px;background:' + (c.treatment === 'positive' ? '#d4edda' : '#fff3cd') + ';padding:2px 6px;border-radius:3px;margin-left:6px">' + esc(c.treatment) + '</span>' : '')
        + '</div>'
      ).join('') + '</div></div>';
    }

    document.getElementById('vf-results').innerHTML = html;
  } catch (err) {
    document.getElementById('vf-results').innerHTML = '<p style="color:#cc0000;font-size:13px;padding:12px">❌ ' + esc(err.message) + '</p>';
  } finally {
    document.getElementById('vf-loading').style.display = 'none';
  }
}

// ═══════════════════════════════════════════════════════════════════
//   JUDGE INTELLIGENCE WORKSPACE (Tab 4)
// ═══════════════════════════════════════════════════════════════════

async function loadJudgeList() {
  // Populate datalist with judge names from local moat for autocomplete
  // (not blocking — fetch async, fail silently if endpoint not ready)
  try {
    const judges = ['Wardlaw','Malphrus','Goodwin','Owen','Greer','Holmes','Pauley','Grant','Osuna','Hurwitz'];
    const dl = document.getElementById('jw-judge-list');
    if (dl) dl.innerHTML = judges.map(j => '<option value="' + j + '">').join('');
    const dl2 = document.getElementById('ji-judge-options');
    if (dl2) dl2.innerHTML = judges.map(j => '<option value="' + j + '">').join('');
  } catch {}
}

async function runJudgeWorkspace() {
  const judge = document.getElementById('jw-judge').value.trim();
  if (!judge) return;
  const motion = document.getElementById('jw-motion').value;

  document.getElementById('jw-loading').style.display = 'block';
  document.getElementById('jw-results').innerHTML = '';

  try {
    const params = new URLSearchParams({ limit: '30' });
    if (motion) params.append('motion', motion);
    const resp = await fetch(RES_API + '/judge/' + encodeURIComponent(judge) + '/top-cited?' + params);
    const data = await resp.json();
    const cases = data.cases || [];

    let html = '<div style="background:#faf8f4;border-radius:8px;padding:14px;margin-bottom:14px"><strong>' + cases.length + ' authorities</strong> ' + esc(judge) + ' relies on most' + (motion ? ' for <em>' + esc(motion) + '</em>' : '') + '</div>';

    if (cases.length === 0) {
      html += '<p style="color:#999;font-size:13px;padding:12px">No data for this judge yet. Layer 1 may not have indexed their rulings, or the motion type filter is too restrictive.</p>';
    } else {
      html += cases.map((c, i) =>
        '<div style="background:#faf8f4;border:1px solid #e0d8c8;border-radius:6px;padding:12px;margin-bottom:8px">'
        + '<div style="display:flex;justify-content:space-between;align-items:flex-start">'
        + '<div style="flex:1">'
        + '<div style="font-weight:bold;color:#0C1C36">' + (i + 1) + '. ' + esc(c.cited_case_name || 'Unknown') + '</div>'
        + (c.cited_case_citation ? '<div style="font-size:11px;color:#B79C62;margin-top:2px">' + esc(c.cited_case_citation) + '</div>' : '')
        + '</div>'
        + '<div style="text-align:right;font-size:12px;color:#0C1C36;font-weight:bold;background:rgba(183,156,98,.15);padding:4px 10px;border-radius:4px">cited ' + c.times_cited + '×</div>'
        + '</div>'
        + (c.sample_parentheticals && c.sample_parentheticals.length
          ? '<div style="margin-top:8px;font-size:11px;font-style:italic;color:#555;border-left:2px solid #B79C62;padding-left:8px">"' + esc(c.sample_parentheticals[0].substring(0, 200)) + '..."</div>'
          : '')
        + (c.cited_cluster_id
          ? '<div style="margin-top:8px"><a onclick="openCaseDetail(\\'' + c.cited_cluster_id + '\\');showResearchTab(\\'cases\\')" style="font-size:11px;color:#0C1C36;cursor:pointer;text-decoration:underline">View case →</a></div>'
          : '')
        + '</div>'
      ).join('');
    }

    document.getElementById('jw-results').innerHTML = html;
  } catch (err) {
    document.getElementById('jw-results').innerHTML = '<p style="color:#cc0000;font-size:13px;padding:12px">❌ ' + esc(err.message) + '</p>';
  } finally {
    document.getElementById('jw-loading').style.display = 'none';
  }
}

async function runPredictTreatment() {
  const judge = document.getElementById('pt-judge').value.trim();
  const caseName = document.getElementById('pt-case').value.trim();
  const motion = document.getElementById('pt-motion').value.trim();
  if (!judge || !caseName) return;

  const out = document.getElementById('pt-result');
  out.innerHTML = '<div style="color:#999;font-size:13px"><span class="spinner"></span> Predicting...</div>';

  try {
    const resp = await fetch(RES_API + '/predict-treatment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ judge_name: judge, case_name: caseName, motion_type: motion || null })
    });
    const data = await resp.json();

    const colors = { HIGH: '#27ae60', MEDIUM: '#f39c12', LOW: '#999' };
    out.innerHTML =
      '<div style="background:#faf8f4;border:1px solid #e0d8c8;border-radius:8px;padding:14px">'
      + '<div style="display:flex;justify-content:space-between;margin-bottom:10px"><strong>Prediction</strong>'
      + '<span style="background:' + (colors[data.confidence] || '#999') + ';color:white;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:bold">' + (data.confidence || 'LOW') + '</span></div>'
      + '<p style="font-size:13px;color:#0C1C36;margin-bottom:12px">' + esc(data.summary || '') + '</p>'
      + (data.prior_citations && data.prior_citations.length
        ? '<div style="margin-top:10px"><strong style="font-size:12px">Prior citations:</strong><div style="font-size:11px;margin-top:6px">'
          + data.prior_citations.slice(0, 3).map(p =>
            '<div style="padding:6px 8px;background:white;border-radius:4px;margin-bottom:4px">'
            + (p.parenthetical ? '<em>"' + esc(p.parenthetical) + '"</em>' : '<span style="color:#888">no parenthetical</span>')
            + (p.treatment ? '<div style="font-size:10px;color:#B79C62;margin-top:2px">' + esc(p.treatment) + '</div>' : '')
            + '</div>'
          ).join('') + '</div></div>'
        : '')
      + '</div>';
  } catch (err) {
    out.innerHTML = '<p style="color:#cc0000;font-size:13px">❌ ' + esc(err.message) + '</p>';
  }
}

// ═══════════════════════════════════════════════════════════════════
//   SAVED CASES
// ═══════════════════════════════════════════════════════════════════

async function loadSaved() {
  const params = new URLSearchParams();
  const type = document.getElementById('saved-filter-type').value;
  const tag = document.getElementById('saved-filter-tag').value.trim();
  if (type) params.append('type', type);
  if (tag) params.append('tag', tag);

  document.getElementById('saved-loading').style.display = 'block';
  document.getElementById('saved-results').innerHTML = '';

  try {
    const resp = await fetch(RES_API + '/saved?' + params);
    const items = await resp.json();

    document.getElementById('saved-results').innerHTML = items.length
      ? items.map(it => {
          const ico = { case: '⚖️', statute: '📚', reg: '📋', form: '📝', brief: '📄' }[it.resource_type] || '📌';
          return '<div style="background:#faf8f4;border:1px solid #e0d8c8;border-radius:6px;padding:12px;margin-bottom:8px">'
            + '<div style="display:flex;justify-content:space-between;margin-bottom:6px">'
            + '<div style="font-weight:bold;color:#0C1C36">' + ico + ' ' + esc(it.cached_title || it.resource_id) + '</div>'
            + '<button onclick="deleteSaved(' + it.id + ')" style="background:none;border:none;color:#cc0000;cursor:pointer;font-size:11px">✕ Delete</button>'
            + '</div>'
            + (it.cached_citation ? '<div style="font-size:11px;color:#B79C62;margin-bottom:4px">' + esc(it.cached_citation) + '</div>' : '')
            + ((it.tags || []).length ? '<div style="margin-bottom:6px">' + it.tags.map(t => '<span style="font-size:10px;background:#f0ede6;color:#0C1C36;padding:2px 8px;border-radius:10px;margin-right:4px">' + esc(t) + '</span>').join('') + '</div>' : '')
            + (it.notes_md ? '<div style="font-size:11px;color:#555;font-style:italic">' + esc(it.notes_md) + '</div>' : '')
            + (it.cached_url ? '<div style="margin-top:8px"><a href="' + esc(it.cached_url) + '" target="_blank" style="font-size:11px;color:#0C1C36;text-decoration:underline">View →</a>' + (it.resource_type === 'case' ? '<a onclick="openCaseDetail(\\'' + it.resource_id + '\\');showResearchTab(\\'cases\\')" style="font-size:11px;color:#0C1C36;text-decoration:underline;cursor:pointer;margin-left:10px">Open in research →</a>' : '') + '</div>' : '')
            + '</div>';
        }).join('')
      : '<p style="color:#999;font-size:13px;padding:12px">No saved items. Click ⭐ Save on any case detail view to save it here.</p>';
  } catch (err) {
    document.getElementById('saved-results').innerHTML = '<p style="color:#cc0000;font-size:13px">❌ ' + esc(err.message) + '</p>';
  } finally {
    document.getElementById('saved-loading').style.display = 'none';
  }
}

async function deleteSaved(id) {
  if (!confirm('Delete this saved item?')) return;
  try {
    await fetch(RES_API + '/save/' + id, { method: 'DELETE' });
    loadSaved();
  } catch (err) {
    alert('❌ ' + err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
//   UTILITY
// ═══════════════════════════════════════════════════════════════════

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
</script>

<script src="/admin/panel.js"></script>
</body>
</html>`;
}

module.exports = { router, handleAdminCallback, initPromptTable, getSavedPrompt, requireAuth };
