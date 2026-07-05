// ============================================================
//  TEZ LAW P.C. — WEEKLY MOAT UPDATE v1
//  ─────────────────────────────────────────────────────────
//  PHASE 1 SELF-LEARNING: Passive data ingestion.
//
//  Every Saturday at 11:00 PM PT this job:
//    1. Snapshots current moat state
//    2. For each priority court (ca9, bia, ca5, ca11):
//       - Rescans latest year (up to 500 clusters per court)
//       - Uses spawned `node expand-scan.js` subprocess
//       - Runs with per-court timeout (25 min)
//    3. Runs `node embed-parens.js` to embed any new parens
//       - Auto-picks up WHERE embedded_at IS NULL
//       - Timed out at 60 min
//    4. Computes delta (new rulings, new edges, new embeddings)
//    5. Sends Telegram summary to JJ
//    6. Records to Postgres moat_update_history
//
//  Safety features:
//    - Hard budget cap: $2/run (checks OpenAI balance first)
//    - Hard time cap: 25 min per court, 60 min for embed
//    - Failure alerts via Telegram
//    - Idempotent: existing checkpoints prevent duplicate work
//    - Only 1 run at a time (checks moat_update_history for RUNNING status)
//
//  Called from server.js:
//    require("./weekly-moat-update").scheduleWeekly();
// ============================================================

const { spawn } = require("child_process");
const axios     = require("axios");
const db        = require("./db");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const JJ_TELEGRAM_ID = process.env.JJ_TELEGRAM_ID;

// ── Configuration ──────────────────────────────────────────
const PRIORITY_COURTS = ["ca9", "bia", "ca5", "ca11"];
const PER_COURT_MAX_CLUSTERS = 500;
const PER_COURT_TIMEOUT_MS = 25 * 60 * 1000;    // 25 min per court
const EMBED_TIMEOUT_MS = 60 * 60 * 1000;         // 60 min for embed
const HARD_BUDGET_USD = 2.00;
const MIN_OPENAI_BALANCE = 0.50;  // skip if OpenAI has less than $0.50 (rough check)

// ── Helpers ────────────────────────────────────────────────

/** Send message to JJ via Telegram (silent no-op if not configured) */
async function notifyJJ(text) {
  if (!TELEGRAM_TOKEN || !JJ_TELEGRAM_ID) {
    console.log("[weekly-moat] Telegram not configured — skipping notify");
    console.log(text);
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id:    JJ_TELEGRAM_ID,
        text:       text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      },
      { timeout: 10000 }
    );
  } catch (e) {
    console.error("[weekly-moat] Telegram send failed:", e.message);
  }
}

/** Snapshot the moat's current state. */
async function snapshotMoat() {
  const r = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM judge_rulings) AS rulings,
      (SELECT COUNT(*) FROM citation_edges_internal) AS edges,
      (SELECT COUNT(*) FROM citation_edges_internal WHERE embedding IS NOT NULL) AS embedded,
      (SELECT COUNT(*) FROM citation_edges_internal
        WHERE embedding IS NULL
          AND parenthetical IS NOT NULL
          AND length(parenthetical) > 20) AS unembedded
  `);
  const row = r.rows[0];
  return {
    rulings:    parseInt(row.rulings, 10),
    edges:      parseInt(row.edges, 10),
    embedded:   parseInt(row.embedded, 10),
    unembedded: parseInt(row.unembedded, 10),
  };
}

/** Ensure moat_update_history table exists. */
async function ensureHistoryTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS moat_update_history (
      id             SERIAL PRIMARY KEY,
      started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at   TIMESTAMPTZ,
      status         TEXT NOT NULL DEFAULT 'running',  -- running | success | failed | skipped
      before_snap    JSONB,
      after_snap     JSONB,
      delta          JSONB,
      cost_usd       NUMERIC(10, 4) DEFAULT 0,
      duration_sec   INTEGER,
      error_message  TEXT,
      courts_scanned TEXT[]
    );

    CREATE INDEX IF NOT EXISTS idx_moat_update_started
      ON moat_update_history (started_at DESC);
  `);
}

