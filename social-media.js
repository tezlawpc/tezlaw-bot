// ============================================================
//  social-media.js — branded images and short videos for Tez Law
//
//  Everything is rendered on the server from text Zara already wrote and
//  JJ approves: no stock photos, no AI-generated faces, no music licences.
//  The look is the TEZ brand kit, the same as the firm profile deck:
//    charcoal #2B2523 · orange #FF7B00 · marble #FAF8F5
//    headlines Cormorant Garamond Bold (中文: Noto Serif SC Bold)
//    labels and body Montserrat (中文: Noto Serif SC)
//    the shield logo and the TEZ LAW lockup, from assets/brand/
//
//  • card(opts)      → PNG, 1080×1350 (Instagram/Facebook/LinkedIn) or
//                      1200×900 (Google Business Profile)
//  • video(script)   → MP4, 1080×1920: one slide per scene, the spoken line
//                      on screen, OpenAI voice. The last slide carries the
//                      logo, the disclaimer, and says the narration is
//                      AI-generated (B&P Code 6157.2(c): an ad may not imply
//                      someone else's voice is the lawyer's).
// ============================================================

const fs    = require("fs");
const os    = require("os");
const path  = require("path");
const { execFile } = require("child_process");
const { Resvg } = require("@resvg/resvg-js");
const opentype = require("opentype.js");

const FFMPEG = require("ffmpeg-static");
const ASSETS = path.join(__dirname, "assets");
const FONT_FILES = {
  cormorant: "Brand-Cormorant-Bold.ttf",
  montserrat: "Brand-Montserrat-Regular.ttf",
  montserratBold: "Brand-Montserrat-Bold.ttf",
  serifBold: "TezSerif-Bold.ttf",
  serif: "TezSerif-Regular.ttf",
};
const FONT_PATHS = Object.values(FONT_FILES).map(f => path.join(ASSETS, "fonts", f));

// Brand colours (tez-brand-kit)
const C = { char: "#2B2523", orange: "#FF7B00", marble: "#FAF8F5",
  sand: "#D8D0C8", muted: "#BDB3AA", line: "#4A4240" };

// Type styles: SVG family list (brand Latin face first, Chinese fallback), weight,
// and which font files measure them.
const T = {
  head:  { family: "Cormorant Garamond", weight: 700, latin: "cormorant", cjk: "serifBold" },
  label: { family: "Montserrat", weight: 700, latin: "montserratBold", cjk: "serifBold" },
  body:  { family: "Montserrat", weight: 400, latin: "montserrat", cjk: "serif" },
  zhHead:{ family: "Noto Serif SC", weight: 700, latin: "serifBold", cjk: "serifBold" },
  zhBody:{ family: "Noto Serif SC", weight: 400, latin: "serif", cjk: "serif" },
};

// ── Fonts, loaded once, used to measure text exactly ────────
let FONTS = null;
function fonts() {
  if (!FONTS) {
    FONTS = {};
    for (const [k, f] of Object.entries(FONT_FILES)) FONTS[k] = opentype.loadSync(path.join(ASSETS, "fonts", f));
  }
  return FONTS;
}
function measure(text, style, size, spacing = 0) {
  const F = fonts();
  let w = 0;
  for (const ch of String(text)) {
    let f = F[style.latin];
    let gi = f.charToGlyphIndex(ch);
    if (!gi) { f = F[style.cjk]; gi = f.charToGlyphIndex(ch); }
    const g = f.glyphs.get(gi || 0);
    w += (g.advanceWidth || f.unitsPerEm * 0.5) * size / f.unitsPerEm + spacing;
  }
  return w;
}

