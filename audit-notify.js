// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-notify.js — NOTIFICATION ROUTING
//  ─────────────────────────────────────────────────────────
//  Who hears about what, and when.
//
//  ROUTING PRINCIPLE: the auditor hears about EVIDENCE arriving;
//  the company hears about OBLIGATIONS coming due. Sending both
//  sides everything is how a notification system gets muted in
//  week two, and a muted system is worse than none — it creates a
//  false record that the auditor "was notified."
//
//    → auditor          document uploaded (with the brief),
//                       document superseded by a new version,
//                       sweep answered YES (new obligation found),
//                       gate item satisfied, engagement ready for
//                       archive, AS 1215 countdown
//    → company          item due soon, item overdue, gate overdue,
//                       auditor review note raised, document
//                       rejected, filing deadline approaching,
//                       12b-25 decision point
//    → both             engagement opened, checklist generated,
//                       report released, engagement archived/locked
//    → audit committee  gate status, overdue gates, AS 1301 package
//                       ready, report released. Weekly digest only —
//                       committee members should not be paged.
//
//  DELIVERY: every notification is written to the outbox table
//  FIRST and sent SECOND. If SMTP is down, the record still exists
//  and retries on the next sweep. That ordering matters: "the
//  auditor was notified" is itself audit evidence under AS 1301.25
//  (difficulties encountered, including delays in receiving
//  information), so the record cannot depend on the mail server
//  having been up.
//
//  CHANNELS: email via nodemailer (already a dependency), optional
//  SMS via Twilio REST through axios (already a dependency), and an
//  optional generic webhook. No new packages.
// ============================================================

const db = require("./db");
const tax = require("./audit-taxonomy");
const cal = require("./audit-calendar");
const schema = require("./audit-schema");