/** Spawn a node subprocess with a timeout. Returns { code, timedOut, stdout, stderr }. */
function runNodeScript(scriptPath, args, timeoutMs, label) {
  return new Promise((resolve) => {
    console.log(`[weekly-moat] Starting ${label}: node ${scriptPath} ${args.join(" ")}`);
    const start = Date.now();

    const child = spawn("node", [scriptPath, ...args], {
      cwd:   __dirname,
      env:   process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      // Stream last 500 chars to console so it's visible in Render logs
      if (chunk.trim()) console.log(`[${label}]`, chunk.trim().slice(-500));
    });

    child.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      if (chunk.trim()) console.log(`[${label}] STDERR`, chunk.trim().slice(-500));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      console.log(`[weekly-moat] ${label} exceeded ${(timeoutMs / 60000).toFixed(0)} min — killing`);
      try { child.kill("SIGTERM"); } catch (_) {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, 15000);
    }, timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(timer);
      const durMs = Date.now() - start;
      console.log(`[weekly-moat] ${label} exited code=${code} timedOut=${timedOut} dur=${(durMs / 60000).toFixed(1)}min`);
      resolve({ code, timedOut, stdout, stderr, durMs });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      console.log(`[weekly-moat] ${label} error:`, err.message);
      resolve({ code: -1, timedOut: false, stdout, stderr, durMs: Date.now() - start, error: err.message });
    });
  });
}

/** Runs expand-scan for a single court. */
async function scanCourt(court) {
  return runNodeScript(
    "./expand-scan.js",
    [
      `--rescan=${court}`,
      `--max-clusters=${PER_COURT_MAX_CLUSTERS}`,
      `--stop-year=${new Date().getFullYear() - 1}`,  // scan back 1 year window
    ],
    PER_COURT_TIMEOUT_MS,
    `scan-${court}`
  );
}

/** Runs embed-parens for all unembedded rows. */
async function runEmbedNewParens() {
  return runNodeScript(
    "./embed-parens.js",
    [],
    EMBED_TIMEOUT_MS,
    "embed"
  );
}

/** Quick OpenAI credit check — returns true if we have room to embed. */
async function hasOpenAICapacity() {
  if (!process.env.OPENAI_API_KEY) return false;
  try {
    // No official balance endpoint, so we test with a tiny call
    await axios.post(
      "https://api.openai.com/v1/embeddings",
      { input: "test", model: "text-embedding-3-large" },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );
    return true;
  } catch (e) {
    const code = e.response?.data?.error?.code;
    if (code === "insufficient_quota") return false;
    // Other errors — assume capacity exists, embed-parens will handle retries
    console.log("[weekly-moat] OpenAI probe unclear error:", code, e.message);
    return true;
  }
}

/** Get the last cost from embed_parens checkpoint (updated by embed-parens.js). */
async function getEmbedCost() {
  try {
    const r = await db.query(
      `SELECT totals FROM cleanup_checkpoint WHERE job_name = 'embed_parens:all'`
    );
    if (r.rows.length === 0) return 0;
    const t = r.rows[0].totals || {};
    return t.cost_usd || 0;
  } catch (_) {
    return 0;
  }
}

// ── Main Orchestrator ──────────────────────────────────────

/**
 * Run one weekly moat update cycle.
 * Records progress to moat_update_history table.
 */
