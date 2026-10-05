// ============================================================
//  tg-route.js — WHERE A FIRM ALERT LANDS
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  Before this file, twenty-seven modules each built their own
//  Telegram call and every one of them addressed JJ_TELEGRAM_ID.
//  Court notices, social posts, lead alerts and backup reports
//  all arrived in the same direct message, in the order they
//  happened, which is the same as arriving in no order at all.
//
//  This routes them instead. One supergroup with Topics turned
//  on; each category posts into its own topic thread. The group
//  is TG_OPS_CHAT_ID and each topic is a message_thread_id:
//
//    TG_TOPIC_COURT    Court & deadlines
//      TG_TOPIC_STATE    State court
//      TG_TOPIC_EOIR     EOIR immigration court
//      TG_TOPIC_FEDERAL  Federal court (district, circuit, bankruptcy)
//      TG_TOPIC_USPTO    USPTO (and the Copyright Office)
//    TG_TOPIC_SOCIAL   Social & content
//    TG_TOPIC_LEADS    Leads & intake
//    TG_TOPIC_OPS      Ops & system
//
//  THE FALLBACK IS THE POINT. With none of those set, every
//  send goes to JJ_TELEGRAM_ID exactly as it did before. A
//  half-configured group must never turn into a silent alert —
//  the failure mode of a notification system is not noise, it
//  is a court date nobody was told about. The same applies per
//  topic: an unset topic lands in the group untopiced rather
//  than nowhere.
//
//  THE COURT TOPIC IS DIVIDED. A notice is sorted by the court it
//  comes from (courtTopic below) into one of the four indented
//  topics. A court topic whose variable is not set yet posts in
//  Court & deadlines, where everything went before, so the topics
//  can be created one at a time and nothing goes missing on the
//  way. Anything that names no court stays in Court & deadlines.
//
//  Use `scripts/tg-discover.js` to read the ids off a real
//  message once the group exists.
// ============================================================

// Lazy, matching broker-accounts.js: the pure helpers below (routeFor,
// describeRouting) can then be loaded and checked on a machine with no
// node_modules installed.
const axios = () => require("axios");

const TOPICS = {
  court:   { env: "TG_TOPIC_COURT",   label: "Court & deadlines" },
  state:   { env: "TG_TOPIC_STATE",   label: "State court",            parent: "court" },
  eoir:    { env: "TG_TOPIC_EOIR",    label: "EOIR immigration court", parent: "court" },
  federal: { env: "TG_TOPIC_FEDERAL", label: "Federal court",          parent: "court" },
  uspto:   { env: "TG_TOPIC_USPTO",   label: "USPTO",                  parent: "court" },
  social:  { env: "TG_TOPIC_SOCIAL",  label: "Social & content" },
  leads:   { env: "TG_TOPIC_LEADS",   label: "Leads & intake" },
  ops:     { env: "TG_TOPIC_OPS",     label: "Ops & system" },
};

// A topic id must be a number. Anything else (a topic's NAME pasted in by
// mistake, a stray quote) is treated as unset. Returns the number, or null.
function threadOf(spec) {
  const thread = (process.env[spec.env] || "").trim();
  return thread !== "" && /^-?\d+$/.test(thread) ? Number(thread) : null;
}

function token() {
  return process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || null;
}

function dmChatId() {
  // RECIPIENT_JUE_TELEGRAM_ID is last, and only because several senders
  // already fell back to it. Preserved rather than tidied away: dropping
  // it would silence an alert on an install where it is the only id set.
  return process.env.JJ_TELEGRAM_ID
      || process.env.RECIPIENT_JJ_TELEGRAM_ID
      || process.env.RECIPIENT_JUE_TELEGRAM_ID
      || null;
}

/**
 * Where a topic's messages should go, as a chat_id and an optional
 * message_thread_id. Pure — no network, no env mutation — so the
 * routing table can be exercised in a check without a token.
 */
function routeFor(topic) {
  const group = (process.env.TG_OPS_CHAT_ID || "").trim();
  const spec = TOPICS[topic];

  if (group && spec) {
    // `via` says where the message really goes: its own topic, the topic it
    // is a division of (a court topic not created yet), or the group itself.
    // It never claims a thread the message will not reach.
    const own = threadOf(spec);
    if (own !== null) return { chat_id: group, via: "topic", message_thread_id: own };
    const up = spec.parent && TOPICS[spec.parent] ? threadOf(TOPICS[spec.parent]) : null;
    if (up !== null) return { chat_id: group, via: "parent", message_thread_id: up, parent: spec.parent };
    return { chat_id: group, via: "group" };
  }

  const dm = dmChatId();
  return dm ? { chat_id: dm, via: "dm" } : null;
}

/**
 * Send one alert. Never throws: a notifier that can bring down the
 * job it reports on is worse than no notifier. Returns true on a
 * delivered message, false otherwise, and says why in the log.
 */
