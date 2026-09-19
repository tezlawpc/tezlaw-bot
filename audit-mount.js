// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-mount.js — SINGLE ENTRY POINT
//  ─────────────────────────────────────────────────────────
//  Wiring the whole portal into an existing Express app is two
//  lines in server.js:
//
//      const ngtfAudit = require("./audit-mount");
//      ngtfAudit.mount(app);
//
//  That is deliberately the entire integration surface. Everything
//  else — tables, triggers, auth, routes, cron — is set up from
//  here, so the host application never has to know the portal's
//  internals and the portal can be removed by deleting those two
//  lines.
//
//  MOUNT ORDER MATTERS, for the same reason it matters in the host
//  app's own auth: the /audit auth middleware must be registered
//  BEFORE the router, or req.auditUser is undefined when a route
//  handler runs and every request 401s.
//
//  This mounts at /audit, NOT /admin/audit, so the portal sits
//  outside the host application's admin authentication. External
//  auditors sign in here with their own accounts and never touch
//  the host app's user table, navigation or session.
// ============================================================

const schema = require("./audit-schema");
const auth = require("./audit-auth");
const api = require("./audit-api");
const notify = require("./audit-notify");
const cal = require("./audit-calendar");

const BASE = process.env.AUDIT_BASE_PATH || "/audit";

let _cronStarted = false;
let _logged = false;

/**
 * Create tables, triggers and seed settings.
 *
 * Safe to call repeatedly AND concurrently — schema.initAuditTables()
 * memoizes its in-flight promise and holds a Postgres advisory lock, so
 * calling this from mount() and again from boot code (or from two
 * application instances at once) is fine. Callers can await it to be
 * certain the schema exists before touching it.
 */
async function init() {
  await schema.initAuditTables();
  try {
    await require("./audit-sync").initSyncTables();
  } catch (err) {
    // The folder scan is an add-on; the portal must still boot without it.
    console.error("[ngtf-audit] sync tables init failed:", err.message);
  }
  if (!_logged) {
    _logged = true;
    console.log("[ngtf-audit] schema ready (tables, AS 1215 immutability triggers, settings)");
  }
}

/**
 * Mount the portal on an Express app.
 * @param {object} app      Express application
 * @param {object} options  { basePath, startCron }
 */
function mount(app, options = {}) {
  const base = options.basePath || BASE;

  // Schema init runs in the background so a slow first connection
  // never blocks server startup. Requests that arrive before it
  // finishes get a clean 503 from the auth middleware rather than a
  // stack trace.
  init().catch((err) => {
    console.error("[ngtf-audit] schema init FAILED:", err.message);
    console.error("[ngtf-audit] the portal will not work until this is resolved. Check DATABASE_URL.");
  });

  // 1. Auth middleware FIRST — sets req.auditUser on every request.
  app.use(base, auth.requireAuth);

  // 2. Router SECOND.
  app.use(base, api.router);

  console.log(`[ngtf-audit] mounted at ${base}`);

  if (options.startCron !== false) startCron();

  return app;
}

/**
 * Scheduled notification sweeps.
 *
 * Times are expressed in the timezone given by AUDIT_TZ (default
 * America/New_York — Nightfood is headquartered in Tarrytown, NY, and
 * SEC deadlines are effectively Eastern). node-cron is already a
 * dependency of the host app.
 */
