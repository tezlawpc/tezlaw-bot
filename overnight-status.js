// ============================================================
//  overnight-status.js
//  Quick status checker — read this when you wake up.
//
//  Usage:  node overnight-status.js
// ============================================================

const fs   = require("fs");
const path = require("path");
const db   = require("./db");

const STORAGE_DIR     = process.env.PERSISTENT_STORAGE_DIR || "/var/data";
const CHECKPOINT_FILE = path.join(STORAGE_DIR, "overnight-checkpoint.json");
const REPORT_FILE     = path.join(STORAGE_DIR, "overnight-report.json");
const LOG_FILE        = path.join(STORAGE_DIR, "overnight-progress.log");

function box(title) {
  console.log("");
  console.log("═".repeat(60));
  console.log("  " + title);
  console.log("═".repeat(60));
}

(async () => {
  // 1. Job complete?
  if (fs.existsSync(REPORT_FILE)) {
    box("✅ JOB COMPLETED");
    const report = JSON.parse(fs.readFileSync(REPORT_FILE, "utf8"));
    console.log(`Started:  ${report.job_started}`);
    console.log(`Finished: ${report.job_finished}`);
    console.log(`Runtime:  ${report.runtime_hours} hours`);
    console.log("");
    console.log("Phases:");
    for (const [n, p] of Object.entries(report.phases)) {
      const icon = p.status === "complete" ? "✅" : (p.status === "errored" ? "❌" : "⚠️");
      console.log(`  ${icon} Phase ${n} (${p.status}): ${p.processed}/${p.total} processed, ${p.errors} errors`);
    }
    console.log("");
    console.log("Edges:");
    console.log(`  Total:              ${report.final_stats.edges.total_edges}`);
    console.log(`  With cluster_id:    ${report.final_stats.edges.with_cluster_id}`);
    console.log(`  With parenthetical: ${report.final_stats.edges.with_parenthetical}`);
    console.log(`  With treatment:     ${report.final_stats.edges.with_treatment}`);
    console.log("");
    console.log("Top 5 cited cases:");
    report.final_stats.top_cited_cases.slice(0, 5).forEach((c, i) => {
      console.log(`  ${i+1}. ${c.cited_case_name} — ${c.times_cited}x by ${c.distinct_judges} judges`);
    });
    console.log("");
    console.log(`Full report: cat ${REPORT_FILE}`);
    process.exit(0);
  }

  // 2. Job in progress (checkpoint exists, no report)
  if (fs.existsSync(CHECKPOINT_FILE)) {
    box("⏳ JOB IN PROGRESS");
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
    console.log(`Job ID:        ${cp.job_id}`);
    console.log(`Started:       ${cp.started_at}`);
    console.log(`Current phase: ${cp.current_phase}`);
    console.log("");
    for (const [n, p] of Object.entries(cp.phases)) {
      const icon = p.status === "complete" ? "✅" :
                    p.status === "running" ? "🔄" :
                    p.status === "paused_budget" ? "⏸️" :
                    p.status === "pending" ? "⏳" : "❓";
      const pct = p.total > 0 ? ` (${Math.round(p.processed * 100 / p.total)}%)` : "";
      console.log(`  ${icon} Phase ${n} (${p.status}): ${p.processed}/${p.total}${pct}, ${p.errors} errors`);
    }
    console.log("");

    // Check if process is still running
    try {
      const { execSync } = require("child_process");
      const psOutput = execSync("ps aux | grep 'overnight-enrichment' | grep -v grep || true").toString();
      if (psOutput.trim()) {
        console.log("Process status: RUNNING");
        console.log(psOutput.split("\n")[0].substring(0, 120));
      } else {
        console.log("Process status: NOT RUNNING (may have exited or been killed)");
        console.log("To resume: node overnight-enrichment.js");
      }
    } catch (err) { /* skip */ }
  } else {
    box("ℹ️  NO JOB FOUND");
    console.log("No checkpoint or report file exists.");
    console.log("To start a job: node overnight-enrichment.js");
  }

  // 3. Recent log lines
  if (fs.existsSync(LOG_FILE)) {
    box("📜 RECENT LOG (last 15 lines)");
    try {
      const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n");
      lines.slice(-15).forEach(l => console.log(l));
    } catch (err) { console.log("(could not read log)"); }
  }

  // 4. Live database snapshot
  box("📊 CURRENT DATABASE STATS");
  try {
    const r = await db.query(`
      SELECT
        COUNT(*) AS total_edges,
        COUNT(*) FILTER (WHERE cited_cluster_id IS NOT NULL) AS with_cluster_id,
        COUNT(*) FILTER (WHERE parenthetical IS NOT NULL) AS with_parenthetical,
        COUNT(*) FILTER (WHERE treatment IS NOT NULL) AS with_treatment
      FROM citation_edges_internal
    `);
    const s = r.rows[0];
    console.log(`Edges total:        ${s.total_edges}`);
    console.log(`With cluster_id:    ${s.with_cluster_id}  (${pct(s.with_cluster_id, s.total_edges)}%)`);
    console.log(`With parenthetical: ${s.with_parenthetical}  (${pct(s.with_parenthetical, s.total_edges)}%)`);
    console.log(`With treatment:     ${s.with_treatment}  (${pct(s.with_treatment, s.total_edges)}%)`);
  } catch (err) {
    console.log("DB query failed:", err.message);
  }

  process.exit(0);
})();

function pct(num, total) {
  if (!total || total === "0") return "0";
  return Math.round(parseInt(num) * 100 / parseInt(total));
}