// ── Logo ────────────────────────────────────────────────────
const LOGO = {};
function logo(name) {
  if (!LOGO[name]) {
    const s = fs.readFileSync(path.join(ASSETS, "brand", `${name}.svg`), "utf8");
    const vb = s.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
    // Only the drawing is kept. The exported files carry a <metadata> block
    // (a c2pa content-credentials manifest) whose namespace is declared on the
    // outer <svg> tag, which is dropped here; left in, the renderer rejects
    // the whole card ("unknown namespace prefix 'c2pa'").
    const inner = s.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")
      .replace(/<metadata[\s\S]*?<\/metadata>/g, "")
      .replace(/<([a-z][\w-]*):[\w-]+[^>]*\/>/gi, "")
      .replace(/<([a-z][\w-]*):([\w-]+)[^>]*>[\s\S]*?<\/\1:\2>/gi, "");
    LOGO[name] = { vb, inner };
  }
  return LOGO[name];
}
// Place a logo by height; returns { svg, w }.
function placeLogo(name, x, y, h) {
  const L = logo(name), w = h * L.vb[2] / L.vb[3];
  return { w, svg: `<svg x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${h}" viewBox="${L.vb.join(" ")}">${L.inner}</svg>` };
}
// Shield + "TEZ LAW FIRM" wordmark, coloured like the lockup (TEZ orange, LAW marble).
function brandRow(x, y, h, size) {
  const sh = placeLogo("shield-reversed", x, y, h);
  const tx = x + sh.w + h * 0.3, ty = y + h / 2 + size * 0.36, sp = size * 0.28;
  const tez = measure("TEZ ", T.label, size, sp);
  return sh.svg +
    `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" font-family="${T.label.family}" font-weight="700" font-size="${size}" letter-spacing="${sp.toFixed(1)}" fill="${C.orange}">TEZ</text>` +
    `<text x="${(tx + tez).toFixed(1)}" y="${ty.toFixed(1)}" font-family="${T.label.family}" font-weight="700" font-size="${size}" letter-spacing="${sp.toFixed(1)}" fill="${C.marble}">LAW FIRM</text>`;
}

// ── Text layout ─────────────────────────────────────────────
const straight = s => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isCJK = ch => /[　-〿㐀-鿿＀-￯]/.test(ch);
// resvg picks one font for a whole <text>, so a line that mixes English and
// 中文 is drawn as separate <text> pieces placed side by side: Chinese in Noto
// Serif SC, everything else in the style's brand face.
const CJK_RUN = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+|[^\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+/g;
function textLine({ x, y, text, style, size, fill, anchor = "start", spacing = 0 }) {
  const attrs = fam => `font-family="${fam}" font-weight="${style.weight}" font-size="${size}"${spacing ? ` letter-spacing="${spacing}"` : ""} fill="${fill}"`;
  const str = String(text);
  if (style.family === "Noto Serif SC" || !/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(str)) {
    return `<text x="${x}" y="${y}" ${attrs(style.family)} text-anchor="${anchor}">${esc(str)}</text>`;
  }
  const parts = str.match(CJK_RUN) || [];
  const total = measure(str, style, size, spacing);
  let cx = anchor === "middle" ? x - total / 2 : anchor === "end" ? x - total : x;
  let out = "";
  for (const t of parts) {
    const cjk = isCJK(t[0]);
    out += `<text x="${cx.toFixed(1)}" y="${y}" ${attrs(cjk ? "Noto Serif SC" : style.family)} xml:space="preserve">${esc(t)}</text>`;
    cx += measure(t, style, size, spacing);
  }
  return out;
}
const NO_START = "，。、；：？！）」』】》,.;:?!)%";

// Wrap Latin at spaces and CJK at any character (never starting a line with
// closing punctuation), measured with the real font.
function wrap(text, style, size, maxW, maxLines = 99, spacing = 0) {
  if (typeof style === "number") { maxLines = maxW || 99; maxW = size; size = style; style = T.body; } // old signature
  const tokens = [];
  let buf = "";
  for (const ch of String(text).replace(/\s+/g, " ").trim()) {
    if (isCJK(ch)) { if (buf) { tokens.push(buf); buf = ""; } tokens.push(ch); }
    else if (ch === " ") { if (buf) tokens.push(buf); tokens.push(" "); buf = ""; }
    else buf += ch;
  }
  if (buf) tokens.push(buf);
  const lines = [];
  let line = "";
  for (const t of tokens) {
    const next = line + t;
    if (measure(next.trim(), style, size, spacing) > maxW && line.trim()) {
      if (NO_START.includes(t) && t.length === 1) { line += t; continue; }
      lines.push(line.trim());
      line = t === " " ? "" : t;
    } else line = next;
  }
  if (line.trim()) lines.push(line.trim());
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    let last = cut[maxLines - 1].replace(/[\s,，、]*$/, "");
    while (last && measure(last + "…", style, size, spacing) > maxW) last = last.slice(0, -1).trimEnd();
    cut[maxLines - 1] = last + "…";
    return cut;
  }
  return lines;
}
function textBlock(lines, { x, y, size, lh = 1.3, style = T.body, fill = C.marble, anchor = "start", spacing = 0 }) {
  return lines.map((l, i) => textLine({ x, y: Math.round(y + i * size * lh), text: l, style, size, fill, anchor, spacing })).join("");
}
function png(svg, w) {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: w },
    font: { fontFiles: FONT_PATHS, loadSystemFonts: false, defaultFontFamily: "Montserrat" } });
  return r.render().asPng();
}
const styles = lang => lang === "zh" ? { head: T.zhHead, body: T.zhBody, label: T.zhHead } : { head: T.head, body: T.body, label: T.label };
const TAGLINE = { en: "Protect your rights, we\u2019ll lead the fight.", zh: "守护您的权益，我们为您据理力争。", es: "Proteja sus derechos, nosotros damos la pelea." };
const ADV = { en: "ATTORNEY ADVERTISING", zh: "律师广告", es: "PUBLICIDAD DE ABOGADO" };

