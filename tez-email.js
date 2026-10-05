// ============================================================
//  tez-email.js — one look for every email the firm sends
//  TEZ Law Firm (Tez Law P.C.)
// ------------------------------------------------------------
//  The admin, the consultant portal and the sign-in pages wear the
//  TEZ brand (tez-theme.js). The emails did not: the signing request
//  was walnut-and-gold "Britannia", most of the others were plain
//  text. A client's first sight of the firm online is often one of
//  these emails.
//
//  Email is not a web page. Gmail removes <style> in places and
//  strips SVG; Outlook renders with Word. So this is tables, inline
//  styles and a hosted PNG of the lockup — the wordmark is the
//  artwork, never retyped. Webfonts do not load in most mail apps,
//  so the brand faces are named first and fall back to Georgia and
//  Helvetica/Arial.
//
//    wrap({ heading, body, button, note })  → the whole HTML email
//    button(href, label)                    → the orange button alone
//    esc(text)                              → escape for HTML
//
//  Always send a plain `text` part as well; this builds only `html`.
// ============================================================

const C = {
  orange: "#FF7B00", ink: "#1E1B1A", charcoal: "#2B2523", ember: "#A34C00",
  travertine: "#E8E3DC", marble: "#FAF8F5", stone: "#5E5854", white: "#FFFFFF",
};
const SERIF = "'Cormorant Garamond',Georgia,'Times New Roman',serif";
const SANS = "Montserrat,'Helvetica Neue',Helvetica,Arial,sans-serif";
const PHONE = "626-678-8677";

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Where the firm's server is reached from outside (for the logo image). */
function baseUrl() {
  return String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com").replace(/\/$/, "");
}

/** The orange button. Dark ink on Seal Orange: the brand's readable pairing. */
function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px;"><tr>` +
    `<td bgcolor="${C.orange}" style="background:${C.orange};border-radius:4px;">` +
    `<a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font-family:${SANS};font-size:14px;font-weight:700;letter-spacing:1.2px;` +
    `text-transform:uppercase;color:${C.ink};text-decoration:none;">${esc(label)}</a></td></tr></table>`;
}

/**
 * @param {object} o
 * @param {string} o.heading      the headline, plain text
 * @param {string} o.body         HTML already escaped by the caller (use esc())
 * @param {{href:string,label:string}} [o.button]
 * @param {string} [o.note]       small print under the button, plain text
 * @param {string} [o.preheader]  the line mail apps show next to the subject
 */
function wrap({ heading = "", body = "", button: btn = null, note = "", preheader = "" } = {}) {
  const logo = `${baseUrl()}/static/brand/tez-lockup-email.png`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:${C.marble};">` +
    (preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.marble};">${esc(preheader)}</div>` : "") +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.marble}" style="background:${C.marble};"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:${C.white};border:1px solid ${C.travertine};">` +
    `<tr><td align="center" bgcolor="${C.charcoal}" style="background:${C.charcoal};padding:20px 20px 16px;border-bottom:3px solid ${C.orange};">` +
    `<img src="${esc(logo)}" width="92" alt="TEZ Law Firm" style="display:block;border:0;width:92px;height:auto;font-family:${SANS};font-size:15px;letter-spacing:3px;color:${C.marble};"></td></tr>` +
    `<tr><td style="padding:28px 30px 8px;font-family:${SANS};font-size:15px;line-height:1.6;color:${C.charcoal};">` +
    (heading ? `<h1 style="margin:0 0 14px;font-family:${SERIF};font-size:27px;line-height:1.2;font-weight:600;color:${C.charcoal};">${esc(heading)}</h1>` : "") +
    body +
    (btn && btn.href ? button(btn.href, btn.label || "Open") : "") +
    (note ? `<p style="margin:14px 0 0;font-size:12.5px;line-height:1.5;color:${C.stone};">${esc(note)}</p>` : "") +
    `</td></tr>` +
    `<tr><td style="padding:18px 30px 24px;font-family:${SANS};font-size:12px;line-height:1.6;color:${C.stone};">` +
    `<div style="border-top:1px solid ${C.travertine};padding-top:14px;">` +
    `<span style="letter-spacing:1.6px;text-transform:uppercase;color:${C.charcoal};font-weight:700;">TEZ Law Firm</span><br>` +
    `${PHONE} &nbsp;·&nbsp; <a href="https://tezlawfirm.com" style="color:${C.ember};text-decoration:none;">tezlawfirm.com</a><br>` +
    `<span style="font-size:11px;">Tez Law P.C.</span></div></td></tr>` +
    `</table></td></tr></table></body></html>`;
}

/**
 * Paragraphs from plain text: blank line = new paragraph, single newline =
 * line break, and any https:// address becomes a link (in Ember).
 */
function paragraphs(text) {
  const link = t => t.replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g,
    u => `<a href="${u}" style="color:${C.ember};word-break:break-all;">${u}</a>`);
  return String(text || "").split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p style="margin:0 0 14px;">${link(esc(p)).replace(/\n/g, "<br>")}</p>`).join("");
}

module.exports = { C, SERIF, SANS, PHONE, esc, baseUrl, button, wrap, paragraphs };
