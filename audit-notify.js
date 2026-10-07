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
const issuer = require("./audit-issuer");

// ── Who these messages are about ────────────────────────────
//
// Read from the issuer profile rather than written into the templates.
// An email is the part of the portal that travels: it gets forwarded,
// printed and pasted into board packs, and it has to still be correct
// when it arrives somewhere the portal is not.

/** Subject line tag, e.g. "[NGTF]". */
function tag() {
  const p = issuer.current();
  return `[${p.ticker || p.name || "Audit"}]`;
}

/** Masthead line for the email shell. */
function mastLine() {
  const p = issuer.current();
  return [p.name, p.ticker, "Audit Portal"].filter(Boolean).join(" · ");
}

function issuerName() {
  return issuer.current().name || "the registrant";
}

/**
 * How much a date can be relied on, in words that survive a forward.
 *
 * A corporate action obligation can be created from a rule whose citation
 * has not been checked. The portal labels that on screen. Without this,
 * the label stopped at the screen: the reminder email stated an
 * unverified date in the same voice as a statutory deadline, which is
 * the single failure this whole feature exists to prevent, because the
 * email is what people actually act on.
 */
function confidenceTag(row) {
  if (!row || !row.date_confidence || row.date_confidence === "computed") return "";
  if (row.date_confidence === "approximate") {
    return ` <span style="color:#B45309;font-weight:600;">[APPROXIMATE DATE — measured in trading days, confirm before relying on it]</span>`;
  }
  return ` <span style="color:#9C4221;font-weight:600;">[UNVERIFIED — this obligation is believed to apply but its citation and day count have not been confirmed; treat the date as a prompt to check, not a deadline]</span>`;
}

