#!/usr/bin/env node
/**
 * run-all-tests.mjs — sequential test runner for the Continue monorepo.
 *
 * Usage:
 *   node scripts/run-all-tests.mjs              # run all suites (sequential)
 *   node scripts/run-all-tests.mjs --only gui,core-jest
 *   node scripts/run-all-tests.mjs --only core-vitest --filter boardState
 *   node scripts/run-all-tests.mjs --list
 *   node scripts/run-all-tests.mjs --timeout 30 # per-suite timeout in minutes
 *
 * --filter limits each selected suite to matching test files instead of the
 * full suite: passed through as positional file filter (vitest: substring
 * match on the path; jest: regex on the path). Use it for targeted runs —
 * a full suite is a milestone gate, not a per-change gate.
 *
 * Why sequential: some suites have timing-sensitive tests that flake under
 * parallel load (see test-baseline.md, gotcha #6).
 *
 * Output: per-suite logs + report.json in os.tmpdir()/continue-test-report.
 * Exit code 0 when every executed suite passes (skips don't fail the gate).
 *
 * Details: running-tests.md
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPORT_DIR = path.join(os.tmpdir(), "continue-test-report");
const DEFAULT_TIMEOUT_MIN = 20;

/**
 * Suite inventory. Add new suites here — one entry each.
 * runner: "jest" | "vitest" (selects the summary parser)
 * skipReason: suite is always skipped with this explanation
 */
const SUITES = [
  {
    id: "core-jest",
    label: "core (jest)",
    dir: "core",
    cmd: "npm",
    args: ["test"],
    runner: "jest",
  },
  {
    id: "core-vitest",
    label: "core (vitest)",
    dir: "core",
    cmd: "npm",
    args: ["run", "vitest"],
    runner: "vitest",
  },
  {
    id: "gui",
    label: "gui",
    dir: "gui",
    cmd: "npm",
    args: ["test"],
    runner: "vitest",
  },
  {
    id: "config-yaml",
    label: "packages/config-yaml",
    dir: "packages/config-yaml",
    cmd: "npm",
    args: ["test"],
    runner: "jest",
  },
  {
    id: "fetch",
    label: "packages/fetch",
    dir: "packages/fetch",
    cmd: "npm",
    args: ["test"],
    runner: "vitest",
  },
  {
    id: "openai-adapters",
    label: "packages/openai-adapters",
    dir: "packages/openai-adapters",
    cmd: "npx",
    args: ["vitest", "run"],
    runner: "vitest",
  },
  {
    id: "ext-vscode",
    label: "extensions/vscode",
    dir: "extensions/vscode",
    cmd: "npm",
    args: ["test"],
    runner: "vitest",
  },
  {
    id: "cli",
    label: "extensions/cli",
    dir: "extensions/cli",
    cmd: "npm",
    args: ["test"],
    runner: "vitest",
  },
  {
    id: "binary",
    label: "binary",
    dir: "binary",
    skipReason:
      "integration test spawns the built binary (npm run build in binary/ first)",
  },
];

// ---------------------------------------------------------------------------

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function parseSegments(segmentText) {
  // "2 failed | 154 passed | 5 skipped" or "5 failed, 7 skipped, 46 passed, 51 of 58 total"
  const counts = { failed: 0, passed: 0, skipped: 0, todo: 0 };
  for (const seg of segmentText.split(/[|,]/)) {
    const m = seg.trim().match(/^(\d+)\s+(failed|passed|skipped|todo)\b/);
    if (m) counts[m[2]] = Number(m[1]);
  }
  return counts;
}

