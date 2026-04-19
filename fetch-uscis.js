// ============================================================
//  fetch-uscis.js — GitHub Actions USCIS Data Fetcher
//  Tez Law P.C.
//
//  Run by GitHub Actions every Sunday at 6am PT.
//  Fetches live processing times from USCIS API,
//  writes uscis-times.json to the repo root.
//  Render picks it up on next deploy or via GitHub raw URL.
//
//  Usage: node fetch-uscis.js
// ============================================================

const https = require("https");
const fs    = require("fs");

// ── Forms and service centers to fetch ─────────────────────
// USCIS API: GET /processing-times/api/processingtime/{FORM}/{OFFICE}
// Common offices: NBC (National Benefits Center), TSC, VSC, NSC, CSC, MSC
// We use NBC as the primary (handles most family/employment cases)

const FORMS_TO_FETCH = [
  // Form,   Office,  fallback office
  ["I-485", "NBC",   null],
  ["I-485", "TSC",   null],
  ["I-130", "NBC",   null],
  ["I-765", "NBC",   null],
  ["I-131", "NBC",   null],
  ["N-400", "NBC",   null],
  ["I-751", "NBC",   null],
  ["I-589", "ZLA",   null],  // Asylum — Los Angeles
  ["I-90",  "NBC",   null],
];

// ── HTTP helper ─────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TezLaw-DataFetcher/1.0)",
        "Accept": "application/json",
      },
      timeout: 15000,
    }, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: null, raw: body.substring(0, 200) });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("timeout")));
  });
}

// ── Parse USCIS response into a clean range string ─────────
function parseRange(apiData) {
  if (!apiData) return null;
  try {
    // USCIS API response structure:
    // { data: { processing_time: { subtypes: [{ range: [{ unit, value }] }] } } }
    const pt = apiData?.data?.processing_time;
    if (!pt) return null;

    // Try subtypes first (most common)
    const subtypes = pt.subtypes || [];
    const ranges = [];

    for (const sub of subtypes) {
      const r = sub.range;
      if (!r || r.length === 0) continue;
      if (r.length === 1) {
        ranges.push(`${r[0].value} ${r[0].unit}`);
      } else if (r.length >= 2) {
        // Range like "5 to 7 months"
        const unit = r[0].unit;
        ranges.push(`${r[0].value}–${r[r.length-1].value} ${unit}`);
      }
    }

    if (ranges.length > 0) {
      // Deduplicate and join
      const unique = [...new Set(ranges)];
      return unique.join(" / ");
    }

    // Fallback: try top-level range
    if (pt.range && pt.range.length >= 2) {
      const unit = pt.range[0].unit;
      return `${pt.range[0].value}–${pt.range[pt.range.length-1].value} ${unit}`;
    }
  } catch (err) {
    console.error("parseRange error:", err.message);
  }
  return null;
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  console.log("🔄 Fetching USCIS processing times...");
  console.log(`   Date: ${new Date().toISOString()}\n`);

  const forms = {};
  const errors = [];

  for (const [form, office] of FORMS_TO_FETCH) {
    const url = `https://egov.uscis.gov/processing-times/api/processingtime/${form}/${office}`;
    try {
      console.log(`  Fetching ${form}/${office}...`);
      const resp = await get(url);

      if (resp.status === 200 && resp.data) {
        const range = parseRange(resp.data);
        if (range) {
          // Store by form, prefer NBC, but store all offices
          if (!forms[form]) {
            forms[form] = { range, office, fetched_at: new Date().toISOString() };
          } else if (office === "NBC") {
            // NBC takes priority
            forms[form] = { range, office, fetched_at: new Date().toISOString() };
          }
          console.log(`    ✅ ${form}/${office}: ${range}`);
        } else {
          console.log(`    ⚠️  ${form}/${office}: Could not parse range`);
          errors.push(`${form}/${office}: parse failed`);
        }
      } else {
        console.log(`    ❌ ${form}/${office}: HTTP ${resp.status}`);
        errors.push(`${form}/${office}: HTTP ${resp.status}`);
      }

      // Small delay to be polite to USCIS servers
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      console.log(`    ❌ ${form}/${office}: ${err.message}`);
      errors.push(`${form}/${office}: ${err.message}`);
    }
  }

  // Build the output JSON
  const output = {
    updated_at: new Date().toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric",
      timeZone: "America/Los_Angeles"
    }),
    updated_iso: new Date().toISOString(),
    forms,
    errors: errors.length > 0 ? errors : undefined,
    source_note: "USCIS.gov — times are estimates and vary by service center and case specifics",
  };

  // Write to file
  const outPath = process.env.OUTPUT_PATH || "./uscis-times.json";
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Written to ${outPath}`);
  console.log(`   Forms captured: ${Object.keys(forms).length}/${FORMS_TO_FETCH.length}`);

  if (errors.length > 0) {
    console.log(`   Errors: ${errors.length}`);
    errors.forEach(e => console.log(`     - ${e}`));
  }

  // Exit with error code if we got nothing (so GitHub Actions fails visibly)
  if (Object.keys(forms).length === 0) {
    console.error("\n❌ No data fetched — all requests failed");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
