// public/calendar-feeds.js — the Calendars page
//
// Served as a real static file rather than inlined, for the reason
// client-script.js sets out: a page built as a server-side template literal
// eats backslash escapes, and one swallowed quote kills every function on the
// page at once. Nothing here is re-escaped by anything.

(function () {
  "use strict";

  function row(id) {
    return document.querySelector('.feed-row[data-id="' + id + '"]');
  }

  function say(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.style.color = kind === "error" ? "#9C2B1E" : kind === "ok" ? "#2F6B3F" : "#5E5854";
  }

  function busy(button, on, labelWhenBusy) {
    if (!button) return;
    if (on) {
      button.dataset.label = button.textContent;
      button.textContent = labelWhenBusy || "Working…";
      button.disabled = true;
      button.style.opacity = "0.6";
    } else {
      if (button.dataset.label) button.textContent = button.dataset.label;
      button.disabled = false;
      button.style.opacity = "1";
    }
  }

  async function send(method, url, body) {
    const opts = { method: method, headers: { "Content-Type": "application/json" } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    let data = null;
    try { data = await resp.json(); } catch (e) { /* a non-JSON error page */ }
    if (!resp.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ("Request failed (" + resp.status + ")"));
    }
    return data;
  }

  // Reads a feed row back out of the DOM, so Save sends exactly what is on screen.
  function readRow(id) {
    const r = row(id);
    if (!r) throw new Error("That calendar is no longer on the page — reload.");
    const mode = r.querySelector('.f-mode:checked');
    return {
      name: r.querySelector(".f-name").value,
      ical_url: r.querySelector(".f-url").value,
      color: r.querySelector(".f-color").value,
      enabled: r.querySelector(".f-enabled").checked,
      filter_mode: mode ? mode.value : "keywords",
      keyword_filter: r.querySelector(".f-keywords").value,
    };
  }

  // A row carries its own status line; reuse it rather than a floating toast.
  function rowStatus(id) {
    const r = row(id);
    if (!r) return null;
    let el = r.querySelector(".f-msg");
    if (!el) {
      el = document.createElement("div");
      el.className = "f-msg";
      el.style.cssText = "font-size:11px; margin-top:8px;";
      r.appendChild(el);
    }
    return el;
  }

  window.saveFeed = async function (id) {
    const btn = row(id) && row(id).querySelector("button");
    const msg = rowStatus(id);
    say(msg, "Saving…");
    busy(btn, true, "Saving…");
    try {
      await send("PATCH", "/admin/calendars/" + id, readRow(id));
      say(msg, "Saved.", "ok");
      // The colour swatch and the name are visible immediately; the border is
      // the one thing the server would otherwise have to re-render for.
      const r = row(id);
      if (r) r.style.borderLeftColor = r.querySelector(".f-color").value;
    } catch (e) {
      say(msg, e.message, "error");
    } finally {
      busy(btn, false);
    }
  };

  window.syncFeed = async function (id) {
    const msg = rowStatus(id);
    const btns = row(id) ? row(id).querySelectorAll("button") : [];
    const btn = btns.length > 1 ? btns[1] : null;
    say(msg, "Fetching the calendar…");
    busy(btn, true, "Syncing…");
    try {
      // Save first: syncing a URL the person just typed but has not saved would
      // silently fetch the old one and look like the edit did nothing.
      await send("PATCH", "/admin/calendars/" + id, readRow(id));
      const r = await send("POST", "/admin/calendars/" + id + "/sync");
      const parts = [];
      if (r.imported) parts.push(r.imported + " new");
      if (r.updated) parts.push(r.updated + " updated");
      if (r.skipped) parts.push(r.skipped + " skipped");
      say(msg, "Read " + (r.total_events || 0) + " event(s)" +
               (parts.length ? " — " + parts.join(", ") : " — nothing changed") + ".", "ok");
      if (r.errors && r.errors.length) {
        say(msg, msg.textContent + " " + r.errors.length + " could not be filed.", "error");
      }
    } catch (e) {
      say(msg, e.message, "error");
    } finally {
      busy(btn, false);
    }
  };

  window.removeFeed = async function (id, button) {
    const r = row(id);
    const name = r ? r.querySelector(".f-name").value : "this calendar";
    const count = r ? (r.textContent.match(/(\d+) event\(s\) stored/) || [0, "0"])[1] : "0";
    if (!window.confirm(
      "Remove " + name + "?\n\n" +
      "Its " + count + " stored event(s) come off the calendar too, since nothing " +
      "will be refreshing them any more. The calendar itself is untouched — you can " +
      "add it back with the same URL."
    )) return;

    const msg = rowStatus(id);
    say(msg, "Removing…");
    busy(button, true, "Removing…");
    try {
      await send("DELETE", "/admin/calendars/" + id);
      if (r) r.remove();
    } catch (e) {
      say(msg, e.message, "error");
      busy(button, false);
    }
  };

  window.addFeed = async function () {
    const msg = document.getElementById("add-msg");
    const name = document.getElementById("new-name");
    const url = document.getElementById("new-url");
    const mode = document.getElementById("new-mode");
    say(msg, "Adding…");
    try {
      await send("POST", "/admin/calendars", {
        name: name.value,
        ical_url: url.value,
        filter_mode: mode.value,
      });
      say(msg, "Added. Syncing it now…", "ok");
      // A feed that has been added but never fetched looks broken, so pull it
      // straight away and let the reloaded page show the result.
      window.location.reload();
    } catch (e) {
      say(msg, e.message, "error");
    }
  };

  window.syncAll = async function () {
    const msg = document.getElementById("sync-msg");
    say(msg, "Fetching every calendar…");
    try {
      const r = await send("POST", "/admin/calendars/sync-all");
      const results = r.results || [];
      const failed = results.filter(function (x) { return x.error; });
      const skipped = results.filter(function (x) { return x.skipped; });
      const ok = results.length - failed.length - skipped.length;
      let text = ok + " calendar(s) synced";
      if (skipped.length) text += ", " + skipped.length + " with no URL yet";
      if (failed.length) {
        text += ", " + failed.length + " failed: " +
                failed.map(function (x) { return x.feed_name + " (" + x.error + ")"; }).join("; ");
      }
      say(msg, text, failed.length ? "error" : "ok");
      if (!failed.length) setTimeout(function () { window.location.reload(); }, 1200);
    } catch (e) {
      say(msg, e.message, "error");
    }
  };
})();
