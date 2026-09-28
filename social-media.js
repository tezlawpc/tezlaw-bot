// ============================================================
//  social-media.js — branded images and short videos for Tez Law
//
//  Everything is rendered on the server from text Zara already wrote and
//  JJ approves: no stock photos, no AI-generated faces, no music licences.
//
//  • card(opts)      → PNG, 1080×1350 (Instagram/Facebook/LinkedIn) or
//                      1200×900 (Google Business Profile)
//  • video(script)   → MP4, 1080×1920, 30–75 s: one slide per scene, the
//                      spoken line burned in as the caption, OpenAI voice.
//                      The last slide always carries the disclaimer and says
//                      the narration is AI-generated (B&P Code 6157.2(c): an
//                      ad may not imply someone else's voice is the lawyer's).
//
//  Fonts: assets/fonts/*.ttf — Noto Sans SC / Noto Serif SC subset to Latin +
//  the 6,763 GB2312 characters, so English and 简体中文 both render.
// ============================================================

const fs    = require("fs");
const os    = require("os");
const path  = require("path");
const { execFile } = require("child_process");
const { Resvg } = require("@resvg/resvg-js");

const FFMPEG = require("ffmpeg-static");
const FONT_DIR = path.join(__dirname, "assets", "fonts");
const FONTS = ["TezSans-Regular.ttf", "TezSans-Bold.ttf", "TezSerif-Bold.ttf"].map(f => path.join(FONT_DIR, f));
const SANS = "Noto Sans SC", SERIF = "Noto Serif SC";

const C = { char: "#2B2523", ember: "#A34C00", orange: "#FF7B00", marble: "#FAF8F5", muted: "#BDB3AA", line: "#4A4240" };

// ── Text layout ─────────────────────────────────────────────
const esc = s => String(s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isCJK = ch => /[　-〿㐀-鿿＀-￯]/.test(ch);
function charW(ch) {
  if (isCJK(ch)) return 1.0;
  if (ch === " ") return 0.28;
  if (/[A-Z]/.test(ch)) return 0.66;
  if (/[mw]/.test(ch)) return 0.82;
  if (/[iljt.,:;'!|]/.test(ch)) return 0.3;
  if (/[0-9]/.test(ch)) return 0.58;
  return 0.54;
}
const width = (s, size) => [...s].reduce((a, ch) => a + charW(ch), 0) * size;
const straight = s => String(s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
const NO_START = "，。、；：？！）」』】》,.;:?!)%";

// Word-wrap Latin at spaces, CJK at any character (but never start a line with closing punctuation)
function wrap(text, size, maxW, maxLines = 99) {
  const tokens = [];
  let buf = "";
  for (const ch of straight(text).replace(/\s+/g, " ").trim()) {
    if (isCJK(ch)) { if (buf) { tokens.push(buf); buf = ""; } tokens.push(ch); }
    else if (ch === " ") { if (buf) tokens.push(buf); tokens.push(" "); buf = ""; }
    else buf += ch;
  }
  if (buf) tokens.push(buf);
  const lines = [];
  let line = "";
  for (const t of tokens) {
    const next = line + t;
    if (width(next.trim(), size) > maxW && line.trim()) {
      if (NO_START.includes(t) && t.length === 1) { line += t; continue; }
      lines.push(line.trim());
      line = t === " " ? "" : t;
    } else line = next;
  }
  if (line.trim()) lines.push(line.trim());
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = cut[maxLines - 1].replace(/[\s,，、]*$/, "") + "…";
    return cut;
  }
  return lines;
}
function textBlock(lines, { x, y, size, lh = 1.3, family = SANS, weight = 400, fill = C.marble, anchor = "start" }) {
  return lines.map((l, i) => `<text x="${x}" y="${Math.round(y + i * size * lh)}" font-family="${family}" font-weight="${weight}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${esc(l)}</text>`).join("");
}
function png(svg, w) {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: w }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: SANS } });
  return r.render().asPng();
}

// ── Image card ──────────────────────────────────────────────
/**
 * card({ eyebrow, title, points[], lang, format: "portrait"|"landscape" }) → PNG Buffer
 */
