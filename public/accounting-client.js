/**
 * accounting-client.js — pick the client an accounting entry belongs to.
 *
 * The Record Fee and Record Retainer forms had a plain text box for the
 * client's name, and the server turned whatever was typed into a client key by
 * slugifying it: "Chen Wei" became "chen-wei". That key is what the journal
 * entry, and for a retainer the client's trust ledger, is filed under.
 *
 * Nothing checked it against the firm's actual clients. So:
 *   · "Chen Wei", "Wei Chen" and "chen wei" produced three different clients
 *   · none of them necessarily matched the real client record, which means the
 *     client's own trust ledger page could not find the entry
 *   · a retainer could open a trust ledger for a client who does not exist
 *
 * A trust ledger under a key that matches no client is not a client ledger,
 * and RRC 1.15 requires one per client. So this box now searches the firm's
 * clients and carries the real key.
 *
 * THE PROPERTY THIS FILE EXISTS FOR
 * The hidden key is cleared the moment the name is edited. Picking "Chen Wei"
 * and then typing over it must not post Chen Wei's key with somebody else's
 * name — that would file one client's money under another client's ledger,
 * which is worse than the free-text box it replaces.
 *
 * A name with no match is still allowed: staff take retainers from people who
 * are not in the system yet. But the form says so, and shows the key the entry
 * will be filed under, rather than letting it happen invisibly.
 */
(function () {
  "use strict";

  var DEBOUNCE_MS = 180;
  var MIN_CHARS = 2;

  function slug(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = String(s == null ? "" : s);
    return d.innerHTML;
  }

  function setup(box) {
    var name = box.querySelector('input[name="client_name"]');
    var key = box.querySelector('input[name="client_key"]');
    var menu = box.querySelector("[data-client-menu]");
    var note = box.querySelector("[data-client-note]");
    if (!name || !key || !menu || !note) return;

    var items = [];
    var active = -1;
    var timer = null;
    var seq = 0;

    function say(html, color) {
      note.innerHTML = html;
      note.style.color = color || "#5E5854";
    }

    // What the entry will actually be filed under, said plainly.
    function describe() {
      var typed = name.value.trim();
      if (key.value) {
        say("Attached to <strong>" + esc(name.dataset.pickedName || typed) +
            "</strong> &middot; <code>" + esc(key.value) + "</code>", "#2F6B3F");
      } else if (!typed) {
        say("");
      } else {
        say("No existing client selected. This will be filed under <code>" +
            esc(slug(typed)) + "</code>, which creates a new ledger.", "#A34C00");
      }
    }

    function close() {
      menu.hidden = true;
      menu.innerHTML = "";
      items = [];
      active = -1;
    }

    function choose(i) {
      var c = items[i];
      if (!c) return;
      name.value = c.client_name || c.key;
      name.dataset.pickedName = name.value;
      key.value = c.key || "";
      close();
      describe();
    }

    function render() {
      if (!items.length) { close(); return; }
      menu.innerHTML = items.map(function (c, i) {
        var sub = [c.a_number, c.key].filter(Boolean).join(" · ");
        return '<div data-i="' + i + '" role="option"' +
          ' style="padding:7px 10px; cursor:pointer; font-size:13px; ' +
          (i === active ? "background:#F3EFE9;" : "") + '">' +
          "<div>" + esc(c.client_name || c.key) + "</div>" +
          (sub ? '<div style="font-size:11px; color:#5E5854;">' + esc(sub) + "</div>" : "") +
          "</div>";
      }).join("");
      menu.hidden = false;
    }

    function search() {
      var q = name.value.trim();
      if (q.length < MIN_CHARS) { close(); return; }
      var mine = ++seq;
      fetch("/admin/api/clients/search?q=" + encodeURIComponent(q) + "&limit=8", {
        headers: { Accept: "application/json" },
      }).then(function (r) { return r.json(); }).then(function (d) {
        // A slow earlier request must not overwrite a newer one's results.
        if (mine !== seq) return;
        items = (d && d.ok && Array.isArray(d.results)) ? d.results : [];
        active = items.length ? 0 : -1;
        render();
      }).catch(function () {
        if (mine !== seq) return;
        close();
        // The name box still works without the search; say so rather than
        // leaving a dead dropdown.
        say("Client search is unavailable — the name you type will be used as-is.", "#9C2B1E");
      });
    }

    name.setAttribute("autocomplete", "off");

    name.addEventListener("input", function () {
      // The key belongs to the name that was picked. Editing the name
      // invalidates it, every time, before anything else happens.
      if (key.value) {
        key.value = "";
        delete name.dataset.pickedName;
      }
      describe();
      clearTimeout(timer);
      timer = setTimeout(search, DEBOUNCE_MS);
    });

    name.addEventListener("keydown", function (e) {
      if (menu.hidden) return;
      if (e.key === "ArrowDown") { active = Math.min(active + 1, items.length - 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
      else if (e.key === "Enter") { if (active >= 0) { choose(active); e.preventDefault(); } }
      else if (e.key === "Escape") { close(); }
    });

    menu.addEventListener("mousedown", function (e) {
      var row = e.target.closest("[data-i]");
      if (!row) return;
      e.preventDefault();          // keep focus; blur would close before click
      choose(parseInt(row.dataset.i, 10));
    });

    name.addEventListener("blur", function () { setTimeout(close, 120); });

    describe();
  }

  function init() {
    var boxes = document.querySelectorAll("[data-client-pick]");
    for (var i = 0; i < boxes.length; i++) setup(boxes[i]);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
