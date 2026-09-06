/**
 * push-notifications.js — Send push notifications to Expo push tokens.
 *
 * Uses Expo's push service (https://exp.host/--/api/v2/push/send).
 * No auth token needed for push send — Expo accepts any request with
 * valid ExponentPushToken[…] format. Rate-limited by Expo (100 msgs/sec
 * per project, which is plenty for our scale).
 *
 * Token registration/storage: push_tokens table (created in app-api.js init).
 * Columns: user_kind ('firm'|'consultant'|'client'), user_ref (uid or client_key),
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
 * Kind: 'firm' (uid), 'consultant' (uid), 'client' (client_key OR phone).
 */
async function sendToUser(userKind, userRef, payload) {
  if (!userRef) return { sent: 0 };
  try {
    const r = await db.query(
      `SELECT expo_token FROM push_tokens WHERE user_kind = $1 AND user_ref = $2`,
      [userKind, String(userRef)]
    );
    const tokens = r.rows.map(row => row.expo_token);
    return sendToTokens(tokens, payload);
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
    // Match firm user by name substring, get their tokens
    const r = await db.query(`
      SELECT DISTINCT pt.expo_token
      FROM push_tokens pt
      JOIN admin_users au ON au.id::text = pt.user_ref
      WHERE pt.user_kind = 'firm'
        AND LOWER(au.name) LIKE $1
    `, [`%${String(name).toLowerCase().trim()}%`]);
    return sendToTokens(r.rows.map(row => row.expo_token), payload);
  } catch (err) {
    console.error("[push] sendToFirmByName failed:", err.message);
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

module.exports = { sendToTokens, sendToUser, sendToFirmByName, sendToAdmins };