function card({ eyebrow = "", title = "", points = [], lang = "en", format = "portrait" }) {
  const W = format === "landscape" ? 1200 : 1080, H = format === "landscape" ? 900 : 1350;
  const pad = format === "landscape" ? 80 : 90, inner = W - pad * 2;
  const tSize = lang === "zh" ? (format === "landscape" ? 60 : 70) : (format === "landscape" ? 64 : 76);
  const tLines = wrap(title, tSize, inner, format === "landscape" ? 3 : 5);
  const tLH = lang === "zh" ? 1.35 : 1.18, pSize = format === "landscape" ? 30 : 36;
  const top = format === "landscape" ? 275 : 330, bottom = H - 190;
  const pts = [];
  let h = tLines.length * tSize * tLH;
  for (const p of points.slice(0, format === "landscape" ? 2 : 3)) {
    const pl = wrap(p, pSize, inner - 40, 3);
    const add = 40 + pl.length * pSize * 1.4 - 8;
    if (top + h + add > bottom) break;
    pts.push(pl); h += add;
  }
  // start at `top`, or lower if there is room, so short cards don't leave a hole at the bottom
  let y = top + Math.max(0, Math.min((bottom - top - h) / 2, format === "landscape" ? 40 : 90));
  let body = textBlock(tLines, { x: pad, y, size: tSize, lh: tLH, family: SERIF, weight: 700 });
  const eyebrowY = y - tSize - (format === "landscape" ? 18 : 24);
  y += (tLines.length - 1) * tSize * tLH + 40 + pSize * 1.4;
  for (const pl of pts) {
    body += `<rect x="${pad}" y="${Math.round(y - pSize * 0.62)}" width="12" height="12" fill="${C.orange}"/>`;
    body += textBlock(pl, { x: pad + 34, y, size: pSize, lh: 1.4, fill: "#D8D0C8" });
    y += pl.length * pSize * 1.4 + 22;
  }
  const foot = lang === "zh" ? "tezlawfirm.com · 626-678-8677 · 普通话 / English" : "tezlawfirm.com · 626-678-8677";
  const tag = lang === "zh" ? "守护您的权益，我们为您据理力争。" : "Protect your rights, we’ll lead the fight.";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.char}"/>
<rect x="0" y="${H - 14}" width="${W}" height="14" fill="${C.orange}"/>
<text x="${pad}" y="${format === "landscape" ? 100 : 120}" font-family="${SANS}" font-weight="700" font-size="26" letter-spacing="6" fill="${C.marble}">TEZ LAW P.C.</text>
<rect x="${pad}" y="${format === "landscape" ? 130 : 155}" width="84" height="6" fill="${C.orange}"/>
${eyebrow ? `<text x="${pad}" y="${Math.round(eyebrowY)}" font-family="${SANS}" font-weight="700" font-size="${format === "landscape" ? 24 : 28}" letter-spacing="${lang === "zh" ? 2 : 4}" fill="${C.orange}">${esc(lang === "zh" ? eyebrow : String(eyebrow).toUpperCase())}</text>` : ""}
${body}
<rect x="${pad}" y="${H - 150}" width="${inner}" height="2" fill="${C.line}"/>
<text x="${pad}" y="${H - 95}" font-family="${SERIF}" font-weight="700" font-size="${format === "landscape" ? 28 : 32}" fill="${C.marble}">${esc(tag)}</text>
<text x="${pad}" y="${H - 50}" font-family="${SANS}" font-size="${format === "landscape" ? 22 : 24}" fill="${C.muted}">${esc(foot)}</text>
</svg>`;
  return png(svg, W);
}

// ── Video ───────────────────────────────────────────────────
function slide({ text, eyebrow = "", lang = "en", index = 0, total = 1, kind = "scene" }) {
  const W = 1080, H = 1920, pad = 96, inner = W - pad * 2;
  const size = kind === "end" ? (lang === "zh" ? 44 : 44) : kind === "title" ? (lang === "zh" ? 92 : 96) : (lang === "zh" ? 72 : 76);
  const lines = String(text).split("\n").flatMap((para, i) => (i ? [""] : []).concat(wrap(para, size, inner, 8))).slice(0, 22);
  const lh = lang === "zh" ? 1.4 : 1.2;
  const blockH = lines.length * size * lh;
  const y0 = Math.round((H - blockH) / 2 + size * 0.8);
  const dots = Array.from({ length: total }, (_, i) => `<rect x="${pad + i * 44}" y="${H - 250}" width="32" height="8" fill="${i <= index ? C.orange : C.line}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.char}"/>
