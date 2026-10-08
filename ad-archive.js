// ============================================================
//  ad-archive.js — a true copy of every ad, kept for a year
//
//  B&P Code § 6159.1: "A true and correct copy of any advertisement made by
//  a person or licensee shall be retained for one year." Until October 2026
//  Zara threw the video away once it was scheduled and never kept the image
//  card as posted, so the only copies were in JJ's Telegram chat and on the
//  platforms themselves.
//
//  Now, when a post or video is handed to Postiz (or handed back to JJ to
//  paste), this keeps:
//    · a row in ad_archive with the words, the channel, the language, the
//      schedule and the post it came from — always;
//    · the file itself (video or card) in Dropbox under AD_ARCHIVE_DIR
//      (default "/TEZ Ad Archive/<year>/"), when Dropbox is connected;
//    · if Dropbox is not connected or the upload fails, an image card is kept
//      in the row itself, and a video is reported as not archived so the
//      caller keeps its own copy (social_posts.media_file) instead.
//  Copies older than 400 days are cleared from the table (the Dropbox files
//  stay until someone removes them).
// ============================================================

const db = require("./db");

const DIR = () => String(process.env.AD_ARCHIVE_DIR || "/TEZ Ad Archive").replace(/\/+$/, "");
const KEEP_DAYS = 400;

let ready = null;
function initTable() {
  ready = ready || db.query(`
    CREATE TABLE IF NOT EXISTS ad_archive (
      id SERIAL PRIMARY KEY,
      post_id INTEGER, channel TEXT, kind TEXT, lang TEXT,
      text TEXT, source_url TEXT, media JSONB, delivered JSONB,
      file BYTEA, file_ext TEXT, file_bytes INTEGER, dropbox_path TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS ad_archive_post ON ad_archive(post_id);`).catch(e => { ready = null; throw e; });
  return ready;
}

function dropbox() {
  try { const d = require("./dropbox-integration"); return d.isConfigured() ? d : null; } catch { return null; }
}

/**
 * Keep a copy. `row` is the social_posts row; `buffer` the file as posted
 * (null for a text-only post). Returns { ok, where } — ok is true when the
 * file (if any) is safely kept somewhere.
 */
async function keep({ row, kind = null, buffer = null, ext = "png", text = null, done = null }, { dbx = dropbox() } = {}) {
  await initTable();
  const day = new Date().toISOString().slice(0, 10);
  const base = `${DIR()}/${day.slice(0, 4)}/${day}_${row.channel || kind || "post"}_${row.id}`;
  let dropboxPath = null, inRow = null;
  if (buffer && dbx) {
    try {
      const r = await dbx.uploadFile({ path: `${base}.${ext}`, buffer, mode: "add", autorename: true });
      dropboxPath = (r && (r.path_display || r.path_lower)) || `${base}.${ext}`;
      const words = [`Channel: ${row.channel}`, `Post: #${row.id}`, row.source_url ? `Source: ${row.source_url}` : "",
        done ? `Scheduled: ${JSON.stringify(done)}` : "", "", text || row.text || ""].filter(x => x !== null).join("\n");
      await dbx.uploadFile({ path: `${base}.txt`, buffer: Buffer.from(words, "utf8"), mode: "add", autorename: true }).catch(() => {});
    } catch (e) { console.warn("[ad-archive] dropbox:", e.message); dropboxPath = null; }
  }
  if (buffer && !dropboxPath && ext !== "mp4") inRow = buffer;   // cards are small; videos are not
  await db.query(
    `INSERT INTO ad_archive (post_id, channel, kind, lang, text, source_url, media, delivered, file, file_ext, file_bytes, dropbox_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12)`,
    [row.id, row.channel, kind || row.channel, row.lang || null, text || row.text || null, row.source_url || null,
      JSON.stringify(row.media || null), JSON.stringify(done || null), inRow, buffer ? ext : null, buffer ? buffer.length : null, dropboxPath]);
  db.query(`UPDATE ad_archive SET file = NULL WHERE file IS NOT NULL AND created_at < NOW() - INTERVAL '${KEEP_DAYS} days'`).catch(() => {});
  return { ok: !buffer || !!dropboxPath || !!inRow, where: dropboxPath || (inRow ? "database" : buffer ? "not kept" : "text only") };
}

module.exports = { keep, initTable, DIR, KEEP_DAYS };
