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
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours
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
          document.cookie = 'admin_token=' + data.token + '; path=/; max-age=28800; SameSite=Strict';
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
  <div class="nav-item" onclick="showPage('poster')" id="nav-poster">
    <span class="icon">✍️</span><span>Manual Post</span>
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
  <div class="nav-item" onclick="showPage('research')" id="nav-research">
    <span class="icon">🔍</span><span>Research</span>
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


  <!-- Manual Post -->
  <div class="page" id="page-poster">
    <div class="page-header">
      <h1>Manual Post</h1>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
    <div class="card">
      <h3>✍️ Write &amp; Publish a Post</h3>
      <p style="font-size:13px;color:#666;margin-bottom:20px">
        Paste an article, news link, or write your own content. Zara will write a full SEO post
        and publish to WordPress in <strong>English + Chinese + Spanish</strong>. Takes ~1–2 minutes.
      </p>

      <div style="display:grid;gap:14px;max-width:800px">

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label style="font-size:12px;font-weight:bold;color:#0C1C36;display:block;margin-bottom:5px">
              Practice Area
            </label>
            <select id="posterArea" style="width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;background:#fff">
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
            <label style="font-size:12px;font-weight:bold;color:#0C1C36;display:block;margin-bottom:5px">
              Source URL <span style="font-weight:normal;color:#999">(optional — paste a news link)</span>
            </label>
            <input id="posterUrl" placeholder="https://uscis.gov/news/..." 
              style="width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px">
          </div>
        </div>

        <div>
          <label style="font-size:12px;font-weight:bold;color:#0C1C36;display:block;margin-bottom:5px">
            Topic / Content <span style="color:#cc0000">*</span>
            <span style="font-weight:normal;color:#999"> — paste an article, headline, or describe what to write</span>
          </label>
          <textarea id="posterContent" rows="10"
            placeholder="Examples:&#10;• USCIS announces new fee increases effective January 2026&#10;• Paste the full text of a news article here&#10;• Write about how the new H-1B lottery rules affect tech workers in California&#10;• California AB 1234 changes eviction procedures for landlords"
            style="width:100%;padding:12px;border:1px solid #ddd;border-radius:6px;font-size:13px;font-family:Arial,sans-serif;line-height:1.5;resize:vertical;outline:none;color:#0C1C36"></textarea>
        </div>

        <div>
          <label style="font-size:12px;font-weight:bold;color:#0C1C36;display:block;margin-bottom:5px">
            Instructions for Zara <span style="font-weight:normal;color:#999">(optional)</span>
          </label>
          <input id="posterNotes" placeholder="e.g. Focus on how this affects clients in West Covina, mention free consultations available"
            style="width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px">
        </div>

        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <button class="action-btn" id="posterBtn" onclick="submitManualPost()" style="padding:12px 28px;font-size:14px">
            ✍️ Generate &amp; Publish
          </button>
          <span id="posterMsg" style="font-size:13px"></span>
        </div>

        <div id="posterResult" style="display:none;padding:16px;background:#f0fff4;border:1px solid #b2dfdb;border-radius:8px;font-size:13px"></div>
      </div>
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
    <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap">
      <button class="action-btn" id="rtab-caselaw" onclick="showResearchTab('caselaw')" style="font-size:12px;padding:8px 14px">⚖️ Case Law</button>
      <button class="action-btn" id="rtab-statutes" onclick="showResearchTab('statutes')" style="font-size:12px;padding:8px 14px;opacity:.6">📚 CA Statutes</button>
      <button class="action-btn" id="rtab-immigration" onclick="showResearchTab('immigration')" style="font-size:12px;padding:8px 14px;opacity:.6">🛂 Immigration</button>
      <button class="action-btn" id="rtab-verify" onclick="showResearchTab('verify')" style="font-size:12px;padding:8px 14px;opacity:.6">✅ Verify Citation</button>
      <button class="action-btn" id="rtab-cache" onclick="showResearchTab('cache')" style="font-size:12px;padding:8px 14px;opacity:.6">⚡ Answer Cache</button>
    </div>

    <!-- Case Law Search -->
    <div id="rsub-caselaw">
      <div class="card">
        <h3>⚖️ California Case Law Search</h3>
        <p style="font-size:12px;color:#666;margin-bottom:14px">Powered by CourtListener REST API v4 — Free Law Project | ~9M decisions</p>
        <div style="display:flex;gap:10px;margin-bottom:12px">
          <input id="cl-query" placeholder="e.g. demurrer breach of contract, unlawful detainer notice, asylum credibility..."
            style="flex:1;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:13px"
            onkeydown="if(event.key==='Enter') runAdminCLSearch()">
          <button class="action-btn" onclick="runAdminCLSearch()">Search</button>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
          <select id="cl-area" style="padding:8px;border:1px solid #ddd;border-radius:6px;font-size:12px">
            <option value="cal,calctapp_1st,calctapp_2nd,calctapp_3rd,calctapp_4th,calctapp_5th,calctapp_6th">California Civil</option>
            <option value="ca9,bia">Immigration (9th/BIA)</option>
            <option value="ca9,cacd,caed">Federal (CA Districts)</option>
            <option value="cal,calctapp_1st,calctapp_2nd,calctapp_3rd,calctapp_4th,calctapp_5th,calctapp_6th,ca9,bia">All Courts</option>
          </select>
          <select id="cl-date" style="padding:8px;border:1px solid #ddd;border-radius:6px;font-size:12px">
            <option value="2015-01-01">Last 10 years</option>
            <option value="2010-01-01" selected>Last 15 years</option>
            <option value="2000-01-01">Last 25 years</option>
          </select>
          <select id="cl-sort" style="padding:8px;border:1px solid #ddd;border-radius:6px;font-size:12px">
            <option value="score">Relevance</option>
            <option value="-dateFiled">Most Recent</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
          ${['demurrer breach of contract','unlawful detainer 3-day notice','comparative negligence personal injury','asylum credibility BIA','voluntary departure 9th circuit','living trust probate California','anti-SLAPP motion','non-compete void California'].map(q =>
            `<span onclick="document.getElementById('cl-query').value='${q}';runAdminCLSearch()"
              style="font-size:11px;background:#f0ede6;padding:4px 10px;border-radius:12px;cursor:pointer;color:#0C1C36">${q}</span>`
          ).join('')}
        </div>
        <div id="cl-warning" style="display:none;background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px;font-size:12px;margin-bottom:12px;color:#856404">
          ⚠️ Always verify citations in vLex Fastcase before filing. CourtListener does not provide citator/good-law status.
        </div>
        <div id="cl-loading" style="display:none;color:#999;font-size:13px;padding:10px"><span class="spinner"></span> Searching CourtListener...</div>
        <div id="cl-results"></div>
      </div>
    </div>

    <!-- CA Statutes -->
    <div id="rsub-statutes" style="display:none">
      <div class="card">
        <h3>📚 California Statute Lookup</h3>
        <p style="font-size:12px;color:#666;margin-bottom:14px">Official text from leginfo.legislature.ca.gov — public domain under Gov. Code §10248.5</p>
        <div style="display:flex;gap:10px;margin-bottom:14px">
          <input id="stat-query" placeholder="e.g. CCP 430.10, Civil Code 1714, demurrer, unlawful detainer..."
            style="flex:1;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:13px"
            onkeydown="if(event.key==='Enter') runAdminStatLookup()">
          <button class="action-btn" onclick="runAdminStatLookup()">Look Up</button>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
          ${[['CCP','430.10'],['CCP','430.41'],['CCP','437c'],['CCP','335.1'],['CCP','1161'],['CIV','1946.2'],['CIV','3294'],['PROB','15200'],['BPC','16600'],['GOV','911.2']].map(([c,s]) =>
            `<span onclick="adminStatLookup('${c}','${s}')"
              style="font-size:11px;background:#f0ede6;padding:4px 10px;border-radius:12px;cursor:pointer;color:#0C1C36">${c} §${s}</span>`
          ).join('')}
        </div>
        <div id="stat-loading" style="display:none;color:#999;font-size:13px;padding:10px"><span class="spinner"></span> Fetching from leginfo.ca.gov...</div>
        <div id="stat-results"></div>
      </div>
    </div>

    <!-- Immigration Research -->
    <div id="rsub-immigration" style="display:none">
      <div class="card">
        <h3>🛂 Immigration Research — 9th Circuit + BIA</h3>
        <div style="display:flex;gap:10px;margin-bottom:12px">
          <input id="imm-query" placeholder="e.g. asylum credibility adverse findings, CAT deferral, voluntary departure bond..."
            style="flex:1;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:13px"
            onkeydown="if(event.key==='Enter') runAdminImmSearch()">
          <button class="action-btn" onclick="runAdminImmSearch()">Search</button>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
          ${['asylum one year bar exception','BIA adverse credibility inconsistencies','voluntary departure bond deadline','motion to reopen in absentia','withholding removal PSG','CAT deferral torture','BIA Lozada IAC','9th circuit PFR jurisdiction','VAWA self petition','cancellation of removal continuous presence'].map(q =>
            `<span onclick="document.getElementById('imm-query').value='${q}';runAdminImmSearch()"
              style="font-size:11px;background:#f0ede6;padding:4px 10px;border-radius:12px;cursor:pointer;color:#0C1C36">${q}</span>`
          ).join('')}
        </div>
        <div id="imm-loading" style="display:none;color:#999;font-size:13px;padding:10px"><span class="spinner"></span> Searching 9th Circuit + BIA...</div>
        <div id="imm-results"></div>
      </div>
    </div>

    <!-- Citation Verifier -->
    <div id="rsub-verify" style="display:none">
      <div class="card">
        <h3>✅ Citation Verifier</h3>
        <p style="font-size:12px;color:#666;margin-bottom:14px">Anti-hallucination check — confirm any case citation exists before using in filings</p>
        <div style="display:flex;gap:10px;margin-bottom:12px">
          <input id="cite-query" placeholder="e.g. 230 Cal.App.4th 1234, or Smith v. Jones 2019"
            style="flex:1;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:13px"
            onkeydown="if(event.key==='Enter') runAdminVerify()">
          <button class="action-btn" onclick="runAdminVerify()">Verify</button>
        </div>
        <div id="cite-loading" style="display:none;color:#999;font-size:13px;padding:10px"><span class="spinner"></span> Checking CourtListener...</div>
        <div id="cite-result"></div>
        <div class="card" style="margin-top:16px;background:#faf8f4">
          <h3>Batch Verify</h3>
          <textarea id="batch-cites" rows="5" placeholder="Paste citations one per line..."
            style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:13px;resize:vertical;margin-bottom:8px"></textarea>
          <button class="action-btn" onclick="runAdminBatch()">Verify All</button>
          <div id="batch-results" style="margin-top:12px"></div>
        </div>
      </div>
    </div>

    <!-- Answer Cache Stats -->
    <div id="rsub-cache" style="display:none">
      <div class="card">
        <h3>⚡ Answer Cache Statistics</h3>
        <p style="font-size:12px;color:#666;margin-bottom:14px">Semantic cache saves tokens by reusing verified answers for similar questions</p>
        <div id="cache-stats"><div class="loading"><span class="spinner"></span> Loading...</div></div>
      </div>
      <div class="card">
        <h3>🔗 Citation Database</h3>
        <div id="citation-stats"><div class="loading"><span class="spinner"></span> Loading...</div></div>
      </div>
    </div>

  </div>

