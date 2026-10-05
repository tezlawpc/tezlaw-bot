/**
 * check-bundle-names.js — a page's script is never replaced by a server file.
 *
 * client-script.js rescues a browser bundle that was uploaded to the
 * repository root instead of public/: at boot it copies the root file over
 * the one in public/. That is right for a flattened upload and wrong when
 * the root file is a different thing with the same name.
 *
 * calendar-feeds.js is both — the server's routes at the root, the page's
 * script in public/ — and the rescue copied the first over the second on
 * every boot. The Calendars page then loaded Node code and did nothing, the
 * server's source was served from /static/, and on a developer's machine
 * the working tree was left with a modified public/calendar-feeds.js ready
 * to be committed by accident.
 *
 * This boots the rescue exactly as server.js does and checks that every
 * file in public/ is byte-for-byte what it was.
 *
 * node scripts/check-bundle-names.js
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

let failures = 0;
const check = (name, fn) => {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || r === undefined; if (!ok) detail = String(r); } catch (e) { detail = e.message; }
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "\n         " + detail));
  if (!ok) failures++;
};
const sha = (f) => crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex");
const isNode = (f) => { const s = fs.readFileSync(f, "utf8"); return /\bmodule\.exports\b/.test(s) || /\brequire\(\s*["'`]/.test(s); };

console.log("\nclient bundles and the files that share their names");

const cs = require("../client-script");
const shared = cs.CLIENT_BUNDLES.filter((f) => fs.existsSync(path.join(ROOT, f)) && fs.existsSync(path.join(PUBLIC, f)));

console.log("  (same name at the root and in public/: " + (shared.join(", ") || "none") + ")");

check("every file in public/ is written for a browser (none requires or exports)", () => {
  const bad = fs.readdirSync(PUBLIC).filter((f) => /\.js$/.test(f)).filter((f) => isNode(path.join(PUBLIC, f)));
  return bad.length === 0 || "written for Node: " + bad.join(", ") + " — a server file has been copied over a page's script";
});

const before = {};
for (const f of fs.readdirSync(PUBLIC)) { const p = path.join(PUBLIC, f); if (fs.statSync(p).isFile()) before[f] = sha(p); }
let moved;
check("the boot-time rescue runs", () => { moved = cs.healClientBundles(); return Array.isArray(moved); });
check("…and leaves every file in public/ exactly as it was", () => {
  const changed = Object.keys(before).filter((f) => sha(path.join(PUBLIC, f)) !== before[f]);
  return changed.length === 0 || "changed by the rescue: " + changed.join(", ");
});
check("…and reports nothing moved", () => moved.length === 0 || "moved: " + moved.join(", "));

check("a server module at the root is never taken for a stray bundle", () => {
  const src = fs.readFileSync(path.join(ROOT, "client-script.js"), "utf8");
  return /if \(isServerModule\(stray\)\) return false;/.test(src) && /function isServerModule\(file\)/.test(src);
});

check("a real stray upload is still rescued (a browser file at the root, missing from public/)", () => {
  const name = "zara-chat.js";
  const target = path.join(PUBLIC, name), stray = path.join(ROOT, name), keep = fs.readFileSync(target);
  if (fs.existsSync(stray)) return "a " + name + " is already sitting at the root — move it into public/ in git";
  try {
    fs.writeFileSync(stray, keep);
    fs.unlinkSync(target);
    delete require.cache[require.resolve("../client-script")];
    const fresh = require("../client-script");
    const got = fresh.healClientBundles();
    return (got.includes(name) && fs.existsSync(target) && fs.readFileSync(target).equals(keep)) || "not rescued: " + JSON.stringify(got);
  } finally {
    fs.writeFileSync(target, keep);
    if (fs.existsSync(stray)) fs.unlinkSync(stray);
  }
});

console.log(failures ? `\n${failures} FAILED\n` : "\nall bundle-name checks passed\n");
process.exit(failures ? 1 : 0);
