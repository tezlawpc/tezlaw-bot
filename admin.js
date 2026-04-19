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
// nodemailer loaded lazily in sendAuthEmail to avoid crash if not installed

const router = express.Router();

// ── Config ────────────────────────────────────────────────
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const ANALYTICS_LOG        = process.env.ANALYTICS_LOG || "/var/data/analytics_history.json";
const JJ_TELEGRAM_ID       = process.env.JJ_TELEGRAM_ID; // JJ's personal Telegram user ID

// In-memory session store (tokens expire after 8 hours)
const sessions = new Map(); // token → { userId, expiresAt }
// Pending auth requests: telegramUserId → { token, expiresAt }
const pendingAuths = new Map();

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
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  return token;
}

function validateSession(token) {
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return false; }
  return true;
}

function requireAuth(req, res, next) {
  const token = req.cookies?.admin_token || req.headers["x-admin-token"];
  if (validateSession(token)) return next();
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
function handleAdminCallback(callbackData, callbackQueryId) {
  const [action, requestId] = callbackData.split(":");
  if (!["admin_approve", "admin_deny"].includes(action)) return false;

  const pending = pendingAuths.get(requestId);
  if (!pending || Date.now() > pending.expiresAt) {
    return { answer: "❌ This request has expired." };
  }

  if (action === "admin_approve") {
    pending.approved = true;
    pending.token = createSession("jj");
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
router.post("/api/logout", requireAuth, (req, res) => {
  const token = req.cookies?.admin_token || req.headers["x-admin-token"];
  sessions.delete(token);
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
  await savePrompt(prompt);
  // Update live prompt in memory
  req.app.locals.SYSTEM_PROMPT = prompt;
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
  <div class="nav-item" onclick="showPage('analytics')" id="nav-analytics">
    <span class="icon">🤖</span><span>Analytics</span>
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
      <h3>📅 Analytics History</h3>
      <div id="analyticsHistory"><div class="loading"><span class="spinner"></span> Loading...</div></div>
    </div>
  </div>

</div>

<script>
  const TOKEN = getCookie('admin_token');

  function getCookie(name) {
    return document.cookie.split('; ').find(r => r.startsWith(name + '='))?.split('=')[1] || '';
  }

  async function api(path, options = {}) {
    const res = await fetch('/admin' + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN, ...options.headers }
    });
    if (res.status === 401) { window.location.href = '/admin/login'; return null; }
    return res.json();
  }

  function platBadge(p) {
    const map = { telegram:'badge-tg', whatsapp:'badge-wa', website:'badge-web',
                  wechat:'badge-wc', messenger:'badge-ms' };
    return \`<span class="badge \${map[p]||''}">\${p}</span>\`;
  }

  function showPage(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById('page-' + name).classList.add('active');
    document.getElementById('nav-' + name).classList.add('active');

    if (name === 'dashboard') loadDashboard();
    if (name === 'prompt') loadPrompt();
    if (name === 'intakes') loadIntakes();
    if (name === 'messages') loadMessages();
    if (name === 'analytics') loadAnalytics();
  }

  // Dashboard
  async function loadDashboard() {
    const data = await api('/api/stats');
    if (!data) return;

    document.getElementById('statsGrid').innerHTML = \`
      <div class="stat-card"><div class="stat-num">\${data.totalMessages.toLocaleString()}</div><div class="stat-label">Total Messages</div></div>
      <div class="stat-card"><div class="stat-num">\${data.totalClients.toLocaleString()}</div><div class="stat-label">Total Clients</div></div>
      <div class="stat-card"><div class="stat-num">\${data.totalIntakes.toLocaleString()}</div><div class="stat-label">Total Intakes</div></div>
      <div class="stat-card"><div class="stat-num">\${data.messagesToday.toLocaleString()}</div><div class="stat-label">Messages Today</div></div>
    \`;

    document.getElementById('platformBar').innerHTML = data.byPlatform.map(p =>
      \`<div class="platform-stat"><div class="n">\${Number(p.messages).toLocaleString()}</div><div class="p">\${p.platform}</div></div>\`
    ).join('') || '<p style="color:#999;font-size:13px">No data yet</p>';

    document.getElementById('caseTypeBar').innerHTML = data.weekIntakeTypes.length
      ? \`<table><thead><tr><th>Case Type</th><th>Count</th></tr></thead><tbody>\${
          data.weekIntakeTypes.map(r => \`<tr><td>\${r.case_type||'Unknown'}</td><td>\${r.n}</td></tr>\`).join('')
        }</tbody></table>\`
      : '<p style="color:#999;font-size:13px">No intakes this week yet</p>';
  }

  // Prompt editor
  async function loadPrompt() {
    const data = await api('/api/prompt');
    if (data) document.getElementById('promptEditor').value = data.prompt;
  }

  async function savePrompt() {
    const btn = document.getElementById('saveBtn');
    const msg = document.getElementById('saveMsg');
    const prompt = document.getElementById('promptEditor').value;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    msg.textContent = '';

    const res = await api('/api/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt })
    });

    btn.disabled = false;
    btn.textContent = '💾 Save & Apply Now';
    if (res?.ok) {
      msg.textContent = '✅ Saved and live!';
      setTimeout(() => msg.textContent = '', 3000);
    } else {
      msg.style.color = '#cc0000';
      msg.textContent = '❌ Save failed';
    }
  }

  // Intakes
  async function loadIntakes() {
    const data = await api('/api/intakes');
    if (!data) return;
    document.getElementById('intakesTable').innerHTML = data.length
      ? \`<table>
          <thead><tr><th>Date</th><th>Platform</th><th>Name</th><th>Case Type</th><th>Contact</th><th>Issue</th></tr></thead>
          <tbody>\${data.map(r => \`<tr>
            <td style="white-space:nowrap">\${new Date(r.created_at).toLocaleDateString('en-US')}</td>
            <td>\${platBadge(r.platform)}</td>
            <td>\${r.name||'—'}</td>
            <td>\${r.case_type||'—'}</td>
            <td>\${r.contact||'—'}</td>
            <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${r.issue||''}">\${r.issue||'—'}</td>
          </tr>\`).join('')}</tbody>
        </table>\`
      : '<p style="color:#999;font-size:13px;padding:12px">No intakes yet.</p>';
  }

  // Messages
  async function loadMessages() {
    const data = await api('/api/messages');
    if (!data) return;
    document.getElementById('messagesTable').innerHTML = data.length
      ? \`<table>
          <thead><tr><th>Time</th><th>Platform</th><th>Role</th><th>Message</th></tr></thead>
          <tbody>\${data.map(r => \`<tr>
            <td style="white-space:nowrap;font-size:11px">\${new Date(r.created_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
            <td>\${platBadge(r.platform)}</td>
            <td><span style="font-size:11px;font-weight:bold;color:\${r.role==='assistant'?'#B79C62':'#0C1C36'}">\${r.role==='assistant'?'ZARA':'CLIENT'}</span></td>
            <td style="max-width:400px;font-size:13px">\${r.content.substring(0,200)}\${r.content.length>200?'…':''}</td>
          </tr>\`).join('')}</tbody>
        </table>\`
      : '<p style="color:#999;font-size:13px;padding:12px">No messages yet.</p>';
  }

  // Analytics
  async function loadAnalytics() {
    const data = await api('/api/analytics');
    if (!data) return;
    const entries = Object.entries(data).reverse();
    document.getElementById('analyticsHistory').innerHTML = entries.length
      ? entries.map(([week, entry]) => \`
          <div class="analytics-entry">
            <div class="analytics-week">📅 \${week.replace('-', ' ').replace('W', 'Week ')}</div>
            <div style="font-size:11px;color:#999;margin-bottom:8px">Run at: \${new Date(entry.ranAt).toLocaleString('en-US')}</div>
            <div class="analytics-summary">\${entry.summary}</div>
          </div>\`).join('')
      : '<p style="color:#999;font-size:13px">No analytics runs yet.</p>';
  }

  async function runAnalytics() {
    const btn = document.getElementById('runAnalyticsBtn');
    const msg = document.getElementById('analyticsMsg');
    btn.disabled = true;
    btn.textContent = 'Running...';

    const res = await api('/api/analytics/run', { method: 'POST' });
    btn.disabled = false;
    btn.textContent = '▶ Run Analytics Now';
    if (res?.ok) {
      msg.textContent = '✅ ' + res.message;
      setTimeout(() => loadAnalytics(), 120000); // reload after 2 min
    }
  }

  async function logout() {
    await api('/api/logout', { method: 'POST' });
    document.cookie = 'admin_token=; path=/; max-age=0';
    window.location.href = '/admin/login';
  }

  // Load dashboard on start
  loadDashboard();
</script>
</body>
</html>`;
}

module.exports = { router, handleAdminCallback, initPromptTable, getSavedPrompt };
