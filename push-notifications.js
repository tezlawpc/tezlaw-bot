/**
 * push-notifications.js — Send push notifications to Expo push tokens.
 *
 * Uses Expo's push service (https://exp.host/--/api/v2/push/send).
 * No auth token needed for push send — Expo accepts any request with
 * valid ExponentPushToken[…] format. Rate-limited by Expo (100 msgs/sec
 * per project, which is plenty for our scale).
 *
 * Token registration/storage: push_tokens table (created in app-api.js init).
 * Columns: user_kind ('firm'|'consultant'|'client'), user_ref (staff or
 * consultant: admin_users.id; client: "c<client_accounts.id>"),
 * expo_token (unique), platform ('ios'|'android'), updated_at.
 */

const axios = require("axios");
const db = require("./db");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/**
 * Send a push notification to specific Expo tokens.
 * Falls silent on delivery failures — never blocks the caller.
 */
async function sendToTokens(tokens, { title, body, data }) {
  const validTokens = (Array.isArray(tokens) ? tokens : [tokens])
    .filter(t => typeof t === "string" && t.startsWith("ExponentPushToken"));
  if (!validTokens.length) return { sent: 0 };

  const messages = validTokens.map(to => ({
    to, title, body,
    data: data || {},
    sound: "default",
    priority: "high",
  }));

  try {
    const res = await axios.post(EXPO_PUSH_URL, messages, {
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      timeout: 10000,
    });
    // Expo returns receipts per message; clean up tokens marked DeviceNotRegistered
    const receipts = res.data?.data || [];
    const badTokens = [];
    for (let i = 0; i < receipts.length; i++) {
      const r = receipts[i];
      if (r.status === "error" && r.details?.error === "DeviceNotRegistered") {
        badTokens.push(validTokens[i]);
      }
    }
    if (badTokens.length) {
      try {
        await db.query(
          `DELETE FROM push_tokens WHERE expo_token = ANY($1::text[])`,
          [badTokens]
        );
      } catch {}
    }
    return { sent: validTokens.length - badTokens.length, removed: badTokens.length };
  } catch (err) {
    console.error("[push] send failed:", err.response?.data || err.message);
    return { sent: 0, error: err.message };
  }
}

/**
 * Send to a single user by their kind + ref.
 * Kind: 'firm' (uid), 'consultant' (uid), 'client' (account id or phone).
 *
 * This used to be an exact match on (user_kind, user_ref), and for anyone
 * who was not firm staff it never matched. /api/push/register decided the
 * kind from a token field, `k`, that tokens do not carry — so every device
 * was filed as kind 'firm': a consultant under their user id, a client under
 * "c<account id>". Callers meanwhile asked for ('consultant', 7) or
 * ('client', <phone>), and a few passed the two arguments the other way
 * round. Nothing threw; the push simply went nowhere.
 *
 * Registration is fixed (app-api.js), but phones registered before the fix
 * are still filed the old way and will stay so until the app next starts.
 * So this looks in both places:
 *
 *   consultant 7   → user_ref '7', kind 'consultant' or 'firm'. Staff and
 *                    consultants share one id sequence (admin_users), so '7'
 *                    cannot be somebody else.
 *   client         → the account's "c<id>" and its phone, either kind.
 *                    A bare number is NEVER matched against kind 'firm':
 *                    client account 7 and staff member 7 are different people.
 */
const KINDS = new Set(["firm", "consultant", "client"]);

async function clientRefs(ref) {
  const raw = String(ref).trim();
  const refs = new Set();
  const digits = raw.replace(/\D/g, "");
  const isId = /^c?\d{1,9}$/i.test(raw);
  try {
    const r = isId
      ? await db.query(`SELECT id, phone, client_key FROM client_accounts WHERE id = $1 LIMIT 1`, [parseInt(digits, 10)])
      : await db.query(
          `SELECT id, phone, client_key FROM client_accounts
            WHERE phone = $1 OR client_key = $1
               OR ($2 <> '' AND right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = right($2, 10))
            LIMIT 5`, [raw, digits.length >= 10 ? digits : ""]);
    for (const a of r.rows) {
      refs.add("c" + a.id);
      if (a.phone) refs.add(String(a.phone));
    }
  } catch { /* no accounts table: fall through to the literal ref */ }
  if (!isId) refs.add(raw);
  return [...refs];
}

