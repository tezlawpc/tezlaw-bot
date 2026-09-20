// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-server.js — STANDALONE ENTRY POINT
//  ─────────────────────────────────────────────────────────
//  Boots the portal as its own Express process, with its own
//  database, on its own Render service.
//
//      node audit-server.js
//
//  This is the deployment to prefer. The portal issues credentials
//  to an outside audit firm; running it in the same process and the
//  same database as the firm's client matters puts external users
//  one application bug away from privileged files, and puts a 50MB
//  PDF parse on the same event loop as a WeChat webhook that must
//  answer within five seconds.
//
//  Running standalone also means this service can be handed to
//  Nightfood later — change the Render account and the DNS, nothing
//  else — which is where an issuer's books-and-records system should
//  live once it is listed.
//
//  Nothing else in the portal changes. audit-mount.js still works
//  for an in-process mount; this file is an alternative front door,
//  not a fork.
// ============================================================

const express = require("express");
const portal = require("./audit-mount");

const PORT = Number(process.env.PORT) || 3000;
const BASE = process.env.AUDIT_BASE_PATH || "/audit";

// Fail fast and loudly. A portal that boots without a database looks
// healthy to Render's health check and then 500s on the first auditor
// who signs in, which is the worst possible time to discover it.
if (!process.env.DATABASE_URL) {
  console.error("[ngtf-audit] FATAL: DATABASE_URL is not set.");
  console.error("[ngtf-audit] Standalone mode needs its own Postgres, separate from the host application's.");
  process.exit(1);
}

const app = express();

// Render terminates TLS at its proxy. Without this, req.protocol is
// "http" behind the proxy, req.ip is the proxy's address rather than
// the client's, and the login throttle in audit-auth.js would count
// every failed attempt in the portal against one shared address.
app.set("trust proxy", 1);
app.disable("x-powered-by");

// ── Health check ────────────────────────────────────────────
// Render pings this. Deliberately outside the portal mount so it
// never requires a session, and deliberately touching the database
// so a service with a dead connection reports unhealthy instead of
// sitting green while every real request fails.
app.get("/healthz", async (_req, res) => {
  try {
    const db = require("./db");
    const r = await db.query("SELECT 1 AS ok");
    res.status(200).json({
      ok: r.rows[0].ok === 1,
      service: "ngtf-audit-portal",
      base: BASE,
      time: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// ── The portal ──────────────────────────────────────────────
portal.mount(app);

// Bare domain goes to the portal rather than a 404. Auditors will be
// given the root URL and will not think to append the mount path.
app.get("/", (_req, res) => res.redirect(BASE));

// Anything else.
app.use((_req, res) => {
  res.status(404).type("html").send(
    `<!doctype html><meta charset="utf-8"><title>Not found</title>` +
      `<style>body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;margin:16vh auto;max-width:34rem;padding:0 1.5rem;color:#1b1b1f}` +
      `a{color:#2b5fd9}</style>` +
      `<h1 style="font-size:1.25rem;margin:0 0 .5rem">Not found</h1>` +
      `<p>No page at this address. <a href="${BASE}">Go to the audit portal</a>.</p>`
  );
});

// ── Listen ──────────────────────────────────────────────────
// Bind 0.0.0.0 explicitly: Render's health check reaches the
// container from outside, and a default bind to localhost would pass
// locally and fail in deployment.
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[ngtf-audit] standalone portal listening on :${PORT}`);
  console.log(`[ngtf-audit] portal path ${BASE}`);
  console.log(`[ngtf-audit] health check /healthz`);
});

// Render sends SIGTERM on deploy and on scale-down, then SIGKILLs
// after 30 seconds. Draining matters here more than in a chat bot: a
// severed connection mid-upload leaves a document row with no bytes
// behind it, and the auditor sees an item that claims to be satisfied
// by a file that will not download.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[ngtf-audit] ${signal} received, finishing in-flight requests`);
  const force = setTimeout(() => {
    console.error("[ngtf-audit] drain timed out at 25s, exiting anyway");
    process.exit(1);
  }, 25000);
  force.unref();
  server.close(() => {
    console.log("[ngtf-audit] closed cleanly");
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// An unhandled rejection in a notification sweep should be loud in the
// log, not a silent process death that Render restarts without comment.
process.on("unhandledRejection", (err) => {
  console.error("[ngtf-audit] unhandled rejection:", err && err.stack ? err.stack : err);
});

// ── Keep a dropped database connection from killing the process ─────
//
// node-postgres emits an 'error' event on a pooled client when its TCP
// connection dies while the client sits idle — a managed-Postgres idle
// timeout, a failover, a network blip. With no listener, Node treats it
// as an uncaught exception and the process EXITS:
//
//   throw er; // Unhandled 'error' event
//   Error: Connection terminated unexpectedly
//       at Connection.<anonymous> (pg/lib/client.js:204)
//
// That is what was killing every folder scan. A scan downloads a file
// for several seconds at a time, so pooled connections sit idle exactly
// long enough to be reaped, and the death looked like an unexplained
// restart. The pool recovers from this on its own — it discards the
// dead client and opens a new one — provided somebody is listening.
try {
  const db = require("./db");
  const pool = typeof db.getPool === "function" ? db.getPool() : null;
  if (pool && typeof pool.on === "function") {
    pool.on("error", (err) => {
      console.error("[ngtf-audit] idle database client dropped (recovering):", err.message);
    });
  } else {
    console.warn("[ngtf-audit] could not attach a pool error handler — db.js exposes no getPool()");
  }
} catch (err) {
  console.error("[ngtf-audit] pool error handler not attached:", err.message);
}

// Last line of defence. A connection error that still reaches here is
// survivable and must not take the process down mid-scan. Anything else
// is a real defect: log it in full and exit so Render restarts cleanly
// rather than leaving a half-broken process serving requests.
process.on("uncaughtException", (err) => {
  const msg = (err && err.message) || String(err);
  const recoverable =
    /Connection terminated|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|Client has encountered a connection error/i.test(msg);
  if (recoverable) {
    console.error("[ngtf-audit] recoverable connection error (continuing):", msg);
    return;
  }
  console.error("[ngtf-audit] FATAL uncaught exception:", err && err.stack ? err.stack : err);
  process.exit(1);
});

module.exports = { app, server };
