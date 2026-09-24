/**
 * client-search.js
 *
 * Matching a typed query against a list of clients. No database, no
 * requires — just the rules, so anything holding a list of clients can
 * search it the same way and a test can check the rules directly.
 *
 * Client folders are named "WANG, BAOHONG": surname first, with a comma.
 * Nobody types it that way, so a plain substring search misses the client
 * the moment the comma or the order is different. These rules compare the
 * words of the name instead of the string.
 */

// The words of a name, lowercased, punctuation dropped.
function nameWords(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    // Apostrophes join a name rather than break it: O'Brien is one word, so
    // that "obrien" and "o'brien" both find him.
    .replace(/['‘’ʼ`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Digits typed as a search are an A-number, not part of the name — so
// "A201-555-444" searches on the number and not on the letter A.
function parseQuery(q) {
  const raw = String(q == null ? "" : q).trim();
  const digits = raw.replace(/\D/g, "");
  const words = nameWords(digits.length >= 4 ? raw.replace(/[\d\-\s]+/g, " ") : raw);
  return { raw, digits, words };
}

function matchesQuery(client, words, digits) {
  // Four digits is the shortest run worth searching on; fewer would match
  // half the firm.
  if (digits.length >= 4) {
    const a = String(client.a_number || "").replace(/\D/g, "");
    if (a && a.includes(digits)) return true;
  }
  if (!words.length) return false;
  const have = nameWords(client.client_name);
  if (!have.length) return false;
  // Every word typed must begin one of the words in the name, so "wang b"
  // finds Baohong Wang but "wang" alone still finds every Wang.
  return words.every(w => have.some(h => h.startsWith(w)));
}

// The clients matching what was typed, best first: an A-number hit, then a
// whole-name match, then the rest, alphabetically inside each group.
function rankClients(clients, q, limit = 8) {
  const { raw, digits, words } = parseQuery(q);
  if (raw.length < 2) return [];
  if (!words.length && digits.length < 4) return [];

  const hits = [];
  for (const c of clients || []) {
    if (!matchesQuery(c, words, digits)) continue;
    const a = String(c.a_number || "").replace(/\D/g, "");
    const byNumber = digits.length >= 4 && a && a.includes(digits);
    const whole = nameWords(c.client_name).join(" ") === words.join(" ");
    hits.push({ c, rank: byNumber ? 0 : whole ? 1 : 2 });
  }
  hits.sort((x, y) => x.rank - y.rank ||
    String(x.c.client_name || "").localeCompare(String(y.c.client_name || "")));
  return hits.slice(0, Math.max(1, limit)).map(h => h.c);
}

module.exports = { nameWords, parseQuery, matchesQuery, rankClients };
