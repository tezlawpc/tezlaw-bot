// ============================================================
//  eyecite-bridge.js (subprocess version — SAME SERVICE)
//
//  Calls eyecite_runner.py as a child process. No separate Render
//  web service. No EYECITE_URL env var. Just Python + Node in one box.
//
//  REQUIREMENTS:
//    1. eyecite_runner.py must be in the same directory as this file
//    2. Render build command must install eyecite:
//         npm install && pip install --break-system-packages eyecite==2.6.5
//
//  USAGE:
//    const ec = require("./eyecite-bridge");
//    const cites = await ec.extract("Bush v. Gore, 531 U.S. 98 (2000).");
// ============================================================

const { spawn } = require("child_process");
const path      = require("path");

const RUNNER_PATH = path.join(__dirname, "eyecite_runner.py");
const PYTHON_BIN  = process.env.PYTHON_BIN || "python3";
const TIMEOUT_MS  = 30000;

/**
 * Invoke the Python runner with a JSON request.
 */
function _run(request) {
  return new Promise((resolve, reject) => {
    const py = spawn(PYTHON_BIN, [RUNNER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "", stderr = "";
    let timer = setTimeout(() => {
      py.kill("SIGKILL");
      reject(new Error(`Eyecite subprocess timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    py.stdout.on("data", chunk => stdout += chunk.toString());
    py.stderr.on("data", chunk => stderr += chunk.toString());

    py.on("error", err => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });

    py.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`eyecite_runner exited ${code}: ${stderr || stdout}`));
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error) return reject(new Error(result.error));
        resolve(result);
      } catch (e) {
        reject(new Error(`Invalid JSON from eyecite_runner: ${stdout.substring(0, 500)}`));
      }
    });

    py.stdin.write(JSON.stringify(request));
    py.stdin.end();
  });
}

/** Extract all citations from text. */
async function extract(text, cleanSteps = ["all_whitespace"]) {
  if (!text || !text.trim()) return [];
  return await _run({ action: "extract", text, clean: cleanSteps });
}

/** Resolve short forms / supra / id back to full citations. */
async function resolve(text, cleanSteps = ["all_whitespace"]) {
  if (!text || !text.trim()) return { resolutions: [] };
  return await _run({ action: "resolve", text, clean: cleanSteps });
}

/** Clean text using eyecite's clean_text helper. */
async function clean(text, steps = ["all_whitespace"]) {
  return await _run({ action: "clean", text, clean: steps });
}

/** Health check: verify Python + eyecite are available. */
async function health() {
  try {
    const r = await extract("Test v. Test, 1 U.S. 1 (2000).");
    return Array.isArray(r) && r.length > 0;
  } catch (err) {
    console.error(`[eyecite-bridge] Health check failed: ${err.message}`);
    return false;
  }
}

/** Filter to ONLY full case citations. */
async function extractFullCases(text, cleanSteps = ["all_whitespace"]) {
  const all = await extract(text, cleanSteps);
  return all.filter(c => c.type === "full_case");
}

/**
 * Detect negative-treatment signals by scanning parenthetical text
 * for Bluebook negative phrases.
 */
function classifyTreatment(citations) {
  const NEG = {
    overrules:     /\boverrul(ed|ing|es)\b|\babrogat(ed|ing|es)\b|\bsuperseded by statute\b/i,
    reverses:      /\brevers(ed|ing|es)\b|\bvacat(ed|ing|es)\b/i,
    criticizes:    /\bcriticiz(ed|ing|es)\b|\bcalled into doubt\b|\bquestioned\b/i,
    distinguishes: /\bdistinguish(ed|ing|es)\b|\bdeclin(ed|ing|es) to follow\b/i,
  };
  const POS = {
    positive: /\b(?:re)?affirm(ed|ing|s)\b|\bfollow(ed|ing|s)\b|\breaffirm(ed|ing|s)\b/i,
  };

  return citations.map(c => {
    const par = c.parenthetical || "";
    if (!par) return { ...c, treatment: null };
    for (const [k, rx] of Object.entries(NEG)) {
      if (rx.test(par)) return { ...c, treatment: k };
    }
    for (const [k, rx] of Object.entries(POS)) {
      if (rx.test(par)) return { ...c, treatment: k };
    }
    return { ...c, treatment: "neutral" };
  });
}

module.exports = {
  extract,
  resolve,
  clean,
  health,
  extractFullCases,
  classifyTreatment,
};
