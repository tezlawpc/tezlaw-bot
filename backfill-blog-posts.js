// ============================================================
//  BACKFILL EXISTING WORDPRESS BLOG POSTS INTO firm_documents
//  ─────────────────────────────────────────────────────────
//  One-time script. Pulls every published post from tezlawfirm.com
//  and ingests through the Phase 2 firm-documents pipeline.
//
//  Usage:
//    node backfill-blog-posts.js                    # do the backfill
//    node backfill-blog-posts.js --dry-run          # just count posts, don't ingest
//    node backfill-blog-posts.js --limit=10         # first 10 only
//    node backfill-blog-posts.js --lang=en          # only English (avoid dupes from translations)
//
//  Safety:
//    - Dedup via SHA-256 hash in firm_documents (already implemented)
//    - Skips too-short posts (<500 chars)
//    - Throttled 1 req/sec to avoid API rate limits
//    - Resumable — if killed and rerun, dedup skips already-ingested
//
//  Cost: ~$0.009 per post. ~100 posts = ~$0.90 total.
// ============================================================

const axios = require("axios");
const { ingestDocument } = require("./firm-documents");

const WP_URL          = process.env.WP_URL || "https://tezlawfirm.com";
const WP_USER         = process.env.WP_USER;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;

if (!WP_USER || !WP_APP_PASSWORD) {
  console.error("Missing WP_USER or WP_APP_PASSWORD env vars");
  process.exit(1);
}

// ── Parse args ─────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT   = (() => {
  const a = args.find(x => x.startsWith("--limit="));
  return a ? parseInt(a.split("=")[1], 10) : Infinity;
})();
const LANG_FILTER = (() => {
  const a = args.find(x => x.startsWith("--lang="));
  return a ? a.split("=")[1] : null;  // null = all langs
})();

// ── Helpers ────────────────────────────────────────────────

/** Strip HTML tags and decode entities, return clean plain text. */
function stripHtml(html) {
  return String(html || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, "\"")
    .replace(/&#8221;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

/** Guess post language from title. */
function guessLang(title) {
  if (/[\u4e00-\u9fff]/.test(title)) return "zh";  // Chinese chars
  if (/[¿¡ñáéíóúü]/i.test(title))    return "es";   // Spanish diacritics
  return "en";
}

// ── Main ───────────────────────────────────────────────────

(async () => {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64");

  console.log("═".repeat(60));
  console.log("  WordPress Blog Backfill → firm_documents");
  console.log("═".repeat(60));
  console.log(`  Mode:     ${DRY_RUN ? "DRY RUN (no ingestion)" : "🔥 LIVE INGEST"}`);
  console.log(`  Limit:    ${LIMIT === Infinity ? "unlimited" : LIMIT}`);
  console.log(`  Lang:     ${LANG_FILTER || "all"}`);
  console.log(`  Source:   ${WP_URL}`);
  console.log("═".repeat(60));
  console.log("");

  let page = 1;
  let totalScanned = 0;
  let totalIngested = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let totalDuplicates = 0;
  let totalFilteredByLang = 0;
  const perPage = 20;
  const startTime = Date.now();

  while (totalScanned < LIMIT) {
    process.stdout.write(`\n=== Page ${page} `);

    let posts;
    try {
      const r = await axios.get(
        `${WP_URL}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&orderby=date&order=desc&_fields=id,title,content,link,date,categories`,
        {
          headers: { Authorization: `Basic ${auth}` },
          timeout: 30000,
        }
      );
      posts = r.data;
    } catch (e) {
      if (e.response?.status === 400) {
        console.log("(no more pages)\n");
        break;
      }
      console.error("Fetch error:", e.message);
      break;
    }

    if (!posts.length) {
      console.log("(empty)\n");
      break;
    }

    console.log(`— ${posts.length} posts ===`);

    for (const p of posts) {
      if (totalScanned >= LIMIT) break;
      totalScanned++;

      const title = stripHtml(p.title.rendered);
      const plainText = stripHtml(p.content.rendered);
      const fullText = "Title: " + title + "\n\n" + plainText;
      const lang = guessLang(title);

      const shortTitle = title.substring(0, 60);

      if (LANG_FILTER && lang !== LANG_FILTER) {
        console.log(`  [LANG-FILTER] (${lang}) ${shortTitle}`);
        totalFilteredByLang++;
        continue;
      }

      if (fullText.length < 500) {
        console.log(`  [TOO-SHORT] (${fullText.length}c) ${shortTitle}`);
        totalSkipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [DRY-RUN] (${fullText.length}c, ${lang}) ${shortTitle}`);
        totalScanned = totalScanned;
        continue;
      }

      try {
        const result = await ingestDocument({
          text: fullText,
          sourceUrl: p.link,
          matterLabelOverride: title,
          allowPrivate: false,
          actorId: "backfill",
        });

        if (result.ok) {
          console.log(`  ✅ #${result.docId} (${fullText.length}c) ${shortTitle}`);
          totalIngested++;
        } else if (result.reason && result.reason.includes("Already ingested")) {
          console.log(`  [DUP] #${result.docId} ${shortTitle}`);
          totalDuplicates++;
        } else {
          console.log(`  [SKIP] ${result.reason?.substring(0, 60)} — ${shortTitle}`);
          totalSkipped++;
        }
      } catch (e) {
        console.error(`  ❌ ${shortTitle}: ${e.message}`);
        totalFailed++;
      }

      // Throttle: 1 sec between calls to be nice to APIs
      await new Promise(r => setTimeout(r, 1000));
    }

    if (posts.length < perPage) {
      console.log("\n(last page)\n");
      break;
    }
    page++;
  }

  const durationMin = ((Date.now() - startTime) / 60000).toFixed(1);
  const estCost = (totalIngested * 0.009).toFixed(2);

  console.log("");
  console.log("═".repeat(60));
  console.log("  BACKFILL COMPLETE");
  console.log("═".repeat(60));
  console.log(`  Duration:            ${durationMin} min`);
  console.log(`  Scanned:             ${totalScanned}`);
  console.log(`  ✅ Ingested:         ${totalIngested}`);
  console.log(`  📁 Duplicates:       ${totalDuplicates} (already in DB)`);
  console.log(`  ⏭️  Skipped:          ${totalSkipped}`);
  console.log(`  🌐 Lang-filtered:    ${totalFilteredByLang}`);
  console.log(`  ❌ Failed:           ${totalFailed}`);
  console.log(`  💰 Estimated cost:   $${estCost}`);
  console.log("═".repeat(60));

  process.exit(0);
})().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