</div>

<script>
// ── Research tab logic ─────────────────────────────────────
function showResearchTab(tab) {
  ['caselaw','statutes','immigration','verify','cache'].forEach(t => {
    document.getElementById('rsub-' + t).style.display = t === tab ? 'block' : 'none';
    const btn = document.getElementById('rtab-' + t);
    if (btn) btn.style.opacity = t === tab ? '1' : '.6';
  });
  if (tab === 'cache') loadCacheStats();
}

// ── CourtListener search ───────────────────────────────────
const CL_TOKEN = ''; // Set in admin settings or leave blank for anonymous

async function runAdminCLSearch() {
  const q     = document.getElementById('cl-query').value.trim();
  const court = document.getElementById('cl-area').value;
  const date  = document.getElementById('cl-date').value;
  const sort  = document.getElementById('cl-sort').value;
  if (!q) return;

  document.getElementById('cl-loading').style.display = 'block';
  document.getElementById('cl-results').innerHTML = '';
  document.getElementById('cl-warning').style.display = 'none';

  try {
    const params = new URLSearchParams({ q, type:'o', stat_Published:'on', court, filed_after:date, order_by:sort, page_size:'8' });
    const headers = {};
    const savedToken = localStorage.getItem('cl_token');
    if (savedToken) headers['Authorization'] = 'Token ' + savedToken;

    const resp = await fetch('https://www.courtlistener.com/api/rest/v4/search/?' + params, { headers });
    if (resp.status === 429) throw new Error('Rate limited — add a free CourtListener API token in Settings');
    const data = await resp.json();
    const results = data.results || [];

    document.getElementById('cl-warning').style.display = results.length ? 'block' : 'none';
    document.getElementById('cl-results').innerHTML = results.length
      ? results.map(r => renderCaseCard(r)).join('')
      : '<p style="color:#999;font-size:13px;padding:12px">No results. Try broader terms.</p>';
  } catch(err) {
    document.getElementById('cl-results').innerHTML = '<p style="color:#cc0000;font-size:13px;padding:12px">❌ ' + err.message + '</p>';
  } finally {
    document.getElementById('cl-loading').style.display = 'none';
  }
}

