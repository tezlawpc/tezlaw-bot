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
const ROOT_DIR = __dirname;

// ── Self-healing ────────────────────────────────────────────
//
// Four separate times now, a client bundle has arrived in the repository
// ROOT instead of public/ — GitHub's web "Upload files" flattens folder
// paths, and unzipping a delivery without preserving folders does the
// same. Each time the symptom was identical (a red banner, or worse, a
// silently empty page) and each time the fix was a human moving one file.
//
// The server can just do it. If a bundle is missing from public/ but an
// identically-named file is sitting at the root, copy it across and say
// so in the log. Deliberately one-directional and only when public/ has
// nothing: a stale root copy can never overwrite the real one, which
// matters because this repo currently has four such strays.
//
// Only these names are ever moved. Copying anything that happened to be
// at the root into a publicly-served directory is how a .env ends up on
// the internet.
const CLIENT_BUNDLES = [
  "civil-admin.js",
  "zara-admin.js",
  "zara-chat.js",
  "civil-intake.js",
  "civil-docs.js",
  "esign-admin.js",
  "esign-sign.js",
  "court-mail-page.js",
  "transcripts-page.js",
];

const healed = new Set();

function healOne(file) {
  const base = path.basename(file);
  if (!CLIENT_BUNDLES.includes(base) || healed.has(base)) return false;
  healed.add(base);

  const stray = path.join(ROOT_DIR, base);
  if (!fs.existsSync(stray)) return false;
  const target = path.join(PUBLIC_DIR, base);
  try {
    // A root copy only ever exists because GitHub's web upload flattened a
    // NEW version of the file. So when public/ also has one and they differ,
    // the public/ copy is the stale one: the root copy wins. (This is what
    // left the LOG TIME button dead — the page was new, its script was old.)
    if (fs.existsSync(target) && fs.readFileSync(target).equals(fs.readFileSync(stray))) return false;
    const replacing = fs.existsSync(target);
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    fs.copyFileSync(stray, target);
    console.warn(
      `[client-script] ${base} was in the repository root, not public/. ` +
      (replacing ? "It differed from public/" + base + ", so the root copy (the newer upload) replaced it. "
                 : "Copied it into public/ so the page works. ") +
      `Move it in git to make this permanent.`
    );
    return true;
  } catch (e) {
    console.error(`[client-script] could not rescue ${base} from the root: ${e.message}`);
    return false;
  }
}

/** Run once at boot so a stray bundle is fixed before the first request. */
function healClientBundles() {
  return CLIENT_BUNDLES.filter(f => healOne(f));
}

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
  // Reduced to a bare filename before anything else touches it, so neither
  // the filesystem lookup nor the banner ever sees a path.
  file = path.basename(String(file || ""));
  const full = path.join(PUBLIC_DIR, file);
  if (!fs.existsSync(full)) healOne(file);   // a stray at the root is not a failure
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
        Fix: put <code>${esc(file)}</code> in the repository's <code>public/</code> folder — the same
        folder as <code>tez-shield.png</code> — and redeploy. If the file is in the repository root
        instead, the server moves it across by itself on the next boot; this banner means it is not
        in the repository at all. GitHub's web uploader flattens folders, so add it with
        <code>git add public/${esc(file)}</code> rather than by drag-and-drop.
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

module.exports = {
  clientScriptTag, auditClientScripts, healClientBundles,
  PUBLIC_DIR, ROOT_DIR, CLIENT_BUNDLES,
};
