/* ────────────────────────────────────────────────────────────
 * consultant-clients.js — the consultant portal's client pages.
 *
 *   [data-consultant-clients="list"]  My Clients, with search
 *   [data-consultant-clients="new"]   Add a client
 *   [data-consultant-clients="view"]  One client: details (editable if
 *                                     they entered it), open work, messages
 *
 * JJ: consultants must be able to enter client info, search it, and see
 * it on their phone and computer. Same /api/consultant/* calls as the
 * phone app; the web sign-in cookie is accepted there.
 *
 * Colours are the TEZ brand's (tez-theme.js sets them as CSS variables on
 * the page; the names below are what this file has always called them).
 * No emoji — the brand guide rules them out as icons.
 * ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  var host = document.querySelector("[data-consultant-clients]");
  if (!host) return;
  var API = "/api/consultant";
  var NAVY = "#2B2523", GOLD = "#A34C00", MUTED = "#5E5854", RED = "#9C2B1E", LINE = "#E8E3DC", MARBLE = "#FAF8F5", GREEN = "#2F6B3F";

  // Two languages. The page says which (<html lang>, set by the server from
  // the consultant's own choice); every phrase this file shows goes through
  // L(). Simplified Chinese only. What a client typed, a client's name, a
  // hearing type or a court's name is data and is shown as it is.
  var ZH = /^zh/i.test(document.documentElement.getAttribute("lang") || "");
  var ZHMAP = {
      "Search name, phone, email or A-number…": "按姓名、电话、邮箱或 A 号码搜索…",
      "Add client": "添加客户",
      "No client of yours matches.": "没有符合条件的客户。",
      "No clients yet. Add one, or the firm will assign clients to you.": "还没有客户。您可以添加客户，本所也会为您分配客户。",
      "(no name yet)": "（暂无姓名）",
      "Entered by you": "由您录入",
      "Assigned by the firm": "本所分配",
      "Referring broker": "推荐顾问",
      "Referred by this consultant": "由您推荐",
      "This PDF has no text in it - it looks like a scan or a photo. Upload the original PDF, or type the details in.": "这个 PDF 里没有文字，看起来是扫描件或照片。请上传原始 PDF，或手动填写资料。",
      "That is a photo, not a document. Upload the PDF, or type the details in.": "这是照片，不是文件。请上传 PDF，或手动填写资料。",
      "Word files cannot be read here yet. Save it as a PDF and upload that.": "这里暂时无法读取 Word 文件。请另存为 PDF 后上传。",
      "That file type cannot be read. A PDF works best.": "无法读取这种文件，建议使用 PDF。",
      "Client name": "客户姓名",
      "A number": "A 号码",
      "Phone": "电话",
      "Email": "电子邮箱",
      "Optional. Upload a signed agreement and the client's details are read off it for you to check. Nothing is saved until you do.": "可选。上传已签署的协议，系统会读取客户资料供您核对。在您确认之前不会保存任何内容。",
      "Choose a PDF": "选择 PDF",
      "Reading...": "正在读取…",
      "Choose a different PDF": "选择其他 PDF",
      "Nothing could be read from this file. Enter the details by hand.": "未能从该文件读取到内容，请手动填写。",
      "Use ticked details": "使用勾选的资料",
      "Signed agreement": "已签署的协议",
      "Client name *": "客户姓名 *",
      "Last, First": "姓，名",
      "A-number (if any)": "A 号码（如有）",
      "Language": "语言",
      "What they need help with": "需要办理的事项",
      "Notes for the firm": "给本所的备注",
      "Background, how you met them, deadlines they mentioned…": "背景情况、如何认识客户、客户提到的期限…",
      "Save client": "保存客户",
      "Client name is required.": "请填写客户姓名。",
      "Saving…": "正在保存…",
      "Client saved. The firm has been notified.": "客户已保存，本所已收到通知。",
      "Client": "客户",
      "A-number": "A 号码",
      "Matter": "案件",
      "Your role": "您的身份",
      "Not opened yet (contact only)": "尚未立案（仅联系人）",
      "New task for this client": "为该客户新建任务",
      "Edit details": "修改资料",
      "This client's record belongs to the firm. To change their details, send the firm a task or a message.": "该客户的档案由本所管理。如需修改资料，请向本所提交任务或留言。",
      "Save": "保存",
      "Cancel": "取消",
      "Awaiting approval": "待审批",
      "Approved": "已批准",
      "In the queue": "已排队",
      "In progress": "处理中",
      "Nothing open for this client.": "该客户目前没有待办事项。",
      "(task)": "（任务）",
      "sent by you": "由您提交",
      "Court dates": "开庭日期",
      "No upcoming court date is on file for this client.": "该客户目前没有已登记的开庭日期。",
      "Dates change. Confirm with the firm before telling the client anything.": "日期可能变动。告知客户之前，请先向本所确认。",
      "Recent updates": "最近动态",
      "Messages with the client": "与客户的消息",
      "No messages yet.": "暂无消息。",
      "Firm": "本所",
      "Write to the client…": "给客户写消息…",
      "Send": "发送",
      "Sending…": "正在发送…",
      "— choose —": "请选择",
      "Immigration — asylum": "移民：庇护",
      "Immigration — family / green card": "移民：亲属 / 绿卡",
      "Immigration — court / removal": "移民：法庭 / 递解",
      "Immigration — other": "移民：其他",
      "Personal injury": "人身伤害",
      "Business": "商业",
      "Landlord / tenant": "房东与租客",
      "Estate planning": "遗产规划",
      "Real estate": "房地产",
      "Trademark": "商标",
      "Other": "其他",
      "New court notice": "新的法院通知",
      "Hearing scheduled": "开庭已排期",
      "Hearing rescheduled": "开庭已改期",
      "Deadline approaching": "期限临近",
      "Case status changed": "案件状态有变化",
      "New document on file": "有新文件",
      "Case update": "案件有更新",
      "Action needed": "需要您处理",
      "Task approved": "任务已批准",
      "Task not accepted": "任务未受理",
      "Update on your task": "您的任务有更新",
      "Task completed": "任务已完成"
  };
  function L(s) { return ZH && Object.prototype.hasOwnProperty.call(ZHMAP, s) ? ZHMAP[s] : s; }
  // A court date arrives as a calendar day (ymd) plus its English wording.
  function courtDay(c) {
    if (!ZH || !c.ymd) return c.day;
    try { return new Date(c.ymd + "T12:00:00").toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }); }
    catch (e) { return c.day; }
  }

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "style") e.style.cssText = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", headers: { Accept: "application/json" }, credentials: "same-origin" };
    if (opts.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    return fetch(API + path, init).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }).then(function (d) {
        if (r.status === 401) { location.href = "/admin/login?next=" + encodeURIComponent(location.pathname + location.search); }
        if (!r.ok || d.ok === false) throw new Error(d.error || "HTTP " + r.status);
        return d;
      });
    });
  }
  function note(msg, bad) { return h("div", { text: msg, style: "font-size:13px;color:" + (bad ? RED : MUTED) + ";margin:8px 0;" }); }
  function when(v) { try { return v ? new Date(v).toLocaleString(ZH ? "zh-CN" : "en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : ""; } catch (e) { return ""; } }
  function field(label, input) { return h("div", { style: "margin-bottom:12px;" }, [h("label", { text: label }), input]); }
  function input(name, value, attrs) {
    var a = { type: "text", name: name, value: value || "" };
    Object.keys(attrs || {}).forEach(function (k) { a[k] = attrs[k]; });
    return h("input", a);
  }
  var MATTERS = ["", "Immigration — asylum", "Immigration — family / green card", "Immigration — court / removal", "Immigration — other",
    "Personal injury", "Business", "Landlord / tenant", "Estate planning", "Real estate", "Trademark", "Other"];

  // ── List + search ─────────────────────────────────────────
  function list() {
    var q = h("input", { type: "search", placeholder: L("Search name, phone, email or A-number…"), style: "flex:1;min-width:220px;" });
    var box = h("div");
    host.appendChild(h("div", { style: "display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px;" }, [
      q, h("a", { href: "/consultant/clients/new", class: "btn-primary", text: L("Add client") }),
    ]));
    host.appendChild(box);
    var timer = null, seq = 0;
    function load() {
      var mine = ++seq;
      api("/clients?q=" + encodeURIComponent(q.value.trim())).then(function (d) {
        if (mine !== seq) return;
        clear(box);
        if (!d.clients.length) { box.appendChild(h("div", { class: "card" }, [note(q.value.trim() ? L("No client of yours matches.") : L("No clients yet. Add one, or the firm will assign clients to you."))])); return; }
        d.clients.forEach(function (c) {
          var meta = [c.client_phone, c.client_email, c.a_number ? "A# " + c.a_number : null].filter(Boolean).join(" · ");
          box.appendChild(h("a", { href: "/consultant/client/" + encodeURIComponent(c.client_key), class: "card",
            style: "display:block;text-decoration:none;color:inherit;padding:14px 18px;" }, [
            h("div", { style: "display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;" }, [
              h("strong", { text: c.client_name || L("(no name yet)"), style: "color:" + NAVY + ";font-size:15px;" }),
              h("span", { text: c.entered_by_me ? L("Entered by you") : L(c.role_description || "Assigned by the firm"), style: "font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:" + GOLD + ";font-weight:600;" }),
            ]),
            meta ? h("div", { text: meta, style: "font-size:12.5px;color:" + MUTED + ";margin-top:3px;" }) : null,
            h("div", { text: (c.matter_type ? c.matter_type + " · " : "") + (function (n) { return ZH ? n + " 项待办" : (n === 1 ? "1 open item" : n + " open items"); })(Number(c.open_task_count) || 0), style: "font-size:12px;color:" + MUTED + ";margin-top:3px;" }),
          ]));
        });
      }).catch(function (e) { clear(box).appendChild(note(e.message, true)); });
    }
    q.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(load, 250); });
    load();
  }

  // ── Reading an agreement ──────────────────────────────────
  // A consultant standing in front of somebody with a signed agreement should
  // not have to retype the name and A-number off it. What comes back here is
  // deliberately thinner than what the firm sees: the server strips the fee
  // terms before the response leaves, because what the firm charges a client is
  // not an outside referrer's to read. Identity only, and still only what the
  // extractor could quote from the document.
  var UNREADABLE = {
    NO_TEXT_LAYER: L("This PDF has no text in it - it looks like a scan or a photo. Upload the original PDF, or type the details in."),
    IMAGE_UNSUPPORTED: L("That is a photo, not a document. Upload the PDF, or type the details in."),
    DOCX_UNSUPPORTED: L("Word files cannot be read here yet. Save it as a PDF and upload that."),
    UNSUPPORTED: L("That file type cannot be read. A PDF works best.")
  };
  var AG_LABELS = {
    client_name: L("Client name"), a_number: L("A number"),
    client_phone: L("Phone"), client_email: L("Email")
  };
  function agreementBlock(form) {
    var note = h("div", { style: "font-size:12px;color:" + MUTED + ";margin-bottom:8px;" ,
      text: L("Optional. Upload a signed agreement and the client's details are read off it for you to check. Nothing is saved until you do.") });
    var review = h("div", { style: "margin-top:10px;" });
    var file = h("input", { type: "file", accept: "application/pdf", style: "display:none;" });
    var btn = h("button", {
      type: "button", class: "btn-secondary",
      style: "width:100%;border-style:dashed;",
      text: L("Choose a PDF"),
      onclick: function () { file.click(); }
    });
    file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      if (!f) return;
      clear(review);
      btn.disabled = true; btn.textContent = L("Reading...");
      var fd = new FormData();
      fd.append("file", f);
      fetch("/consultant/clients/extract-agreement", { method: "POST", body: fd, credentials: "same-origin" })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; })
          .then(function (d) {
            if (!r.ok || d.ok === false) throw new Error((d.code && UNREADABLE[d.code]) || d.error || ("HTTP " + r.status));
            return d;
          }); })
        .then(function (d) { drawReview(d.proposal, f.name || "agreement.pdf"); })
        .catch(function (e) { review.appendChild(note2(e.message, true)); })
        .then(function () { btn.disabled = false; btn.textContent = L("Choose a different PDF"); file.value = ""; });
    });
    function note2(msg, bad) {
      return h("div", { text: msg, style: "font-size:13px;color:" + (bad ? RED : MUTED) + ";margin:6px 0;" });
    }
    function drawReview(p, filename) {
      clear(review);
      var rows = [], id = p.identity || {};
      Object.keys(id).forEach(function (k) {
        var c = id[k];
        if (!c || c.value == null || c.value === "" || !c.quote) return;
        rows.push([k, c]);
      });
      if (!rows.length) {
        review.appendChild(note2(L("Nothing could be read from this file. Enter the details by hand.")));
        return;
      }
      var boxes = {};
      rows.forEach(function (pair) {
        var k = pair[0], c = pair[1];
        var cb = h("input", { type: "checkbox", checked: "checked", style: "margin-top:3px;" });
        boxes[k] = cb;
        review.appendChild(h("label", {
          style: "display:flex;gap:8px;align-items:flex-start;padding:10px;border:1px solid " + LINE + ";border-radius:3px;background:#fff;margin-bottom:6px;cursor:pointer;text-transform:none;letter-spacing:0;"
        }, [cb, h("span", { style: "flex:1;" }, [
          h("span", { style: "display:block;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:" + MUTED + ";", text: AG_LABELS[k] || k }),
          h("span", { style: "display:block;font-size:14px;color:" + NAVY + ";", text: String(c.value) }),
          h("span", { style: "display:block;font-size:12px;font-style:italic;color:" + MUTED + ";margin-top:3px;", text: c.quote })
        ])]));
      });
      review.appendChild(h("button", {
        type: "button", class: "btn-primary", style: "width:100%;margin-top:4px;", text: L("Use ticked details"),
        onclick: function () {
          rows.forEach(function (pair) {
            if (!boxes[pair[0]].checked) return;
            var input = form.querySelector('[name="' + pair[0] + '"]');
            if (input) input.value = String(pair[1].value);
          });
          clear(review);
          review.appendChild(note2(ZH ? "已从 " + filename + " 读取。保存前请核对下方各项。" : "Read from " + filename + ". Check the fields below before saving."));
        }
      }));
    }
    return h("div", { class: "card", style: "margin-bottom:14px;" }, [
      h("h3", { text: L("Signed agreement") }),
      note, file, btn, review
    ]);
  }

  // ── Add a client ──────────────────────────────────────────
  function add() {
    var status = h("span", { style: "font-size:13px;margin-left:12px;color:" + MUTED + ";" });
    var matter = h("select", { name: "matter_interest" }, MATTERS.map(function (m) { return h("option", { value: m, text: L(m || "— choose —") }); }));
    var form = h("form", { class: "card" }, [
      h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0 16px;" }, [
        field(L("Client name *"), input("client_name", "", { required: "required", placeholder: L("Last, First"), maxlength: "200" })),
        field(L("Phone"), input("client_phone", "", { type: "tel", placeholder: "(626) 555-0100", maxlength: "40" })),
        field(L("Email"), input("client_email", "", { type: "email", maxlength: "200" })),
        field(L("A-number (if any)"), input("a_number", "", { placeholder: "A123-456-789", maxlength: "30" })),
        field(L("Language"), input("language", "", { placeholder: "English, 中文, Español…", maxlength: "40" })),
        field(L("What they need help with"), matter),
      ]),
      field(L("Notes for the firm"), h("textarea", { name: "notes", rows: "4", maxlength: "4000", placeholder: L("Background, how you met them, deadlines they mentioned…") })),
      h("div", {}, [h("button", { type: "submit", class: "btn-primary", text: L("Save client") }), status]),
    ]);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var data = {};
      new FormData(form).forEach(function (v, k) { if (String(v).trim()) data[k] = String(v).trim(); });
      if (!data.client_name) { status.textContent = L("Client name is required."); status.style.color = RED; return; }
      var btn = form.querySelector("button"); btn.disabled = true; status.textContent = L("Saving…"); status.style.color = MUTED;
      api("/clients", { method: "POST", body: data }).then(function (d) {
        location.href = "/consultant/client/" + encodeURIComponent(d.client.client_key) + "?saved=1";
      }).catch(function (e) { btn.disabled = false; status.textContent = e.message; status.style.color = RED; });
    });
    host.appendChild(agreementBlock(form));
    host.appendChild(form);
  }

  // ── One client ────────────────────────────────────────────
  function view() {
    var key = host.getAttribute("data-key");
    var top = h("div"), updates = h("div"), work = h("div"), msgs = h("div");
    host.appendChild(top); host.appendChild(updates); host.appendChild(work); host.appendChild(msgs);
    if (/saved=1/.test(location.search)) top.appendChild(h("div", { class: "card ok", text: L("Client saved. The firm has been notified.") }));

    function drawInfo(c, assignment) {
      var box = h("div", { class: "card" });
      var title = document.querySelector(".page-header h1");
      if (title) title.textContent = c.client_name || L("Client");
      var rows = [[L("Phone"), c.client_phone], [L("Email"), c.client_email], [L("A-number"), c.a_number], [L("Matter"), c.matter_type === "Contact" ? L("Not opened yet (contact only)") : c.matter_type],
        [L("Your role"), assignment && assignment.role_description ? L(assignment.role_description) : null]];
      box.appendChild(h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;" }, rows.filter(function (r) { return r[1]; }).map(function (r) {
        return h("div", {}, [h("label", { text: r[0] }), h("div", { text: r[1], style: "font-weight:600;color:" + NAVY + ";" })]);
      })));
      var actions = h("div", { style: "margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;" }, [
        h("a", { class: "btn-primary", href: "/consultant/new?client=" + encodeURIComponent(c.client_name || ""), text: L("New task for this client") }),
      ]);
      if (c.editable) actions.appendChild(h("button", { type: "button", class: "btn-secondary", text: L("Edit details"), onclick: function () { clear(box); box.appendChild(editForm(c)); } }));
      box.appendChild(actions);
      if (!c.editable) box.appendChild(note(L("This client's record belongs to the firm. To change their details, send the firm a task or a message.")));
      return box;
    }

    function editForm(c) {
      var status = h("span", { style: "font-size:13px;margin-left:12px;color:" + MUTED + ";" });
      var form = h("form", {}, [
        h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 16px;" }, [
          field(L("Client name *"), input("client_name", c.client_name, { required: "required", maxlength: "200" })),
          field(L("Phone"), input("client_phone", c.client_phone, { type: "tel", maxlength: "40" })),
          field(L("Email"), input("client_email", c.client_email, { type: "email", maxlength: "200" })),
          field(L("A-number"), input("a_number", c.a_number, { maxlength: "30" })),
        ]),
        h("button", { type: "submit", class: "btn-primary", text: L("Save") }),
        h("button", { type: "button", class: "btn-secondary", text: L("Cancel"), style: "margin-left:8px;", onclick: function () { load(); } }),
        status,
      ]);
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var data = {};
        new FormData(form).forEach(function (v, k) { data[k] = String(v).trim(); });
        status.textContent = L("Saving…");
        api("/clients/" + encodeURIComponent(key), { method: "PATCH", body: data }).then(function () { load(); })
          .catch(function (e) { status.textContent = e.message; status.style.color = RED; });
      });
      return form;
    }

    // What the firm has open for this client. The server sends the wording
    // only of work orders this consultant submitted; the firm's own tasks
    // arrive as a title. `completed` is what older servers sent; `status`
    // is the truth.
    var STATUS_WORDS = { pending_approval: L("Awaiting approval"), open: L("Approved"), pending: L("In the queue"), in_progress: L("In progress") };
    function drawWork(tasks) {
      clear(work);
      var open = tasks.filter(function (t) { return !t.completed && t.status !== "completed" && t.matter_type !== "Contact"; });
      var box = h("div", { class: "card" }, [h("h3", { text: (ZH ? "待办事项（" + open.length + "）" : "Open work (" + open.length + ")") })]);
      if (!open.length) box.appendChild(note(L("Nothing open for this client.")));
      open.slice(0, 30).forEach(function (t) {
        var meta = [STATUS_WORDS[t.status] || String(t.status || "").replace(/_/g, " "), t.due_date ? (ZH ? "期限 " : "due ") + String(t.due_date).slice(0, 10) : null, t.mine ? L("sent by you") : null].filter(Boolean).join(" · ");
        box.appendChild(h("div", { style: "padding:10px 0;border-top:1px solid " + LINE + ";font-size:14px;" }, [
          h("div", { text: t.description || t.title || L("(task)"), style: "color:" + NAVY + ";white-space:pre-wrap;overflow-wrap:anywhere;" }),
          h("div", { text: meta, style: "font-size:12px;color:" + MUTED + ";margin-top:2px;" }),
        ]));
      });
      work.appendChild(box);
    }

    // Court dates and what the consultant has been alerted to. The alerts
    // they get outside the portal say only "something happened — log in";
    // this is where they read it.
    function drawUpdates(d) {
      clear(updates);
      var dates = d.court_dates || [], alerts = d.alerts || [];
      var box = h("div", { class: "card" }, [h("h3", { text: L("Court dates") })]);
      if (!dates.length) box.appendChild(note(L("No upcoming court date is on file for this client.")));
      dates.forEach(function (c) {
        box.appendChild(h("div", { style: "padding:10px 0;border-top:1px solid " + LINE + ";" }, [
          h("div", { text: courtDay(c) + (c.time ? (ZH ? " " : " at ") + c.time : ""), style: "font-weight:600;color:" + NAVY + ";" }),
          h("div", { text: [c.type, c.court].filter(Boolean).join(" · "), style: "font-size:12.5px;color:" + MUTED + ";margin-top:2px;" }),
        ]));
      });
      if (dates.length) box.appendChild(note(L("Dates change. Confirm with the firm before telling the client anything.")));
      updates.appendChild(box);
      if (alerts.length) {
        var list = h("div", { class: "card" }, [h("h3", { text: L("Recent updates") })]);
        alerts.slice(0, 12).forEach(function (a) {
          list.appendChild(h("div", { style: "display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:9px 0;border-top:1px solid " + LINE + ";font-size:14px;" }, [
            a.task_id ? h("a", { href: "/consultant/task/" + a.task_id, text: L(a.label) }) : h("span", { text: L(a.label), style: "color:" + NAVY + ";" }),
            h("span", { text: when(a.at), style: "font-size:12px;color:" + MUTED + ";" }),
          ]));
        });
        updates.appendChild(list);
      }
    }

    function drawMsgs(list) {
      clear(msgs);
      var box = h("div", { class: "card" }, [h("h3", { text: L("Messages with the client") })]);
      var thread = h("div", { style: "max-height:360px;overflow:auto;" });
      if (!list.length) thread.appendChild(note(L("No messages yet.")));
      list.forEach(function (m) {
        var fromClient = m.sender_kind === "client";
        thread.appendChild(h("div", { style: "margin:6px 0;display:flex;justify-content:" + (fromClient ? "flex-start" : "flex-end") + ";" }, [
          h("div", { style: "max-width:75%;padding:8px 12px;font-size:13.5px;white-space:pre-wrap;border-radius:3px;background:" + (fromClient ? MARBLE : "#fff") + ";border:1px solid " + LINE + ";" }, [
            h("div", { text: m.body }),
            h("div", { text: (m.sender_name || (fromClient ? L("Client") : L("Firm"))) + " · " + when(m.created_at), style: "font-size:10.5px;color:" + MUTED + ";margin-top:3px;" }),
          ]),
        ]));
      });
      var ta = h("textarea", { rows: "2", placeholder: L("Write to the client…"), maxlength: "4000" });
      var status = h("span", { style: "font-size:12px;color:" + MUTED + ";margin-left:10px;" });
      var send = h("button", { type: "button", class: "btn-primary", text: L("Send"), onclick: function () {
        var body = ta.value.trim(); if (!body) return;
        send.disabled = true; status.textContent = L("Sending…");
        api("/clients/" + encodeURIComponent(key) + "/messages", { method: "POST", body: { body: body } })
          .then(function () { return api("/clients/" + encodeURIComponent(key) + "/messages"); })
          .then(function (d) { drawMsgs(d.messages || []); })
          .catch(function (e) { send.disabled = false; status.textContent = e.message; status.style.color = RED; });
      } });
      box.appendChild(thread);
      box.appendChild(h("div", { style: "margin-top:10px;" }, [ta, h("div", { style: "margin-top:6px;" }, [send, status])]));
      msgs.appendChild(box);
      thread.scrollTop = thread.scrollHeight;
    }

    function load() {
      var enc = encodeURIComponent(key);
      api("/clients/" + enc).then(function (d) {
        var keep = top.firstChild && /saved/.test(top.firstChild.textContent) ? top.firstChild : null;
        clear(top); if (keep) top.appendChild(keep);
        top.appendChild(drawInfo(d.client, d.assignment));
        return Promise.all([
          api("/clients/" + enc + "/updates").then(drawUpdates).catch(function () { clear(updates); }),
          api("/clients/" + enc + "/tasks").then(function (t) { drawWork(t.tasks || []); }).catch(function (e) { clear(work).appendChild(h("div", { class: "card" }, [note((ZH ? "待办事项加载失败：" : "Open work could not be loaded: ") + e.message, true)])); }),
          api("/clients/" + enc + "/messages").then(function (m) { drawMsgs(m.messages || []); }).catch(function () { clear(msgs); }),
        ]);
      }).catch(function (e) { clear(top).appendChild(note(e.message, true)); });
    }
    load();
  }

  var mode = host.getAttribute("data-consultant-clients");
  if (mode === "new") add(); else if (mode === "view") view(); else list();
})();