async function sendToUser(userKind, userRef, payload) {
  // Tolerate the call sites that pass (ref, kind).
  if (!KINDS.has(String(userKind)) && KINDS.has(String(userRef))) [userKind, userRef] = [userRef, userKind];
  if (userRef == null || userRef === "") return { sent: 0 };
  try {
    let r;
    if (userKind === "client") {
      const refs = await clientRefs(userRef);
      const literal = /^c?\d{1,9}$/i.test(String(userRef).trim()) ? String(userRef).trim().replace(/^c/i, "") : null;
      r = await db.query(
        `SELECT DISTINCT expo_token FROM push_tokens
          WHERE (user_ref = ANY($1::text[]) AND user_kind IN ('client', 'firm'))
             OR ($2::text IS NOT NULL AND user_kind = 'client' AND user_ref = $2)`,
        [refs, literal]);
    } else if (userKind === "consultant") {
      r = await db.query(
        `SELECT DISTINCT expo_token FROM push_tokens
          WHERE user_ref = $1 AND user_kind IN ('consultant', 'firm')`,
        [String(userRef)]);
    } else {
      r = await db.query(
        `SELECT expo_token FROM push_tokens WHERE user_kind = $1 AND user_ref = $2`,
        [userKind || "firm", String(userRef)]);
    }
    return sendToTokens(r.rows.map(row => row.expo_token), payload);
  } catch (err) {
    console.error("[push] sendToUser query failed:", err.message);
    return { sent: 0, error: err.message };
  }
}

/**
 * Send to any firm user matching a name term (used for task assignments
 * where we know the assignee name but not their user id).
 */
async function sendToFirmByName(name, payload) {
  if (!name) return { sent: 0 };
  try {
    // admin_users has full_name and username; there is no `name` column, and
    // asking for one made this query fail (quietly) every time it ran.
    const r = await db.query(`
      SELECT DISTINCT pt.expo_token
      FROM push_tokens pt
      JOIN admin_users au ON au.id::text = pt.user_ref
      WHERE pt.user_kind = 'firm' AND au.role <> 'consultant'
        AND (LOWER(COALESCE(au.full_name, '')) LIKE $1 OR LOWER(au.username) LIKE $1)
    `, [`%${String(name).toLowerCase().trim()}%`]);
    return sendToTokens(r.rows.map(row => row.expo_token), payload);
  } catch (err) {
    console.error("[push] sendToFirmByName failed:", err.message);
    return { sent: 0 };
  }
}

/**
 * Send to everyone holding one of these roles — e.g. the people who can
 * approve a work order (attorney, manager, admin).
 */
async function sendToRoles(roles, payload) {
  const want = (Array.isArray(roles) ? roles : [roles]).map(String).filter(r => r && r !== "consultant" && r !== "client");
  if (!want.length) return { sent: 0 };
  try {
    const r = await db.query(`
      SELECT DISTINCT pt.expo_token
      FROM push_tokens pt
      JOIN admin_users au ON au.id::text = pt.user_ref
      WHERE pt.user_kind = 'firm' AND au.role = ANY($1::text[]) AND COALESCE(au.disabled, FALSE) = FALSE
    `, [want]);
    return sendToTokens(r.rows.map(row => row.expo_token), payload);
  } catch (err) {
    console.error("[push] sendToRoles failed:", err.message);
    return { sent: 0 };
  }
}

/**
 * Send to all admin users (for approval requests, etc.)
 */
async function sendToAdmins(payload) {
  try {
    const r = await db.query(`
      SELECT DISTINCT pt.expo_token
      FROM push_tokens pt
      JOIN admin_users au ON au.id::text = pt.user_ref
      WHERE pt.user_kind = 'firm' AND au.role = 'admin'
    `);
    return sendToTokens(r.rows.map(row => row.expo_token), payload);
  } catch (err) {
    console.error("[push] sendToAdmins failed:", err.message);
    return { sent: 0 };
  }
}

module.exports = { sendToTokens, sendToUser, sendToFirmByName, sendToAdmins, sendToRoles };