// ── Image card ──────────────────────────────────────────────
/**
 * card({ eyebrow, title, points[], lang, format: "portrait"|"landscape" }) → PNG Buffer
 */
function card({ eyebrow = "", title = "", points = [], lang = "en", format = "portrait" }) {
  const land = format === "landscape";
  const W = land ? 1200 : 1080, H = land ? 900 : 1350;
  const pad = land ? 80 : 90, inner = W - pad * 2;
  const S = styles(lang), zh = lang === "zh";
  const tSize = zh ? (land ? 58 : 68) : (land ? 72 : 88);
  const tLH = zh ? 1.38 : 1.04;
  const tLines = wrap(title, S.head, tSize, inner, land ? 3 : 5);
  const pSize = land ? 27 : 32, pLH = zh ? 1.6 : 1.45;

  const top = land ? 240 : 310, bottom = H - (land ? 180 : 205);
  const pts = [];
  let h = tLines.length * tSize * tLH;
  for (const p of points.slice(0, land ? 2 : 3)) {
    const pl = wrap(p, S.body, pSize, inner - 40, 3);
    const add = (pts.length ? 24 : 46) + pl.length * pSize * pLH;
    if (top + h + add > bottom) break;
    pts.push(pl); h += add;
  }
  let y = top + Math.max(0, Math.min((bottom - top - h) / 2, land ? 40 : 90)) + tSize * 0.78;
  const eyebrowY = y - tSize * 0.78 - (land ? 26 : 32);
  let body = textBlock(tLines, { x: pad, y, size: tSize, lh: tLH, style: S.head });
  y += (tLines.length - 1) * tSize * tLH + 46 + pSize * 1.1;
  for (const pl of pts) {
    body += `<rect x="${pad}" y="${Math.round(y - pSize * 0.62)}" width="11" height="11" fill="${C.orange}"/>`;
    body += textBlock(pl, { x: pad + 32, y, size: pSize, lh: pLH, style: S.body, fill: C.sand });
    y += pl.length * pSize * pLH + 24;
  }
  const ebSize = land ? 21 : 24, ebSp = zh ? 3 : +(ebSize * 0.22).toFixed(1);
  const foot = zh ? "tezlawfirm.com · 626-678-8677 · 普通话 · English" : "tezlawfirm.com · 626-678-8677";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.char}"/>
