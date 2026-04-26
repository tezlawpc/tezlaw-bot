// Quick diagnostic — run this in Render shell:
// node diagnose.js
const axios = require("axios");

const COURTLISTENER_TOKEN = process.env.COURTLISTENER_TOKEN;
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;

async function run() {
  console.log("\n=== STEP 1: CourtListener fetch ===");
  const headers = COURTLISTENER_TOKEN
    ? { Authorization: `Token ${COURTLISTENER_TOKEN}` }
    : {};

  let opinions = [];
  try {
    const resp = await axios.get("https://www.courtlistener.com/api/rest/v4/search/", {
      params: {
        type: "o", stat_Published: "on", court: "ca9",
        filed_after: "2024-01-01", order_by: "dateFiled desc", page_size: 3,
      },
      headers, timeout: 15000,
    });
    opinions = resp.data?.results || [];
    console.log(`✅ Fetched ${opinions.length} opinions`);
    if (opinions[0]) {
      const o = opinions[0];
      console.log("  caseName:", o.caseName || o.case_name);
      console.log("  judge:", o.judge);
      console.log("  snippet length:", (o.snippet||"").length);
      console.log("  snippet sample:", (o.snippet||"").substring(0,120));
    }
  } catch(err) {
    console.error("❌ CourtListener error:", err.message);
    return;
  }

  console.log("\n=== STEP 2: Keyword relevance check ===");
  const KEYWORDS = [
    "appeal","affirm","reverse","remand","judgment","district court",
    "plaintiff","defendant","circuit","affirmed","reversed",
    "negligence","contract","constitutional","statutory",
    "section 1983","title vii","immigration","asylum","removal",
    "de novo","abuse of discretion","summary judgment",
    "we affirm","we reverse","we remand","held that",
    "district court","court of appeals","ninth circuit"
  ];

  for (const op of opinions) {
    const text = (op.snippet||"").toLowerCase();
    const matched = KEYWORDS.filter(kw => text.includes(kw));
    const relevant = matched.length > 0;
    console.log(`  Opinion: "${(op.caseName||"?").substring(0,40)}" — relevant: ${relevant}, matches: ${matched.slice(0,5).join("|") || "NONE"}`);
    if (!relevant) {
      console.log(`    Full snippet: "${text.substring(0,200)}"`);
    }
  }

  console.log("\n=== STEP 3: Claude extraction test ===");
  const testOpinion = opinions[0];
  if (!testOpinion) return;

  const testRuling = {
    judge_name: testOpinion.judge || "Unknown",
    court: "9th Circuit",
    motion_type: "Appeal",
    result: "Unknown",
    hearing_date: testOpinion.dateFiled,
    full_text: (testOpinion.snippet||"").replace(/<[^>]+>/g," ").trim(),
    case_name: testOpinion.caseName,
  };

  console.log("  Sending to Claude Haiku...");
  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{
          role: "user",
          content: `Is this a civil court ruling? If yes, extract motion_type and result. If no, say why not.

Text: ${testRuling.full_text.substring(0,500)}

Reply with JSON: {"is_ruling": true/false, "reason": "...", "motion_type": "...", "result": "..."}`
        }]
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    console.log("✅ Claude response:", resp.data.content[0]?.text);
  } catch(err) {
    console.error("❌ Claude error:", err.message);
  }

  console.log("\n=== STEP 4: Check PRACTICE_KEYWORDS match ===");
  const { execSync } = require("child_process");
  try {
    const kwCount = execSync("grep -c '\"' judge-scanner.js | head -1").toString().trim();
    console.log("  judge-scanner.js keyword lines:", kwCount);
  } catch(e) {}

  // Test actual keywords from judge-scanner
  const realKeywords = [
    "appeal","affirm","reverse","remand","de novo",
    "held","court","judgment","plaintiff","defendant",
    "negligence","contract","section 1983","immigration",
    "abuse of discretion","summary judgment","district court"
  ];
  for (const op of opinions) {
    const text = (op.snippet||"").toLowerCase();
    const matches = realKeywords.filter(kw => text.includes(kw));
    console.log(`  "${(op.caseName||"?").substring(0,35)}" — keyword matches: ${matches.length} — [${matches.join(", ")}]`);
  }
}

run().catch(console.error);