function startCron() {
  if (_cronStarted) return;
  let cron;
  try {
    cron = require("node-cron");
  } catch {
    console.warn("[ngtf-audit] node-cron not available — scheduled notification sweeps are disabled.");
    return;
  }
  const tz = process.env.AUDIT_TZ || "America/New_York";
  const opts = { timezone: tz };

  // Outbox drain — every 5 minutes. Instant notifications also flush
  // inline at the point of the event; this catches anything that
  // failed because SMTP was briefly unavailable.
  cron.schedule("*/5 * * * *", async () => {
    try {
      const r = await notify.flush(100);
      if (r.sent) console.log(`[ngtf-audit] outbox: sent ${r.sent}, failed ${r.failed}`);
    } catch (err) {
      console.error("[ngtf-audit] outbox flush error:", err.message);
    }
  }, opts);

  // Retry recent failures — hourly.
  cron.schedule("17 * * * *", async () => {
    try {
      await notify.retryFailed(40);
    } catch (err) {
      console.error("[ngtf-audit] retry error:", err.message);
    }
  }, opts);

  // Morning obligations sweep — weekdays at 07:30.
  // Due-soon, overdue, gating items at risk. Company-facing.
  cron.schedule("30 7 * * 1-5", async () => {
    try {
      const r = await notify.notifyDueAndOverdue();
      await notify.flush(200);
      console.log("[ngtf-audit] morning sweep:", JSON.stringify(r));
    } catch (err) {
      console.error("[ngtf-audit] morning sweep error:", err.message);
    }
  }, opts);

  // Filing deadline reminders — weekdays at 08:00, at T-30/14/7/3/1.
  cron.schedule("0 8 * * 1-5", async () => {
    try {
      const r = await notify.notifyFilingDeadlines();
      await notify.flush(100);
      if (r.sent) console.log("[ngtf-audit] filing reminders sent:", r.sent);
    } catch (err) {
      console.error("[ngtf-audit] filing reminder error:", err.message);
    }
  }, opts);

  // AS 1215 archive countdown — daily at 08:15. Auditor-facing.
  cron.schedule("15 8 * * *", async () => {
    try {
      const r = await notify.notifyArchiveCountdown();
      await notify.flush(100);
      if (r.sent) console.log("[ngtf-audit] archive countdown notices:", r.sent);
    } catch (err) {
      console.error("[ngtf-audit] archive countdown error:", err.message);
    }
  }, opts);

  // Dropbox folder scan.
  //
  // Daily at 06:00 by default, before anyone is looking, so the morning
  // obligations sweep at 07:30 already reflects whatever arrived
  // overnight. AUDIT_SYNC_CRON overrides it — "0 */6 * * *" for every
  // six hours, "0 */3 * * *" for every three.
  //
  // Set AUDIT_SYNC_ENABLED=0 to keep the page and the manual button but
  // stop the schedule, which is what you want while the classifier is
  // still being tuned.
  if (process.env.AUDIT_SYNC_ENABLED !== "0") {
    const syncCron = process.env.AUDIT_SYNC_CRON || "0 6 * * *";
    cron.schedule(
      syncCron,
      async () => {
        try {
          const sync = require("./audit-sync");
          const dropbox = require("./audit-dropbox");
          if (!dropbox.configured()) return;
          const r = await sync.run({});
          await notify.flush(100);
          console.log(
            `[ngtf-audit] dropbox scan: seen ${r.seen}, imported ${r.imported}, skipped ${r.skipped}, failed ${r.failed}`
          );
        } catch (err) {
          console.error("[ngtf-audit] dropbox scan error:", err.message);
        }
      },
      opts
    );
    console.log(`[ngtf-audit] dropbox scan scheduled (${syncCron}, timezone ${tz})`);
  }

  // Audit committee weekly roll-up — Mondays at 08:30.
  cron.schedule("30 8 * * 1", async () => {
    try {
      const r = await notify.notifyCommitteeDigest();
      await notify.flush(50);
      console.log("[ngtf-audit] committee digest:", JSON.stringify(r));
    } catch (err) {
      console.error("[ngtf-audit] committee digest error:", err.message);
    }
  }, opts);

  _cronStarted = true;
  console.log(`[ngtf-audit] scheduled sweeps started (timezone ${tz})`);
}

/**
 * Convenience for a first run: creates every engagement for a fiscal
 * year with its full checklist. Also callable over HTTP via
 * POST /audit/api/engagement/seed-year.
 */
async function seedFiscalYear(fiscalYear, actor) {
  await init();
  const store = require("./audit-store");
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const info = cal.fiscalMonths(fiscalYear).find((x) => x.fiscalMonth === m);
    if (info.isFiscalYearEnd || info.isQuarterEnd) continue;
    const r = await store.openEngagement({ tier: "monthly", fiscalYear, n: m, actor });
    out.push({ period: r.engagement.period_label, created: r.created });
  }
  for (const q of [1, 2, 3]) {
    const r = await store.openEngagement({ tier: "quarterly", fiscalYear, n: q, actor });
    out.push({ period: r.engagement.period_label, created: r.created });
  }
  const a = await store.openEngagement({ tier: "annual", fiscalYear, actor });
  out.push({ period: a.engagement.period_label, created: a.created });
  return out;
}

module.exports = {
  mount,
  init,
  startCron,
  seedFiscalYear,
  BASE,
  // re-exported so callers can reach the pieces without extra requires
  schema,
  auth,
  notify,
  calendar: cal,
  taxonomy: require("./audit-taxonomy"),
  checklists: require("./audit-checklists"),
  classifier: require("./audit-classifier"),
  store: require("./audit-store"),
  sync: require("./audit-sync"),
  dropbox: require("./audit-dropbox"),
  zip: require("./audit-zip"),
};