${brandRow(pad, land ? 62 : 76, land ? 72 : 84, land ? 21 : 24)}
${eyebrow ? `<text x="${pad}" y="${Math.round(eyebrowY)}" font-family="${S.label.family}" font-weight="700" font-size="${ebSize}" letter-spacing="${ebSp}" fill="${C.orange}">${esc(zh ? eyebrow : String(eyebrow).toUpperCase())}</text>` : ""}
${body}
<rect x="${pad}" y="${H - (land ? 152 : 174)}" width="${inner}" height="2" fill="${C.line}"/>
<text x="${pad}" y="${H - (land ? 96 : 110)}" font-family="${S.head.family}" font-weight="700" font-size="${zh ? (land ? 28 : 32) : (land ? 36 : 42)}" fill="${C.marble}">${esc(TAGLINE[lang] || TAGLINE.en)}</text>
${textLine({ x: pad, y: H - (land ? 54 : 62), text: foot, style: S.body, size: land ? 19 : 22, fill: C.muted })}
<text x="${W - pad}" y="${H - (land ? 54 : 62)}" text-anchor="end" font-family="${S.label.family}" font-weight="700" font-size="${zh ? (land ? 16 : 18) : (land ? 13 : 15)}" letter-spacing="${zh ? 3 : 3.5}" fill="${C.muted}">${esc(ADV[lang] || ADV.en)}</text>
<rect x="0" y="${H - 10}" width="${W}" height="10" fill="${C.orange}"/>
</svg>`;
  return png(svg, W);
}

// ── Video ───────────────────────────────────────────────────
function slide({ text, eyebrow = "", lang = "en", index = 0, total = 1, kind = "scene" }) {
  const W = 1080, H = 1920, pad = 96, inner = W - pad * 2;
  const S = styles(lang), zh = lang === "zh";
  const langs = zh ? "普通话 · 上海话 · English" : lang === "es" ? "Español · English · 普通话" : "English · 普通话 · Español";
  const footer = `<text x="${pad}" y="${H - 150}" font-family="${T.label.family}" font-weight="700" font-size="40" letter-spacing="1" fill="${C.marble}">tezlawfirm.com</text>
${textLine({ x: pad, y: H - 96, text: "626-678-8677 · " + langs, style: S.body, size: 31, fill: C.muted })}`;

  if (kind === "end") {
    // Closing card: the full lockup, the tagline, then the disclaimer.
    const lh0 = 440, lk = placeLogo("lockup-reversed", 0, 0, lh0);
    const lock = placeLogo("lockup-reversed", (W - lk.w) / 2, 230, lh0).svg;
    const tSize = zh ? 46 : 52;
    const tag = textBlock(wrap(TAGLINE[lang] || TAGLINE.en, S.head, tSize, inner), { x: W / 2, y: 800, size: tSize, lh: 1.15, style: S.head, anchor: "middle" });
    const dSize = 31, dLH = zh ? 1.6 : 1.45;
    const lines = String(text).split("\n").flatMap((para, i) => (i ? [""] : []).concat(wrap(para, S.body, dSize, inner, 6))).slice(0, 18);
    const d = textBlock(lines, { x: pad, y: 1040, size: dSize, lh: dLH, style: S.body, fill: C.sand });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.char}"/><rect x="0" y="0" width="${W}" height="14" fill="${C.orange}"/>
${lock}${tag}<rect x="${pad}" y="${zh ? 900 : 960}" width="${inner}" height="2" fill="${C.line}"/>${d}${footer}</svg>`;
    return png(svg, W);
  }

  const size = kind === "title" ? (zh ? 88 : 106) : (zh ? 70 : 86);
  const lh = zh ? 1.42 : 1.08;
  const lines = wrap(text, S.head, size, inner, 8);
  const blockH = lines.length * size * lh;
  const y0 = Math.round((H - blockH) / 2 + size * 0.8);
  const dots = Array.from({ length: total }, (_, i) => `<rect x="${pad + i * 44}" y="${H - 250}" width="32" height="7" fill="${i <= index ? C.orange : C.line}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.char}"/>
<rect x="0" y="0" width="${W}" height="14" fill="${C.orange}"/>
${brandRow(pad, 150, 108, 31)}
${eyebrow ? `<text x="${pad}" y="${Math.round(y0 - size * 1.2)}" font-family="${S.label.family}" font-weight="700" font-size="32" letter-spacing="${zh ? 4 : 7}" fill="${C.orange}">${esc(zh ? eyebrow : String(eyebrow).toUpperCase())}</text>` : ""}
${textBlock(lines, { x: pad, y: y0, size, lh, style: S.head })}
${dots}
${footer}
</svg>`;
  return png(svg, W);
}

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { maxBuffer: 1 << 26 }, (err, stdout, stderr) => err ? reject(new Error(String(stderr).slice(-800))) : resolve(String(stderr)));
  });
}
async function duration(file) {
  const out = await run(["-hide_banner", "-i", file, "-f", "null", "-"]).catch(e => e.message);
  const m = String(out).match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
}

