// ============================================================
//  fetch-uscis.js — GitHub Actions USCIS Data Fetcher
//  Tez Law P.C.
//
//  Fetches live processing times from USCIS API.
//  If USCIS blocks, falls back to preserving existing data
//  so the workflow never fails hard on a block.
// ============================================================

const https = require("https");
const fs    = require("fs");

const FORMS_TO_FETCH = [
  ["I-485", "NBC"],
  ["I-485", "TSC"],
  ["I-130", "NBC"],
  ["I-765", "NBC"],
  ["I-131", "NBC"],
  ["N-400", "NBC"],
  ["I-751", "NBC"],
  ["I-589", "ZLA"],
  ["I-90",  "NBC"],
];

// ── HTTP helper with full browser headers ──────────────────
function get(url) {
  return new Promise((resolve) => {
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://egov.uscis.gov/processing-times/",
        "Origin": "https://egov.uscis.gov",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      timeout: 20000,
    };

    const req = https.get(url, options, (res) => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: null, raw: body.substring(0, 300) });
        }
      });
    });
    req.on("error", (err) => resolve({ status: 0, data: null, raw: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, data: null, raw: "timeout" }); });
  });
}

// ── Parse USCIS API response ───────────────────────────────
function parseRange(apiData) {
  if (!apiData) return null;
  try {
    const pt = apiData?.data?.processing_time;
    if (!pt) return null;

    const subtypes = pt.subtypes || [];
    const ranges = [];
    for (const sub of subtypes) {
      const r = sub.range;
      if (!r || r.length === 0) continue;
      const unit = r[0].unit || "months";
      if (r.length === 1) {
        ranges.push(`${r[0].value} ${unit}`);
      } else {
        ranges.push(`${r[0].value}–${r[r.length-1].value} ${unit}`);
      }
    }
    if (ranges.length > 0) return [...new Set(ranges)].join(" / ");

    if (pt.range && pt.range.length >= 2) {
      const unit = pt.range[0].unit || "months";
      return `${pt.range[0].value}–${pt.range[pt.range.length-1].value} ${unit}`;
    }
  } catch {}
  return null;
}

// ── Load existing data to preserve on failure ─────────────
function loadExisting(outPath) {
  try {
    if (fs.existsSync(outPath)) return JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch {}
  return null;
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  const outPath = process.env.OUTPUT_PATH || "./uscis-times.json";
  console.log("Fetching USCIS processing times:", new Date().toISOString());

  const existing = loadExisting(outPath);
  const forms = existing?.forms ? { ...existing.forms } : {};
  const errors = [];
  let successCount = 0;

  for (const [form, office] of FORMS_TO_FETCH) {
    const url = `https://egov.uscis.gov/processing-times/api/processingtime/${form}/${office}`;
    process.stdout.write(`  ${form}/${office}: `);
    const resp = await get(url);

    if (resp.status === 200 && resp.data) {
      const range = parseRange(resp.data);
      if (range) {
        if (!forms[form] || office === "NBC") {
          forms[form] = { range, office, fetched_at: new Date().toISOString() };
        }
        console.log(`OK - ${range}`);
        successCount++;
      } else {
        console.log(`parse failed (raw: ${(resp.raw||"").substring(0,80)})`);
        errors.push(`${form}/${office}: parse failed`);
      }
    } else {
      console.log(`HTTP ${resp.status} - ${resp.raw||""}`);
      errors.push(`${form}/${office}: HTTP ${resp.status}`);
    }

    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`\nResults: ${successCount} fetched, ${errors.length} failed`);

  const output = {
    updated_at: new Date().toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric",
      timeZone: "America/Los_Angeles"
    }),
    updated_iso: new Date().toISOString(),
    fetch_success_count: successCount,
    forms,
    errors: errors.length > 0 ? errors : undefined,
    source_note: "USCIS.gov — times are estimates and vary by service center and case specifics",
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Written to ${outPath}`);

  // Only hard-fail if we have ZERO data total (no existing + no new)
  if (successCount === 0 && Object.keys(forms).length === 0) {
    console.error("ERROR: No data at all — failing");
    process.exit(1);
  }

  if (successCount === 0) {
    console.log("WARNING: All fetches failed — preserved existing data");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
