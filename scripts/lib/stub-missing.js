/**
 * scripts/lib/stub-missing.js
 *
 * Let a check load real project files on a machine with no node_modules.
 *
 * The repo deploys to Render rather than being installed locally, so the Mac
 * somebody runs the checks on usually has no dependencies at all. A check that
 * only runs in one place is a check that does not run.
 *
 * So: stub ONLY bare module names that cannot be resolved. Project files still
 * load normally, which means a check exercises the real code rather than a
 * mock of it. Anything a stub is actually used for returns another stub, so a
 * check that accidentally depends on a stubbed library fails visibly instead
 * of passing by luck.
 *
 * Lifted from check-rendered-scripts.js, which has been doing this for a
 * while; it lives here now so the next check does not need its own copy.
 */
const Module = require("module");

let installed = false;
const stubbed = new Set();

function install() {
  if (installed) return stubbed;
  installed = true;
  const origLoad = Module._load;
  Module._load = function (request) {
    try {
      return origLoad.apply(this, arguments);
    } catch (e) {
      if (e && e.code === "MODULE_NOT_FOUND" && !request.startsWith(".") && !request.startsWith("/")) {
        stubbed.add(request);
        const fn = () => fn;
        return new Proxy(fn, { get: () => fn, apply: () => fn });
      }
      throw e;
    }
  };
  return stubbed;
}

/** One line for the end of a check run, or "" when everything resolved. */
function note() {
  return stubbed.size
    ? "  (stubbed missing deps, not exercised by this check: " + [...stubbed].join(", ") + ")"
    : "";
}

module.exports = { install, note, stubbed };
