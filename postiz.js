// ============================================================
//  postiz.js — the one place that talks to Postiz
//
//  Postiz holds the logins for Facebook, Instagram, LinkedIn, YouTube, TikTok
//  and Google Business Profile, so this bot never stores a social password
//  or token. Zara only ever asks Postiz to SCHEDULE a post that JJ has
//  already approved in Telegram; Postiz publishes it at that time.
//
//  Env:
//    POSTIZ_API_KEY   Settings → Public API in Postiz (paste into Render only)
//    POSTIZ_API_URL   default https://api.postiz.com/public/v1
//                     (self-hosted: https://<your-postiz>/api/public/v1)
//    POSTIZ_INTEGRATION_<CHANNEL>  optional: pin a channel to one connected
//                     account id, e.g. POSTIZ_INTEGRATION_LINKEDIN=clx...
//                     when more than one LinkedIn account is connected.
// ============================================================

const axios = require("axios");

const BASE = () => (process.env.POSTIZ_API_URL || "https://api.postiz.com/public/v1").replace(/\/+$/, "");
const KEY = () => process.env.POSTIZ_API_KEY || "";
const configured = () => !!KEY();

// Which Postiz provider identifiers can serve each of our channels, in order
// of preference (a company page before a personal profile).
const PROVIDERS = {
  facebook:  ["facebook"],
  instagram: ["instagram", "instagram-standalone"],
  linkedin:  ["linkedin-page", "linkedin"],
  gbp:       ["gmb"],
  youtube:   ["youtube"],
  tiktok:    ["tiktok"],
};

function headers(extra = {}) {
  if (!configured()) throw new Error("POSTIZ_API_KEY is not set");
  return { Authorization: KEY(), ...extra };
}
function explain(e) {
  const d = e.response && e.response.data;
  const msg = d ? (typeof d === "string" ? d : (d.message || d.error || JSON.stringify(d))) : e.message;
  const code = e.response ? `HTTP ${e.response.status}: ` : "";
  return new Error(`Postiz ${code}${String(Array.isArray(msg) ? msg.join("; ") : msg).slice(0, 400)}`);
}

let cache = { at: 0, list: null };
async function integrations({ fresh = false } = {}) {
  if (!fresh && cache.list && Date.now() - cache.at < 10 * 60 * 1000) return cache.list;
  try {
    const r = await axios.get(`${BASE()}/integrations`, { headers: headers(), timeout: 20000 });
    cache = { at: Date.now(), list: Array.isArray(r.data) ? r.data : (r.data.integrations || []) };
    return cache.list;
  } catch (e) { throw explain(e); }
}

/** The connected account for a channel, or null. */
async function integrationFor(channel) {
  const list = await integrations();
  const pinned = process.env[`POSTIZ_INTEGRATION_${String(channel).toUpperCase()}`];
  if (pinned) return list.find(i => i.id === pinned) || null;
  for (const ident of PROVIDERS[channel] || []) {
    const hit = list.find(i => i.identifier === ident && !i.disabled);
    if (hit) return hit;
  }
  return null;
}

/** Upload a PNG or MP4 buffer. Returns { id, path }. */
async function upload(buffer, filename, contentType) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("file", buffer, { filename, contentType });
  try {
    const r = await axios.post(`${BASE()}/upload`, form, {
      headers: headers(form.getHeaders()), timeout: 180000,
      maxBodyLength: Infinity, maxContentLength: Infinity,
    });
    if (!r.data || !r.data.path) throw new Error("upload returned no path");
    return { id: r.data.id, path: r.data.path };
  } catch (e) { throw e.response ? explain(e) : e; }
}

/**
 * Settings Postiz requires per provider. `meta` carries what we know about
 * the post: { title, url, tags[] }.
 */
function settingsFor(identifier, meta = {}) {
  switch (identifier) {
    case "youtube":
      return { __type: "youtube", title: String(meta.title || "").slice(0, 100), type: "public",
        selfDeclaredMadeForKids: "no",
        tags: (meta.tags || []).slice(0, 10).map(t => ({ value: t, label: t })) };
    case "tiktok":
      return { __type: "tiktok", title: String(meta.title || "").slice(0, 90),
        privacy_level: "PUBLIC_TO_EVERYONE", duet: false, stitch: false, comment: true,
        autoAddMusic: "no", brand_content_toggle: false, brand_organic_toggle: true,
        // The voice is synthetic; TikTok's own AI label says so on the video.
        video_made_with_ai: true, content_posting_method: "DIRECT_POST" };
    case "instagram":
    case "instagram-standalone":
      return { __type: identifier, post_type: "post" };
    case "gmb":
      return { __type: "gmb", topicType: "STANDARD",
        ...(meta.url ? { callToActionType: "LEARN_MORE", callToActionUrl: meta.url } : {}) };
    case "facebook":
      return { __type: "facebook" };
    case "linkedin":
    case "linkedin-page":
      return { __type: identifier };
    default:
      return { __type: identifier };
  }
}

/**
 * Schedule one post on one channel.
 *   { channel, content, media: [{id,path}], date: Date, meta }
 * Returns { integrationId, identifier, postId, date }.
 */
async function schedule({ channel, content, media = [], date, meta = {}, type = "schedule" }) {
  const integ = await integrationFor(channel);
  if (!integ) throw new Error(`No ${channel} account is connected in Postiz`);
  const body = {
    type,
    date: new Date(date || Date.now()).toISOString(),
    shortLink: false,
    tags: [],
    posts: [{
      integration: { id: integ.id },
      value: [{ content, image: media.map(m => ({ id: m.id, path: m.path })) }],
      settings: settingsFor(integ.identifier, meta),
    }],
  };
  try {
    const r = await axios.post(`${BASE()}/posts`, body, { headers: headers({ "Content-Type": "application/json" }), timeout: 60000 });
    const d = r.data;
    const first = Array.isArray(d) ? d[0] : d;
    return { integrationId: integ.id, identifier: integ.identifier, account: integ.name,
      postId: first && (first.postId || first.id || (first.posts && first.posts[0] && first.posts[0].id)) || null,
      date: body.date };
  } catch (e) { throw explain(e); }
}

module.exports = { configured, integrations, integrationFor, upload, schedule, settingsFor, PROVIDERS };
