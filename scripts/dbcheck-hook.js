/**
 * dbcheck-hook.js — preloaded into the server by scripts/dbcheck.js.
 *
 * Wraps node-postgres so that every query the server runs is watched, from
 * every pool in the codebase (there are eight), and any query the DATABASE
 * rejects as wrong — a column or table that does not exist, a syntax error —
 * is written to a log file with the SQL and the file that sent it.
 *
 * It changes nothing about how a query behaves: the same result or the same
 * error goes back to the caller. It is never loaded in production; the server
 * only sees it when dbcheck.js starts it with NODE_OPTIONS=--require.
 */
const fs = require("fs");
const path = require("path");
const LOG = process.env.DBCHECK_LOG;
if (LOG) {
  // SQLSTATE class 42 = "syntax error or access rule violation": the query
  // text itself is wrong for this schema. 42P07/42710 (already exists) are
  // what CREATE … races produce and are not mistakes.
  const WRONG = /^42/;
  const IGNORE = new Set(["42P07", "42710", "42P06", "42P16"]);
  const ROOT = path.join(__dirname, "..") + path.sep;
  const sourceOf = (stack) => {
    const lines = String(stack || "").split("\n");
    let viaDb = null;
    for (const l of lines) {
      if (l.includes("node_modules") || l.includes("dbcheck-hook") || l.includes("node:internal")) continue;
      const m = l.match(/\(?([^()\s]+\.js):(\d+):\d+\)?$/);
      if (!m || !m[1].startsWith(ROOT)) continue;
      const hit = { file: m[1].slice(ROOT.length), line: Number(m[2]) };
      // db.js's query() is a pass-through most of the codebase calls; the
      // file worth naming is whoever called it.
      if (hit.file === "db.js" && /\bquery\b/.test(l) && !viaDb) { viaDb = hit; continue; }
      return hit;
    }
    return viaDb || { file: "?", line: 0 };
  };
  // viaPool: pool.query() hands the work to a client from inside pg-pool, by
  // which time the caller is no longer on the stack. So the pool wrapper
  // records those (it still has the caller), and the client wrapper records
  // only what it can attribute — a client the code checked out itself.
  const record = (err, text, stack, viaPool) => {
    try {
      if (!err || !WRONG.test(String(err.code || "")) || IGNORE.has(err.code)) return;
      const src = sourceOf(stack);
      if (!viaPool && src.file === "?") return;
      fs.appendFileSync(LOG, JSON.stringify({
        t: Date.now(), code: err.code, message: String(err.message || "").slice(0, 300),
        file: src.file, line: src.line, sql: String(text || "").replace(/\s+/g, " ").trim().slice(0, 400),
      }) + "\n");
    } catch (_) { /* a watcher must never break what it watches */ }
  };
  const pg = require("pg");
  const orig = pg.Client.prototype.query;
  pg.Client.prototype.query = function (...args) {
    const first = args[0];
    const text = typeof first === "string" ? first : first && (first.text || (first.cursor && first.cursor.text));
    const stack = new Error().stack;
    const last = args[args.length - 1];
    if (typeof last === "function") {
      args[args.length - 1] = function (err, res) { if (err) record(err, text, stack); return last.apply(this, arguments); };
      return orig.apply(this, args);
    }
    if (first && typeof first.callback === "function") {
      const cb = first.callback;
      first.callback = function (err, res) { if (err) record(err, text, stack); return cb.apply(this, arguments); };
      return orig.apply(this, args);
    }
    const out = orig.apply(this, args);
    if (out && typeof out.then === "function") out.then(() => {}, (err) => record(err, text, stack));
    return out;
  };

  const poolOrig = pg.Pool.prototype.query;
  pg.Pool.prototype.query = function (...args) {
    const first = args[0];
    const text = typeof first === "string" ? first : first && first.text;
    const stack = new Error().stack;
    const last = args[args.length - 1];
    if (typeof last === "function") {
      args[args.length - 1] = function (err, res) { if (err) record(err, text, stack, true); return last.apply(this, arguments); };
      return poolOrig.apply(this, args);
    }
    const out = poolOrig.apply(this, args);
    if (out && typeof out.then === "function") out.then(() => {}, (err) => record(err, text, stack, true));
    return out;
  };
}
