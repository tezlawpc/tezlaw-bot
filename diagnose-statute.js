// diagnose-statute.js — run this to inspect what leginfo actually returns
// and figure out why the strip regex isn't matching.
//
// Usage:  node diagnose-statute.js

const axios = require("axios");
const cheerio = require("cheerio");
const db = require("./db");

(async () => {
  // Clear cache first
  await db.query("DELETE FROM research_cache WHERE cache_key LIKE 'ca:%'");
  console.log("✅ Cache cleared\n");

  const url = "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=3342.";
  console.log("Fetching:", url, "\n");

  const r = await axios.get(url, {
    timeout: 30000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    },
  });
  const $ = cheerio.load(r.data);

  // Try every selector our code uses
  const SELECTORS = [
    "#codeLawSectionNoHead",
    "#manylawsections",
    "#displayCodeSection",
    "#codeLawSectionHead",
  ];

  for (const sel of SELECTORS) {
    const found = $(sel);
    if (found.length) {
      const raw = found.text();
      console.log(`=== Selector "${sel}" matched ${found.length} element(s) ===`);
      console.log("Raw text length:", raw.length);
      console.log("Raw text first 200 chars (JSON-stringified to show whitespace):");
      console.log(JSON.stringify(raw.substring(0, 200)));
      console.log();

      // Apply collapse + strip in same order as actual code
      const collapsed = raw.trim().replace(/\s+/g, " ");
      console.log("After whitespace collapse, first 200 chars:");
      console.log(JSON.stringify(collapsed.substring(0, 200)));
      console.log();

      const stripped = collapsed.replace(
        /^[\s\S]*\(\s*(?:Heading of\s+)?(?:Part|Title|Chapter|Division|Article|Subdivision)\s+\d+(?:\.\d+)?\s+(?:enacted|added|amended|repealed)[^)]*\)\s*/i,
        ""
      );
      console.log("After strip regex:");
      console.log(JSON.stringify(stripped.substring(0, 300)));
      console.log("Stripped length:", stripped.length, "(was", collapsed.length + ")");
      console.log("\n---\n");
    }
  }

  process.exit(0);
})().catch(e => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
