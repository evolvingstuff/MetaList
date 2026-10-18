// Runs the whole browser smoke in parallel: `core` (the full smoke's own steps) and every
// focused suite once, several at a time. Each run already has its own server, free ports
// and temporary namespace (browser-smoke.mjs), so runs cannot disturb one another or the
// user's own MetaList.
//
//   node scripts/run-browser-suites.mjs --browser chrome --workers 6
//
// Every output line is prefixed with the seconds since its run started, so slow steps show.
// Exits non-zero when any run failed, after all runs have finished, and prints each failed
// run's log path and last lines.
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {FOCUSED_SUITES} from './browser-suite-names.mjs';

const CORE = 'core';
// The longest runs (from timed runs, 2026-10-18) start first, so no worker is left
// running one of them alone at the end. Only the order depends on this list: a suite
// missing from it still runs, after these.
const SLOWEST_FIRST = ['reference-paste', 'exit-edit-scroll', 'click-caret', 'ai-note-tags', CORE, 'sorted-tabs',
  'delete-warning', 'list-edges', 'editable-embeds'];
// A run that takes longer than this is stuck: it is stopped and reported as failed.
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const MS_PER_SECOND = 1000;
// How many of a failed run's last lines the summary prints.
const FAILURE_TAIL_LINES = 25;
const BROWSERS = ['chrome', 'firefox'];
// Wide enough for the seconds prefix up to 9999.9s, so log lines stay aligned.
const SECONDS_COLUMN_WIDTH = 6;

const {values: options} = parseArgs({options: {browser: {type: 'string'}, workers: {type: 'string'}}});
if (!BROWSERS.includes(options.browser)) throw new Error(`--browser must be one of ${BROWSERS.join(', ')}`);
if (options.workers === undefined || !/^[1-9][0-9]*$/.test(options.workers)) {
  throw new Error('--workers must be a positive whole number (6 suits an 8-core machine)');
}
const workerCount = Number(options.workers);

const directory = await mkdtemp(join(tmpdir(), 'metalist-browser-suites-'));
const startedAt = performance.now();

function seconds(fromMs) {
  return ((performance.now() - fromMs) / MS_PER_SECOND).toFixed(1);
}

// Runs one suite to the end; resolves with its outcome, never rejects.
function runSuite(suite) {
  const logPath = join(directory, `${suite}.log`);
  const log = createWriteStream(logPath);
  const runStartedAt = performance.now();
  const env = {...process.env, BROWSER_TEST_BROWSER: options.browser, BROWSER_TEST_SUITE: suite};
  const child = spawn(process.execPath, ['scripts/browser-smoke.mjs'], {env, stdio: ['ignore', 'pipe', 'pipe']});
  const tail = [];
  let pending = '';
  const write = chunk => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const stamped = `[${seconds(runStartedAt).padStart(SECONDS_COLUMN_WIDTH)}s] ${line}`;
      log.write(`${stamped}\n`);
      tail.push(stamped);
      if (tail.length > FAILURE_TAIL_LINES) tail.shift();
    }
  };
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
  return new Promise(resolve => child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (pending !== '') write('\n');
    log.end();
    resolve({suite, passed: code === 0, code, signal, seconds: seconds(runStartedAt), logPath, tail});
  }));
}

// Runs the suites `workers` at a time, each worker taking the next waiting suite.
async function runAll(suites, workers) {
  const waiting = [...suites];
  const finished = [];
  const worker = async () => {
    while (waiting.length > 0) {
      const result = await runSuite(waiting.shift());
      finished.push(result);
      console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.suite} in ${result.seconds}s (${finished.length}/${suites.length})`);
    }
  };
  await Promise.all(Array.from({length: workers}, worker));
  return finished;
}

const allSuites = [CORE, ...FOCUSED_SUITES];
for (const suite of SLOWEST_FIRST) {
  if (!allSuites.includes(suite)) throw new Error(`SLOWEST_FIRST names an unknown suite: ${suite}`);
}
const suites = [...SLOWEST_FIRST, ...allSuites.filter(suite => !SLOWEST_FIRST.includes(suite))];
console.log(`Running ${suites.length} browser runs in ${options.browser}, ${workerCount} at a time; logs in ${directory}`);
const results = await runAll(suites, workerCount);

const failed = results.filter(result => !result.passed);
const summary = results
  .sort((first, second) => Number(second.seconds) - Number(first.seconds))
  .map(result => `${result.passed ? 'PASS' : 'FAIL'} ${result.suite} ${result.seconds}s`)
  .join('\n');
await writeFile(join(directory, 'summary.txt'), `${summary}\n`);
console.log(`\nAll runs finished in ${seconds(startedAt)}s; slowest first:\n${summary}`);
for (const result of failed) {
  console.log(`\nFAILED ${result.suite} (exit code ${result.code}, signal ${result.signal}), log: ${result.logPath}\n${result.tail.join('\n')}`);
}
if (failed.length > 0) {
  console.log(`\n${failed.length} of ${results.length} runs failed.`);
  process.exitCode = 1;
}
