/* ────────────────────────────────────────────────────────────
 * esign-sign.js — the page a client (or witness, or JJ) signs on.
 * TEZ Law Firm
 *
 * Opened from a private link: /sign/e/<token>. Two kinds of document:
 *
 *   · made from one of the firm's Word templates — the whole document
 *     is shown as text, then the consent, a typed name and a box to
 *     draw the signature in;
 *   · UPLOADED (a PDF, a scan) — the pages are drawn exactly as they
 *     are, with this signer's fields laid over them: sign here, initial
 *     here, a text box, a checkbox. Tap each one, then finish.
 *
 * English or 中文 (Simplified), chosen from the browser's language and
 * the button in the header. Works on a phone, and on the office tablet
 * for signing in person.
 * ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  var root = document.getElementById("esign");
  if (!root) return;
  var token = root.getAttribute("data-token") || "";
  var api = "/api/public/esign/" + encodeURIComponent(token);
  var PDFJS = "/static/vendor/pdfjs/";
  var PDFJS_V = "4.10.38";
  var INK = "#0B1F4B";

  // ── Words ──────────────────────────────────────────────────
  var WORDS = {
    en: {
      area: "Secure document signing", other_lang: "中文",
      for_: "For: {name}", loading: "Loading the document…",
      thanks: "Thank you — you have signed.", already: "You have already signed this document.",
      all_done: "Everyone has now signed. TEZ Law Firm will send you a copy of the signed document.",
      wait_rest: "TEZ Law Firm will send you a copy once everyone has signed. You can close this page.",
      download: "Download a copy", download_signed: "Download the signed document",
      not_turn: "Not your turn yet",
      not_turn_body: "This document is waiting for {names} to sign first. You will get a link when it is your turn.",
      sign_h: "Sign", sign_help: "Read the whole document above first. The highlighted spots show where your signature and the date will go.",
      type_name: "Type your full name", name_ph: "Your full legal name", draw_sig: "Draw your signature",
      sign_btn: "Sign", saving: "Saving…", clear_sig: "Clear signature", no_sign: "I do not want to sign",
      decline_h: "Decline to sign?",
      decline_body: "TEZ Law Firm will be told you did not sign. If something in the document is wrong, say what, and we will correct it.",
      decline_ph: "Optional: tell us why, or what needs to change", decline_btn: "Decline", back: "Go back",
      declined_h: "Recorded.", declined_body: "You did not sign. TEZ Law Firm will be in touch.",
      cannot_use: "This link cannot be used", contact: "Please contact TEZ Law Firm at 626-678-8677.",
      load_fail_h: "The document could not be loaded",
      load_fail: "Check your connection and reload the page. If it keeps happening, call TEZ Law Firm at 626-678-8677.",
      save_fail: "Could not save your signature", record_fail: "Could not record that",
      e_withdrawn: "This document was withdrawn by TEZ Law Firm. You do not need to sign it.",
      e_declined: "Signing was declined for this document. Please contact TEZ Law Firm at 626-678-8677.",
      e_expired: "This link has expired. Please ask TEZ Law Firm to send it again.",
      e_not_sent: "This document has not been sent for signature yet.",
      // uploaded documents
      how: "Tap each orange box on the pages below. When they are all green, agree and finish at the bottom.",
      progress: "{done} of {total} done", next: "Next", all_set: "All filled in",
      f_signature: "Sign", f_initials: "Initial", f_text: "Type here", f_name: "Name", f_date: "Date", f_other: "Other signer",
      optional: "optional",
      adopt_sig: "Your signature", adopt_ini: "Your initials", tab_draw: "Draw", tab_type: "Type",
      draw_hint: "Draw with your finger, a stylus or the mouse.", type_hint: "Type it, and it is written out for you.",
      use_it: "Use this", cancel: "Cancel", clear: "Clear", change_sig: "Change signature", change_ini: "Change initials",
      text_h: "Fill in", ok: "OK",
      finish_h: "Finish", finish_btn: "Finish and sign",
      need_fields: "{n} box(es) on the pages still need you. Tap “Next” to go to the first one.",
      need_name: "Type your full name.", need_consent: "Tick the box to agree to sign electronically.",
      need_sig: "Tap a “Sign” box on the pages to add your signature.",
      page_of: "Page {n} of {total}",
      pdf_fail_h: "This browser cannot show the document",
      pdf_fail: "Open this link in a current version of Chrome, Safari or Edge. Or call TEZ Law Firm at 626-678-8677 and we will help.",
      open_pdf: "Open the document",
    },
    zh: {
      area: "安全文件签署", other_lang: "English",
      for_: "签署人：{name}", loading: "正在加载文件…",
      thanks: "谢谢，您已完成签署。", already: "您已经签署过这份文件。",
      all_done: "所有签署人均已签署。TEZ律师事务所会把签署完成的文件发给您。",
      wait_rest: "待所有人签署完毕后，TEZ律师事务所会把文件副本发给您。您现在可以关闭此页面。",
      download: "下载副本", download_signed: "下载已签署的文件",
      not_turn: "还没有轮到您",
      not_turn_body: "这份文件需要先由 {names} 签署。轮到您时，您会收到链接。",
      sign_h: "签署", sign_help: "请先阅读上面的整份文件。高亮的位置是您的签名和日期将出现的地方。",
      type_name: "请输入您的全名", name_ph: "您的法定全名", draw_sig: "请手写签名",
      sign_btn: "签署", saving: "正在保存…", clear_sig: "清除签名", no_sign: "我不想签署",
      decline_h: "确定不签署吗？",
      decline_body: "TEZ律师事务所会收到您未签署的通知。如果文件内容有误，请告诉我们哪里需要修改。",
      decline_ph: "可选：请说明原因，或需要修改的内容", decline_btn: "不签署", back: "返回",
      declined_h: "已记录。", declined_body: "您没有签署。TEZ律师事务所会与您联系。",
      cannot_use: "此链接无法使用", contact: "请致电 626-678-8677 联系TEZ律师事务所。",
      load_fail_h: "无法加载文件",
      load_fail: "请检查网络后刷新页面。如果问题持续，请致电 626-678-8677 联系TEZ律师事务所。",
      save_fail: "无法保存您的签名", record_fail: "无法记录",
      e_withdrawn: "TEZ律师事务所已撤回这份文件，您无需签署。",
      e_declined: "这份文件已被拒绝签署。请致电 626-678-8677 联系TEZ律师事务所。",
      e_expired: "此链接已过期。请联系TEZ律师事务所重新发送。",
      e_not_sent: "这份文件尚未发出签署。",
      how: "请依次点击下面页面上的橙色方框。全部变成绿色后，在页面底部勾选同意并完成签署。",
      progress: "已完成 {done} / {total}", next: "下一处", all_set: "已全部填写",
      f_signature: "签名", f_initials: "姓名缩写", f_text: "点此填写", f_name: "姓名", f_date: "日期", f_other: "其他签署人",
      optional: "选填",
      adopt_sig: "您的签名", adopt_ini: "您的姓名缩写", tab_draw: "手写", tab_type: "输入",
      draw_hint: "请用手指、触控笔或鼠标书写。", type_hint: "输入后会自动生成签名字样。",
      use_it: "使用", cancel: "取消", clear: "清除", change_sig: "更换签名", change_ini: "更换缩写",
      text_h: "填写", ok: "确定",
      finish_h: "完成签署", finish_btn: "完成并签署",
      need_fields: "页面上还有 {n} 处需要您填写。请点击“下一处”前往。",
      need_name: "请输入您的全名。", need_consent: "请勾选同意以电子方式签署。",
      need_sig: "请点击页面上的“签名”方框添加您的签名。",
      page_of: "第 {n} 页，共 {total} 页",
      pdf_fail_h: "此浏览器无法显示文件",
      pdf_fail: "请用新版的 Chrome、Safari 或 Edge 打开此链接，或致电 626-678-8677，我们会协助您。",
      open_pdf: "打开文件",
    },
  };
  var lang = "en";
  try { lang = window.localStorage.getItem("tez-sign-lang") || ""; } catch (e) { lang = ""; }
  if (lang !== "en" && lang !== "zh") lang = /^zh/i.test((window.navigator && window.navigator.language) || "") ? "zh" : "en";
  function t(key, vars) {
    var s = (WORDS[lang] && WORDS[lang][key]) || WORDS.en[key] || key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split("{" + k + "}").join(String(vars[k])); });
    return s;
  }

  // ── Small helpers ──────────────────────────────────────────
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function show(nodes, keepScroll) {
    while (root.firstChild) root.removeChild(root.firstChild);
    nodes.forEach(function (n) { if (n) root.appendChild(n); });
    if (!keepScroll) window.scrollTo(0, 0);
  }
  function card(title, text) {
    return h("div", { "class": "card" }, [h("h2", { text: title, style: "margin:0 0 6px;font-size:26px;" }), text ? h("div", { text: text }) : null]);
  }
  function json(r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); }
  // Can the PDF's own fonts write this? (Latin-1.) Anything else travels as a picture too.
  // The same test as the server's (esign-pdf.js): Latin-1 and the typographic
  // quotes and dashes a phone keyboard puts in by itself.
  function plain(s) { return /^[\x20-\x7E\u00A0-\u00FF\u2018\u2019\u201C\u201D\u2013\u2014\u2026]*$/.test(String(s)); }

  // A picture of a line of text, for names and answers in Chinese and other
  // scripts the PDF's standard fonts cannot write.
  function textPng(text, opts) {
    opts = opts || {};
    var c = document.createElement("canvas");
    var size = opts.size || 44, font = (opts.italic ? "italic " : "") + (opts.weight || "500") + " " + size + "px " +
      (opts.family || '"Noto Sans SC","PingFang SC","Microsoft YaHei","Hiragino Sans GB","Heiti SC",Arial,sans-serif');
    var ctx = c.getContext && c.getContext("2d");
    if (!ctx) return null;
    ctx.font = font;
    var w = Math.ceil((ctx.measureText ? ctx.measureText(text).width : text.length * size) + size * 0.5);
    c.width = Math.max(40, Math.min(2400, w)); c.height = Math.round(size * 1.5);
    ctx = c.getContext("2d");
    ctx.font = font; ctx.fillStyle = INK; ctx.textBaseline = "middle";
    ctx.fillText(text, size * 0.2, c.height / 2);
    return c.toDataURL("image/png");
  }

  // ── The header's language button ───────────────────────────
  var state = null;      // what the signer has filled in so far (kept across a language switch)
  var current = null;    // the last view from the server
  function applyLang() {
    document.documentElement.setAttribute("lang", lang === "zh" ? "zh-Hans" : "en");
    var area = document.getElementById("esign-area");
    if (area) area.textContent = t("area");
    var b = document.getElementById("esign-lang");
    if (b) { b.textContent = t("other_lang"); b.hidden = false; }
  }
  (function () {
    var b = document.getElementById("esign-lang");
    if (b) b.addEventListener("click", function () {
      lang = lang === "zh" ? "en" : "zh";
      try { window.localStorage.setItem("tez-sign-lang", lang); } catch (e) { /* private mode */ }
      applyLang();
      if (current) draw(current, true); else load();
    });
  })();

  function done(d, justSigned) {
    var completed = (d && d.completed) || (justSigned && justSigned.completed);
    var c = card(justSigned ? t("thanks") : t("already"), completed ? t("all_done") : t("wait_rest"));
    var upload = (d && d.kind === "upload") || (current && current.kind === "upload");
    current = null;      // nothing left to redraw: a language switch asks the server again
    if (upload || (d && d.can_download)) {
      c.appendChild(h("p", { style: "margin:16px 0 0;" }, [
        h("a", { "class": "btn-secondary", href: api + "/pdf?download=1", text: completed ? t("download_signed") : t("download") })]));
    }
    show([c]);
  }

  // ── Drawing ────────────────────────────────────────────────
  function pad(canvas, onChange) {
    var ctx, drawing = false, last = null, dirty = false;
    function size() {
      var r = canvas.getBoundingClientRect(), ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(300, Math.round((r.width || 600) * ratio));
      canvas.height = Math.max(100, Math.round((r.height || 170) * ratio));
      ctx = canvas.getContext && canvas.getContext("2d");
      if (!ctx) return;
      ctx.lineWidth = 2.6 * ratio; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = INK;
      dirty = false; onChange(false);
    }
    function point(e) {
      var r = canvas.getBoundingClientRect(), p = e.touches ? e.touches[0] : e;
      return { x: (p.clientX - r.left) * (canvas.width / (r.width || 1)), y: (p.clientY - r.top) * (canvas.height / (r.height || 1)) };
    }
    function down(e) { if (!ctx) return; e.preventDefault(); drawing = true; last = point(e); }
    function move(e) {
      if (!drawing || !ctx) return; e.preventDefault();
      var p = point(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p;
      if (!dirty) { dirty = true; onChange(true); }
    }
    function up() { drawing = false; }
    canvas.addEventListener("mousedown", down); canvas.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    canvas.addEventListener("touchstart", down, { passive: false }); canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", up);
    size();
    return {
      clear: function () { if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; onChange(false); },
      empty: function () { return !dirty; },
      // Only the ink, with a little air round it: a signature drawn small in
      // the corner of the box still fills its line on the document.
      png: function () {
        try {
          var w = canvas.width, hh = canvas.height, data = ctx.getImageData(0, 0, w, hh).data;
          var x0 = w, y0 = hh, x1 = -1, y1 = -1, x, y;
          for (y = 0; y < hh; y++) for (x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          }
          if (x1 < x0 || y1 < y0) return canvas.toDataURL("image/png");
          var m = Math.round(ctx.lineWidth * 2);
          x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(hh - 1, y1 + m);
          var out = document.createElement("canvas");
          out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
          out.getContext("2d").drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
          return out.toDataURL("image/png");
        } catch (e) { return canvas.toDataURL("image/png"); }
      },
    };
  }

  function declineFlow() {
    var why = h("textarea", { rows: "3", placeholder: t("decline_ph") });
    var e2 = h("div", { "class": "err" });
    show([card(t("decline_h"), t("decline_body")),
      h("div", { "class": "card" }, [why,
        h("div", { "class": "row" }, [
          h("button", { "class": "btn-primary", type: "button", text: t("decline_btn"), onclick: function () {
            fetch(api + "/decline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: why.value }) })
              .then(json).then(function (r) {
                if (!r.ok) throw new Error(r.error || t("record_fail"));
                current = null;
                show([card(t("declined_h"), t("declined_body"))]);
              }).catch(function (x) { e2.textContent = x.message; });
          } }),
          h("button", { "class": "btn-secondary", type: "button", text: t("back"), onclick: function () { if (current) draw(current); else load(); } }),
        ]), e2])]);
  }

  function introCard(d) {
    var intro = card(d.title, null);
    intro.appendChild(h("div", { "class": "muted", text: t("for_", { name: d.signer.name + (d.signer.label ? " (" + d.signer.label + ")" : "") }) }));
    if (d.message) intro.appendChild(h("div", { "class": "quote", text: d.message }));
    return intro;
  }
  function consentRow(d, box) {
    return h("label", { "class": "consent" }, [box, h("span", {}, [
      h("span", { text: d.consent_text }),
      lang === "zh" && d.consent_text_zh ? h("span", { "class": "zh-consent", text: d.consent_text_zh }) : null])]);
  }

  // ═══════════════════════════════════════════════════════════
  //  A document made from a template (shown as text)
  // ═══════════════════════════════════════════════════════════
  function renderTemplate(d) {
    var intro = introCard(d);
    var doc = h("div", { "class": "doc", html: d.document_html });

    if (!d.your_turn) {
      show([intro, card(t("not_turn"), t("not_turn_body", { names: (d.waiting_for || []).join(", ") })), doc]);
      return;
    }

    var nameIn = h("input", { type: "text", autocomplete: "name", placeholder: t("name_ph"), value: state.name });
    var consent = h("input", { type: "checkbox", id: "esign-consent" });
    consent.checked = !!state.consent;
    var canvas = h("canvas", { "class": "sigpad", "aria-label": t("draw_sig") });
    var err = h("div", { "class": "err" });
    var signBtn = h("button", { "class": "btn-primary", type: "button", text: t("sign_btn") });
    var sig;

    function ready() {
      state.name = nameIn.value; state.consent = consent.checked;
      signBtn.disabled = !(consent.checked && nameIn.value.trim().length >= 2 && sig && !sig.empty());
    }
    consent.addEventListener("change", ready);
    nameIn.addEventListener("input", ready);

    var form = h("div", { "class": "card" }, [
      h("h3", { text: t("sign_h") }),
      h("div", { "class": "muted", text: t("sign_help") }),
      consentRow(d, consent),
      h("label", { text: t("type_name") }), nameIn,
      h("label", { text: t("draw_sig"), style: "margin-top:14px;" }), canvas,
      h("div", { "class": "row" }, [
        signBtn,
        h("button", { "class": "btn-secondary", type: "button", text: t("clear_sig"), onclick: function () { sig.clear(); } }),
        h("button", { "class": "btn-quiet", type: "button", text: t("no_sign"), onclick: declineFlow }),
      ]),
      err,
    ]);
    show([intro, doc, form]);
    sig = pad(canvas, ready);
    ready();

    signBtn.addEventListener("click", function () {
      err.textContent = "";
      signBtn.disabled = true; signBtn.textContent = t("saving");
      var name = nameIn.value.trim();
      var body = { typed_name: name, signature: sig.png(), consent: consent.checked === true, lang: lang, mode: "drawn" };
      if (!plain(name)) { var pic = textPng(name); if (pic) body.images = { __name: pic }; }
      fetch(api + "/sign", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      }).then(json).then(function (r) {
        if (!r.ok) throw new Error(r.error || t("save_fail"));
        done(d, r);
      }).catch(function (e) {
        err.textContent = e.message; signBtn.textContent = t("sign_btn"); ready();
      });
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  An uploaded document (the PDF pages, with fields over them)
  // ═══════════════════════════════════════════════════════════
  var pdfLib = null;
  function loadPdfJs() {
    if (pdfLib) return pdfLib;
    pdfLib = import(PDFJS + "pdf.min.mjs?v=" + PDFJS_V).then(function (lib) {
      lib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs?v=" + PDFJS_V;
      return lib;
    });
    pdfLib.catch(function () { pdfLib = null; });
    return pdfLib;
  }

  /** Draw the pages of `url` into `host`; returns the page elements at once. */
  function pagesView(host, pages, url) {
    var els = pages.map(function (pg, i) {
      var cv = h("canvas", { "aria-label": t("page_of", { n: i + 1, total: pages.length }) });
      var el = h("div", { "class": "pdf-page", "data-page": String(i), style: "aspect-ratio:" + pg.w + " / " + pg.h + ";" }, [cv]);
      host.appendChild(el);
      host.appendChild(h("div", { "class": "pdf-num", text: t("page_of", { n: i + 1, total: pages.length }) }));
      return { el: el, canvas: cv, drawn: false };
    });
    loadPdfJs().then(function (lib) {
      return lib.getDocument({ url: url, cMapUrl: PDFJS + "cmaps/", cMapPacked: true, standardFontDataUrl: PDFJS + "standard_fonts/", isEvalSupported: false }).promise;
    }).then(function (pdf) {
      function paint(i) {
        var p = els[i];
        if (!p || p.drawn) return;
        p.drawn = true;
        pdf.getPage(i + 1).then(function (page) {
          var cssW = p.el.clientWidth || 800;
          var base = page.getViewport({ scale: 1 });
          var scale = Math.min(2400, cssW * Math.min(2, window.devicePixelRatio || 1)) / base.width;
          var vp = page.getViewport({ scale: scale });
          p.canvas.width = Math.round(vp.width); p.canvas.height = Math.round(vp.height);
          return page.render({ canvasContext: p.canvas.getContext("2d"), viewport: vp }).promise;
        }).catch(function () { p.drawn = false; });
      }
      if (window.IntersectionObserver) {
        var io = new window.IntersectionObserver(function (entries) {
          entries.forEach(function (en) { if (en.isIntersecting) paint(Number(en.target.getAttribute("data-page"))); });
        }, { rootMargin: "600px 0px" });
        els.forEach(function (p) { io.observe(p.el); });
      } else els.forEach(function (_, i) { paint(i); });
    }).catch(function () {
      while (host.firstChild) host.removeChild(host.firstChild);
      var c = card(t("pdf_fail_h"), t("pdf_fail"));
      c.appendChild(h("p", { style: "margin:14px 0 0;" }, [h("a", { "class": "btn-secondary", href: url, target: "_blank", rel: "noopener", text: t("open_pdf") })]));
      host.appendChild(c);
    });
    return els;
  }

  // A sheet over the page: adopting a signature, typing into a box.
  function sheet(title, build) {
    var back = h("div", { "class": "sheet-back", role: "dialog", "aria-modal": "true", "aria-label": title });
    var box = h("div", { "class": "sheet" }, [h("h3", { text: title })]);
    function close() { if (back.parentNode) back.parentNode.removeChild(back); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    document.addEventListener("keydown", onKey);
    back.appendChild(box);
    document.body.appendChild(back);
    build(box, close);
    return close;
  }

  /** Draw or type a signature (or initials). Calls back with {png, mode}. */
  function adopt(kind, suggestion, onUse) {
    var isSig = kind === "signature";
    sheet(isSig ? t("adopt_sig") : t("adopt_ini"), function (box, close) {
      var mode = "draw";
      var canvas = h("canvas", { "class": "sigpad" + (isSig ? "" : " small"), "aria-label": isSig ? t("adopt_sig") : t("adopt_ini") });
      var typed = h("input", { type: "text", value: suggestion || "", maxlength: isSig ? "80" : "8", autocomplete: "off" });
      var preview = h("div", { "class": "typed-sig", text: suggestion || "" });
      var hint = h("div", { "class": "muted", text: t("draw_hint") });
      var use = h("button", { "class": "btn-primary", type: "button", text: t("use_it") });
      var drawPane = h("div", {}, [canvas]);
      var typePane = h("div", { hidden: "" }, [typed, preview]);
      var tabDraw = h("button", { type: "button", "class": "tab on", text: t("tab_draw") });
      var tabType = h("button", { type: "button", "class": "tab", text: t("tab_type") });
      var sig;
      function ready() { use.disabled = mode === "draw" ? !(sig && !sig.empty()) : typed.value.trim().length < 1; }
      function pick(m) {
        mode = m;
        tabDraw.className = "tab" + (m === "draw" ? " on" : ""); tabType.className = "tab" + (m === "type" ? " on" : "");
        drawPane.hidden = m !== "draw"; typePane.hidden = m !== "type";
        hint.textContent = m === "draw" ? t("draw_hint") : t("type_hint");
        if (m === "type") typed.focus();
        ready();
      }
      tabDraw.addEventListener("click", function () { pick("draw"); });
      tabType.addEventListener("click", function () { pick("type"); });
      typed.addEventListener("input", function () { preview.textContent = typed.value; ready(); });
      box.appendChild(h("div", { "class": "tabs" }, [tabDraw, tabType]));
      box.appendChild(hint);
      box.appendChild(drawPane); box.appendChild(typePane);
      box.appendChild(h("div", { "class": "row" }, [
        use,
        h("button", { "class": "btn-secondary", type: "button", text: t("clear"), onclick: function () { if (mode === "draw") sig.clear(); else { typed.value = ""; preview.textContent = ""; ready(); } } }),
        h("button", { "class": "btn-quiet", type: "button", text: t("cancel"), onclick: close }),
      ]));
      sig = pad(canvas, ready);
      ready();
      use.addEventListener("click", function () {
        var png = mode === "draw" ? sig.png()
          : textPng(typed.value.trim(), { size: 72, italic: true, weight: "400",
              family: '"Snell Roundhand","Segoe Script","Brush Script MT","Apple Chancery","Lucida Handwriting","KaiTi","STKaiti",cursive' });
        if (!png) return;
        close();
        onUse({ png: png, mode: mode === "draw" ? "drawn" : "typed" });
      });
    });
  }

  function initialsOf(name) {
    return String(name || "").trim().split(/\s+/).map(function (w) { return w.charAt(0); }).join("").toUpperCase().slice(0, 4);
  }
  function todayPT() {
    try { return new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "2-digit", day: "2-digit", year: "numeric" }); }
    catch (e) { return new Date().toLocaleDateString("en-US"); }
  }

  function renderUpload(d) {
    var intro = introCard(d);
    var wrap = h("div", { "class": "pdf-wrap" });
    var url = api + "/pdf";

    if (!d.your_turn) {
      show([intro, card(t("not_turn"), t("not_turn_body", { names: (d.waiting_for || []).join(", ") })), wrap]);
      pagesView(wrap, d.pages, url);
      return;
    }

    var mineFields = d.fields.filter(function (f) { return f.mine; });
    var needsTap = mineFields.filter(function (f) { return f.type === "signature" || f.type === "initials" || f.type === "text" || f.type === "checkbox"; });
    var nameIn = h("input", { type: "text", autocomplete: "name", placeholder: t("name_ph"), value: state.name });
    var consent = h("input", { type: "checkbox", id: "esign-consent" });
    consent.checked = !!state.consent;
    var err = h("div", { "class": "err" });
    var finish = h("button", { "class": "btn-primary", type: "button", text: t("finish_btn") });
    var progress = h("span", { "class": "prog" });
    var nextBtn = h("button", { "class": "btn-small btn-secondary", type: "button", text: t("next") });
    var bar = h("div", { "class": "signbar" }, [progress, nextBtn]);
    var nodes = {};      // field id → its element on the page

    function isDone(f) {
      if (f.type === "signature") return !!state.sig && !!state.placed[f.id];
      if (f.type === "initials") return !!state.ini && !!state.placed[f.id];
      if (f.type === "text") return !!String(state.values[f.id] || "").trim() || !f.required;
      if (f.type === "checkbox") return state.values[f.id] === true || !f.required;
      return true;
    }
    function missing() { return needsTap.filter(function (f) { return !isDone(f); }); }

    function paintField(f) {
      var el = nodes[f.id];
      if (!el) return;
      while (el.firstChild) el.removeChild(el.firstChild);
      var filled = false;
      if (f.type === "signature" && state.sig && state.placed[f.id]) { el.appendChild(h("img", { src: state.sig, alt: t("f_signature") })); filled = true; }
      else if (f.type === "initials" && state.ini && state.placed[f.id]) { el.appendChild(h("img", { src: state.ini, alt: t("f_initials") })); filled = true; }
      else if (f.type === "date") { el.appendChild(h("span", { "class": "val", text: todayPT() })); filled = true; }
      else if (f.type === "name") { el.appendChild(h("span", { "class": "val", text: nameIn.value.trim() || t("f_name") })); filled = nameIn.value.trim().length >= 2; }
      else if (f.type === "text" && String(state.values[f.id] || "").trim()) { el.appendChild(h("span", { "class": "val", text: state.values[f.id] })); filled = true; }
      else if (f.type === "checkbox") { if (state.values[f.id] === true) { el.appendChild(h("span", { "class": "tick", text: "✕" })); filled = true; } }
      else el.appendChild(h("span", { "class": "ask", text: f.type === "signature" ? t("f_signature") : f.type === "initials" ? t("f_initials") : (f.label || t("f_text")) }));
      el.className = "fld mine " + f.type + (filled ? " done" : "") + (!f.required ? " opt" : "");
      // The words inside follow the size of the box.
      var hpx = el.clientHeight || 20;
      el.style.fontSize = Math.max(8, Math.min(16, hpx * 0.55)) + "px";
    }
    function refresh() {
      state.name = nameIn.value; state.consent = consent.checked;
      mineFields.forEach(paintField);
      var left = missing().length, total = needsTap.length;
      progress.textContent = left ? t("progress", { done: total - left, total: total }) : t("all_set");
      nextBtn.hidden = !left;
      bar.className = "signbar" + (left ? "" : " ok");
    }

    function tap(f) {
      err.textContent = "";
      if (f.type === "signature") {
        if (state.sig && !state.placed[f.id]) { state.placed[f.id] = true; return refresh(); }
        return adopt("signature", nameIn.value.trim() || d.signer.name, function (r) {
          state.sig = r.png; state.sigMode = r.mode; state.placed[f.id] = true; refresh();
        });
      }
      if (f.type === "initials") {
        if (state.ini && !state.placed[f.id]) { state.placed[f.id] = true; return refresh(); }
        return adopt("initials", initialsOf(nameIn.value.trim() || d.signer.name), function (r) {
          state.ini = r.png; state.placed[f.id] = true; refresh();
        });
      }
      if (f.type === "checkbox") { state.values[f.id] = state.values[f.id] !== true; return refresh(); }
      if (f.type === "text") {
        return sheet(f.label || t("text_h"), function (box, close) {
          var input = h("input", { type: "text", maxlength: "500", value: state.values[f.id] || "" });
          function save() { state.values[f.id] = input.value.trim(); close(); refresh(); }
          input.addEventListener("keydown", function (e) { if (e.key === "Enter") save(); });
          box.appendChild(input);
          if (!f.required) box.appendChild(h("div", { "class": "muted", text: "(" + t("optional") + ")" }));
          box.appendChild(h("div", { "class": "row" }, [
            h("button", { "class": "btn-primary", type: "button", text: t("ok"), onclick: save }),
            h("button", { "class": "btn-quiet", type: "button", text: t("cancel"), onclick: close })]));
          input.focus();
        });
      }
    }

    var form = h("div", { "class": "card", id: "esign-finish" }, [
      h("h3", { text: t("finish_h") }),
      h("label", { text: t("type_name") }), nameIn,
      consentRow(d, consent),
      h("div", { "class": "row" }, [
        finish,
        h("button", { "class": "btn-quiet", type: "button", text: t("no_sign"), onclick: declineFlow }),
      ]),
      err,
    ]);
    show([intro, h("div", { "class": "card note how", text: t("how") }), bar, wrap, form], !!state.keepScroll);
    state.keepScroll = false;

    var pageEls = pagesView(wrap, d.pages, url);
    d.fields.forEach(function (f) {
      var pg = pageEls[f.page];
      if (!pg) return;
      var pos = "left:" + (f.x * 100) + "%;top:" + (f.y * 100) + "%;width:" + (f.w * 100) + "%;height:" + (f.h * 100) + "%;";
      if (!f.mine) {
        // Someone else's spot. Once they have signed, their mark is on the page itself.
        if (!f.done) pg.el.appendChild(h("div", { "class": "fld other", style: pos, title: t("f_other") }));
        return;
      }
      var tappable = f.type !== "date" && f.type !== "name";
      var el = h(tappable ? "button" : "div", { "class": "fld mine " + f.type, style: pos, "data-field": f.id });
      if (tappable) { el.setAttribute("type", "button"); el.addEventListener("click", function () { tap(f); }); }
      nodes[f.id] = el;
      pg.el.appendChild(el);
    });

    nextBtn.addEventListener("click", function () {
      var m = missing()[0];
      var el = m && nodes[m.id];
      if (!el) return;
      if (el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("pulse");
      setTimeout(function () { el.classList.remove("pulse"); }, 1600);
    });
    nameIn.addEventListener("input", refresh);
    consent.addEventListener("change", refresh);
    window.addEventListener("resize", refresh);
    refresh();

    finish.addEventListener("click", function () {
      err.textContent = "";
      var left = missing();
      var name = nameIn.value.trim();
      if (left.length) { err.textContent = t("need_fields", { n: left.length }); return; }
      if (!state.sig) { err.textContent = t("need_sig"); return; }
      if (name.length < 2) { err.textContent = t("need_name"); nameIn.focus(); return; }
      if (!consent.checked) { err.textContent = t("need_consent"); return; }
      var values = {}, images = {};
      mineFields.forEach(function (f) {
        if (f.type === "text" && String(state.values[f.id] || "").trim()) {
          values[f.id] = state.values[f.id];
          if (!plain(values[f.id])) { var pic = textPng(values[f.id]); if (pic) images[f.id] = pic; }
        } else if (f.type === "checkbox") values[f.id] = state.values[f.id] === true;
      });
      if (!plain(name)) { var np = textPng(name); if (np) images.__name = np; }
      finish.disabled = true; finish.textContent = t("saving");
      fetch(api + "/sign", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ typed_name: name, signature: state.sig, initials: state.ini || null, consent: true,
          values: values, images: images, lang: lang, mode: state.sigMode || "drawn" }),
      }).then(json).then(function (r) {
        if (!r.ok) throw new Error(r.error || t("save_fail"));
        done(d, r);
      }).catch(function (e) {
        err.textContent = e.message; finish.disabled = false; finish.textContent = t("finish_btn");
      });
    });
  }

  // ── Loading ────────────────────────────────────────────────
  function draw(d, sameView) {
    current = d;
    if (!state) state = { name: (d.signer && d.signer.name) || "", consent: false, sig: null, sigMode: null, ini: null, placed: {}, values: {} };
    state.keepScroll = !!sameView;
    if (d.kind === "upload") renderUpload(d); else renderTemplate(d);
  }
  function load() {
    applyLang();
    fetch(api, { headers: { Accept: "application/json" } }).then(json).then(function (d) {
      if (d.ok && d.signed) { current = null; return done(d); }
      if (!d.ok) {
        current = null;
        return show([card(d.title || t("cannot_use"), (d.code && WORDS[lang]["e_" + d.code]) || d.error || t("contact"))]);
      }
      draw(d);
    }).catch(function () {
      show([card(t("load_fail_h"), t("load_fail"))]);
    });
  }

  window.EsignSign = { reload: load };
  load();
})();