function parseRunnerOutput(runner, text) {
  const clean = stripAnsi(text);
  const suites = { failed: 0, passed: 0, skipped: 0 };
  const tests = { failed: 0, passed: 0, skipped: 0, todo: 0 };
  let found = false;

  if (runner === "jest") {
    const suiteMatches = [...clean.matchAll(/^Test Suites:\s*(.+)$/gm)];
    const testMatches = [...clean.matchAll(/^Tests:\s*(.+)$/gm)];
    if (suiteMatches.length) {
      Object.assign(
        suites,
        parseSegments(suiteMatches[suiteMatches.length - 1][1]),
      );
      found = true;
    }
    if (testMatches.length) {
      Object.assign(tests, parseSegments(testMatches[testMatches.length - 1][1]));
      found = true;
    }
  } else {
    const suiteMatches = [...clean.matchAll(/Test Files\s+([^\n(]+)\(\d+\)/g)];
    const testMatches = [...clean.matchAll(/^\s*Tests\s+([^\n(]+)\(\d+\)/gm)];
    if (suiteMatches.length) {
      Object.assign(
        suites,
        parseSegments(suiteMatches[suiteMatches.length - 1][1]),
      );
      found = true;
    }
    if (testMatches.length) {
      Object.assign(tests, parseSegments(testMatches[testMatches.length - 1][1]));
      found = true;
    }
  }

  // Failing test names (best effort, capped)
  const failLines = [];
  const mark = runner === "jest" ? "●" : "×";
  for (const line of clean.split("\n")) {
    const t = line.trim();
    if (t.startsWith(mark + " ") && !failLines.includes(t)) failLines.push(t);
    if (failLines.length >= 20) break;
  }

  return { found, suites, tests, failingTests: failLines };
}

function runSuite(suite, logFile, timeoutMin, filter) {
  return new Promise((resolve) => {
    const started = Date.now();
    const logStream = fs.createWriteStream(logFile);
    let timedOut = false;

    // npm needs "--" before args that belong to the wrapped script
    const args = filter
      ? suite.cmd === "npm"
        ? [...suite.args, "--", filter]
        : [...suite.args, filter]
      : suite.args;

    const child = spawn(suite.cmd, args, {
      cwd: path.join(REPO_ROOT, suite.dir),
      shell: true,
      env: {
        ...process.env,
        CI: "true",
        NO_COLOR: "1",
        // A globally set FORCE_COLOR breaks substring assertions on styled
        // terminal output (see test-baseline.md, gotcha #1)
        FORCE_COLOR: "0",
      },
      windowsHide: true,
    });

    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMin * 60_000);

    child.stdout.on("data", (d) => logStream.write(d));
    child.stderr.on("data", (d) => logStream.write(d));

    child.on("error", (err) => {
      clearTimeout(killer);
      logStream.end(() =>
        resolve({ exitCode: -1, timedOut, durationSec: elapsed(), err }),
      );
    });

    const elapsed = () => Math.round((Date.now() - started) / 1000);

    child.on("close", (code) => {
      clearTimeout(killer);
      logStream.end(() =>
        resolve({ exitCode: code ?? -1, timedOut, durationSec: elapsed() }),
      );
    });
  });
}

function fmtCounts({ failed, passed, skipped }) {
  const parts = [`${passed} passed`];
  if (failed) parts.unshift(`${failed} FAILED`);
  if (skipped) parts.push(`${skipped} skipped`);
  return parts.join(", ");
}

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (argv.includes("--help")) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 18).join("\n"));
    return;
  }

  let timeoutMin = DEFAULT_TIMEOUT_MIN;
  const timeoutArg = getArg("--timeout");
  if (timeoutArg && Number(timeoutArg) > 0) timeoutMin = Number(timeoutArg);

  let suites = SUITES;
  if (argv.includes("--list")) {
    for (const s of SUITES) {
      console.log(`${s.id.padEnd(16)} ${s.label}${s.skipReason ? "  [always skipped: " + s.skipReason + "]" : ""}`);
    }
    return;
  }
  const only = getArg("--only");
  if (only) {
    const wanted = new Set(only.split(",").map((s) => s.trim()));
    const unknown = [...wanted].filter((w) => !SUITES.some((s) => s.id === w));
    if (unknown.length) {
      console.error(`Unknown suite id(s): ${unknown.join(", ")} (see --list)`);
      process.exit(2);
    }
    suites = SUITES.filter((s) => wanted.has(s.id));
  }

  const filter = getArg("--filter");

  fs.rmSync(REPORT_DIR, { recursive: true, force: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  console.log(`Report dir: ${REPORT_DIR}`);
  console.log(
    `Running ${suites.length} suite(s) sequentially, timeout ${timeoutMin}min each` +
      (filter ? `, filter "${filter}"` : "") +
      "\n",
  );

  const results = [];
  for (const [i, suite] of suites.entries()) {
    const prefix = `[${i + 1}/${suites.length}] ${suite.label}`;

    if (suite.skipReason) {
      console.log(`- ${prefix}: SKIPPED (${suite.skipReason})`);
      results.push({ id: suite.id, label: suite.label, status: "skipped", reason: suite.skipReason });
      continue;
    }
    if (!fs.existsSync(path.join(REPO_ROOT, suite.dir, "node_modules"))) {
      const reason = `node_modules missing — run 'npm install' in ${suite.dir}/ first`;
      console.log(`- ${prefix}: SKIPPED (${reason})`);
      results.push({ id: suite.id, label: suite.label, status: "skipped", reason });
      continue;
    }

    process.stdout.write(`▶ ${prefix} ... `);
    const logFile = path.join(REPORT_DIR, `${suite.id}.log`);
    const { exitCode, timedOut, durationSec } = await runSuite(
      suite,
      logFile,
      timeoutMin,
      filter,
    );

    const logText = fs.readFileSync(logFile, "utf8");
    const parsed = parseRunnerOutput(suite.runner, logText);
    const failed = exitCode !== 0 || timedOut;
    const status = failed ? "failed" : "passed";

    let line = failed
      ? `FAILED (exit ${exitCode}${timedOut ? ", timeout" : ""})`
      : `ok`;
    if (parsed.found) {
      line += ` — ${fmtCounts(parsed.suites)} suites, ${fmtCounts(parsed.tests)} tests`;
    } else {
      line += " — (no summary found in log)";
    }
    line += ` [${durationSec}s]`;
    console.log(line);

    if (failed && parsed.failingTests.length) {
      for (const t of parsed.failingTests.slice(0, 10)) console.log(`    ${t}`);
      if (parsed.failingTests.length > 10)
        console.log(`    … ${parsed.failingTests.length - 10} more (see log)`);
    }

    results.push({
      id: suite.id,
      label: suite.label,
      status,
      exitCode,
      timedOut,
      durationSec,
      suites: parsed.suites,
      tests: parsed.tests,
      failingTests: parsed.failingTests,
      logFile,
    });
  }

  fs.writeFileSync(
    path.join(REPORT_DIR, "report.json"),
    JSON.stringify({ startedAt: new Date().toISOString(), results }, null, 2),
  );

  console.log("\n===== SUMMARY =====");
  let anyFailed = false;
  for (const r of results) {
    if (r.status === "failed") anyFailed = true;
    const detail =
      r.status === "failed" || r.status === "passed"
        ? `${fmtCounts(r.tests)} tests [${r.durationSec}s]`
        : `skipped (${r.reason})`;
    console.log(`${r.status === "failed" ? "✗" : r.status === "passed" ? "✓" : "-"} ${r.label.padEnd(26)} ${detail}`);
  }
  console.log(`\nLogs + report.json: ${REPORT_DIR}`);
  console.log(anyFailed ? "RESULT: FAILED" : "RESULT: ALL GREEN");
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