// One spoken line: made in the language's own voice, then transcribed and
// compared with what it was meant to say (video-voice.js). Returns how that went.
async function speak(text, lang, outFile) {
  return require("./video-voice").speakChecked(text, lang, outFile);
}

const DISCLAIMER = {
  en: "General information, not legal advice. Every case is different, and prior results do not guarantee a similar outcome.\nThe narration is AI-generated; it is not the voice of an attorney.\nAttorney advertising. Tez Law P.C. · Responsible attorney: JJ Zhang, Esq. · 4141 S. Nogales St., Suite C102, West Covina, CA 91792",
  zh: "本视频仅供一般参考，不构成法律意见。每个案件情况不同，过往结果不保证类似结果。\n配音为AI合成，并非律师本人的声音。\n律师广告。Tez Law P.C. · 负责律师：章律师（JJ Zhang, Esq.）· 4141 S. Nogales St., Suite C102, West Covina, CA 91792",
  es: "Información general, no asesoría legal. Cada caso es diferente, y los resultados anteriores no garantizan un resultado similar.\nLa narración es generada por IA; no es la voz de un abogado.\nPublicidad de abogado. Tez Law P.C. · Abogado responsable: JJ Zhang, Esq. · 4141 S. Nogales St., Suite C102, West Covina, CA 91792",
};

/**
 * video({ lang, eyebrow, scenes: [{ text, say }], speakFn? }) → { file, seconds, dir, voice }
 * `voice` has one entry per scene: was the line heard back as written (see video-voice.js).
 * `text` is the on-screen line, `say` what the voice reads (defaults to text).
 */
async function video({ lang = "en", eyebrow = "", scenes = [], speakFn = speak, workDir = null }) {
  if (!scenes.length) throw new Error("No scenes");
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), "tezvid-"));
  const total = scenes.length;
  const segs = [], voice = [];
  const enc = ["-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2"];
  for (let i = 0; i < total; i++) {
    const s = scenes[i];
    const img = path.join(dir, `s${i}.png`), aud = path.join(dir, `s${i}.mp3`), seg = path.join(dir, `s${i}.mp4`);
    fs.writeFileSync(img, slide({ text: s.text, eyebrow: i === 0 ? eyebrow : "", lang, index: i, total, kind: i === 0 ? "title" : "scene" }));
    const heard = await speakFn(s.say || s.text, lang, aud);
    voice.push(Object.assign({ scene: i + 1 }, heard && typeof heard === "object" ? heard : { checked: false }));
    const d = Math.max(1.5, (await duration(aud)) + 0.45);
    await run(["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", "30", "-i", img, "-i", aud,
      "-t", d.toFixed(2), "-af", "apad", ...enc, seg]);
    segs.push(seg);
  }
  // Closing card: logo + disclaimer + AI-voice notice, 5 seconds, silent
  const endImg = path.join(dir, "end.png"), endSeg = path.join(dir, "end.mp4");
  fs.writeFileSync(endImg, slide({ text: DISCLAIMER[lang] || DISCLAIMER.en, lang, kind: "end" }));
  await run(["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", "30", "-i", endImg, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "5", ...enc, endSeg]);
  segs.push(endSeg);
  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, segs.map(s => `file '${s}'`).join("\n"));
  const out = path.join(dir, "video.mp4");
  await run(["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
  return { file: out, seconds: await duration(out), dir, voice };
}

module.exports = { card, slide, video, wrap, measure, DISCLAIMER, TAGLINE };