// ── Transport config ────────────────────────────────────────
const SMTP = {
  host: process.env.AUDIT_SMTP_HOST || null,
  port: Number(process.env.AUDIT_SMTP_PORT || 587),
  user: process.env.AUDIT_SMTP_USER || process.env.GMAIL_EMAIL || null,
  pass: process.env.AUDIT_SMTP_PASS || process.env.GMAIL_APP_PASSWORD || null,
  from: process.env.AUDIT_FROM_EMAIL || process.env.GMAIL_EMAIL || null,
  fromName: process.env.AUDIT_FROM_NAME || null, // falls back to the issuer name at send time
};
const TWILIO = {
  sid: process.env.TWILIO_ACCOUNT_SID || null,
  token: process.env.TWILIO_AUTH_TOKEN || null,
  from: process.env.AUDIT_SMS_FROM || process.env.TWILIO_PHONE_NUMBER || null,
};
const WEBHOOK_URL = process.env.AUDIT_WEBHOOK_URL || null;
const PORTAL_URL = (process.env.AUDIT_PORTAL_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const BASE = process.env.AUDIT_BASE_PATH || "/audit";

function portalLink(path) {
  return PORTAL_URL ? `${PORTAL_URL}${path}` : path;
}

/**
 * The per-recipient receipt link.
 *
 * Clicking it records that the link addressed to THIS person was
 * clicked, from an IP, at a time — and then sends them to sign in. The
 * token identifies; it does not authorise. That distinction is the whole
 * design: it gives evidence as good as a read receipt with none of a
 * magic link's exposure, and no tracking pixel anywhere.
 */
function receiptLink(token) {
  return portalLink(`${BASE}/r/${token}`);
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

async function insertNotification({ kind, channel, recipient, addr, subject, body, documentId, itemId, engagementId, receiptId, transmittalId, scheduled }) {
  try {
    const r = await db.query(
      `INSERT INTO ngtf_audit_notifications
         (kind, channel, recipient_id, recipient_addr, subject, body, document_id, item_id, engagement_id,
          receipt_id, transmittal_id, scheduled_for)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12, NOW()))
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
        receiptId || null,
        transmittalId || null,
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

async function sendEmail(to, subject, html, { headers = null } = {}) {
  const t = transport();
  if (!t) throw new Error("SMTP not configured (set AUDIT_SMTP_USER/AUDIT_SMTP_PASS or GMAIL_EMAIL/GMAIL_APP_PASSWORD)");
  // Returned so the outbox can keep the provider's message id. When a
  // delivery claim is later challenged, that id is what lets the mail
  // provider's own logs be lined up against this one.
  return await t.sendMail({
    ...(headers ? { headers } : {}),
    // A display name with a stray double quote in it produces a header
    // some servers reject outright, and the issuer name is now
    // user-entered, so it is stripped rather than trusted.
    from: `"${String(SMTP.fromName || `${issuerName()} Audit Portal`).replace(/"/g, "")}" <${SMTP.from || SMTP.user}>`,
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
      let info = null;
      if (n.channel === "email") {
        info = await sendEmail(n.recipient_addr, n.subject, n.body, {
          // Lets a provider callback find its way back to the exact
          // receipt row rather than being matched by address and guess.
          headers: n.receipt_id ? { "X-Audit-Receipt": String(n.receipt_id) } : null,
        });
      } else if (n.channel === "sms") await sendSMS(n.recipient_addr, n.body);
      else if (n.channel === "webhook")
        await sendWebhook(n.recipient_addr, {
          kind: n.kind,
          subject: n.subject,
          body: n.body,
          documentId: n.document_id,
          engagementId: n.engagement_id,
          transmittalId: n.transmittal_id,
        });
      const messageId = info && info.messageId ? String(info.messageId).slice(0, 300) : null;
      await db.query(
        `UPDATE ngtf_audit_notifications SET status='sent', sent_at=NOW(), provider_message_id=COALESCE($2, provider_message_id) WHERE id=$1`,
        [n.id, messageId]
      );
      // A delivery receipt only ever records what actually happened: the
      // mail server accepted it. Whether it ARRIVED is a separate fact
      // that only the provider callback can supply, so it is not written
      // here however convenient that would be.
      if (n.receipt_id && n.channel === "email") {
        await stampReceiptSent(n.receipt_id, messageId);
      }
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

async function stampReceiptSent(receiptId, messageId) {
  try {
    await db.query(
      `UPDATE ngtf_audit_transmittal_recipients
          SET notified_at    = COALESCE(notified_at, NOW()),
              email_sent_at  = COALESCE(email_sent_at, NOW())
        WHERE id = $1`,
      [receiptId]
    );
    if (messageId) {
      await db.query(
        `INSERT INTO ngtf_audit_mail_events (provider, event_type, receipt_id, message_id, matched_by, payload)
         VALUES ('smtp', 'accepted_by_relay', $1, $2, 'outbox', $3)`,
        [receiptId, messageId, JSON.stringify({ note: "our relay accepted the message; arrival not yet confirmed" })]
      );
    }
  } catch (err) {
    console.error("[ngtf-audit notify] receipt stamp failed:", err.message);
  }
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
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:.75;">${esc(mastLine())}</div>
      <div style="font-size:19px;font-weight:600;margin-top:4px;">${esc(title)}</div>
    </div>
    <div style="padding:22px;color:#1a1a1a;font-size:14px;line-height:1.6;">${inner}</div>
    <div style="padding:14px 22px;background:#F6F7F9;color:#667;font-size:11px;line-height:1.5;border-top:1px solid #E3E6EA;">
      Automated message from the ${esc(issuerName())} audit portal. Documents are retained for seven years from the
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
  // The per-file heads-up and the transmittal do different jobs: this one
  // says "something arrived", the transmittal says "here is the package,
  // please sign for it". On a busy close the pair can be too much, so the
  // per-file one can be switched off and the transmittal left to carry
  // it. Off by default rather than on, because losing the instant notice
  // means a document can sit for up to the auto-transmit window before
  // anyone hears — acceptable against a four-business-day clock, but it
  // should be a decision rather than a surprise.
  if (process.env.AUDIT_DELIVERY_SUPPRESS_UPLOAD_EMAIL === "1") return 0;

  const cat = classification.categoryCode ? tax.CATEGORY_BY_CODE[classification.categoryCode] : null;
  const br = cat ? tax.BRACKET_BY_CODE[cat.bracket] : null;
  const accent = br ? br.color : "#667";

  const subject = classification.classified
    ? `${tag()} ${cat.label} uploaded — ${classification.period.periodLabel}`
    : `${tag()} Unclassified document uploaded — needs triage`;

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
    body: shell(subject.replace(tag() + " ", ""), inner, accent),
    documentId: document.id,
    engagementId: engagement ? engagement.id : null,
    instant: true,
  });
  return recipients.length;
}

/** A sweep answered YES means new obligations just appeared. */
async function notifySweepYes({ item, answerNote, spawned, user, engagement }) {
  const subject = `${tag()} Sweep answered YES — ${spawned.length} new item${spawned.length === 1 ? "" : "s"} required`;
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
  const subject = `${tag()} Auditor review note${document ? ` — ${document.filename}` : ""}`;
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
/**
 * An operator reported something. Tell the officers NOW.
 *
 * This is the control doing its job: Rule 13a-15(e) is about information
 * being "accumulated and communicated to the issuer's management ... to
 * allow timely decisions regarding required disclosure." The email is
 * that communication, and the time between the report and this message
 * is the control's own performance measure.
 */
async function notifyOperatingEvent({ report, built, actor }) {
  const preAct = built.obligations.filter((o) => o.preAct);
  const filings = built.obligations.filter((o) => o.kind === "filing");
  const s3 = built.obligations.filter((o) => o.s3Risk);

  const subject = preAct.length
    ? `${tag()} ACTION ALREADY DUE \u2014 ${built.label}`
    : filings.length
    ? `${tag()} ${filings.length} filing${filings.length === 1 ? "" : "s"} triggered \u2014 ${built.label}`
    : `${tag()} Reported: ${built.label}`;

  const line = (o) =>
    `<li style="margin-bottom:7px;">${o.item8k ? `<strong>Form 8-K Item ${esc(o.item8k)}</strong> \u2014 ` : ""}` +
    `${esc(o.label)}<br><span style="color:#667;">` +
    `${o.dueDate ? `due ${esc(o.dueDate)}` : "no fixed date"}` +
    `${o.anchorLabel ? `, measured from ${esc(String(o.anchorLabel).toLowerCase())}` : ""}` +
    `${o.anchorDate ? ` (${esc(o.anchorDate)})` : ""}</span>` +
    `${o.s3Risk ? `<br><span style="color:#991B1B;font-weight:600;">Filing this late also costs Form S-3 eligibility for twelve months.</span>` : ""}` +
    `${!o.verified ? `<br><span style="color:#9C4221;font-weight:600;">[UNVERIFIED \u2014 this date is a prompt to check, not a confirmed deadline]</span>` : ""}` +
    `${o.consequence ? `<br><span style="color:#445;">${esc(o.consequence)}</span>` : ""}</li>`;

  const inner = `
    <p style="margin:0 0 12px;"><strong>${esc(actor && actor.name ? actor.name : "Someone")}</strong> reported:
      \u201c${esc(built.label)}\u201d${report.summary ? ` \u2014 ${esc(report.summary)}` : ""}.</p>
    ${
      preAct.length
        ? `<div style="margin:0 0 14px;padding:12px;background:#FDECEC;border-left:3px solid #991B1B;">
             <strong style="color:#991B1B;">There is a notice here that was due BEFORE the act.</strong>
             It cannot be cured by filing late. Read this first and call counsel today.
             <ul style="margin:8px 0 0;padding-left:20px;">${preAct.map(line).join("")}</ul>
           </div>`
        : ""
    }
    ${
      filings.length
        ? `<p style="margin:0 0 4px;font-weight:600;color:#991B1B;">Filings triggered (${filings.length})</p>
           <ul style="margin:6px 0 14px;padding-left:20px;">${filings.map(line).join("")}</ul>
           <p style="margin:0 0 14px;color:#445;">There is no Rule 12b-25 extension for a Form 8-K. A late one is simply late.</p>`
        : `<p style="margin:0 0 14px;color:#1C7C54;">No filing appears to be triggered. The determination still has to be recorded.</p>`
    }
    ${
      built.obligations.filter((o) => o.kind !== "filing" && !o.preAct).length
        ? `<p style="margin:0 0 4px;font-weight:600;color:#B45309;">Documents and analysis to produce</p>
           <ul style="margin:6px 0 14px;padding-left:20px;">${built.obligations
             .filter((o) => o.kind !== "filing" && !o.preAct)
             .map(line)
             .join("")}</ul>`
        : ""
    }
    <div style="margin:12px 0;padding:10px 12px;background:#F2F6FA;border-left:3px solid #2C5F8A;font-size:13px;">
      <strong>A determination is still outstanding.</strong> Somebody has to decide, on the record, whether this
      is reportable \u2014 including if the answer is no. A decision not to file leaves no other trace, and it is
      the one most likely to be examined later. The portal will not decide materiality for you: that is
      management's judgment under Item 307, and under SAB 99 a conclusion resting only on a percentage has no
      basis in the accounting literature or the law.
    </div>
    ${button("Open the event and record the determination", portalLink(`/audit/event/${report.id}`), "#991B1B")}
  `;

  const recipients = await audience("company_lead");
  const rows = await enqueue({
    kind: preAct.length ? "operating_event_preact" : "operating_event",
    recipients,
    subject,
    body: shell(subject.replace(tag() + " ", ""), inner, preAct.length ? "#991B1B" : "#1F3A5F"),
    engagementId: report.engagement_id || null,
  });
  await flush(rows.length || 10);
  return { sent: rows.length };
}

/**
 * Chase the open obligations from reported events.
 *
 * Separate from the checklist sweep because these have a different
 * character: a four-business-day clock with no extension, and a
 * pre-act notice that is already unfixable.
 */
async function notifyEventObligations() {
  const r = await db.query(
    `SELECT o.*, rep.event_label, rep.id AS report_id
       FROM ngtf_audit_event_obligations o
       JOIN ngtf_audit_event_reports rep ON rep.id = o.report_id
      WHERE o.status = 'open'
        AND o.due_date IS NOT NULL
        AND o.due_date <= CURRENT_DATE + INTERVAL '3 days'
      ORDER BY o.due_date, o.severity`
  );
  if (!r.rows.length) return { sent: 0, reason: "nothing due" };

  const overdue = r.rows.filter((x) => cal.parse(cal.dstr(x.due_date)) < cal.parse(cal.today()));
  const subject = overdue.length
    ? `${tag()} ${overdue.length} event obligation${overdue.length === 1 ? "" : "s"} OVERDUE`
    : `${tag()} ${r.rows.length} event obligation${r.rows.length === 1 ? "" : "s"} due within 3 days`;

  const li = (x) =>
    `<li style="margin-bottom:6px;">${x.item_8k ? `<strong>Form 8-K Item ${esc(x.item_8k)}</strong> \u2014 ` : ""}` +
    `${esc(x.label)} <span style="color:#889;">\u2014 due ${esc(cal.dstr(x.due_date))} \u00b7 from \u201c${esc(x.event_label)}\u201d</span>` +
    `${x.s3_risk ? `<br><span style="color:#991B1B;font-weight:600;">Late here costs Form S-3 eligibility for twelve months.</span>` : ""}` +
    `${x.verified === false ? `<br><span style="color:#9C4221;font-weight:600;">[UNVERIFIED date \u2014 check the rule]</span>` : ""}</li>`;

  const inner = `
    ${overdue.length ? `<p style="margin:0 0 4px;font-weight:600;color:#991B1B;">Overdue (${overdue.length})</p>
      <ul style="margin:6px 0 14px;padding-left:20px;">${overdue.map(li).join("")}</ul>` : ""}
    ${r.rows.length - overdue.length ? `<p style="margin:0 0 4px;font-weight:600;color:#B45309;">Due within 3 days</p>
      <ul style="margin:6px 0 14px;padding-left:20px;">${r.rows.filter((x) => !overdue.includes(x)).map(li).join("")}</ul>` : ""}
    ${button("Open the event register", portalLink("/audit/events"), "#1F3A5F")}
  `;
  const recipients = await audience("company");
  const rows = await enqueue({ kind: "event_obligations_due", recipients, subject, body: shell(subject.replace(tag() + " ", ""), inner, "#991B1B") });
  await flush(rows.length || 20);
  return { sent: rows.length, overdue: overdue.length, soon: r.rows.length - overdue.length };
}

/**
 * The weekly roll-call. This is the completeness half of the control.
 *
 * A register that only knows what someone chose to type in can support
 * "what we reported, we reported" and nothing else. An affirmative nil
 * response from each named person, for a stated period, is the only
 * thing that evidences completeness \u2014 and it is what lets the
 * certifying officers say the channel operated rather than hoping it did.
 */
async function notifyEventRollCall() {
  const today = cal.today();
  const start = cal.iso(cal.addDays(cal.parse(today), -7));
  const recipients = await audience("company");
  if (!recipients.length) return { sent: 0, reason: "nobody to ask" };

  const already = await db.query(
    `SELECT user_id FROM ngtf_audit_event_attestations WHERE period_start=$1 AND period_end=$2`,
    [start, today]
  );
  const done = new Set(already.rows.map((x) => x.user_id));
  const pending = recipients.filter((u) => !done.has(u.id));
  if (!pending.length) return { sent: 0, reason: "everyone has confirmed" };

  const events = require("./audit-events");
  const prompts = Object.values(events.EVENTS)
    .map((e) => `<li style="margin-bottom:3px;">${esc(e.label)}</li>`)
    .join("");

  const subject = `${tag()} Anything happen this week? One click either way`;
  const inner = `
    <p style="margin:0 0 12px;">This is the weekly check for the period <strong>${esc(start)}</strong> to
      <strong>${esc(today)}</strong>. It takes one click if the answer is no, and that click is the point:
      an affirmative \u201cnothing to report\u201d is what makes the record evidence rather than a list of
      whatever happened to get typed in.</p>
    <p style="margin:0 0 6px;font-weight:600;">Did any of these happen, even in a small way?</p>
    <ul style="margin:6px 0 14px;padding-left:20px;font-size:13px;color:#445;">${prompts}</ul>
    <div style="margin:12px 0;padding:10px 12px;background:#FFF6E5;border-left:3px solid #B45309;font-size:13px;">
      If you are not sure whether something counts, report it. The portal works out whether it triggers
      anything, and an event reported and found not reportable costs a minute. The reverse costs a filing
      deadline, and for some items twelve months of Form S-3 eligibility.
    </div>
    ${button("Report something", portalLink("/audit/report-event"), "#991B1B")}
    ${button("Nothing to report this week", portalLink(`/audit/events?confirm=${start}`), "#1C7C54")}
  `;
  const rows = await enqueue({
    kind: "event_roll_call",
    recipients: pending,
    subject,
    body: shell("Weekly disclosure check", inner, "#1F3A5F"),
    instant: false,
  });
  await flush(rows.length || 20);
  return { sent: rows.length, asked: pending.length, alreadyConfirmed: done.size };
}

async function notifyDueAndOverdue() {
  const soon = await db.query(
    `SELECT i.*, c.period_label, c.tier, c.engagement_id
       FROM ngtf_audit_checklist_items i
       JOIN ngtf_audit_checklists c ON c.id = i.checklist_id
      WHERE i.status IN ('open','pending_confirmation')
        AND i.due_date IS NOT NULL
        AND i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'
      ORDER BY i.is_gate DESC, i.due_date ASC`
  );
  const overdue = await db.query(
    `SELECT i.*, c.period_label, c.tier, c.engagement_id
       FROM ngtf_audit_checklist_items i
       JOIN ngtf_audit_checklists c ON c.id = i.checklist_id
      WHERE i.status IN ('open','pending_confirmation')
        AND i.due_date IS NOT NULL
        AND i.due_date < CURRENT_DATE
      ORDER BY i.is_gate DESC, i.due_date ASC`
  );
  if (!soon.rows.length && !overdue.rows.length) return { sent: 0, reason: "nothing due" };

  const gatesOverdue = overdue.rows.filter((r) => r.is_gate);
  const subject = gatesOverdue.length
    ? `${tag()} ${gatesOverdue.length} GATING item${gatesOverdue.length === 1 ? "" : "s"} overdue — filing at risk`
    : `${tag()} ${overdue.rows.length} overdue, ${soon.rows.length} due within 3 days`;

  const list = (rows, color) =>
    rows.length
      ? `<ul style="margin:6px 0 14px;padding-left:20px;">${rows
          .slice(0, 40)
          .map(
            (r) =>
              `<li style="margin-bottom:4px;">${r.is_gate ? `<strong style="color:${color};">[GATE]</strong> ` : ""}${esc(
                r.playbook_step_id || r.category_code || r.sweep_id || ""
              )} ${esc(r.label.slice(0, 110))} <span style="color:#889;">— due ${esc(cal.dstr(r.due_date))} · ${esc(r.period_label)}</span>${confidenceTag(r)}</li>`
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
    const days = Math.round((cal.parse(cal.dstr(eng.filing_due_date)) - cal.parse(cal.today())) / 86400000);
    if (!daysAhead.includes(days)) continue;

    const open = await db.query(
      `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_gate)::int AS gates
         FROM ngtf_audit_checklist_items i
         JOIN ngtf_audit_checklists c ON c.id = i.checklist_id
        WHERE c.engagement_id = $1 AND i.status IN ('open','pending_confirmation')`,
      [eng.id]
    );
    const o = open.rows[0] || { n: 0, gates: 0 };
    const subject = `${tag()} ${eng.filing_form || "Filing"} due in ${days} day${days === 1 ? "" : "s"} — ${eng.period_label}`;
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
               within 120 days of fiscal year end. ${
                 issuer.derive(issuer.current()).camsApply
                   ? `Because ${esc(issuerName())} is not an emerging growth company, the auditor's report must include critical audit matters under AS 3101.`
                   : `${esc(issuerName())} is an emerging growth company, so the auditor's report omits critical audit matters.`
               }
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
        ? `${tag()} AS 1215 documentation completion date PASSED — ${eng.period_label}`
        : `${tag()} AS 1215 archive due in ${cd.daysRemaining} day${cd.daysRemaining === 1 ? "" : "s"} — ${eng.period_label}`;
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
        December 15, 2025.
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
              WHERE c.engagement_id=e.id AND i.status IN ('open','pending_confirmation'))::int AS open_items,
            (SELECT COUNT(*) FROM ngtf_audit_checklist_items i JOIN ngtf_audit_checklists c ON c.id=i.checklist_id
              WHERE c.engagement_id=e.id AND i.status IN ('open','pending_confirmation') AND i.is_gate)::int AS open_gates,
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
      in receiving information — <strong>before</strong> the report is issued. ${
        issuer.derive(issuer.current()).camsApply
          ? "Because this registrant is not an emerging growth company, that communication record is also the population from which critical audit matters are drawn under AS 3101."
          : "This registrant is an emerging growth company, so the auditor's report omits critical audit matters and that population is not drawn."
      }
    </div>
    ${button("Open portal", portalLink("/audit"), "#6B21A8")}
  `;
  const recipients = await audience("committee");
  await enqueue({
    kind: "committee_digest",
    recipients,
    subject: `${tag()} Audit committee weekly status`,
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
  const subject = `${tag()} ${titles[event] || event} — ${engagement.period_label}`;
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

// ════════════════════════════════════════════════════════════
//  DELIVERY: transmittals, receipts and chasing
// ════════════════════════════════════════════════════════════
//
// Every message below is addressed to ONE person and carries THEIR
// receipt token, so each is enqueued individually rather than through
// enqueue(). That is the point: a single email to a distribution list
// can tell you that somebody somewhere was mailed, and nothing more.

async function enqueueReceiptEmail({ kind, recipient, subject, body, transmittalId, engagementId }) {
  return await insertNotification({
    kind,
    channel: "email",
    recipient: recipient.user_id ? { id: recipient.user_id } : null,
    addr: recipient.email,
    subject,
    body,
    receiptId: recipient.id,
    transmittalId,
    engagementId: engagementId || null,
    scheduled: null,
  });
}

function manifestTable(docs) {
  if (!docs.length) return "";
  const rows = docs
    .map(
      (d) => `<tr>
      <td style="padding:5px 8px;border-bottom:1px solid #EFF2F5;color:#889;text-align:right;width:28px;">${d.ordinal}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #EFF2F5;">${esc(d.filename)}
        ${d.item_id && !d.document_id ? `<br><span style="color:#B45309;font-size:11px;">requested — not enclosed</span>` : ""}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #EFF2F5;color:#667;font-size:11.5px;">${esc(d.category_label || d.category_code || "—")}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #EFF2F5;color:#667;text-align:right;white-space:nowrap;">${
        d.size_bytes ? (Number(d.size_bytes) / 1024 / 1024).toFixed(2) + " MB" : "—"
      }</td>
      <td style="padding:5px 8px;border-bottom:1px solid #EFF2F5;"><code style="font-size:10px;color:#99A;">${esc(
        (d.sha256 || "").slice(0, 12)
      )}</code></td>
    </tr>`
    )
    .join("");
  return `<table style="width:100%;border-collapse:collapse;font-size:12.5px;margin:12px 0;">
    <tr style="background:#F6F7F9;">
      <th style="padding:6px 8px;text-align:right;font-size:10.5px;color:#667;">#</th>
      <th style="padding:6px 8px;text-align:left;font-size:10.5px;color:#667;">File</th>
      <th style="padding:6px 8px;text-align:left;font-size:10.5px;color:#667;">Category</th>
      <th style="padding:6px 8px;text-align:right;font-size:10.5px;color:#667;">Size</th>
      <th style="padding:6px 8px;text-align:left;font-size:10.5px;color:#667;">SHA-256</th>
    </tr>${rows}</table>`;
}

const MANIFEST_NOTE = `
<div style="margin:12px 0;padding:10px 12px;background:#F2F6FA;border-left:3px solid #2C5F8A;font-size:12.5px;">
  <strong>Manifest fingerprint.</strong> The hash below is taken over this package's own ordered list of file
  names, file hashes and sizes. Either a file is under that fingerprint or it is not, so if anything is ever
  said to be missing the question can be settled by arithmetic instead of recollection. Both sides can
  recompute it.