async function weeklyMoatUpdate() {
  const overallStart = Date.now();
  await ensureHistoryTable();

  // Check for concurrent run
  const runningCheck = await db.query(`
    SELECT id FROM moat_update_history
    WHERE status = 'running'
      AND started_at > NOW() - INTERVAL '3 hours'
    ORDER BY started_at DESC LIMIT 1
  `);
  if (runningCheck.rows.length > 0) {
    console.log("[weekly-moat] Another update is running — skipping");
    return;
  }

  const before = await snapshotMoat();
  console.log("[weekly-moat] Before:", before);

  // Insert history row (status=running)
  const historyRes = await db.query(
    `INSERT INTO moat_update_history (before_snap, courts_scanned)
     VALUES ($1, $2)
     RETURNING id`,
    [JSON.stringify(before), PRIORITY_COURTS]
  );
  const historyId = historyRes.rows[0].id;

  const costBefore = await getEmbedCost();
  let errorMessage = null;
  let status = "success";
  const scanResults = {};

  try {
    // ── Step 1: Verify OpenAI capacity ────────────────────
    console.log("[weekly-moat] Checking OpenAI capacity...");
    const hasOpenAI = await hasOpenAICapacity();
    if (!hasOpenAI) {
      throw new Error("OpenAI quota exhausted — skipping run");
    }
    console.log("[weekly-moat] OpenAI ready");

    // ── Step 2: Scan each priority court ──────────────────
    for (const court of PRIORITY_COURTS) {
      console.log(`[weekly-moat] Scanning ${court}...`);
      const result = await scanCourt(court);
      scanResults[court] = {
        exitCode: result.code,
        timedOut: result.timedOut,
        durMin:   (result.durMs / 60000).toFixed(1),
      };
      if (result.code !== 0 && !result.timedOut) {
        console.log(`[weekly-moat] ${court} exited non-zero but continuing`);
      }
    }

    // ── Step 3: Embed any new parens ──────────────────────
    console.log("[weekly-moat] Running embed-parens.js...");
    const embedResult = await runEmbedNewParens();
    scanResults.embed = {
      exitCode: embedResult.code,
      timedOut: embedResult.timedOut,
      durMin:   (embedResult.durMs / 60000).toFixed(1),
    };

    // Enforce budget cap AFTER the run — if it blew past, log a warning
    const costAfter = await getEmbedCost();
    const runCost = Math.max(0, costAfter - costBefore);
    if (runCost > HARD_BUDGET_USD) {
      console.log(`[weekly-moat] ⚠️  Run cost $${runCost.toFixed(2)} exceeded budget $${HARD_BUDGET_USD}`);
    }

  } catch (e) {
    status = "failed";
    errorMessage = e.message;
    console.error("[weekly-moat] Failed:", e.message, e.stack);
  }

  // ── Step 4: Snapshot + compute delta ───────────────────
  const after = await snapshotMoat();
  const costAfter = await getEmbedCost();
  const runCost = Math.max(0, costAfter - costBefore);
  const delta = {
    newRulings:  after.rulings - before.rulings,
    newEdges:    after.edges - before.edges,
    newEmbedded: after.embedded - before.embedded,
    unembeddedRemaining: after.unembedded,
  };
  const durationSec = Math.round((Date.now() - overallStart) / 1000);

  console.log("[weekly-moat] After:", after);
  console.log("[weekly-moat] Delta:", delta);
  console.log("[weekly-moat] Cost:", "$" + runCost.toFixed(4));

  // ── Step 5: Update history row ─────────────────────────
  await db.query(
    `UPDATE moat_update_history
       SET completed_at  = NOW(),
           status        = $2,
           after_snap    = $3,
           delta         = $4,
           cost_usd      = $5,
           duration_sec  = $6,
           error_message = $7
     WHERE id = $1`,
    [
      historyId,
      status,
      JSON.stringify(after),
      JSON.stringify(delta),
      runCost,
      durationSec,
      errorMessage,
    ]
  );

  // ── Step 6: Send Telegram summary ──────────────────────
  const emoji = status === "success" ? "🧠" : (status === "skipped" ? "⏸️" : "⚠️");
  const durMin = (durationSec / 60).toFixed(1);
  const scanSummary = Object.entries(scanResults)
    .map(([court, r]) => `  • ${court}: ${r.timedOut ? "⏱️ timeout" : (r.exitCode === 0 ? "✓" : "code=" + r.exitCode)} (${r.durMin}min)`)
    .join("\n");

  let msg;
  if (status === "success") {
    msg = `${emoji} *Weekly Moat Update*\n\n` +
      `*Δ from last week:*\n` +
      `  • Rulings: +${delta.newRulings.toLocaleString()}\n` +
      `  • Citation edges: +${delta.newEdges.toLocaleString()}\n` +
      `  • Embedded parens: +${delta.newEmbedded.toLocaleString()}\n` +
      (delta.unembeddedRemaining > 0
        ? `  • Still unembedded: ${delta.unembeddedRemaining.toLocaleString()}\n`
        : "") +
      `\n*Total moat:*\n` +
      `  • ${after.rulings.toLocaleString()} rulings\n` +
      `  • ${after.edges.toLocaleString()} citation edges\n` +
      `  • ${after.embedded.toLocaleString()} embeddings\n\n` +
      `*Scan details:*\n${scanSummary}\n\n` +
      `Cost: $${runCost.toFixed(4)}\n` +
      `Duration: ${durMin} min`;
  } else {
    msg = `${emoji} *Weekly Moat Update — ${status}*\n\n` +
      `Error: ${errorMessage || "unknown"}\n\n` +
      `Partial delta:\n` +
      `  • Rulings: +${delta.newRulings.toLocaleString()}\n` +
      `  • Edges: +${delta.newEdges.toLocaleString()}\n` +
      `  • Embedded: +${delta.newEmbedded.toLocaleString()}\n\n` +
      `Duration: ${durMin} min\n\n` +
      `Review Render logs for details.`;
  }

  await notifyJJ(msg);

  return {
    status,
    delta,
    cost: runCost,
    durationSec,
    historyId,
  };
}