<rect x="0" y="0" width="${W}" height="16" fill="${C.orange}"/>
<text x="${pad}" y="190" font-family="${SANS}" font-weight="700" font-size="34" letter-spacing="8" fill="${C.marble}">TEZ LAW P.C.</text>
<rect x="${pad}" y="225" width="96" height="7" fill="${C.orange}"/>
${eyebrow ? `<text x="${pad}" y="${y0 - size * 1.3}" font-family="${SANS}" font-weight="700" font-size="36" letter-spacing="${lang === "zh" ? 3 : 5}" fill="${C.orange}">${esc(lang === "zh" ? eyebrow : String(eyebrow).toUpperCase())}</text>` : ""}
${textBlock(lines, { x: pad, y: y0, size, lh, family: kind === "end" ? SANS : SERIF, weight: kind === "end" ? 400 : 700, fill: kind === "end" ? "#D8D0C8" : C.marble })}
${kind === "end" ? "" : dots}
<text x="${pad}" y="${H - 150}" font-family="${SANS}" font-weight="700" font-size="40" fill="${C.marble}">tezlawfirm.com</text>
<text x="${pad}" y="${H - 96}" font-family="${SANS}" font-size="32" fill="${C.muted}">626-678-8677 · ${lang === "zh" ? "普通话 · 上海话 · English" : "English · 普通话 · Español"}</text>
</svg>`;
  return png(svg, W);
}

function run(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile(FFMPEG, args, { maxBuffer: 1 << 26 }, (err, stdout, stderr) => err ? reject(new Error(String(stderr).slice(-800))) : resolve(String(stderr)));
    if (input) { p.stdin.end(input); }
  });
}
async function duration(file) {
  const out = await run(["-hide_banner", "-i", file, "-f", "null", "-"]).catch(e => e.message);
  const m = String(out).match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
}

async function speak(text, lang, outFile) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set (needed for the voiceover)");
  const axios = require("axios");
  const r = await axios.post("https://api.openai.com/v1/audio/speech",
    { model: process.env.SOCIAL_TTS_MODEL || "tts-1-hd", voice: process.env.SOCIAL_TTS_VOICE || (lang === "zh" ? "nova" : "onyx"), input: text, response_format: "mp3", speed: 1.0 },
    { headers: { Authorization: `Bearer ${key}` }, responseType: "arraybuffer", timeout: 60000 });
  fs.writeFileSync(outFile, Buffer.from(r.data));
}

const DISCLAIMER = {
  en: "General information, not legal advice. Every case is different, and prior results do not guarantee a similar outcome.\nThe narration is AI-generated; it is not the voice of an attorney.\nAttorney advertising. Tez Law P.C.\nResponsible attorney: JJ Zhang, Esq.\n4141 S. Nogales St., Suite C102, West Covina, CA 91792",
  zh: "本视频仅供一般参考，不构成法律意见。每个案件情况不同，过往结果不保证类似结果。\n配音为AI合成，并非律师本人的声音。\n律师广告。Tez Law P.C.\n负责律师：章律师（JJ Zhang, Esq.）\n4141 S. Nogales St., Suite C102, West Covina, CA 91792",
};

/**
 * video({ lang, eyebrow, scenes: [{ text, say }], speakFn? }) → { file, seconds }
 * `text` is the on-screen caption, `say` what the voice reads (defaults to text).
 */
async function video({ lang = "en", eyebrow = "", scenes = [], speakFn = speak, workDir = null }) {
  if (!scenes.length) throw new Error("No scenes");
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), "tezvid-"));
  const total = scenes.length;
  const segs = [];
  for (let i = 0; i < total; i++) {
    const s = scenes[i];
    const img = path.join(dir, `s${i}.png`), aud = path.join(dir, `s${i}.mp3`), seg = path.join(dir, `s${i}.mp4`);
    fs.writeFileSync(img, slide({ text: s.text, eyebrow: i === 0 ? eyebrow : "", lang, index: i, total, kind: i === 0 ? "title" : "scene" }));
    await speakFn(s.say || s.text, lang, aud);
    const d = Math.max(1.5, (await duration(aud)) + 0.45);
    await run(["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", "30", "-i", img, "-i", aud,
      "-t", d.toFixed(2), "-af", "apad", "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-pix_fmt", "yuv420p",
      "-r", "30", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", seg]);
    segs.push(seg);
  }
  // Closing slide: disclaimer + AI-voice notice, 4 seconds, silent
  const endImg = path.join(dir, "end.png"), endSeg = path.join(dir, "end.mp4");
  fs.writeFileSync(endImg, slide({ text: DISCLAIMER[lang] || DISCLAIMER.en, lang, kind: "end" }));
  await run(["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", "30", "-i", endImg, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "4", "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "128k", endSeg]);
  segs.push(endSeg);
  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, segs.map(s => `file '${s}'`).join("\n"));
  const out = path.join(dir, "video.mp4");
  await run(["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
  return { file: out, seconds: await duration(out), dir };
}

module.exports = { card, slide, video, wrap, DISCLAIMER };