async function runAdminImmSearch() {
  const q = document.getElementById('imm-query').value.trim();
  if (!q) return;
  document.getElementById('imm-loading').style.display = 'block';
  document.getElementById('imm-results').innerHTML = '';
  try {
    const params = new URLSearchParams({ q, type:'o', stat_Published:'on', court:'ca9,bia', filed_after:'2005-01-01', order_by:'score', page_size:'8' });
    const headers = {};
    const savedToken = localStorage.getItem('cl_token');
    if (savedToken) headers['Authorization'] = 'Token ' + savedToken;
    const resp = await fetch('https://www.courtlistener.com/api/rest/v4/search/?' + params, { headers });
    const data = await resp.json();
    const results = data.results || [];
    document.getElementById('imm-results').innerHTML = results.length
      ? results.map(r => renderCaseCard(r)).join('')
      : '<p style="color:#999;font-size:13px;padding:12px">No results found.</p>';
  } catch(err) {
    document.getElementById('imm-results').innerHTML = '<p style="color:#cc0000;font-size:13px">❌ ' + err.message + '</p>';
  } finally {
    document.getElementById('imm-loading').style.display = 'none';
  }
}

function renderCaseCard(r) {
  const name     = esc(r.caseName || r.case_name || 'Unknown');
  const citation = esc((r.citation || []).join(', ') || 'No citation');
  const court    = esc(r.court || '');
  const date     = esc(r.dateFiled || r.date_filed || '');
  const snippet  = esc((r.snippet || '').replace(/<[^>]+>/g,' ').trim().substring(0,220));
  const url      = r.absolute_url ? 'https://www.courtlistener.com' + r.absolute_url : null;
  return \`<div style="background:#faf8f4;border:1px solid #e0d8c8;border-radius:8px;padding:14px;margin-bottom:10px">
    <div style="font-weight:bold;color:#0C1C36;margin-bottom:4px">\${name}</div>
    <div style="font-size:11px;color:#B79C62;background:rgba(183,156,98,.1);display:inline-block;padding:2px 8px;border-radius:4px;margin-bottom:6px">\${citation}</div>
    <div style="font-size:11px;color:#888;margin-bottom:6px">🏛️ \${court} &nbsp;📅 \${date}</div>
    \${snippet ? '<div style="font-size:12px;color:#555;font-style:italic;border-left:2px solid #B79C62;padding-left:8px;margin-bottom:8px">"' + snippet + '..."</div>' : ''}
    <div style="display:flex;gap:8px">
      \${url ? '<a href="' + url + '" target="_blank" style="font-size:11px;background:#0C1C36;color:#B79C62;padding:4px 10px;border-radius:4px;text-decoration:none">📄 Read →</a>' : ''}
      <button onclick="navigator.clipboard.writeText(\\'' + name.replace(/'/g,"\\\\'") + ', ' + citation.replace(/'/g,"\\\\'") + '\\')" style="font-size:11px;background:#f0ede6;color:#0C1C36;border:none;padding:4px 10px;border-radius:4px;cursor:pointer">📋 Copy</button>
    </div>
  </div>\`;
}

// ── CA Statute lookup ──────────────────────────────────────
async function runAdminStatLookup() {
  const query = document.getElementById('stat-query').value.trim();
  if (!query) return;
  const m = query.match(/^([A-Za-z]{2,6})\\s*[§§]?\\s*(\\d+(?:\\.\\d+)?[a-z]?)$/i);
  if (m) { adminStatLookup(m[1].toUpperCase(), m[2]); return; }
  // Keyword — show quick matches
  const index = {demurrer:[['CCP','430.10'],['CCP','430.41']],'unlawful detainer':[['CCP','1161']],'damages':[['CIV','3294']],'negligence':[['CIV','1714']],'fraud':[['CIV','1710']],'trust':[['PROB','15200']],'non-compete':[['BPC','16600']],'summary judgment':[['CCP','437c']]};
  const k = query.toLowerCase();
  let matches = [];
  for (const [topic, secs] of Object.entries(index)) { if (topic.includes(k) || k.includes(topic)) matches = matches.concat(secs); }
  document.getElementById('stat-results').innerHTML = matches.length
    ? matches.map(([c,s]) => '<span onclick="adminStatLookup(\\'' + c + '\\',\\'' + s + '\\')" style="cursor:pointer;display:inline-block;margin:4px;background:#f0ede6;padding:6px 12px;border-radius:6px;font-size:13px">' + c + ' §' + s + '</span>').join('')
    : '<p style="color:#999;font-size:13px">Try a direct section like "CCP 430.10"</p>';
}

async function adminStatLookup(code, section) {
  document.getElementById('stat-query').value = code + ' ' + section;
  document.getElementById('stat-loading').style.display = 'block';
  document.getElementById('stat-results').innerHTML = '';
  const normalized = section.endsWith('.') ? section : section + '.';
  const url = 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=' + code + '&sectionNum=' + encodeURIComponent(normalized);
  try {
    const resp = await fetch(url);
    const html = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const textEl = doc.getElementById('codeLawSectionNoClass') || doc.querySelector('.lawText');
    const codeNames = {CCP:'Code of Civil Procedure',CIV:'Civil Code',FAM:'Family Code',PROB:'Probate Code',BPC:'Business & Professions Code',GOV:'Government Code',LAB:'Labor Code',PEN:'Penal Code',VEH:'Vehicle Code'};
    if (textEl) {
      const text = (textEl.innerText || textEl.textContent || '').trim();
      document.getElementById('stat-results').innerHTML = '<div style="background:#faf8f4;border:1px solid #e0d8c8;border-radius:8px;padding:16px"><div style="font-weight:bold;color:#B79C62;margin-bottom:8px">📚 ' + (codeNames[code]||code) + ' §' + section + '</div><pre style="white-space:pre-wrap;font-family:Arial;font-size:13px;color:#0C1C36;line-height:1.6">' + esc(text.substring(0,3000)) + '</pre><div style="margin-top:10px"><a href="' + url + '" target="_blank" style="font-size:11px;background:#0C1C36;color:#B79C62;padding:5px 12px;border-radius:4px;text-decoration:none">🔗 View on leginfo.ca.gov →</a></div><p style="font-size:10px;color:#aaa;margin-top:8px">Verify current text before filing. Public domain — Gov. Code §10248.5</p></div>';
    } else {
      document.getElementById('stat-results').innerHTML = '<div style="padding:12px"><p style="font-size:13px;margin-bottom:10px">Could not auto-extract. View directly:</p><a href="' + url + '" target="_blank" style="font-size:12px;background:#0C1C36;color:#B79C62;padding:6px 14px;border-radius:4px;text-decoration:none">📄 View ' + code + ' §' + section + ' on leginfo.ca.gov →</a></div>';
    }
  } catch(err) {
    document.getElementById('stat-results').innerHTML = '<div style="padding:12px"><a href="' + url + '" target="_blank" style="font-size:12px;background:#0C1C36;color:#B79C62;padding:6px 14px;border-radius:4px;text-decoration:none">📄 View ' + code + ' §' + section + ' on leginfo.ca.gov →</a></div>';
  } finally {
    document.getElementById('stat-loading').style.display = 'none';
  }
}

// ── Citation verifier ──────────────────────────────────────
async function runAdminVerify() {
  const q = document.getElementById('cite-query').value.trim();
  if (!q) return;
  document.getElementById('cite-loading').style.display = 'block';
  document.getElementById('cite-result').innerHTML = '';
  try {
    const headers = {};
    const t = localStorage.getItem('cl_token');
    if (t) headers['Authorization'] = 'Token ' + t;
    const resp = await fetch('https://www.courtlistener.com/api/rest/v4/search/?q=' + encodeURIComponent('"' + q + '"') + '&type=o&page_size=3', { headers });
    const data = await resp.json();
    const found = (data.results||[]).length > 0;
    const best  = found ? data.results[0] : null;
    document.getElementById('cite-result').innerHTML = '<div style="background:' + (found?'#d4edda':'#f8d7da') + ';border:1px solid ' + (found?'#c3e6cb':'#f5c6cb') + ';border-radius:6px;padding:14px;font-size:13px">'
      + (found ? '✅ <strong>FOUND IN DATABASE</strong><br><br>' : '❌ <strong>NOT FOUND</strong><br><br>')
      + (best ? '<strong>Case:</strong> ' + esc(best.caseName||best.case_name||'') + '<br><strong>Citation:</strong> ' + esc((best.citation||[]).join(', ')||'No reporter') + '<br><strong>Court:</strong> ' + esc(best.court||'') + ' | <strong>Date:</strong> ' + esc(best.dateFiled||best.date_filed||'') + '<br>' + (best.absolute_url ? '<br><a href="https://www.courtlistener.com' + best.absolute_url + '" target="_blank" style="color:#155724">View Opinion →</a>' : '') : 'Verify manually in vLex Fastcase before filing.')
      + '<br><br><small>⚠️ Still verify Good Law status in vLex Fastcase (Shepard\'s) before any filing.</small></div>';
  } catch(err) {
    document.getElementById('cite-result').innerHTML = '<p style="color:#cc0000">❌ ' + esc(err.message) + '</p>';
  } finally {
    document.getElementById('cite-loading').style.display = 'none';
  }
}

async function runAdminBatch() {
  const lines = document.getElementById('batch-cites').value.split('\\n').map(l=>l.trim()).filter(Boolean);
  if (!lines.length) return;
  const container = document.getElementById('batch-results');
  container.innerHTML = '<div class="loading"><span class="spinner"></span> Verifying ' + lines.length + ' citations...</div>';
  const headers = {};
  const t = localStorage.getItem('cl_token');
  if (t) headers['Authorization'] = 'Token ' + t;
  const results = [];
  for (const cite of lines) {
    try {
      const resp = await fetch('https://www.courtlistener.com/api/rest/v4/search/?q=' + encodeURIComponent('"'+cite+'"') + '&type=o&page_size=1', { headers });
      const data = await resp.json();
      results.push({ cite, found: (data.results||[]).length > 0, name: data.results?.[0]?.caseName || '' });
    } catch { results.push({ cite, found: false, name: '' }); }
    await new Promise(r => setTimeout(r, 400));
  }
  container.innerHTML = results.map(r =>
    '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:' + (r.found?'rgba(39,174,96,.08)':'rgba(192,57,43,.08)') + ';border:1px solid ' + (r.found?'rgba(39,174,96,.25)':'rgba(192,57,43,.25)') + ';border-radius:6px;margin-bottom:6px;font-size:12px">'
    + '<span>' + (r.found?'✅':'❌') + '</span><div><div style="font-family:monospace">' + esc(r.cite) + '</div>' + (r.name?'<div style="color:#888;font-size:11px">'+esc(r.name)+'</div>':'') + '</div></div>'
  ).join('');
}

// ── Cache stats ────────────────────────────────────────────
async function loadCacheStats() {
  try {
    const token = document.cookie.split(';').find(c=>c.trim().startsWith('admin_token='))?.split('=')[1];
    const resp = await fetch('/legal/citation-stats');
    const data = await resp.json();
    document.getElementById('citation-stats').innerHTML =
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">'
      + [['Cases Indexed', data.total_cases||0],['Citations Tracked',data.total_treatments||0],['Negative Treatments',data.negative_count||0],['Added This Week',data.new_this_week||0]].map(([label,val])=>
        '<div style="text-align:center;background:#f0ede6;border-radius:8px;padding:14px"><div style="font-size:28px;font-weight:bold;color:#B79C62">'+val+'</div><div style="font-size:11px;color:#666;margin-top:4px">'+label+'</div></div>'
      ).join('') + '</div>'
      + '<p style="font-size:11px;color:#aaa;margin-top:10px">Coverage: April 2026 onwards. Always verify pre-launch cases in vLex Fastcase.</p>';
  } catch { document.getElementById('citation-stats').innerHTML = '<p style="color:#999;font-size:13px">Stats unavailable</p>'; }

  // Answer cache stats placeholder
  document.getElementById('cache-stats').innerHTML =
    '<p style="font-size:13px;color:#555;line-height:1.6">The semantic answer cache automatically stores verified responses to common client questions. Every time a client asks something Zara has answered before, the cached answer is returned instantly — no Claude API call needed.</p>'
    + '<div style="margin-top:12px;background:#f0ede6;border-radius:8px;padding:14px;font-size:13px"><strong>How it works:</strong><br>'
    + '① Keyword fingerprint check (free, instant)<br>'
    + '② Haiku similarity check against cached Q&As (~$0.001)<br>'
    + '③ Full Sonnet response → stored for next client<br><br>'
    + '<strong>Never cached:</strong> personal situations, case numbers, emergency/distress, JJ private mode</div>';
}

// ── Utility ────────────────────────────────────────────────
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
</script>

<script src="/admin/panel.js"></script>
</body>
</html>`;
}

module.exports = { router, handleAdminCallback, initPromptTable, getSavedPrompt };