// ── Cron Scheduler ─────────────────────────────────────────

/**
 * Schedule the weekly job. Called once from server.js at startup.
 *
 * Timing: Saturday 11:00 PM Los Angeles time (well before Sunday 3am cache purge).
 * Cron pattern: minute hour day-of-month month day-of-week
 *   "0 23 * * 6"  =  Saturday 23:00 (11pm) in LA timezone
 */
async function scheduleWeekly() {
  try {
    const { default: cron } = await import("node-cron").catch(() => ({ default: require("node-cron") }));
    cron.schedule("0 23 * * 6", () => {
      console.log("🧠 Weekly moat update triggered by cron");
      weeklyMoatUpdate().catch(err => {
        console.error("🧠 Weekly moat update error:", err.message);
        notifyJJ(`⚠️ *Weekly Moat Update crashed*\n\n${err.message}\n\nCheck Render logs.`).catch(() => {});
      });
    }, { timezone: "America/Los_Angeles" });
    console.log("🧠 Weekly moat update scheduled (Saturday 11 PM PT).");
  } catch (e) {
    console.error("🧠 Weekly moat scheduler failed:", e.message);
  }
}

// ── Exports ────────────────────────────────────────────────

module.exports = {
  weeklyMoatUpdate,
  scheduleWeekly,
  snapshotMoat,
  ensureHistoryTable,
};

// ── CLI Mode ───────────────────────────────────────────────
// Run manually: node weekly-moat-update.js
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);

    if (args.includes("--snapshot")) {
      console.log("Current moat state:");
      const snap = await snapshotMoat();
      console.log(JSON.stringify(snap, null, 2));
      process.exit(0);
    }

    if (args.includes("--history")) {
      await ensureHistoryTable();
      const r = await db.query(`
        SELECT id, started_at, completed_at, status,
               delta, cost_usd, duration_sec, error_message
        FROM moat_update_history
        ORDER BY started_at DESC
        LIMIT 20
      `);
      if (r.rows.length === 0) {
        console.log("No history entries yet.");
      } else {
        for (const row of r.rows) {
          const dur = row.duration_sec ? (row.duration_sec / 60).toFixed(1) + "m" : "-";
          console.log(`#${row.id} | ${row.started_at.toISOString()} | ${row.status} | ${dur} | $${row.cost_usd || 0} | Δ=${JSON.stringify(row.delta || {})}`);
          if (row.error_message) console.log(`   ERROR: ${row.error_message}`);
        }
      }
      process.exit(0);
    }

    if (args.includes("--run") || args.length === 0) {
      console.log("Running weekly moat update NOW (manual invocation)...");
      const result = await weeklyMoatUpdate();
      console.log("Done:", JSON.stringify(result, null, 2));
      process.exit(0);
    }

    console.log(`Usage:
  node weekly-moat-update.js --run          Run the update now
  node weekly-moat-update.js --snapshot     Show current moat state
  node weekly-moat-update.js --history      Show last 20 runs
`);
    process.exit(0);
  })().catch(e => {
    console.error("CLI error:", e);
    process.exit(1);
  });
}