</div>`;

const ACK_NOTE = `
<div style="margin:12px 0;padding:10px 12px;background:#FFF6E5;border-left:3px solid #B45309;font-size:12.5px;">
  <strong>Please acknowledge, even if you have not read it yet.</strong> The portal can see that a message was
  delivered and that a file was downloaded, but only you can say the package is complete. That statement is
  the only thing that closes these items, and it is what stops a &ldquo;we sent it / we never got it&rdquo;
  conversation three weeks from now.
</div>`;

/** A package went out. One message per recipient, each with its own link. */
async function notifyTransmittal(full) {
  if (!full) return { sent: 0 };
  const { transmittal: t, documents, recipients } = full;
  const docs = documents.filter((d) => d.document_id);
  const reqs = documents.filter((d) => !d.document_id);
  const toAuditor = t.direction === "to_auditor";

  const subject =
    `${tag()} ${t.number} — ` +
    (toAuditor
      ? `${docs.length || reqs.length} item${(docs.length || reqs.length) === 1 ? "" : "s"} for review${
          t.period_label ? ` (${t.period_label})` : ""
        }`
      : `${reqs.length || docs.length} item${(reqs.length || docs.length) === 1 ? "" : "s"} requested${
          t.period_label ? ` (${t.period_label})` : ""
        }`);

  let sent = 0;
  for (const r of recipients) {
    const inner = `
      <p style="margin:0 0 10px;">${
        r.name ? esc(r.name.split(" ")[0]) + " — t" : "T"
      }his is transmittal <strong>${esc(t.number)}</strong>${
      r.kind === "cc" ? ' <span style="color:#889;">(you are copied; no response is needed from you)</span>' : ""
    }.</p>
      ${t.message ? `<p style="margin:0 0 12px;white-space:pre-wrap;">${esc(t.message)}</p>` : ""}
      ${kvTable([
        ["Package", `<strong>${esc(t.number)}</strong> — ${esc(t.subject)}`],
        ["Period", esc(t.period_name || t.period_label || "—")],
        ["Enclosed", `${docs.length} document${docs.length === 1 ? "" : "s"}${
          reqs.length ? ` · ${reqs.length} item${reqs.length === 1 ? "" : "s"} requested` : ""
        }`],
        ["Total size", docs.length ? `${(Number(t.total_bytes) / 1024 / 1024).toFixed(2)} MB` : "—"],
        ["Sent", esc(cal.dstr(t.created_at))],
        ...(r.kind === "to" && t.ack_due_on
          ? [["Acknowledgment requested by", `<strong>${esc(cal.dstr(t.ack_due_on))}</strong>`]]
          : []),
        ...(t.delivery_method !== "portal"
          ? [["Also sent by", `${esc(t.delivery_method.replace(/_/g, " "))}${t.method_note ? ` — ${esc(t.method_note)}` : ""}`]]
          : []),
        ["Manifest SHA-256", `<code style="font-size:10px;color:#889;">${esc(t.manifest_sha256)}</code>`],
      ])}
      ${manifestTable(documents)}
      ${MANIFEST_NOTE}
      ${r.kind === "to" ? ACK_NOTE : ""}
      ${button(
        r.kind === "to" ? "Open and acknowledge receipt" : "Open the package",
        receiptLink(r.receipt_token),
        r.kind === "to" ? "#1C7C54" : "#1F3A5F"
      )}
    `;
    const id = await enqueueReceiptEmail({
      kind: "transmittal",
      recipient: r,
      subject,
      body: shell(`${t.number} · ${toAuditor ? "Documents for review" : "Items requested"}`, inner, "#1F3A5F"),
      transmittalId: t.id,
      engagementId: t.engagement_id,
    });
    if (id) sent++;
  }
  await flush(Math.max(sent, 10));
  return { sent };
}

/**
 * A nudge. Two different messages, because there are two different
 * problems: they may not have seen it at all, or they may have it and
 * not yet said it is complete. Treating those the same is how a chaser
 * becomes noise.
 */
async function notifyTransmittalReminder(row) {
  const nth = row.nth || Number(row.reminder_count) + 1;
  const outstanding = `${row.age} business day${row.age === 1 ? "" : "s"}`;

  const subject = row.seen
    ? `${tag()} ${row.number} — still awaiting your acknowledgment (${outstanding})`
    : `${tag()} ${row.number} — not yet opened (${outstanding})`;

  const inner = `
    <p style="margin:0 0 12px;">${
      row.seen
        ? `Transmittal <strong>${esc(row.number)}</strong> has been opened but not acknowledged. The portal can see
           that it reached you; it cannot say on your behalf that the package is complete.`
        : `Transmittal <strong>${esc(row.number)}</strong> has been outstanding for ${esc(outstanding)} with no sign
           that it has been opened. If it has gone to the wrong address or into a spam quarantine, now is the
           moment to find out rather than at the filing deadline.`
    }</p>
    ${kvTable([
      ["Package", `<strong>${esc(row.number)}</strong> — ${esc(row.subject)}`],
      ["Period", esc(row.period_label || "—")],
      ["Contents", `${row.doc_count} document${row.doc_count === 1 ? "" : "s"}${
        row.item_count ? ` · ${row.item_count} requested item${row.item_count === 1 ? "" : "s"}` : ""
      }`],
      ["Sent", esc(cal.dstr(row.sent_on))],
      ["Outstanding", `<strong>${esc(outstanding)}</strong>`],
      ["Acknowledgment was requested by", esc(cal.dstr(row.ack_due_on) || "—")],
      ["Reminder", `${nth} of ${(await deliveryConfig()).max_reminders}`],
    ])}
    ${
      row.seen
        ? `<p style="margin:0 0 12px;">If something is missing, say so instead — a fast objection is worth far
             more to the close than a slow silence, and the portal records it either way.</p>`
        : ""
    }
    ${button("Open and acknowledge receipt", receiptLink(row.receipt_token), "#1C7C54")}
  `;

  await enqueueReceiptEmail({
    kind: "transmittal_reminder",
    recipient: row,
    subject,
    body: shell(row.seen ? "Awaiting acknowledgment" : "Transmittal not yet opened", inner, "#B45309"),
    transmittalId: row.transmittal_id,
    engagementId: row.engagement_id,
  });

  // From the escalation rung onward the recipient is no longer the only
  // audience. The person who SENT it is the one who can pick up a phone,
  // and on a short filing clock that is the intervention that works.
  if (row.ccLead) {
    const senderSide = row.direction === "to_auditor" ? "company_lead" : "auditor_lead";
    const leadInner = `
      <p style="margin:0 0 12px;">Transmittal <strong>${esc(row.number)}</strong> has been outstanding for
        ${esc(outstanding)} and ${esc(row.name || row.email)} has ${
      row.seen ? "opened it but not acknowledged it" : "given no sign of having opened it"
    }. Reminder ${nth} has gone out. This is flagged to you because chasing it is now the more effective move.</p>
      ${kvTable([
        ["Package", `<strong>${esc(row.number)}</strong> — ${esc(row.subject)}`],
        ["Addressed to", `${esc(row.name || "—")} (${esc(row.email)})`],
        ["State", esc(row.stage ? row.stage.label : "—")],
        ["Sent", esc(cal.dstr(row.sent_on))],
        ["Outstanding", `<strong>${esc(outstanding)}</strong>`],
      ])}
      ${button("Open the transmittal", portalLink(`${BASE}/transmittal/${row.transmittal_id}`), "#B45309")}
    `;
    await enqueue({
      kind: "transmittal_escalation",
      recipients: await audience(senderSide),
      subject: `${tag()} ${row.number} outstanding ${outstanding} — ${row.email} has not acknowledged`,
      body: shell("A package is not moving", leadInner, "#B45309"),
      engagementId: row.engagement_id,
      instant: true,
    });
  }
  await flush(20);
}

async function deliveryConfig() {
  try {
    return await require("./audit-delivery").settings();
  } catch {
    return { max_reminders: 4, stalled_business_days: 5 };
  }
}

/** Somebody signed for a package. Short, and only to the sending side. */
async function notifyTransmittalAcknowledged(full, recipient) {
  if (!full) return;
  const { transmittal: t, rollup } = full;
  const side = t.direction === "to_auditor" ? "company_lead" : "auditor_lead";
  const inner = `
    <p style="margin:0 0 12px;"><strong>${esc(recipient.name || recipient.email)}</strong> acknowledged
      <strong>${esc(t.number)}</strong> as complete${
    recipient.acknowledged_note ? `, with a note: &ldquo;${esc(recipient.acknowledged_note)}&rdquo;` : ""
  }.</p>
    ${kvTable([
      ["Package", `${esc(t.number)} — ${esc(t.subject)}`],
      ["Turnaround", `${rollup.ageBusinessDays} business day${rollup.ageBusinessDays === 1 ? "" : "s"}`],
      ["Still outstanding", rollup.owed - rollup.acked === 0 ? "nobody — the package is closed" : `${rollup.owed - rollup.acked} recipient(s)`],
    ])}
    ${button("View the receipt", portalLink(`${BASE}/transmittal/${t.id}`), "#1C7C54")}
  `;
  await enqueue({
    kind: "transmittal_acknowledged",
    recipients: await audience(side),
    subject: `${tag()} ${t.number} acknowledged by ${recipient.email}`,
    body: shell("Receipt acknowledged", inner, "#1C7C54"),
    engagementId: t.engagement_id,
    instant: false,
  });
}

/** They say something is missing. This one is urgent for the sender. */
async function notifyTransmittalDisputed(full, recipient) {
  if (!full) return;
  const { transmittal: t } = full;
  const side = t.direction === "to_auditor" ? "company_lead" : "auditor_lead";
  const inner = `
    <p style="margin:0 0 12px;"><strong>${esc(recipient.name || recipient.email)}</strong> has reported
      <strong>${esc(t.number)}</strong> as incomplete or wrong.</p>
    <div style="margin:0 0 14px;padding:12px;background:#FDF0F0;border-left:3px solid #991B1B;">
      <strong style="color:#991B1B;">What they said</strong><br>
      <span style="white-space:pre-wrap;">${esc(recipient.dispute_note || "")}</span>
    </div>
    ${kvTable([
      ["Package", `${esc(t.number)} — ${esc(t.subject)}`],
      ["Period", esc(t.period_name || t.period_label || "—")],
      ["Sent", esc(cal.dstr(t.created_at))],
      ["Raised", esc(cal.dstr(recipient.disputed_at))],
    ])}
    <p style="margin:0 0 12px;">A sealed manifest cannot be added to, which is deliberate. Send a further
      transmittal with whatever was missing — that is what the numbering is for — and then record how this
      one was resolved.</p>
    ${button("Open the transmittal", portalLink(`${BASE}/transmittal/${t.id}`), "#991B1B")}
  `;
  await enqueue({
    kind: "transmittal_disputed",
    recipients: await audience(side),
    subject: `${tag()} ${t.number} reported INCOMPLETE by ${recipient.email}`,
    body: shell("Package reported incomplete", inner, "#991B1B"),
    engagementId: t.engagement_id,
    instant: true,
  });
  await flush(20);
}

/**
 * It bounced. This is the most valuable message in the module.
 *
 * A hard bounce is the only receipt fact that is knowable on day zero
 * and that nobody has to remember to check. It converts the three-week
 * version of "we never got it" into a same-morning correction.
 */
async function notifyBounce({ receipt, transmittal, bounceType, bounceReason }) {
  const side = transmittal && transmittal.direction === "to_company" ? "auditor_lead" : "company_lead";
  const inner = `
    <div style="margin:0 0 14px;padding:12px;background:#FDF0F0;border-left:3px solid #991B1B;">
      <strong style="color:#991B1B;">This did not arrive.</strong> The notification for
      ${transmittal ? `<strong>${esc(transmittal.number)}</strong>` : "a transmittal"} addressed to
      <strong>${esc(receipt.email)}</strong> was rejected by the receiving mail server. They have not been
      told the package exists, and no reminder will fix it — the address has to be corrected and the package
      reissued.
    </div>
    ${kvTable([
      ...(transmittal ? [["Package", `${esc(transmittal.number)} — ${esc(transmittal.subject)}`]] : []),
      ["Addressed to", `${esc(receipt.name || "—")} (${esc(receipt.email)})`],
      ["Rejection type", esc(bounceType || "unknown")],
      ["What the mail server said", `<span style="white-space:pre-wrap;">${esc(bounceReason || "no detail supplied")}</span>`],
    ])}
    <p style="margin:0 0 12px;">Check the spelling, confirm the address with them by some other channel, fix
      it in <em>Users</em>, and reissue. The bounce stays on the record either way: the ledger has to show
      that a package was sent to an address that did not work.</p>
    ${transmittal ? button("Open the transmittal", portalLink(`${BASE}/transmittal/${transmittal.id}`), "#991B1B") : ""}
  `;
  await enqueue({
    kind: "transmittal_bounced",
    recipients: await audience(side),
    subject: `${tag()} DELIVERY FAILED to ${receipt.email}${transmittal ? ` — ${transmittal.number}` : ""}`,
    body: shell("Notification did not arrive", inner, "#991B1B"),
    engagementId: transmittal ? transmittal.engagement_id : null,
    instant: true,
  });
  await flush(20);
}

/**
 * Daily digest of everything stuck, to the side that can do something.
 *
 * Routed by DIRECTION, not sent to both leads. Each side hears about
 * what it is waiting on: a package the company sent goes to the
 * company's leads, because chasing it is their move; a package the
 * engagement team requested goes to the engagement team's.
 *
 * Blanket-sending to both had a specific failure. The person sitting on
 * a package is usually a lead themselves, so they received the reminder
 * AND a digest naming the same package minutes later. Two emails about
 * one thing is how a recipient decides this portal is noise, and a muted
 * portal is worse than none because it still produces a record saying
 * they were told. The full both-directions schedule lives on the
 * AS 1301.25 page, which is where it is actually read.
 */
async function notifyDeliveryStalled({ stalled = [], bounced = [] } = {}) {
  if (!stalled.length && !bounced.length) return { sent: 0 };
  let total = 0;
  for (const direction of ["to_auditor", "to_company"]) {
    const s = stalled.filter((x) => x.direction === direction);
    const b = bounced.filter((x) => x.direction === direction);
    if (!s.length && !b.length) continue;
    // The sender's leads: they issued it, so they are the ones who can
    // pick up a phone about it.
    const side = direction === "to_auditor" ? "company_lead" : "auditor_lead";
    total += (await stalledDigestTo(side, s, b)).sent;
  }
  return { sent: total };
}

async function stalledDigestTo(side, stalled, bounced) {
  const cfg = await deliveryConfig();

  const li = (x) =>
    `<li style="margin-bottom:6px;"><strong>${esc(x.number)}</strong> — ${esc(x.subject)}<br>
      <span style="color:#667;">to ${esc(x.name || x.email)} · ${esc(x.age)} business days ·
      ${esc(x.seen ? "opened but not acknowledged" : "no sign of having been opened")}
      ${x.reminder_count ? ` · ${x.reminder_count} reminder${Number(x.reminder_count) === 1 ? "" : "s"} sent` : ""}</span></li>`;

  const inner = `
    <p style="margin:0 0 12px;">These packages have been outstanding more than
      ${cfg.stalled_business_days} business days. They are now recorded as delays rather than chased as
      reminders, and they will appear in the AS 1301.25 schedule of difficulties encountered.</p>
    ${
      bounced.length
        ? `<p style="margin:0 0 4px;font-weight:600;color:#991B1B;">Did not arrive (${bounced.length})</p>
           <ul style="margin:6px 0 14px;padding-left:20px;">${bounced.map(li).join("")}</ul>
           <p style="margin:0 0 14px;color:#445;">These addresses rejected the message. Reminders will not be
             sent to them — fix the address and reissue.</p>`
        : ""
    }
    ${
      stalled.length
        ? `<p style="margin:0 0 4px;font-weight:600;color:#B45309;">Stalled (${stalled.length})</p>
           <ul style="margin:6px 0 14px;padding-left:20px;">${stalled.map(li).join("")}</ul>`
        : ""
    }
    <div style="margin:12px 0;padding:10px 12px;background:#F5F0FA;border-left:3px solid #6B21A8;font-size:12.5px;">
      AS 1301.25 requires the auditor to communicate to the audit committee any difficulties encountered
      during the audit, and names delays in receiving information as an example. Assembled from the ledger
      with dates, this is a factual schedule rather than a recollection — which also means it will sometimes
      show the delay was not the company's. The full schedule, in both directions, is on the delays page.
    </div>
    ${button("Open the delivery ledger", portalLink(`${BASE}/transmittals?filter=stalled`), "#991B1B")}
  `;
  const recipients = await audience(side);
  const rows = await enqueue({
    kind: "delivery_stalled",
    recipients,
    subject: `${tag()} ${stalled.length + bounced.length} package${
      stalled.length + bounced.length === 1 ? "" : "s"
    } not moving${bounced.length ? ` (${bounced.length} did not arrive)` : ""}`,
    body: shell("Deliveries not moving", inner, "#991B1B"),
    instant: true,
  });
  await flush(rows.length || 20);
  return { sent: rows.length };
}

/**
 * Documents that have never been handed to anyone.
 *
 * This is the alarm on the exact gap that started all of this: a file
 * uploaded, or swept in from a folder, that no procedure ever carried to
 * the other side. Stored is not delivered, and until a package exists
 * the portal says so rather than showing a reassuring green tick.
 */
async function notifyUndelivered() {
  const delivery = require("./audit-delivery");
  const cfg = await delivery.settings();
  const all = await delivery.undeliveredDocuments({ limit: 1000 });
  const stale = all.filter((d) => d.ageHours >= cfg.undelivered_alert_after_hours);
  if (!stale.length) return { sent: 0, reason: "nothing undelivered past the threshold" };

  const auditors = await audience("auditor");
  const noAuditors = auditors.length === 0;

  const rows = stale
    .slice(0, 40)
    .map(
      (d) => `<li style="margin-bottom:4px;">${esc(d.filename)}
        <span style="color:#889;">— ${esc(d.category_code || "in triage")} · ${esc(
        d.engagement_period || "no period"
      )} · uploaded ${Math.floor(d.ageHours / 24)}d ${d.ageHours % 24}h ago${
        d.uploaded_by_name ? ` by ${esc(d.uploaded_by_name)}` : d.source ? ` via ${esc(d.source)}` : ""
      }</span></li>`
    )
    .join("");

  const inner = `
    <p style="margin:0 0 12px;"><strong>${stale.length} document${stale.length === 1 ? "" : "s"}</strong>
      ${stale.length === 1 ? "has" : "have"} been in the portal for more than
      ${cfg.undelivered_alert_after_hours} hours without ever being transmitted to anyone. Nobody on the other
      side has been told ${stale.length === 1 ? "it" : "they"} exist${stale.length === 1 ? "s" : ""}.</p>
    ${
      noAuditors
        ? `<div style="margin:0 0 14px;padding:12px;background:#FDF0F0;border-left:3px solid #991B1B;">
             <strong style="color:#991B1B;">There are no active auditor accounts, so nothing can be
             transmitted.</strong> This is not a glitch — the portal is refusing to record a delivery that
             cannot have happened. Create the engagement team's accounts and these will go out on the next
             sweep.
           </div>`
        : `<div style="margin:0 0 14px;padding:12px;background:#FDF6EA;border-left:3px solid #B45309;">
             A folder holding a file is not the same thing as the engagement team knowing it is there. One
             click issues a numbered package, tells them, and starts the receipt record.
           </div>`
    }
    <ul style="margin:6px 0 14px;padding-left:20px;">${rows}</ul>
    ${stale.length > 40 ? `<p style="color:#889;margin:0 0 12px;">…and ${stale.length - 40} more.</p>` : ""}
    ${button("Review and transmit", portalLink(`${BASE}/transmittals?tab=undelivered`), "#B45309")}
  `;

  const recipients = await audience("company_lead");
  const out = await enqueue({
    kind: "documents_undelivered",
    recipients,
    subject: `${tag()} ${stale.length} document${stale.length === 1 ? "" : "s"} uploaded but never transmitted`,
    body: shell("Uploaded, but nobody was told", inner, "#B45309"),
    instant: true,
  });
  await flush(out.length || 20);
  return { sent: out.length, undelivered: stale.length, noAuditorAccounts: noAuditors };
}

// ── AR / AP sample requests ─────────────────────────────────

/**
 * A selection list has landed. This goes to the company, because the
 * work is theirs — and it leads with what is ALREADY covered, because
 * the useful number on day one is how much of the list is a non-problem.
 */
async function notifySampleRequest(data) {
  if (!data) return { sent: 0 };
  const sub = require("./audit-subledger");
  const r = data.request;
  const c = data.counts;
  const outstanding = c.open + c.partial;

  const subject = c.unmatched
    ? `${tag()} ${r.ref} — ${c.unmatched} of ${c.total} selections are NOT in the aging we gave them`
    : `${tag()} ${r.ref} — ${outstanding} of ${c.total} selections need support`;

  const inner = `
    <p style="margin:0 0 12px;"><strong>${esc(r.requested_by_firm || "The engagement team")}</strong> has selected
      <strong>${c.total}</strong> item${c.total === 1 ? "" : "s"} for
      ${esc(data.procedure.label.toLowerCase())}, from the ${esc(r.kind === "ar" ? "receivables" : "payables")} aging
      as of ${esc(cal.dstr(r.as_of_date))}.</p>
    ${kvTable([
      ["Request", `<strong>${esc(r.ref)}</strong> — ${esc(r.label)}`],
      ["Already complete", `${c.complete} of ${c.total}${
        data.dollarsPct != null ? ` &nbsp;·&nbsp; <strong>${data.dollarsPct}% by dollars</strong>` : ""
      }`],
      ["Still to find", `${outstanding}`],
      ...(c.unmatched ? [["Not in the aging", `<strong style="color:#991B1B;">${c.unmatched}</strong>`]] : []),
      ["Support required per item", esc((r.required_support || []).map((t) => (sub.SUPPORT_TYPES[t] ? sub.SUPPORT_TYPES[t].label : t)).join(" + "))],
      ...(r.due_on ? [["Due back", `<strong>${esc(cal.dstr(r.due_on))}</strong>`]] : []),
    ])}
    ${
      c.unmatched
        ? `<div style="margin:0 0 14px;padding:12px;background:#FDF0F0;border-left:3px solid #991B1B;">
             <strong style="color:#991B1B;">Settle this before chasing any documents.</strong>
             ${c.unmatched} selection${c.unmatched === 1 ? "" : "s"} cannot be found in the aging that was handed
             over. Either the sample was drawn from a different population, or those invoices are not in that
             aging. It is a five-minute email to ask which aging they are working from, against a week of
             searching for documents that may not need to exist.
           </div>`
        : ""
    }
    ${
      data.procedure.companySuppliesOnly
        ? `<div style="margin:0 0 14px;padding:12px;background:#FDF0F0;border-left:3px solid #991B1B;">
             <strong style="color:#991B1B;">Do not collect the confirmation responses.</strong>
             AS 2310.15 requires the auditor to send the requests and receive the replies. A response that came
             through the company is not confirmation evidence — it voids the procedure rather than speeding it up.
             Supply the verified contact detail and nothing else.
           </div>`
        : ""
    }
    ${
      !r.tied_out
        ? `<div style="margin:0 0 14px;padding:12px;background:#FDF6EA;border-left:3px solid #B45309;">
             <strong>The aging this was drawn from has not been agreed to the general ledger.</strong> Do that
             first — if the population does not tie, the sample means nothing however well it is supported.
           </div>`
        : ""
    }
    ${button("Open the worklist", portalLink(`${BASE}/sample/${r.id}`), "#1F3A5F")}
  `;

  const recipients = await audience("company");
  const rows = await enqueue({
    kind: "sample_request",
    recipients,
    subject,
    body: shell(`${r.ref} · selection list`, inner, c.unmatched ? "#991B1B" : "#1F3A5F"),
    engagementId: r.engagement_id,
    instant: true,
  });
  await flush(rows.length || 10);
  return { sent: rows.length };
}

/** Chase the selections that are still missing support. */
async function notifySampleDue() {
  const r = await db.query(
    `SELECT q.id, q.ref, q.label, q.due_on, q.kind, q.engagement_id, q.requested_by_firm,
            COUNT(*) FILTER (WHERE x.status NOT IN ('complete','waived'))::int AS outstanding,
            COUNT(*) FILTER (WHERE x.status = 'unmatched')::int AS unmatched,
            COUNT(*)::int AS total
       FROM ngtf_audit_sample_requests q
       JOIN ngtf_audit_sample_selections x ON x.request_id = q.id
      WHERE q.status = 'open'
      GROUP BY q.id
     HAVING COUNT(*) FILTER (WHERE x.status NOT IN ('complete','waived')) > 0
      ORDER BY q.due_on NULLS LAST`
  );
  if (!r.rows.length) return { sent: 0, reason: "nothing outstanding" };

  const today = cal.today();
  const due = r.rows.filter((x) => x.due_on && cal.dstr(x.due_on) <= cal.iso(cal.addDays(cal.parse(today), 3)));
  if (!due.length) return { sent: 0, reason: "nothing due within three days" };
  const overdue = due.filter((x) => cal.dstr(x.due_on) < today);

  const li = (x) =>
    `<li style="margin-bottom:6px;"><strong>${esc(x.ref)}</strong> — ${esc(String(x.label).slice(0, 70))}<br>
      <span style="color:#667;">${x.outstanding} of ${x.total} still needed · due ${esc(cal.dstr(x.due_on))}${
      x.unmatched ? ` · <span style="color:#991B1B;font-weight:600;">${x.unmatched} not in the aging</span>` : ""
    }</span></li>`;

  const subject = overdue.length
    ? `${tag()} ${overdue.length} sample request${overdue.length === 1 ? "" : "s"} OVERDUE`
    : `${tag()} ${due.length} sample request${due.length === 1 ? "" : "s"} due within 3 days`;
  const inner = `
    ${overdue.length ? `<p style="margin:0 0 4px;font-weight:600;color:#991B1B;">Overdue (${overdue.length})</p>
      <ul style="margin:6px 0 14px;padding-left:20px;">${overdue.map(li).join("")}</ul>` : ""}
    ${due.length - overdue.length ? `<p style="margin:0 0 4px;font-weight:600;color:#B45309;">Due soon</p>
      <ul style="margin:6px 0 14px;padding-left:20px;">${due.filter((x) => !overdue.includes(x)).map(li).join("")}</ul>` : ""}
    <div style="margin:12px 0;padding:10px 12px;background:#F2F6FA;border-left:3px solid #2C5F8A;font-size:12.5px;">
      A sample response that arrives late is the delay the auditor reports to the audit committee under
      AS 1301.25, and it is the one most clearly attributable to the company. Waiving an item with a written
      reason counts as an answer; silence does not.
    </div>
    ${button("Open the requests", portalLink(`${BASE}/samples`), "#B45309")}
  `;
  const recipients = await audience("company");
  const rows = await enqueue({
    kind: "sample_due",
    recipients,
    subject,
    body: shell("Sample requests outstanding", inner, overdue.length ? "#991B1B" : "#B45309"),
    instant: true,
  });
  await flush(rows.length || 20);
  return { sent: rows.length, due: due.length, overdue: overdue.length };
}

// ── Provider callbacks: did it actually arrive ──────────────
//
// "Our mail server accepted it" and "their mail server accepted it" are
// different facts, and only the second answers the question people
// actually argue about. The first is knowable here; the second only from
// the sending provider, which is why this endpoint exists.
//
// MATCHING, in descending order of reliability. The raw payload is
// stored either way, so a callback that cannot be matched is still
// evidence rather than a silent discard:
//   1. the X-Audit-Receipt header we set on the way out — exact
//   2. the provider's message id against the outbox — exact
//   3. the recipient address against their most recent outstanding
//      receipt, within 21 days — a HEURISTIC, recorded as one
//
// Step 3 is honest about what it is. In practice one person has one
// package in flight, so it is nearly always right; where it is wrong a
// bounce is attributed to the wrong package, which is still a loud and
// useful signal about that address.

function flattenHeaders(obj) {
  const out = {};
  const h = obj && (obj.headers || (obj.data && obj.data.headers));
  if (!h) return out;
  if (Array.isArray(h)) {
    for (const x of h) if (x && x.name) out[String(x.name).toLowerCase()] = x.value;
  } else if (typeof h === "object") {
    for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
  }
  return out;
}

function firstRecipient(payload) {
  const d = payload.data || payload;
  const to = d.to || d.email || d.recipient || payload.to;
  if (Array.isArray(to)) return to.length ? String(to[0]) : null;
  if (typeof to === "string") return to;
  if (to && to.email) return String(to.email);
  return null;
}

function providerMessageId(payload) {
  const d = payload.data || payload;
  return d.email_id || d.message_id || d.messageId || d.MessageID || d.sg_message_id || null;
}

/** Normalise the many provider spellings onto four facts we care about. */
function normaliseEventType(raw) {
  const t = String(raw || "").toLowerCase().replace(/^email\./, "").replace(/[\s_-]+/g, "");
  if (["delivered", "delivery"].includes(t)) return "delivered";
  if (["bounced", "bounce", "hardbounce", "softbounce", "dropped", "spamnotification", "blocked"].includes(t))
    return "bounced";
  if (["opened", "open"].includes(t)) return "opened";
  if (["complained", "complaint", "spamcomplaint"].includes(t)) return "complained";
  if (["deliverydelayed", "deferred", "delayed"].includes(t)) return "delayed";
  if (["sent", "processed", "accepted"].includes(t)) return "sent";
  return t || "unknown";
}

async function matchReceipt(payload) {
  const headers = flattenHeaders(payload);
  const hdr = headers["x-audit-receipt"];
  if (hdr && /^\d+$/.test(String(hdr).trim())) {
    return { receiptId: Number(String(hdr).trim()), matchedBy: "header" };
  }

  const mid = providerMessageId(payload);
  if (mid) {
    const r = await db.query(
      `SELECT receipt_id FROM ngtf_audit_notifications
        WHERE receipt_id IS NOT NULL AND provider_message_id IS NOT NULL
          AND provider_message_id LIKE '%' || $1 || '%'
        ORDER BY id DESC LIMIT 1`,
      [String(mid)]
    );
    if (r.rows.length) return { receiptId: r.rows[0].receipt_id, matchedBy: "message_id" };
  }

  const addr = firstRecipient(payload);
  if (addr) {
    const r = await db.query(
      `SELECT id FROM ngtf_audit_transmittal_recipients
        WHERE lower(email) = lower($1) AND created_at > NOW() - INTERVAL '21 days'
        ORDER BY (acknowledged_at IS NULL) DESC, created_at DESC LIMIT 1`,
      [String(addr).trim()]
    );
    if (r.rows.length) return { receiptId: r.rows[0].id, matchedBy: "recipient_address_heuristic" };
  }
  return { receiptId: null, matchedBy: "unmatched" };
}

/**
 * Apply one provider callback. Returns what it did, for the endpoint's
 * response and for the logs.
 */
async function handleMailProviderEvent(payload, { provider = "unknown" } = {}) {
  const type = normaliseEventType(payload && (payload.type || payload.event || payload.RecordType));
  const addr = firstRecipient(payload) || null;
  const mid = providerMessageId(payload);
  const { receiptId, matchedBy } = await matchReceipt(payload || {});

  // Stored first, always, and exactly as received. When a delivery claim
  // is challenged the useful artefact is the provider's own words, not
  // this application's reading of them.
  await db.query(
    `INSERT INTO ngtf_audit_mail_events (provider, event_type, recipient, message_id, receipt_id, matched_by, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [provider, type, addr, mid ? String(mid) : null, receiptId, matchedBy, JSON.stringify(payload || {})]
  );

  if (!receiptId) return { applied: false, type, matchedBy, reason: "no matching receipt" };

  const cfg = await deliveryConfig();
  const d = (payload && payload.data) || payload || {};
  let applied = null;

  if (type === "delivered") {
    const r = await db.query(
      `UPDATE ngtf_audit_transmittal_recipients
          SET email_delivered_at = COALESCE(email_delivered_at, NOW())
        WHERE id = $1 RETURNING transmittal_id, email, email_delivered_at`,
      [receiptId]
    );
    applied = "email_delivered_at";
    if (r.rows.length) {
      await schema.logEvent({
        transmittalId: r.rows[0].transmittal_id,
        event: "transmittal_mail_delivered",
        detail: { recipient: r.rows[0].email, provider, matchedBy },
      });
    }
  } else if (type === "bounced") {
    const reason =
      d.bounce && (d.bounce.message || d.bounce.reason)
        ? d.bounce.message || d.bounce.reason
        : d.reason || d.Description || d.Details || d.message || null;
    const btype = (d.bounce && (d.bounce.type || d.bounce.subType)) || d.Type || String(payload.type || "") || null;
    const r = await db.query(
      `UPDATE ngtf_audit_transmittal_recipients
          SET email_bounced_at = COALESCE(email_bounced_at, NOW()),
              bounce_type      = COALESCE(bounce_type, $2),
              bounce_reason    = COALESCE(bounce_reason, $3)
        WHERE id = $1 RETURNING *`,
      [receiptId, btype ? String(btype).slice(0, 120) : null, reason ? String(reason).slice(0, 600) : null]
    );
    applied = "email_bounced_at";
    if (r.rows.length) {
      const rec = r.rows[0];
      await schema.logEvent({
        transmittalId: rec.transmittal_id,
        event: "transmittal_mail_bounced",
        detail: { recipient: rec.email, type: btype, reason, provider, matchedBy },
      });
      const t = await db.query(
        `SELECT id, number, subject, direction, engagement_id FROM ngtf_audit_transmittals WHERE id=$1`,
        [rec.transmittal_id]
      );
      try {
        await notifyBounce({
          receipt: rec,
          transmittal: t.rows[0] || null,
          bounceType: btype,
          bounceReason: reason,
        });
      } catch (err) {
        console.error("[ngtf-audit notify] bounce alert failed:", err.message);
      }
    }
  } else if (type === "opened") {
    // Recorded because it is free. Never relied on, and labelled
    // unreliable everywhere it is shown: gateways prefetch the image and
    // most clients block it, so it is wrong in both directions. Ignored
    // entirely unless open tracking was deliberately switched on.
    if (!cfg.email_open_tracking) {
      return { applied: false, type, matchedBy, reason: "open tracking is off; recorded raw only" };
    }
    await db.query(
      `UPDATE ngtf_audit_transmittal_recipients
          SET email_opened_at = COALESCE(email_opened_at, NOW()) WHERE id = $1`,
      [receiptId]
    );
    applied = "email_opened_at";
  } else if (type === "complained") {
    const r = await db.query(
      `SELECT transmittal_id, email FROM ngtf_audit_transmittal_recipients WHERE id=$1`,
      [receiptId]
    );
    if (r.rows.length) {
      await schema.logEvent({
        transmittalId: r.rows[0].transmittal_id,
        event: "transmittal_mail_complaint",
        detail: {
          recipient: r.rows[0].email,
          provider,
          note: "marked as spam — future notifications to this address are likely to be suppressed by the provider",
        },
      });
    }
    applied = "logged_complaint";
  }

  return { applied: !!applied, field: applied, type, receiptId, matchedBy };
}

/** Test harness — verifies transport config without spamming. */
async function selfTest(toEmail) {
  const out = { smtp: !!transport(), twilio: !!(TWILIO.sid && TWILIO.token && TWILIO.from), webhook: !!WEBHOOK_URL, portalUrl: PORTAL_URL || null };
  if (toEmail && out.smtp) {
    try {
      await sendEmail(
        toEmail,
        tag() + " Audit portal notification test",
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
  notifyOperatingEvent,
  notifyEventObligations,
  notifyEventRollCall,
  notifyFilingDeadlines,
  notifyArchiveCountdown,
  notifyCommitteeDigest,
  notifyEngagementEvent,
  // delivery ledger
  notifyTransmittal,
  notifyTransmittalReminder,
  notifyTransmittalAcknowledged,
  notifyTransmittalDisputed,
  notifyBounce,
  notifyDeliveryStalled,
  notifyUndelivered,
  notifySampleRequest,
  notifySampleDue,
  handleMailProviderEvent,
  normaliseEventType,
  matchReceipt,
  receiptLink,
  selfTest,
  shell,
  esc,
  portalLink,
  BASE,
};
