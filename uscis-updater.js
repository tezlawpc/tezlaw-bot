// ============================================================
//  uscis-updater.js — USCIS Live Processing Times
//  Tez Law P.C.
//
//  Architecture:
//  1. GitHub Actions runs fetch-uscis.js weekly (Sunday 6am PT)
//     → fetches live data from egov.uscis.gov API
//     → commits uscis-times.json to repo
//  2. On Render startup + every 6 hours, this module:
//     → reads uscis-times.json from /var/data/ (copied by Render on deploy)
//     → OR fetches directly from GitHub raw URL as fallback
//     → injects current times into app.locals.USCIS_TIMES
//  3. server.js injects USCIS_TIMES into the live system prompt
//     via the admin prompt override OR a dynamic prompt builder
// ============================================================

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

// ── Config ─────────────────────────────────────────────────
const LOCAL_PATH    = process.env.USCIS_DATA_PATH || "/var/data/uscis-times.json";
const GITHUB_RAW    = "https://raw.githubusercontent.com/tezlawpc/tezlaw-telegram-bot/main/uscis-times.json";
const REFRESH_MS    = 6 * 60 * 60 * 1000; // re-read every 6 hours

// ── The forms Tez Law cares about ──────────────────────────
const TRACKED_FORMS = [
  { form: "I-485", label: "Green card (adjustment of status)" },
  { form: "I-130", label: "Family petition" },
  { form: "I-765", label: "Work permit (EAD)" },
  { form: "I-131", label: "Travel document (advance parole)" },
  { form: "N-400", label: "Naturalization / citizenship" },
  { form: "I-751", label: "Remove conditions on green card" },
  { form: "I-589", label: "Asylum application" },
  { form: "I-90",  label: "Green card renewal" },
];

// ── Load from local file ───────────────────────────────────
function loadLocal() {
  try {
    if (fs.existsSync(LOCAL_PATH)) {
      const data = JSON.parse(fs.readFileSync(LOCAL_PATH, "utf8"));
      if (data && data.updated_at) {
        console.log(`✅ USCIS times loaded from local file (updated ${data.updated_at})`);
        return data;
      }
    }
  } catch (err) {
    console.error("loadLocal USCIS error:", err.message);
  }
  return null;
}

// ── Fetch from GitHub raw (fallback) ───────────────────────
async function fetchFromGitHub() {
  try {
    const resp = await axios.get(GITHUB_RAW, { timeout: 10000 });
    const data = resp.data;
    if (data && data.updated_at) {
      // Cache locally for next time
      try {
        fs.writeFileSync(LOCAL_PATH, JSON.stringify(data, null, 2));
      } catch {}
      console.log(`✅ USCIS times fetched from GitHub (updated ${data.updated_at})`);
      return data;
    }
  } catch (err) {
    console.error("fetchFromGitHub USCIS error:", err.message);
  }
  return null;
}

// ── Build the prompt injection string ──────────────────────
function buildPromptSection(data) {
  if (!data || !data.forms) return null;

  const lines = [
    `============================`,
    `USCIS PROCESSING TIMES (live as of ${data.updated_at || "recently"})`,
    `============================`,
  ];

  for (const tracked of TRACKED_FORMS) {
    const entry = data.forms[tracked.form];
    if (!entry) continue;

    if (entry.range) {
      lines.push(`- ${tracked.form} (${tracked.label}): ${entry.range}`);
    } else if (entry.months) {
      lines.push(`- ${tracked.form} (${tracked.label}): ~${entry.months} months`);
    }
    if (entry.note) {
      lines.push(`  Note: ${entry.note}`);
    }
  }

  if (data.source_note) {
    lines.push(`Source: ${data.source_note}`);
  }

  lines.push(`Always tell clients these are estimates — actual times vary by service center and case type.`);

  return lines.join("\n");
}

// ── Inject into system prompt ──────────────────────────────
// Replaces the hardcoded processing times section in the live prompt
function injectIntoPrompt(basePrompt, uscisSection) {
  if (!uscisSection) return basePrompt;

  // Replace the existing hardcoded processing times block
  // Matches from "Processing times" line to end of immigration section bullet points
  const updated = basePrompt.replace(
    /- Processing times \([\d]+\):.*?(?=\n- DACA:|\n- ICE detention:|\n============================)/s,
    uscisSection + "\n"
  );

  // If the regex didn't match (format changed), just return the original
  // so we never break the prompt
  return updated !== basePrompt ? updated : basePrompt;
}

// ── Main: load data and set on app.locals ──────────────────
async function loadUSCISTimes(app) {
  let data = loadLocal();

  if (!data) {
    console.log("📥 No local USCIS file — fetching from GitHub...");
    data = await fetchFromGitHub();
  }

  if (!data) {
    console.log("⚠️  USCIS times unavailable — using hardcoded prompt values");
    return;
  }

  app.locals.USCIS_TIMES = data;
  app.locals.USCIS_PROMPT_SECTION = buildPromptSection(data);
  console.log("✅ USCIS processing times ready");
}

// ── Schedule refresh every 6 hours ────────────────────────
function scheduleUSCISRefresh(app) {
  loadUSCISTimes(app); // run immediately on startup

  setInterval(async () => {
    console.log("🔄 Refreshing USCIS processing times...");
    // Always try GitHub first on scheduled refresh (may have newer data)
    const fresh = await fetchFromGitHub();
    if (fresh) {
      app.locals.USCIS_TIMES = fresh;
      app.locals.USCIS_PROMPT_SECTION = buildPromptSection(fresh);
      console.log("✅ USCIS times refreshed");
    }
  }, REFRESH_MS);
}

// ── Build dynamic prompt (call this instead of static SYSTEM_PROMPT) ──
// Returns the live prompt with current USCIS times injected
function buildLivePrompt(app, basePrompt) {
  const section = app.locals.USCIS_PROMPT_SECTION;
  if (!section) return basePrompt;
  return injectIntoPrompt(basePrompt, section);
}

module.exports = { scheduleUSCISRefresh, buildLivePrompt, loadUSCISTimes };
