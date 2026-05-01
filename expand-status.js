// ============================================================
//  expand-status.js
//  Quick status reader for expand-scan.js
//
//  USAGE:
//    PERSISTENT_STORAGE_DIR=/tmp node expand-status.js
// ============================================================

const fs   = require("fs");
const path = require("path");
const db   = require("./db");

const STORAGE_DIR = process.env.PERSISTENT_STORAGE_DIR || "/tmp";
const CHECKPOINT  = path.join(STORAGE_DIR, "expand-checkpoint.json");
const PROGRESS    = path.join(STORAGE_DIR, "expand-progress.log");
const REPORT      = path.join(STORAGE_DIR, "expand-report.json");

const COURT_NAMES = {
  ca9: "9th Circuit",                  ca1: "1st Circuit",
  ca2: "2nd Circuit",                  ca5: "5th Circuit",
  ca11: "11th Circuit",
  bia: "Board of Immigration Appeals", ag: "Attorney General",
  scotus: "U.S. Supreme Court",
  cacd: "Central District CA",         caed: "Eastern District CA",
  cand: "Northern District CA",        casd: "Southern District CA",
  cal: "California Supreme Court",     calctapp: "California Courts of Appeal",
};

async function main() {
  console.log("═".repeat(60));
  console.log("  EXPAND-SCAN STATUS");
  console.log("═".repeat(60));

  // Process status
  const procs = require("child_process").execSync("ps aux | grep expand-scan | grep -v grep || true").toString().trim();
  if (procs) {
    console.log("Process: 🔄 RUNNING");
    console.log(procs);
  } else {
    console.log("Process: ⏸ NOT RUNNING");
  }
  console.log("");

  // Checkpoint
  if (fs.existsSync(CHECKPOINT)) {
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"));
    const start = new Date(cp.started_at);
    const elapsed = ((Date.now() - start.getTime()) / 3600000).toFixed(2);

    console.log(`Job:          ${cp.job_id}`);
    console.log(`Started:      ${cp.started_at}`);
    console.log(`Elapsed:      ${elapsed}h`);
    console.log(`Current:      ${cp.current_court || "(none)"}`);
    console.log("");
    console.log("Totals:");
    console.log(`  fetched:        ${cp.totals.fetched}`);
    console.log(`  processed:      ${cp.totals.processed}`);
    console.log(`  skipped:        ${cp.totals.skipped}  (already indexed)`);
    console.log(`  Claude calls:   ${cp.totals.claude_calls}`);
    console.log(`  errors:         ${cp.totals.errors}`);
    console.log("");
    console.log("By Court:");
    for (const [k, c] of Object.entries(cp.courts || {})) {
      const icon = {
        complete:      "✅",
        running:       "🔄",
        paused_budget: "⏸",
        paused_errors: "⚠️",
        aborted:       "❌",
        errored:       "❌",
      }[c.status] || "❓";
      const name = COURT_NAMES[k] || k;
      console.log(`  ${icon} ${k.padEnd(10)} ${name.padEnd(38)} status=${(c.status || "?").padEnd(15)} pages=${(c.page || 0).toString().padStart(4)} stored=${(c.processed || 0).toString().padStart(5)} earliest=${c.earliestSeen || "-"}`);
    }
  } else {
    console.log("(no checkpoint file)");
  }

  console.log("");

  // DB stats
  console.log("═".repeat(60));
  console.log("  DATABASE TOTALS");
  console.log("═".repeat(60));
  const stats = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM judge_profiles) AS judges,
      (SELECT COUNT(*) FROM judge_rulings) AS rulings,
      (SELECT COUNT(*) FROM judge_insights) AS insights,
      (SELECT COUNT(*) FROM judge_rulings WHERE created_at > NOW() - INTERVAL '24 hours') AS rulings_24h,
      (SELECT COUNT(*) FROM citation_edges_internal) AS edges,
      (SELECT COUNT(*) FROM citation_edges_internal WHERE parenthetical IS NOT NULL) AS edges_with_paren
  `);
  const s = stats.rows[0];
  console.log(`  Total judges:          ${s.judges}`);
  console.log(`  Total rulings:         ${s.rulings}  (+${s.rulings_24h} in last 24h)`);
  console.log(`  Total insights:        ${s.insights}`);
  console.log(`  Citation edges:        ${s.edges}  (${s.edges_with_paren} with parentheticals)`);
  console.log("");

  // Per-court ruling distribution
  const dist = await db.query(`
    SELECT court, COUNT(*) AS n
    FROM judge_rulings
    GROUP BY court
    ORDER BY n DESC
    LIMIT 20
  `);
  console.log("Rulings per court (top 20):");
  for (const r of dist.rows) {
    console.log(`  ${(r.court || "(unknown)").padEnd(40)} ${r.n.toString().padStart(6)}`);
  }
  console.log("");

  // Tail of progress log
  if (fs.existsSync(PROGRESS)) {
    console.log("═".repeat(60));
    console.log("  RECENT LOG (last 15 lines)");
    console.log("═".repeat(60));
    const lines = fs.readFileSync(PROGRESS, "utf8").trim().split("\n");
    console.log(lines.slice(-15).join("\n"));
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
