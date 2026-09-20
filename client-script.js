// ============================================================
//  client-script.js — script tags that fail loudly
//  ─────────────────────────────────────────────────────────
//  Both admin client bundles (public/civil-admin.js and
//  public/zara-admin.js) are served as real static files rather than
//  inlined, which retired the server-side template-literal escaping
//  bug for good. It introduced a quieter one in its place.
//
//  If the file is not on the server, <script src> 404s, nothing
//  throws anywhere the user can see, and the page renders its empty
//  mount points: three blank boxes and a tab strip that appears to do
//  nothing. That is indistinguishable from a broken feature, and it
//  cost a full round trip to diagnose — twice, because the civil
//  bundle had been missing in production the whole time without
//  anyone being told.
//
//  So: check the file exists at render time. If it does, emit the
//  cache-busted tag as before. If it does not, emit a banner naming
//  the missing file and where it belongs. A page that says what is
//  wrong is worth more than a page that looks merely empty.
// ============================================================

const fs = require("fs");
const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "public");

function esc(t) {
  return String(t == null ? "" : t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * @param {string} file  basename inside public/, e.g. "zara-admin.js"
 * @returns {string}     a <script> tag, or a visible diagnostic banner
 */
function clientScriptTag(file) {
  const full = path.join(PUBLIC_DIR, path.basename(file));
  let v;
  try {
    // Base 36 of the whole-millisecond mtime. `| 0` would wrap a
    // 2026-era timestamp into a negative int32 — neither stable nor
    // monotonic — which is why this is spelled out.
    v = Math.floor(fs.statSync(full).mtimeMs).toString(36);
  } catch (e) {
    return missingBanner(file, e.code === "ENOENT" ? "not deployed" : e.message);
  }
  return `<script src="/static/${esc(file)}?v=${v}" defer></script>`;
}

function missingBanner(file, why) {
  return `
    <div style="margin:18px 0;padding:16px 18px;border:2px solid #A02818;border-radius:6px;background:#FBF3DE;">
      <div style="font-family:Cinzel,serif;font-size:13px;letter-spacing:1.2px;color:#A02818;margin-bottom:6px;">
        THIS PAGE'S CLIENT SCRIPT IS MISSING
      </div>
      <div style="font-size:13px;line-height:1.6;color:#3E2818;">
        <code>public/${esc(file)}</code> is not on the server (${esc(why)}), so nothing on this
        page can load. The panels below will stay empty until it is uploaded.
      </div>
      <div style="font-size:12px;color:#7B5330;margin-top:8px;font-style:italic;">
        Fix: upload <code>${esc(file)}</code> into the repository's <code>public/</code> folder —
        the same folder as <code>tez-shield.png</code> — and redeploy. It is a client-side file;
        putting it in the repository root will not work.
      </div>
    </div>`;
}

/** Which bundles are present. Surfaced on the health page. */
function auditClientScripts(files) {
  return (files || []).map(f => {
    const full = path.join(PUBLIC_DIR, path.basename(f));
    try {
      const st = fs.statSync(full);
      return { file: f, present: true, bytes: st.size, modified: new Date(st.mtimeMs).toISOString() };
    } catch (e) {
      return { file: f, present: false, error: e.code || e.message };
    }
  });
}

module.exports = { clientScriptTag, auditClientScripts, PUBLIC_DIR };
