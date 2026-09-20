/* ────────────────────────────────────────────────────────────
 * zara-admin.js — the console where Zara is defined.
 *
 * Three things live on this page:
 *
 *   CHARTER  — who Zara is. Editing it here changes every surface at
 *              once: the app, the web, the voice line, the background
 *              jobs. No deploy, and every save is a new version with
 *              your name on it.
 *
 *   LESSONS  — what she has learned. Zara proposes; you approve. An
 *              approved lesson is injected into every future prompt in
 *              its scope. Nothing reaches a prompt unreviewed.
 *
 *   HEALTH   — which model actually answered, how often the failover
 *              fired, and what it cost.
 *
 * Served as a real static file for the same reason civil-admin.js is:
 * JavaScript written inside a server-side template literal has its \n
 * and \' eaten before the browser sees it, which kills the whole block.
 *
 * Talks to /admin/zara/api/*, mirrored by app-api.js from
 * /api/staff/zara/* — the same handlers the iOS app calls.
 * ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  var C = {
    walnut: "#3E2818", walnutMid: "#5A3B22", walnutLight: "#8B7355",
    gold: "#B8891E", goldBright: "#E0B44E",
    ember: "#F07800", waxRed: "#A02818",
    parchment: "#F5EBD3", parchmentLit: "#FBF3DE", border: "#D4C4A0",
    green: "#166534", muted: "#7B5330",
  };

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", headers: { Accept: "application/json" } };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch("/admin/zara/api" + path, init).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; })
        .then(function (d) {
          if (!r.ok || d.ok === false) throw new Error(d.error || ("HTTP " + r.status));
          return d;
        });
    });
  }

  function h(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "style") e.style.cssText = attrs[k];
        else if (k === "text") e.textContent = attrs[k];
        else if (k === "html") e.innerHTML = attrs[k];
        else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function card(children) {
    return h("div", {
      style: "background:" + C.parchmentLit + ";border:1px solid " + C.border +
             ";border-radius:6px;padding:18px;margin-bottom:16px;",
    }, children);
  }

  function label(text, hint) {
    return h("div", { style: "margin-bottom:6px;" }, [
      h("div", {
        text: text,
        style: "font-family:Cinzel,serif;font-size:11px;letter-spacing:1.4px;color:" +
               C.walnut + ";text-transform:uppercase;",
      }),
      hint ? h("div", {
        text: hint,
        style: "font-size:11px;color:" + C.muted + ";font-style:italic;margin-top:2px;",
      }) : null,
    ]);
  }

  function textarea(value, rows) {
    return h("textarea", {
      rows: rows || 3,
      style: "width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid " + C.border +
             ";border-radius:4px;background:#fff;font-family:inherit;font-size:13px;" +
             "line-height:1.55;color:" + C.walnut + ";resize:vertical;",
    }, [value == null ? "" : String(value)]);
  }

  function input(value) {
    var e = h("input", {
      type: "text",
      style: "width:100%;box-sizing:border-box;padding:8px 11px;border:1px solid " + C.border +
             ";border-radius:4px;background:#fff;font-size:13px;color:" + C.walnut + ";",
    });
    e.value = value == null ? "" : String(value);
    return e;
  }

  function btn(text, onClick, kind) {
    var bg = kind === "danger" ? C.waxRed : kind === "quiet" ? C.parchment : C.walnutMid;
    var fg = kind === "quiet" ? C.walnut : C.parchmentLit;
    return h("button", {
      text: text, onclick: onClick,
      style: "padding:8px 15px;border:1px solid " + (kind === "quiet" ? C.border : "transparent") +
             ";border-radius:4px;background:" + bg + ";color:" + fg +
             ";font-family:Cinzel,serif;font-size:11px;letter-spacing:1.1px;cursor:pointer;",
    });
  }

  function note(text, kind) {
    var col = kind === "bad" ? C.waxRed : kind === "good" ? C.green : C.muted;
    return h("div", {
      text: text,
      style: "font-size:12px;color:" + col + ";margin:8px 0;",
    });
  }

  function heading(text, sub) {
    return h("div", { style: "margin:26px 0 12px 0;" }, [
      h("h2", {
        text: text,
        style: "margin:0;font-family:Cinzel,serif;font-size:15px;letter-spacing:1.6px;color:" + C.walnut + ";",
      }),
      sub ? h("div", {
        text: sub,
        style: "font-size:12px;color:" + C.muted + ";font-style:italic;margin-top:3px;",
      }) : null,
    ]);
  }

  // A list of lines edited as one textarea, one item per line. Ranked
  // lists (goals) keep their order, which is what makes the ranking real.
  function listField(items) {
    return textarea((items || []).join("\n"), Math.max(3, (items || []).length + 1));
  }
  function readList(el) {
    return el.value.split("\n").map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  // ══════════════════════════════════════════════════════════
  //  CHARTER
  // ══════════════════════════════════════════════════════════
  function renderCharter(host) {
    clear(host);
    host.appendChild(note("Loading charter…"));

    api("/charter").then(function (d) {
      clear(host);
      var c = d.charter || {};
      var f = {};

      if (c._degraded) {
        host.appendChild(card([
          h("div", {
            text: "Running on the built-in charter — the database was unreachable: " + c._degraded,
            style: "color:" + C.waxRed + ";font-size:13px;",
          }),
          h("div", {
            text: "Zara still works. Edits saved here will fail until the database is back.",
            style: "color:" + C.muted + ";font-size:12px;margin-top:5px;",
          }),
        ]));
      }

      host.appendChild(h("div", {
        style: "display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;",
      }, [
        h("div", {
          text: "Charter version " + (c._version || 0),
          style: "font-size:12px;color:" + C.muted + ";",
        }),
        h("a", {
          text: "See the prompt this produces →", href: "#", style: "font-size:12px;color:" + C.gold + ";",
          onclick: function (e) { e.preventDefault(); showPrompt(d.surfaces || []); },
        }),
      ]));

      // ── Identity ──
      f.name = input(c.name); f.title = input(c.title);
      f.firm = input(c.firm); f.location = input(c.location);
      f.escalate_to = input(c.escalate_to);
      host.appendChild(heading("Identity", "What she is called and who she works for."));
      host.appendChild(card([
        label("Name"), f.name,
        h("div", { style: "height:12px;" }),
        label("Title"), f.title,
        h("div", { style: "height:12px;" }),
        label("Firm"), f.firm,
        h("div", { style: "height:12px;" }),
        label("Location"), f.location,
        h("div", { style: "height:12px;" }),
        label("Escalate to", "The human she hands judgment calls to, by name."),
        f.escalate_to,
      ]));

      // ── Purpose ──
      f.purpose = textarea(c.purpose, 4);
      host.appendChild(heading("Purpose", "Why she exists. This is the first thing the model reads."));
      host.appendChild(card([f.purpose]));

      // ── Goals ──
      f.goals = listField(c.goals);
      host.appendChild(heading("Goals, in priority order",
        "One per line. The order is load-bearing: the prompt tells her that when two goals conflict, the higher one wins."));
      host.appendChild(card([f.goals]));

      // ── Values ──
      f.values = listField(c.values);
      host.appendChild(heading("How she works", "One per line. Working habits, not rules."));
      host.appendChild(card([f.values]));

      // ── Voice ──
      f.voice = textarea(c.voice, 4);
      host.appendChild(heading("Voice", "How she sounds. Be specific — 'professional' tells the model nothing."));
      host.appendChild(card([f.voice]));

      // ── Learning goal ──
      f.learning_goal = textarea(c.learning_goal, 3);
      host.appendChild(heading("Learning goal", "What getting better is supposed to mean here."));
      host.appendChild(card([f.learning_goal]));

      // ── Boundaries (read-only) ──
      host.appendChild(heading("Absolute boundaries",
        "Not editable from this page, by design. These are compiled into the code and carried verbatim in every prompt, on every surface. A charter edit cannot weaken them and neither can a learned lesson — an agent that could rewrite its own confidentiality rule is a bar complaint waiting to happen. Changing these takes a deploy and a code review."));
      host.appendChild(card((d.boundaries || []).map(function (b) {
        return h("div", {
          text: "· " + b,
          style: "font-size:12.5px;line-height:1.6;color:" + C.walnut +
                 ";padding:6px 0;border-bottom:1px solid " + C.border + ";",
        });
      })));

      // ── Save ──
      var noteField = input("");
      var status = h("div", { style: "font-size:12px;margin-top:8px;" });
      host.appendChild(card([
        label("What changed?", "Written into the version history next to your name."),
        noteField,
        h("div", { style: "height:12px;" }),
        btn("Save charter", function () {
          clear(status);
          status.appendChild(note("Saving…"));
          api("/charter", {
            method: "PUT",
            body: {
              note: noteField.value || null,
              charter: {
                name: f.name.value, title: f.title.value,
                firm: f.firm.value, location: f.location.value,
                escalate_to: f.escalate_to.value,
                purpose: f.purpose.value,
                goals: readList(f.goals),
                values: readList(f.values),
                voice: f.voice.value,
                learning_goal: f.learning_goal.value,
              },
            },
          }).then(function (r) {
            clear(status);
            status.appendChild(note("Saved as version " + r.version +
              ". Live on every surface within a minute.", "good"));
          }).catch(function (e) {
            clear(status);
            status.appendChild(note(e.message, "bad"));
          });
        }),
        status,
      ]));

      // ── Version history ──
      var hist = h("div");
      host.appendChild(heading("Version history"));
      host.appendChild(hist);
      api("/charter/history").then(function (r) {
        clear(hist);
        if (!(r.versions || []).length) {
          hist.appendChild(note("No saved versions yet — Zara is running on the charter built into the code."));
          return;
        }
        hist.appendChild(card(r.versions.map(function (v) {
          return h("div", {
            style: "display:flex;gap:12px;align-items:baseline;padding:6px 0;border-bottom:1px solid " +
                   C.border + ";font-size:12.5px;",
          }, [
            h("span", {
              text: "v" + v.version + (v.active ? " · live" : ""),
              style: "font-family:Cinzel,serif;min-width:80px;color:" +
                     (v.active ? C.green : C.muted) + ";",
            }),
            h("span", { text: v.note || "(no note)", style: "flex:1;color:" + C.walnut + ";" }),
            h("span", {
              text: (v.edited_by || "—") + " · " + new Date(v.created_at).toLocaleString(),
              style: "color:" + C.muted + ";font-size:11px;",
            }),
          ]);
        })));
      }).catch(function (e) {
        clear(hist); hist.appendChild(note(e.message, "bad"));
      });
    }).catch(function (e) {
      clear(host);
      host.appendChild(note("Could not load the charter: " + e.message, "bad"));
    });
  }

  // The prompt inspector. When Zara behaves oddly, this is the first
  // place to look: it shows exactly what the model was handed.
  function showPrompt(surfaces) {
    var host = document.querySelector('[data-zara-panel="charter"]');
    if (!host) return;
    var box = document.getElementById("zara-prompt-box");
    if (box) { box.parentNode.removeChild(box); return; }

    box = h("div", { id: "zara-prompt-box", style: "margin:14px 0;" });
    var out = h("pre", {
      style: "white-space:pre-wrap;font-size:11.5px;line-height:1.55;background:#fff;border:1px solid " +
             C.border + ";border-radius:4px;padding:14px;max-height:460px;overflow:auto;color:" + C.walnut + ";",
    });
    var picker = h("select", {
      style: "padding:7px 10px;border:1px solid " + C.border + ";border-radius:4px;background:#fff;font-size:12px;",
    }, (surfaces || []).map(function (s) {
      return h("option", { value: s.key, text: s.label + "  (" + s.key + ")" });
    }));
    function load() {
      out.textContent = "Composing…";
      api("/prompt?surface=" + encodeURIComponent(picker.value)).then(function (r) {
        out.textContent = r.prompt + "\n\n— " + r.chars + " characters —";
      }).catch(function (e) { out.textContent = "Error: " + e.message; });
    }
    picker.addEventListener("change", load);
    box.appendChild(card([
      h("div", { style: "display:flex;gap:10px;align-items:center;margin-bottom:10px;" }, [
        h("span", {
          text: "Prompt for surface:",
          style: "font-family:Cinzel,serif;font-size:11px;letter-spacing:1.3px;color:" + C.walnut + ";",
        }),
        picker,
      ]),
      out,
    ]));
    host.insertBefore(box, host.children[1] || null);
    load();
  }

  // ══════════════════════════════════════════════════════════
  //  LESSONS
  // ══════════════════════════════════════════════════════════
  function renderLessons(host) {
    clear(host);
    host.appendChild(note("Loading lessons…"));

    api("/lessons").then(function (d) {
      clear(host);
      var all = d.lessons || [];
      var proposed = all.filter(function (l) { return l.status === "proposed"; });
      var active = all.filter(function (l) { return l.status === "active"; });
      var rejected = all.filter(function (l) { return l.status === "rejected"; });

      // Add one by hand.
      var text = textarea("", 2);
      var scope = input("global");
      var addStatus = h("div");
      host.appendChild(heading("Teach her something",
        "One sentence, phrased so it applies to the next similar question and not only to this one. It lands as a proposal — approve it below to put it into her prompt."));
      host.appendChild(card([
        text,
        h("div", { style: "height:10px;" }),
        label("Scope", "'global' applies everywhere. A surface key (staff, client, paralegal, voice…) limits it to that surface."),
        scope,
        h("div", { style: "height:12px;" }),
        btn("Propose lesson", function () {
          if (!text.value.trim()) return;
          clear(addStatus);
          api("/lessons", {
            method: "POST",
            body: { lesson: text.value, scope: scope.value || "global" },
          }).then(function () { renderLessons(host); })
            .catch(function (e) { addStatus.appendChild(note(e.message, "bad")); });
        }),
        addStatus,
      ]));

      function row(l, actions) {
        return h("div", {
          style: "padding:11px 0;border-bottom:1px solid " + C.border + ";",
        }, [
          h("div", { text: l.lesson, style: "font-size:13px;line-height:1.55;color:" + C.walnut + ";" }),
          h("div", {
            style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:7px;",
          }, [
            h("span", {
              text: l.scope + " · " + (l.source || "—") + " · " +
                    new Date(l.created_at).toLocaleDateString(),
              style: "font-size:11px;color:" + C.muted + ";",
            }),
          ].concat(actions || [])),
          l.rationale ? h("div", {
            text: l.rationale,
            style: "font-size:11px;color:" + C.muted + ";font-style:italic;margin-top:4px;",
          }) : null,
        ]);
      }

      function act(id, verb, labelText, kind) {
        return btn(labelText, function () {
          api("/lessons/" + id + "/" + verb, { method: "POST" })
            .then(function () { renderLessons(host); })
            .catch(function (e) { alert(e.message); });
        }, kind);
      }

      host.appendChild(heading("Waiting for your review (" + proposed.length + ")",
        "Nothing here is in her prompt yet. This is the gate: Zara proposes, a human decides."));
      host.appendChild(card(proposed.length
        ? proposed.map(function (l) {
            return row(l, [act(l.id, "approve", "Approve", null), act(l.id, "reject", "Reject", "quiet")]);
          })
        : [note("Nothing waiting.")]));

      host.appendChild(heading("In her prompt right now (" + active.length + ")",
        "Injected into every prompt in scope, newest and heaviest first. The prompt carries at most 40 — past that, retire the ones that no longer earn their place."));
      host.appendChild(card(active.length
        ? active.map(function (l) { return row(l, [act(l.id, "retire", "Retire", "quiet")]); })
        : [note("She has not been taught anything yet.")]));

      if (rejected.length) {
        host.appendChild(heading("Rejected (" + rejected.length + ")",
          "Kept so the same bad lesson is not proposed twice without you noticing."));
        host.appendChild(card(rejected.map(function (l) { return row(l, []); })));
      }
    }).catch(function (e) {
      clear(host);
      host.appendChild(note("Could not load lessons: " + e.message, "bad"));
    });
  }

  // ══════════════════════════════════════════════════════════
  //  HEALTH
  // ══════════════════════════════════════════════════════════
  function renderHealth(host) {
    clear(host);
    host.appendChild(note("Loading…"));

    api("/health?hours=168").then(function (d) {
      clear(host);
      var hh = d.health || {};

      host.appendChild(card([
        h("div", {
          style: "display:flex;gap:26px;flex-wrap:wrap;",
        }, [
          h("div", {}, [
            label("Providers, in order"),
            h("div", {
              text: (hh.providers_configured || []).join(" → ") || "none configured",
              style: "font-size:13px;color:" + C.walnut + ";",
            }),
          ]),
          h("div", {}, [
            label("Charter version"),
            h("div", { text: String(hh.charter_version), style: "font-size:13px;color:" + C.walnut + ";" }),
          ]),
          h("div", {}, [
            label("Lessons"),
            h("div", {
              text: Object.keys(hh.lessons || {}).map(function (k) {
                return hh.lessons[k] + " " + k;
              }).join(" · ") || "none",
              style: "font-size:13px;color:" + C.walnut + ";",
            }),
          ]),
        ]),
        hh.charter_degraded
          ? note("Charter is running from code, not the database: " + hh.charter_degraded, "bad")
          : null,
        (hh.providers_configured || []).length < 2
          ? note("Only one provider is configured. Set OPENAI_API_KEY to give Zara a failover when Anthropic is unreachable.", "bad")
          : null,
      ]));

      host.appendChild(heading("Model usage, last 7 days",
        "Which model actually answered. A rising 'fallbacks' number means Anthropic was failing and Zara quietly carried on — worth knowing."));

      var rows = hh.usage || [];
      if (!rows.length) {
        host.appendChild(card([note("No calls recorded yet. Every call through zara-core logs here.")]));
        return;
      }

      var head = ["Provider", "Model", "Tier", "Calls", "Errors", "Fallbacks", "In", "Out", "Avg ms"];
      var table = h("table", { style: "width:100%;border-collapse:collapse;font-size:12.5px;" }, [
        h("thead", {}, [h("tr", {}, head.map(function (t) {
          return h("th", {
            text: t,
            style: "text-align:left;padding:7px 9px;border-bottom:1px solid " + C.border +
                   ";font-family:Cinzel,serif;font-size:10.5px;letter-spacing:1.1px;color:" + C.muted + ";",
          });
        }))]),
        h("tbody", {}, rows.map(function (r) {
          return h("tr", {}, [
            r.provider, r.model, r.tier, r.calls, r.errors, r.fallbacks,
            r.input_tokens, r.output_tokens, r.avg_latency_ms,
          ].map(function (v, i) {
            var bad = (i === 4 && Number(v) > 0) || (i === 5 && Number(v) > 0);
            return h("td", {
              text: v == null ? "—" : String(v),
              style: "padding:7px 9px;border-bottom:1px solid " + C.border +
                     ";color:" + (bad ? C.waxRed : C.walnut) + ";",
            });
          }));
        })),
      ]);
      host.appendChild(card([table]));
    }).catch(function (e) {
      clear(host);
      host.appendChild(note("Could not load health: " + e.message, "bad"));
    });
  }

  // ══════════════════════════════════════════════════════════
  //  MOUNT
  // ══════════════════════════════════════════════════════════
  var PANELS = {
    charter: renderCharter,
    lessons: renderLessons,
    health: renderHealth,
  };

  function draw(host, name) {
    if (!PANELS[name]) return;
    try { PANELS[name](host); }
    catch (e) {
      clear(host);
      host.appendChild(note("Panel '" + name + "' failed: " + e.message, "bad"));
    }
  }

  // The three cards at the top are styled as tabs, so they had better behave
  // like tabs. Server-side they are plain anchors over three stacked sections
  // — which is what you get if this script never loads — and this upgrades
  // them in place: one panel visible at a time, drawn on first view, with the
  // hash kept in sync so a link like /admin/zara#lessons lands in the right
  // place and Back works.
  function wireTabs() {
    var strip = document.querySelector("[data-zara-tabs]");
    var tabs = document.querySelectorAll("[data-zara-tab]");
    if (!strip || !tabs.length) return false;

    var panels = {};
    Object.keys(PANELS).forEach(function (k) {
      panels[k] = document.querySelector('[data-zara-panel="' + k + '"]');
    });
    var drawn = {};

    function show(name, push) {
      if (!panels[name]) name = "charter";
      Object.keys(panels).forEach(function (k) {
        if (!panels[k]) return;
        panels[k].style.display = k === name ? "" : "none";
        panels[k].style.marginTop = "0";
      });
      for (var i = 0; i < tabs.length; i++) {
        var on = tabs[i].getAttribute("data-zara-tab") === name;
        tabs[i].style.background = on ? C.walnutMid : C.parchmentLit;
        tabs[i].style.borderColor = on ? C.walnutMid : C.border;
        var kids = tabs[i].children;
        if (kids[0]) kids[0].style.color = on ? C.parchmentLit : C.walnut;
        if (kids[1]) kids[1].style.color = on ? C.parchment : C.muted;
      }
      if (!drawn[name] && panels[name]) { drawn[name] = true; draw(panels[name], name); }
      if (push && window.history && window.history.replaceState) {
        window.history.replaceState(null, "", "#" + name);
      }
    }

    for (var i = 0; i < tabs.length; i++) {
      (function (el) {
        el.addEventListener("click", function (e) {
          e.preventDefault();
          show(el.getAttribute("data-zara-tab"), true);
        });
      })(tabs[i]);
    }
    window.addEventListener("hashchange", function () {
      show((window.location.hash || "").replace("#", "") || "charter", false);
    });

    show((window.location.hash || "").replace("#", "") || "charter", false);
    return true;
  }

  function mount() {
    // If the tab strip is there, it owns which panel is drawn and when.
    if (wireTabs()) return;
    // Otherwise draw everything — this is also the path the tests take.
    var hosts = document.querySelectorAll("[data-zara-panel]");
    for (var i = 0; i < hosts.length; i++) {
      draw(hosts[i], hosts[i].getAttribute("data-zara-panel"));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  window.ZaraAdmin = { mount: mount, api: api };
})();