// ── Transport config ────────────────────────────────────────
const SMTP = {
  host: process.env.AUDIT_SMTP_HOST || null,
  port: Number(process.env.AUDIT_SMTP_PORT || 587),
  user: process.env.AUDIT_SMTP_USER || process.env.GMAIL_EMAIL || null,
  pass: process.env.AUDIT_SMTP_PASS || process.env.GMAIL_APP_PASSWORD || null,
  from: process.env.AUDIT_FROM_EMAIL || process.env.GMAIL_EMAIL || null,
  fromName: process.env.AUDIT_FROM_NAME || "Nightfood Audit Portal",
};
const TWILIO = {
  sid: process.env.TWILIO_ACCOUNT_SID || null,
  token: process.env.TWILIO_AUTH_TOKEN || null,
  from: process.env.AUDIT_SMS_FROM || process.env.TWILIO_PHONE_NUMBER || null,
};
const WEBHOOK_URL = process.env.AUDIT_WEBHOOK_URL || null;
const PORTAL_URL = (process.env.AUDIT_PORTAL_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");

function portalLink(path) {
  return PORTAL_URL ? `${PORTAL_URL}${path}` : path;
}

// ── Audience resolution ─────────────────────────────────────
async function audience(kind) {
  const MAP = {
    auditor: ["auditor_lead", "auditor_staff"],
    auditor_lead: ["auditor_lead"],
    company: ["portal_admin", "company_admin", "company_contributor"],
    company_lead: ["portal_admin", "company_admin"],
    committee: ["audit_committee"],
    all: [
      "portal_admin",
      "company_admin",
      "company_contributor",
      "auditor_lead",
      "auditor_staff",
      "audit_committee",
    ],
  };
  const roles = MAP[kind] || MAP.all;
  const r = await db.query(
    `SELECT id, email, name, role, org, phone, notify_email, notify_sms, notify_instant, notify_digest
       FROM ngtf_audit_users
      WHERE active = TRUE AND role = ANY($1)`,
    [roles]
  );
  return r.rows;
}

// ── Outbox ──────────────────────────────────────────────────
async function enqueue({ kind, recipients, subject, body, documentId, itemId, engagementId, instant = true }) {
  const rows = [];
  for (const u of recipients) {
    // Respect per-user preferences: a user on digest-only does not
    // get paged for routine events, but ALWAYS gets escalations.
    const isEscalation = /overdue|gate|rejected|locked|deadline/.test(kind);
    if (!instant && !isEscalation && u.notify_digest === "off") continue;
    if (u.notify_email && (u.notify_instant || !instant || isEscalation)) {
      rows.push(
        await insertNotification({
          kind,
          channel: "email",
          recipient: u,
          addr: u.email,
          subject,
          body,
          documentId,
          itemId,
          engagementId,
          scheduled: instant || isEscalation ? null : nextDigestTime(),
        })
      );
    }
    if (u.notify_sms && u.phone && isEscalation) {
      rows.push(
        await insertNotification({
          kind,
          channel: "sms",
          recipient: u,
          addr: u.phone,
          subject,
          body: smsify(subject, body),
          documentId,
          itemId,
          engagementId,
          scheduled: null,
        })
      );
    }
  }
  if (WEBHOOK_URL) {
    rows.push(
      await insertNotification({
        kind,
        channel: "webhook",
        recipient: null,
        addr: WEBHOOK_URL,
        subject,
        body,
        documentId,
        itemId,
        engagementId,
        scheduled: null,
      })
    );
  }
  return rows.filter(Boolean);
}

async function insertNotification({ kind, channel, recipient, addr, subject, body, documentId, itemId, engagementId, scheduled }) {
  try {
    const r = await db.query(
      `INSERT INTO ngtf_audit_notifications
         (kind, channel, recipient_id, recipient_addr, subject, body, document_id, item_id, engagement_id, scheduled_for)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, NOW()))
       RETURNING id`,
      [
        kind,
        channel,
        recipient ? recipient.id : null,
        addr,
        subject,
        body,
        documentId || null,
        itemId || null,
        engagementId || null,
        scheduled,
      ]
    );
    return r.rows[0].id;
  } catch (err) {
    console.error("[ngtf-audit notify] enqueue failed:", err.message);
    return null;
  }
}

function nextDigestTime() {
  const hour = Number(process.env.AUDIT_DIGEST_HOUR || 7);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function smsify(subject, body) {
  const plain = String(body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return `${subject} — ${plain}`.slice(0, 300);
}

// ── Senders ─────────────────────────────────────────────────
let _transport = null;
function transport() {
  if (_transport) return _transport;
  if (!SMTP.user || !SMTP.pass) return null;
  const nodemailer = require("nodemailer");
  _transport = SMTP.host
    ? nodemailer.createTransport({
        host: SMTP.host,
        port: SMTP.port,
        secure: SMTP.port === 465,
        auth: { user: SMTP.user, pass: SMTP.pass },
      })
    : nodemailer.createTransport({ service: "gmail", auth: { user: SMTP.user, pass: SMTP.pass } });
  return _transport;
}

async function sendEmail(to, subject, html) {
  const t = transport();
  if (!t) throw new Error("SMTP not configured (set AUDIT_SMTP_USER/AUDIT_SMTP_PASS or GMAIL_EMAIL/GMAIL_APP_PASSWORD)");
  await t.sendMail({
    from: `"${SMTP.fromName}" <${SMTP.from || SMTP.user}>`,
    to,
    subject,
    html,
    text: String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  });
}

async function sendSMS(to, body) {
  if (!TWILIO.sid || !TWILIO.token || !TWILIO.from) throw new Error("Twilio not configured");
  const axios = require("axios");
  const params = new URLSearchParams({ To: to, From: TWILIO.from, Body: body });
  await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO.sid}/Messages.json`, params.toString(), {
    auth: { username: TWILIO.sid, password: TWILIO.token },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });
}

async function sendWebhook(url, payload) {
  const axios = require("axios");
  await axios.post(url, payload, { timeout: 15000 });
}

/** Drain the outbox. Called by cron and after instant events. */
async function flush(limit = 60) {
  let sent = 0;
  let failed = 0;
  const r = await db.query(
    `SELECT * FROM ngtf_audit_notifications
      WHERE status = 'queued' AND scheduled_for <= NOW()
      ORDER BY id ASC LIMIT $1`,
    [limit]
  );
  for (const n of r.rows) {
    try {
      if (n.channel === "email") await sendEmail(n.recipient_addr, n.subject, n.body);
      else if (n.channel === "sms") await sendSMS(n.recipient_addr, n.body);
      else if (n.channel === "webhook")
        await sendWebhook(n.recipient_addr, {
          kind: n.kind,
          subject: n.subject,
          body: n.body,
          documentId: n.document_id,
          engagementId: n.engagement_id,
        });
      await db.query(`UPDATE ngtf_audit_notifications SET status='sent', sent_at=NOW() WHERE id=$1`, [n.id]);
      sent++;
    } catch (err) {
      failed++;
      await db.query(`UPDATE ngtf_audit_notifications SET status='failed', error=$1 WHERE id=$2`, [
        String(err.message).slice(0, 500),
        n.id,
      ]);
      console.error(`[ngtf-audit notify] send failed (${n.channel} → ${n.recipient_addr}):`, err.message);
    }
  }
  return { sent, failed, considered: r.rows.length };
}

/** Retry failures once per sweep, up to a cap. */
async function retryFailed(limit = 25) {
  await db.query(
    `UPDATE ngtf_audit_notifications SET status='queued'
      WHERE id IN (SELECT id FROM ngtf_audit_notifications
                    WHERE status='failed' AND created_at > NOW() - INTERVAL '3 days'
                    ORDER BY id DESC LIMIT $1)`,
    [limit]
  );
  return flush(limit);
}

// ── HTML shell ──────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shell(title, inner, accent = "#1F3A5F") {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;">
    <div style="background:${accent};color:#fff;padding:18px 22px;">
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:.75;">Nightfood Holdings, Inc. · NGTF · Audit Portal</div>
      <div style="font-size:19px;font-weight:600;margin-top:4px;">${esc(title)}</div>
    </div>
    <div style="padding:22px;color:#1a1a1a;font-size:14px;line-height:1.6;">${inner}</div>
    <div style="padding:14px 22px;background:#F6F7F9;color:#667;font-size:11px;line-height:1.5;border-top:1px solid #E3E6EA;">
      Automated message from the Nightfood audit portal. Documents are retained for seven years from the
      report release date under PCAOB AS 1215.14 and become append-only at the documentation completion
      date under AS 1215.16. Every download is logged.
    </div>
  </div>`;
}

function kvTable(rows) {
  return `<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:13px;">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 10px 6px 0;color:#667;white-space:nowrap;vertical-align:top;width:34%;">${esc(
          k
        )}</td><td style="padding:6px 0;color:#1a1a1a;">${v}</td></tr>`
    )
    .join("")}</table>`;
}

function button(label, href, color = "#1F3A5F") {
  if (!PORTAL_URL) return "";
  return `<a href="${esc(href)}" style="display:inline-block;margin-top:10px;padding:10px 18px;background:${color};color:#fff;text-decoration:none;border-radius:5px;font-size:13px;font-weight:600;">${esc(
    label
  )}</a>`;
}

// ── Event notifications ─────────────────────────────────────

/**
 * The core one: the company uploaded a document, the auditor is
 * told what arrived and what it is, without having to open it.
 */
async function notifyDocumentUploaded({ document, classification, uploader, engagement }) {
  const cat = classification.categoryCode ? tax.CATEGORY_BY_CODE[classification.categoryCode] : null;
  const br = cat ? tax.BRACKET_BY_CODE[cat.bracket] : null;
  const accent = br ? br.color : "#667";

  const subject = classification.classified
    ? `[NGTF] ${cat.label} uploaded — ${classification.period.periodLabel}`
    : `[NGTF] Unclassified document uploaded — needs triage`;

  const flagsHtml = (classification.flags || []).length
    ? `<div style="margin:12px 0;padding:10px 12px;background:#FFF6E5;border-left:3px solid #B45309;font-size:13px;">
         <strong style="color:#B45309;">Pre-flight flags</strong><br>${classification.flags
           .map((f) => esc(f.replace(/_/g, " ")))
           .join("<br>")}
       </div>`
    : "";

  const gateHtml = classification.isGate
    ? `<div style="margin:12px 0;padding:10px 12px;background:#FDECEC;border-left:3px solid #991B1B;font-size:13px;">
         <strong style="color:#991B1B;">Gating item.</strong> A report or filing cannot issue without this.
       </div>`
    : "";

  const inner = `
    <p style="margin:0 0 6px;"><strong>${esc(classification.brief || "Document uploaded.")}</strong></p>
    ${gateHtml}
    ${kvTable([
      ["File", esc(document.filename)],
      ["Category", cat ? `${esc(cat.code)} — ${esc(cat.label)}` : "<em>unclassified — in triage queue</em>"],
      ["Section", br ? esc(br.label) : "—"],
      ["Filed to", `<code style="font-size:11px;color:#445;">${esc(classification.folderPath || "/_triage")}</code>`],
      ["Period", esc(classification.period ? classification.period.periodLabel : "—")],
      ["Version", `v${document.version}${document.supersedes_id ? " (supersedes an earlier version)" : ""}`],
      ["Size", `${(document.size_bytes / 1024 / 1024).toFixed(2)} MB`],
      ["SHA-256", `<code style="font-size:10px;color:#889;">${esc(document.sha256)}</code>`],
      ["Uploaded by", `${esc(uploader.name)} (${esc(uploader.email)})`],
      [
        "Classification",
        `${classification.confidence}% confidence via ${esc(classification.method)}${
          classification.needsConfirmation ? " — <strong style='color:#B45309;'>awaiting confirmation</strong>" : ""
        }`,
      ],
      ...(cat && cat.authority ? [["Required under", esc(cat.authority.join(", "))]] : []),
    ])}
    ${flagsHtml}
    ${button("Open in portal", portalLink(`/audit/document/${document.id}`), accent)}
  `;

  const recipients = await audience("auditor");
  await enqueue({
    kind: "document_uploaded",
    recipients,
    subject,
    body: shell(subject.replace("[NGTF] ", ""), inner, accent),
    documentId: document.id,
    engagementId: engagement ? engagement.id : null,
    instant: true,
  });
  return recipients.length;
}

/** A sweep answered YES means new obligations just appeared. */
async function notifySweepYes({ item, answerNote, spawned, user, engagement }) {
  const subject = `[NGTF] Sweep answered YES — ${spawned.length} new item${spawned.length === 1 ? "" : "s"} required`;
  const inner = `
    <p style="margin:0 0 10px;">A period-end sweep question was answered <strong>YES</strong>, which adds document requirements to the checklist.</p>
    ${kvTable([
      ["Question", esc(item.label)],
      ["Answered by", `${esc(user.name)} (${esc(user.email)})`],
      ["Period", esc(engagement ? engagement.period_label : "—")],
      ["Detail provided", answerNote ? esc(answerNote) : "<em>none</em>"],
      ["Authority", esc((item.authority || []).join(", "))],
    ])}
    <p style="margin:12px 0 4px;font-weight:600;">Now required:</p>
    <ul style="margin:0;padding-left:20px;">
      ${spawned
        .map((c) => {
          const cat = tax.CATEGORY_BY_CODE[c];
          return cat ? `<li>${esc(cat.code)} — ${esc(cat.label)}</li>` : "";
        })
        .join("")}
    </ul>
    ${item.why ? `<div style="margin:12px 0;padding:10px 12px;background:#F2F6FA;border-left:3px solid #2C5F8A;font-size:13px;">${esc(item.why)}</div>` : ""}
    ${button("Review checklist", portalLink(`/audit/checklist/${engagement ? engagement.id : ""}`), "#2C5F8A")}
  `;
  const recipients = await audience("auditor");
  await enqueue({
    kind: "sweep_yes",
    recipients,
    subject,
    body: shell("Sweep question answered YES", inner, "#2C5F8A"),
    itemId: item.id,
    engagementId: engagement ? engagement.id : null,
    instant: true,
  });
}

/** Auditor raised a review note / rejected an item → company. */
async function notifyReviewNote({ comment, document, item, author, engagement }) {
  const subject = `[NGTF] Auditor review note${document ? ` — ${document.filename}` : ""}`;
  const inner = `
    <p style="margin:0 0 10px;">${esc(author.name)}${author.firmName ? ` (${esc(author.firmName)})` : ""} raised a note requiring a response.</p>
    ${kvTable([
      ...(document ? [["Document", esc(document.filename)]] : []),
      ...(item ? [["Checklist item", esc(item.label)]] : []),
      ["Period", esc(engagement ? engagement.period_label : "—")],
      ["Note", `<div style="white-space:pre-wrap;">${esc(comment.body)}</div>`],
    ])}
    ${button("Respond in portal", portalLink(document ? `/audit/document/${document.id}` : "/audit"), "#9C4221")}
  `;
  const recipients = await audience("company");
  await enqueue({
    kind: "review_note",
    recipients,
    subject,
    body: shell("Auditor review note", inner, "#9C4221"),
    documentId: document ? document.id : null,
    itemId: item ? item.id : null,
    engagementId: engagement ? engagement.id : null,
    instant: true,
  });
}

/** Daily: what's due soon, what's overdue, which gates are at risk. */
async function notifyDueAndOverdue() {
  const soon = await db.query(
    `SELECT i.*, c.period_label, c.tier, c.engagement_id
       FROM ngtf_audit_checklist_items i
       JOIN ngtf_audit_checklists c ON c.id = i.checklist_id
      WHERE i.status IN ('open')
        AND i.due_date IS NOT NULL
        AND i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'
      ORDER BY i.is_gate DESC, i.due_date ASC`
  );
  const overdue = await db.query(
    `SELECT i.*, c.period_label, c.tier, c.engagement_id
       FROM ngtf_audit_checklist_items i
       JOIN ngtf_audit_checklists c ON c.id = i.checklist_id
      WHERE i.status IN ('open')
        AND i.due_date IS NOT NULL
        AND i.due_date < CURRENT_DATE
      ORDER BY i.is_gate DESC, i.due_date ASC`
  );
  if (!soon.rows.length && !overdue.rows.length) return { sent: 0, reason: "nothing due" };

  const gatesOverdue = overdue.rows.filter((r) => r.is_gate);
  const subject = gatesOverdue.length
    ? `[NGTF] ${gatesOverdue.length} GATING item${gatesOverdue.length === 1 ? "" : "s"} overdue — filing at risk`
    : `[NGTF] ${overdue.rows.length} overdue, ${soon.rows.length} due within 3 days`;

  const list = (rows, color) =>
    rows.length
      ? `<ul style="margin:6px 0 14px;padding-left:20px;">${rows
          .slice(0, 40)
          .map(
            (r) =>
              `<li style="margin-bottom:4px;">${r.is_gate ? `<strong style="color:${color};">[GATE]</strong> ` : ""}${esc(
                r.category_code || r.sweep_id || ""
              )} ${esc(r.label.slice(0, 110))} <span style="color:#889;">— due ${esc(cal.dstr(r.due_date))} · ${esc(r.period_label)}</span></li>`
          )
          .join("")}</ul>`
      : "<p style='color:#889;margin:4px 0 14px;'>None.</p>";

  const inner = `
    ${gatesOverdue.length
      ? `<div style="margin:0 0 14px;padding:12px;background:#FDECEC;border-left:3px solid #991B1B;">
           <strong style="color:#991B1B;">Gating items are overdue.</strong> A gating item is one where a
           standard or rule prevents the report or filing from issuing until it is delivered — for example the
           management representation letter, which makes an AS 4105 interim review incomplete and the 10-Q
           unfileable until signed.
         </div>`
      : ""}
    <p style="margin:0 0 4px;font-weight:600;color:#991B1B;">Overdue (${overdue.rows.length})</p>
    ${list(overdue.rows, "#991B1B")}
    <p style="margin:0 0 4px;font-weight:600;color:#B45309;">Due within 3 days (${soon.rows.length})</p>
    ${list(soon.rows, "#B45309")}
    ${button("Open checklist", portalLink("/audit"), "#1F3A5F")}
  `;

  const recipients = await audience("company");
  await enqueue({
    kind: gatesOverdue.length ? "gate_overdue" : "items_due",
    recipients,
    subject,
    body: shell("Outstanding checklist items", inner, gatesOverdue.length ? "#991B1B" : "#B45309"),
    instant: true,
  });

  // Auditor lead sees gate slippage too — AS 1301.25 requires the
  // auditor to report difficulties, including delays, to the
  // audit committee. Better they learn it here than at the meeting.
  if (gatesOverdue.length) {
    await enqueue({
      kind: "gate_overdue",
      recipients: await audience("auditor_lead"),
      subject,
      body: shell("Gating items overdue", inner, "#991B1B"),
      instant: true,
    });
  }
  return { sent: recipients.length, overdue: overdue.rows.length, soon: soon.rows.length };
}

/** Statutory filing deadline approaching → company lead. */
async function notifyFilingDeadlines(daysAhead = [30, 14, 7, 3, 1]) {
  const r = await db.query(
    `SELECT * FROM ngtf_audit_engagements
      WHERE filing_due_date IS NOT NULL AND filed_on IS NULL
        AND filing_due_date >= CURRENT_DATE
      ORDER BY filing_due_date ASC`
  );
  let sent = 0;
  for (const eng of r.rows) {
    const days = Math.round((cal.parse(cal.dstr(eng.filing_due_date)) - cal.parse(cal.iso(new Date()))) / 86400000);
    if (!daysAhead.includes(days)) continue;

    const open = await db.query(
      `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_gate)::int AS gates
         FROM ngtf_audit_checklist_items i
         JOIN ngtf_audit_checklists c ON c.id = i.checklist_id
        WHERE c.engagement_id = $1 AND i.status = 'open'`,
      [eng.id]
    );
    const o = open.rows[0] || { n: 0, gates: 0 };
    const subject = `[NGTF] ${eng.filing_form || "Filing"} due in ${days} day${days === 1 ? "" : "s"} — ${eng.period_label}`;
    const inner = `
      ${kvTable([
        ["Form", esc(eng.filing_form || "—")],
        ["Period", esc(eng.period_name || eng.period_label)],
        ["Statutory due date", `<strong>${esc(cal.dstr(eng.filing_due_date))}</strong>`],
        ["Form 12b-25 must be filed by", esc(cal.dstr(eng.filing_nt_due_date) || "—")],
        ["Extended date if 12b-25 filed", esc(cal.dstr(eng.filing_extended_date) || "—")],
        ["Open checklist items", `${o.n}${o.gates ? ` (<strong style="color:#991B1B;">${o.gates} gating</strong>)` : ""}`],
      ])}
      ${
        eng.tier === "quarterly"
          ? `<div style="margin:12px 0;padding:10px 12px;background:#F2F6FA;border-left:3px solid #2C5F8A;font-size:13px;">
               Reg S-X 10-01(d) requires the AS 4105 interim review to be complete <strong>before</strong> the
               10-Q is filed, and AS 4105.34 makes the review incomplete without the signed quarterly
               representation letter. AS 1220 also requires an engagement quality review with concurring
               approval of issuance for interim reviews — leave room for the reviewer.
             </div>`
          : `<div style="margin:12px 0;padding:10px 12px;background:#F2F6FA;border-left:3px solid #2C5F8A;font-size:13px;">
               Part III may be incorporated by reference only from a proxy or information statement filed
               within 120 days of fiscal year end. Because Nightfood is not an emerging growth company, the
               auditor's report must include critical audit matters under AS 3101.
             </div>`
      }
      <div style="margin:12px 0;padding:10px 12px;background:#FFF6E5;border-left:3px solid #B45309;font-size:13px;">
        If this filing will be late, Form 12b-25 must be filed within <strong>one business day</strong> of the
        due date, must give the reasons in reasonable detail, and — where the delay is attributable to the
        auditor — must attach a <strong>signed statement from the auditor</strong>. Nasdaq Rule 5250(c) makes
        timely filing a continued-listing condition, so the late-filing pattern needs to be closed out before
        a listing application, not after.
      </div>
      ${button("Open portal", portalLink("/audit"), "#1F3A5F")}
    `;
    await enqueue({
      kind: "filing_deadline",
      recipients: await audience("company_lead"),
      subject,
      body: shell("Filing deadline approaching", inner, days <= 7 ? "#991B1B" : "#B45309"),
      engagementId: eng.id,
      instant: true,
    });
    sent++;
  }
  return { sent };
}

/** AS 1215 archive countdown → auditor. */
async function notifyArchiveCountdown() {
  const r = await db.query(
    `SELECT * FROM ngtf_audit_engagements
      WHERE report_release_date IS NOT NULL
        AND status NOT IN ('archived','locked')`
  );
  let sent = 0;
  for (const eng of r.rows) {
    const cd = cal.archiveCountdown(cal.dstr(eng.report_release_date));
    if (!cd) continue;

    const overdue = cd.daysRemaining < 0;
    if (!overdue && ![10, 7, 3, 1, 0].includes(cd.daysRemaining)) continue;

    // The overdue branch used to have no exit condition, so every
    // un-archived released engagement generated one email to the
    // engagement partner EVERY DAY indefinitely. That is exactly how a
    // notification system gets filtered to trash, and a filtered system
    // is worse than none because it still produces a record saying the
    // auditor was told. Once past the completion date, remind weekly.
    if (overdue) {
      const recent = await db.query(
        `SELECT 1 FROM ngtf_audit_notifications
          WHERE engagement_id=$1 AND kind='archive_countdown'
            AND created_at > NOW() - INTERVAL '7 days' LIMIT 1`,
        [eng.id]
      );
      if (recent.rows.length) continue;
    }

    const subject =
      cd.daysRemaining < 0
        ? `[NGTF] AS 1215 documentation completion date PASSED — ${eng.period_label}`
        : `[NGTF] AS 1215 archive due in ${cd.daysRemaining} day${cd.daysRemaining === 1 ? "" : "s"} — ${eng.period_label}`;
    const inner = `
      ${kvTable([
        ["Engagement", esc(eng.period_name || eng.period_label)],
        ["Report release date", esc(cd.reportReleaseDate)],
        ["Documentation completion date", `<strong>${esc(cd.completionDate)}</strong> (14 days)`],
        ["Days remaining", String(cd.daysRemaining)],
        ["Retention through", esc(cd.retentionExpiry)],
      ])}
      <div style="margin:12px 0;padding:10px 12px;background:#F2F6FA;border-left:3px solid #2C5F8A;font-size:13px;">
        AS 1215.15 as amended by PCAOB Release 2024-004 requires the complete and final documentation set to
        be assembled within <strong>14 days</strong> of report release — not the 45 days that applied before.
        For firms auditing 100 or fewer issuers this applies to fiscal years beginning on or after
        December 15, 2025, which covers Nightfood's FY2027 (beginning July 1, 2026).
        <br><br>
        Once archived, AS 1215.16 permits <strong>additions only</strong>: nothing may be deleted, and every
        addition must record the date added, the preparer and the reason. The portal enforces this in the
        database, not merely in the interface.
      </div>
      ${button("Archive engagement", portalLink(`/audit/engagement/${eng.id}`), "#9C4221")}
    `;
    await enqueue({
      kind: "archive_countdown",
      recipients: await audience("auditor_lead"),
      subject,
      body: shell("AS 1215 documentation completion", inner, "#9C4221"),
      engagementId: eng.id,
      instant: true,
    });
    sent++;
  }
  return { sent };
}

/** Weekly roll-up → audit committee (they should not be paged). */
async function notifyCommitteeDigest() {
  const eng = await db.query(
    `SELECT e.*,
            (SELECT COUNT(*) FROM ngtf_audit_checklist_items i JOIN ngtf_audit_checklists c ON c.id=i.checklist_id
              WHERE c.engagement_id=e.id AND i.status='open')::int AS open_items,
            (SELECT COUNT(*) FROM ngtf_audit_checklist_items i JOIN ngtf_audit_checklists c ON c.id=i.checklist_id
              WHERE c.engagement_id=e.id AND i.status='open' AND i.is_gate)::int AS open_gates,
            (SELECT COUNT(*) FROM ngtf_audit_comments cm
              WHERE cm.engagement_id=e.id AND cm.resolved=FALSE)::int AS open_notes
       FROM ngtf_audit_engagements e
      WHERE e.status NOT IN ('archived','locked')
      ORDER BY e.period_end DESC NULLS LAST LIMIT 6`
  );
  if (!eng.rows.length) return { sent: 0 };

  const rows = eng.rows
    .map(
      (e) => `<tr>
        <td style="padding:7px 8px;border-bottom:1px solid #E3E6EA;">${esc(e.period_name || e.period_label)}</td>
        <td style="padding:7px 8px;border-bottom:1px solid #E3E6EA;">${esc(e.status)}</td>
        <td style="padding:7px 8px;border-bottom:1px solid #E3E6EA;text-align:right;">${e.open_items}</td>
        <td style="padding:7px 8px;border-bottom:1px solid #E3E6EA;text-align:right;color:${e.open_gates ? "#991B1B" : "#1a1a1a"};font-weight:${e.open_gates ? 700 : 400};">${e.open_gates}</td>
        <td style="padding:7px 8px;border-bottom:1px solid #E3E6EA;text-align:right;">${e.open_notes}</td>
        <td style="padding:7px 8px;border-bottom:1px solid #E3E6EA;">${esc(cal.dstr(e.filing_due_date) || "—")}</td>
      </tr>`
    )
    .join("");

  const inner = `
    <p style="margin:0 0 10px;">Weekly status for the audit committee. No action is requested unless a gating item is shown as open.</p>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <tr style="background:#F6F7F9;">
        <th style="padding:7px 8px;text-align:left;">Period</th>
        <th style="padding:7px 8px;text-align:left;">Status</th>
        <th style="padding:7px 8px;text-align:right;">Open</th>
        <th style="padding:7px 8px;text-align:right;">Gates</th>
        <th style="padding:7px 8px;text-align:right;">Notes</th>
        <th style="padding:7px 8px;text-align:left;">Filing due</th>
      </tr>${rows}
    </table>
    <div style="margin:14px 0;padding:10px 12px;background:#F5F0FA;border-left:3px solid #6B21A8;font-size:13px;">
      Reminder on the committee's own obligations: AS 1301 requires the auditor to communicate with the
      committee — including the schedule of uncorrected misstatements, significant estimates, related-party
      matters, going concern, disagreements with management, and any difficulties encountered such as delays
      in receiving information — <strong>before</strong> the report is issued. Because Nightfood is not an
      emerging growth company, that communication record is also the population from which critical audit
      matters are drawn under AS 3101.
    </div>
    ${button("Open portal", portalLink("/audit"), "#6B21A8")}
  `;
  const recipients = await audience("committee");
  await enqueue({
    kind: "committee_digest",
    recipients,
    subject: `[NGTF] Audit committee weekly status`,
    body: shell("Audit committee weekly status", inner, "#6B21A8"),
    instant: false,
  });
  return { sent: recipients.length };
}

/** Engagement lifecycle → both sides. */
async function notifyEngagementEvent({ engagement, event, actor, detail }) {
  const titles = {
    opened: "Engagement opened",
    checklist_generated: "Checklist generated",
    report_released: "Audit/review report released",
    archived: "Engagement archived (AS 1215 documentation completion)",
    locked: "Engagement locked",
    legal_hold: "Legal hold applied",
  };
  const subject = `[NGTF] ${titles[event] || event} — ${engagement.period_label}`;
  const inner = `
    ${kvTable([
      ["Engagement", esc(engagement.period_name || engagement.period_label)],
      ["Event", esc(titles[event] || event)],
      ["By", actor ? `${esc(actor.name)} (${esc(actor.email)})` : "system"],
      ...(detail ? Object.entries(detail).map(([k, v]) => [k, esc(String(v))]) : []),
    ])}
    ${
      event === "archived"
        ? `<div style="margin:12px 0;padding:10px 12px;background:#FDECEC;border-left:3px solid #991B1B;font-size:13px;">
             This engagement is now <strong>append-only</strong>. Documents can no longer be deleted or
             replaced. New information may still be added, but each addition must record the date, the
             preparer and the reason — AS 1215.16. This is enforced by database trigger, so it holds even
             against direct database access.
           </div>`
        : ""
    }
    ${button("Open engagement", portalLink(`/audit/engagement/${engagement.id}`))}
  `;
  const recipients = await audience("all");
  await enqueue({
    kind: `engagement_${event}`,
    recipients,
    subject,
    body: shell(titles[event] || event, inner),
    engagementId: engagement.id,
    instant: true,
  });
}

/** Test harness — verifies transport config without spamming. */
async function selfTest(toEmail) {
  const out = { smtp: !!transport(), twilio: !!(TWILIO.sid && TWILIO.token && TWILIO.from), webhook: !!WEBHOOK_URL, portalUrl: PORTAL_URL || null };
  if (toEmail && out.smtp) {
    try {
      await sendEmail(
        toEmail,
        "[NGTF] Audit portal notification test",
        shell("Notification test", "<p>If you are reading this, email delivery from the audit portal is working.</p>")
      );
      out.emailSent = true;
    } catch (err) {
      out.emailError = err.message;
    }
  }
  return out;
}

module.exports = {
  audience,
  enqueue,
  flush,
  retryFailed,
  sendEmail,
  sendSMS,
  notifyDocumentUploaded,
  notifySweepYes,
  notifyReviewNote,
  notifyDueAndOverdue,
  notifyFilingDeadlines,
  notifyArchiveCountdown,
  notifyCommitteeDigest,
  notifyEngagementEvent,
  selfTest,
  shell,
  esc,
  portalLink,
};