async function send(topic, text, opts = {}) {
  const tok = token();
  const route = routeFor(topic);
  if (!tok || !route) {
    console.warn(`[tg-route] ${topic}: no ${!tok ? "token" : "destination"}; dropped`);
    return false;
  }

  const body = {
    chat_id: route.chat_id,
    text: String(text == null ? "" : text).slice(0, 3900),
    disable_web_page_preview: opts.disable_web_page_preview !== false,
  };
  if (route.message_thread_id) body.message_thread_id = route.message_thread_id;
  if (opts.parse_mode) body.parse_mode = opts.parse_mode;
  if (opts.reply_markup) body.reply_markup = opts.reply_markup;

  const url = `https://api.telegram.org/bot${tok}/sendMessage`;

  try {
    await axios().post(url, body, { timeout: 10000 });
    return true;
  } catch (e) {
    // A deleted or closed topic answers 400. Retry into the group
    // itself rather than losing the message — being in the wrong
    // thread beats not arriving.
    const status = e.response && e.response.status;
    if (body.message_thread_id && status === 400) {
      try {
        delete body.message_thread_id;
        await axios().post(url, body, { timeout: 10000 });
        console.warn(`[tg-route] ${topic}: topic thread rejected; sent to the group instead`);
        return true;
      } catch (e2) {
        console.warn(`[tg-route] ${topic}: ${e2.message}`);
        return false;
      }
    }
    console.warn(`[tg-route] ${topic}: ${e.message}`);
    return false;
  }
}

/**
 * Just the address, for senders that must keep their own posting logic —
 * the hearing-note senders chunk a long note across several messages and
 * throw on failure, and that behaviour should not be flattened into send().
 * Spread it into an existing payload:
 *
 *   const to = tgRoute.target("court");
 *   await axios.post(url, { ...to, text: chunk, parse_mode: "Markdown" });
 */
function target(topic) {
  const r = routeFor(topic);
  if (!r) return null;
  const out = { chat_id: r.chat_id };
  if (r.message_thread_id) out.message_thread_id = r.message_thread_id;
  return out;
}

/** A one-line view of where each topic currently points. */
function describeRouting() {
  return Object.keys(TOPICS).map(k => {
    const r = routeFor(k);
    return {
      topic: k,
      label: TOPICS[k].label,
      via: r ? r.via : "none",
      parent: TOPICS[k].parent || null,
      chat_id: r ? r.chat_id : null,
      message_thread_id: r ? r.message_thread_id || null : null,
    };
  });
}

/**
 * A photo or a video with a caption, to a topic. Same promises as send():
 * never throws, falls back to the group itself when the topic thread is
 * rejected, and to JJ's direct message when no group is configured.
 * kind is "photo" or "video". Returns true once Telegram has it.
 */
async function sendMedia(topic, kind, buffer, filename, caption, opts = {}) {
  const tok = token();
  const route = routeFor(topic);
  if (!tok || !route) {
    console.warn(`[tg-route] ${topic}: no ${!tok ? "token" : "destination"}; ${kind} dropped`);
    return false;
  }
  const method = kind === "video" ? "sendVideo" : "sendPhoto";
  const url = `https://api.telegram.org/bot${tok}/${method}`;
  const post = async (withThread) => {
    const FormData = require("form-data");
    const form = new FormData();
    form.append("chat_id", String(route.chat_id));
    if (withThread && route.message_thread_id) form.append("message_thread_id", String(route.message_thread_id));
    form.append(kind === "video" ? "video" : "photo", buffer, { filename });
    if (caption) form.append("caption", String(caption).slice(0, 1020));
    if (kind === "video") form.append("supports_streaming", "true");
    if (opts.reply_markup) form.append("reply_markup", JSON.stringify(opts.reply_markup));
    await axios().post(url, form, { headers: form.getHeaders(), timeout: opts.timeout || 120000, maxBodyLength: Infinity });
  };
  try {
    await post(true);
    return true;
  } catch (e) {
    const status = e.response && e.response.status;
    if (route.message_thread_id && status === 400) {
      try {
        await post(false);
        console.warn(`[tg-route] ${topic}: topic thread rejected; ${kind} sent to the group instead`);
        return true;
      } catch (e2) { console.warn(`[tg-route] ${topic} ${kind}: ${e2.message}`); return false; }
    }
    console.warn(`[tg-route] ${topic} ${kind}: ${e.message}`);
    return false;
  }
}

// ── Which court a notice belongs to ──────────────────────────────────────
//
// Sorted on what the notice itself says: the agency a court email was read
// as coming from, then the court named on the matter, then the matter type,
// then the wording. Returns "state", "eoir", "federal", "uspto", or "court"
// when nothing names a court. A wrong guess only puts a notice in a
// neighbouring topic of the same group, and an unsure one stays in Court &
// deadlines, so this leans toward "court" over guessing.

const COURT_PATTERNS = [
  // USPTO, its two boards, and the Copyright Office.
  ["uspto", /\b(USPTO|TTAB|PTAB|USCO|TSDR)\b|uspto\.gov|patent and trademark office|trademark trial and appeal|patent trial and appeal|copyright office/i],
  // New York's highest court is a "Court of Appeals" and is a state court.
  ["state", /new york (state )?court of appeals|court of appeals of (the state of )?new york/i],
  // A circuit court comes before EOIR: a petition for review names the BIA
  // and is still a federal case.
  ["federal", /\b\d{1,2}(st|nd|rd|th)\s+cir\b|\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|federal|d\.?c\.?)\s+circuit\b|courts? of appeals\b|ca\d{1,2}\.uscourts/i],
  ["eoir", /\bEOIR\b|\bBIA\b|eoir\.|immigration court|immigration judge|board of immigration appeals|master calendar|individual (merits )?hearing|merits hearing|bond hearing|removal proceeding/i],
  // State before the rest of federal: California's "District Court of
  // Appeal" and "Court of Appeal" (no s) are state courts.
  ["state", /superior court|\b(LASC|OCSC|SBSC|SDSC|RSC|SFSC)\b|stanley mosk|court of appeal\b(?!s)|appellate (district|division|term)|supreme court of (the state of )?(california|new york)|(california|new york) supreme court|supreme court,? .*county|civil court of the city|housing court|small claims|\bcounty\b|justice court|municipal court|surrogate|family court|probate court|state court|unlawful detainer|lacourt\.org|courts\.ca\.gov|nycourts\.gov|occourts\.org/i],
  ["federal", /\bU\.?\s?S\.?\s?D\.?\s?C\b|U\.?S\.? district|united states district|district court|\b[CNSEW]\.?\s?D\.?\s?(Cal|N\.?\s?Y|Tex|Wash|Ill)\b|\b[CNSE]DCA\b|\b[SENW]DNY\b|bankruptcy|federal court|court of federal claims|court of international trade|\bPACER\b|CM\/ECF|uscourts\.gov|supreme court of the united states|\bSCOTUS\b/i],
];

function classifyCourtText(text) {
  const t = String(text || "");
  if (!t.trim()) return null;
  for (const [kind, re] of COURT_PATTERNS) if (re.test(t)) return kind;
  return null;
}

const AGENCY_TOPIC = { state_court: "state", federal_court: "federal", eoir: "eoir", uspto: "uspto" };
// Matter types that are only ever heard in one kind of court.
const TYPE_TOPIC = [
  [/^(trademark|patent|copyright)$/i, "uspto"],
  [/^removal$/i, "eoir"],
  [/unlawful detainer|eviction|small claims|probate|family law|trust \/ estate/i, "state"],
];

/**
 * hint: { agency, court, case_type, title, text }. Every field is optional.
 */
function courtTopic(hint) {
  const h = hint || {};
  const agency = AGENCY_TOPIC[String(h.agency || "").trim().toLowerCase()];
  if (agency) return agency;
  const named = classifyCourtText(h.court);
  if (named) return named;
  const type = String(h.case_type || "").trim();
  for (const [re, kind] of TYPE_TOPIC) if (type && re.test(type)) return kind;
  return classifyCourtText([h.title, h.text].filter(Boolean).join("\n")) || "court";
}

/** One string per destination, so two topics that share a thread compare equal. */
function destKey(topic) {
  const r = routeFor(topic);
  return r ? `${r.chat_id}:${r.message_thread_id || ""}` : "none";
}

/**
 * Sort items into one group per destination. topicOf(item) names the topic.
 * Topics that land in the same place are one group, so with none of the
 * court topics set this returns a single group, and a sender that used to
 * post one message still posts one. Each group: { topic, label, items }.
 * label is empty for whatever lands in Court & deadlines itself.
 */
function groupByDestination(items, topicOf) {
  const general = destKey("court");
  const groups = new Map();
  for (const item of items || []) {
    let topic = topicOf(item);
    if (!TOPICS[topic]) topic = "court";
    const key = destKey(topic);
    if (!groups.has(key)) groups.set(key, { topic, kinds: [], items: [] });
    const g = groups.get(key);
    if (!g.kinds.includes(topic)) g.kinds.push(topic);
    g.items.push(item);
  }
  return [...groups.entries()].map(([key, g]) => ({
    topic: key === general ? "court" : g.topic,
    label: key === general ? "" : g.kinds.map(k => TOPICS[k].label).join(" + "),
    items: g.items,
  }));
}

// The variable a topic's thread id belongs in, from the topic's name as it
// is written in Telegram. /whereami uses it to print the exact line to add.
const NAME_TO_TOPIC = [
  [/state/i, "state"], [/eoir|immigration/i, "eoir"], [/federal|district|circuit/i, "federal"],
  [/uspto|trademark|patent/i, "uspto"], [/court|deadline/i, "court"],
  [/social|content/i, "social"], [/lead|intake/i, "leads"], [/\bops\b|system/i, "ops"],
];
function envForTopicName(name) {
  const n = String(name || "");
  if (!n.trim()) return null;
  for (const [re, topic] of NAME_TO_TOPIC) if (re.test(n)) return TOPICS[topic].env;
  return null;
}

module.exports = {
  send, sendMedia, target, routeFor, describeRouting, TOPICS,
  courtTopic, classifyCourtText, destKey, groupByDestination, envForTopicName,
};
