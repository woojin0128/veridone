// Veridone — condense noisy command output (test runners, builds, installs)
// down to what matters: failures, errors, warnings and the final summary.
// The full raw output is always saved to a log file whose path is included.

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

const IMPORTANT = /\b(error|errors|err!|fail|failed|failing|failure|failures|exception|traceback|panic(ked)?|fatal|assert(ion)?(error)?|expected|received|actual|mismatch|unhandled|uncaught|segmentation fault|timed? ?out|cannot|can't|could not|couldn't|not found|no such file|undefined|refused|denied|unresolved|conflict|deprecat(ed|ion)|warn(ing)?s?|vulnerabilit(y|ies)|E\d{3,5}|TS\d{4})\b|[✕✗✘×❌]|^\s*(FAIL|FAILED|ERROR|ERR|FATAL|E\s{2,}|>\s{3}|-{3,}\s*(Expected|Received))/i;
const SUMMARY = /^\s*(Tests?:|Test Suites?:|Test Files?|Snapshots?:|Time:|Duration|Ran \d+ tests?|OK(\s+\(.*\))?\s*$|FAILED\b|PASSED\b|=+ .*(passed|failed|error|skipped|warnings?).* =+|test result:|Summary|Coverage|All files|✓\s*\d+|\d+ (passing|failing|pending|passed|failed|skipped)|Done in|Finished|BUILD (SUCCESS|FAILED)|Compiled|Build (succeeded|failed)|found \d+ vulnerabilit|added \d+ packages?|up to date|audited \d+|Successfully (installed|built)|ok\s+\S+\s+[\d.]+s|FAIL\s+\S+|\s*Tests\s+\d+|\s*Test Files\s+\d+)/i;
const NOISE = /^\s*(✓|✔|√|PASS\b|PASSED\b|ok\s+\d+|ok\b|\.+\s*$|\.+\s+\[\s*\d+%\]|=== (RUN|PAUSE|CONT)|--- PASS|\s*Compiling\s|\s*Checking\s|\s*Fresh\s|\s*Downloaded?\s|\s*Downloading|\s*Fetching|\s*Installing|\s*Resolving|\s*Building\s|\s*Updating\s|\s*Preparing|\s*Unpacking|\s*Setting up|\s*Collecting|\s*Requirement already satisfied|\s*Using cached|\s*Obtaining|\s*Processing|\s*Stored in directory|npm (WARN|notice|http)|\[\d+\/\d+\]|progress|\d{1,3}%\s|\s*Progress:|\s*Receiving|\s*remote:|test .* \.\.\. ok$|\s*\u001b|^\s*$)/i;
const STACK = /^\s+at\s|^\s+File ".+", line \d+|^\s+\S+\.(go|rs|java|kt|py|rb|js|ts):\d+|^\s*#\d+\s+0x/;

export function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}

/** Resolve carriage-return progress output: keep the text after the last \r on each line. */
function resolveCR(text) {
  return text.split('\n').map((l) => {
    const i = l.lastIndexOf('\r');
    return i >= 0 && i < l.length - 1 ? l.slice(i + 1) : l.replace(/\r$/, '');
  }).join('\n');
}

/**
 * @param {string} text
 * @param {{minChars?:number, targetChars?:number, logPath?:string|null, label?:string}} opts
 * @returns {null | {text:string, before:number, after:number, omitted:number}}
 */
export function condense(text, opts = {}) {
  const minChars = opts.minChars ?? 6000;
  const target = opts.targetChars ?? 3500;
  const raw = String(text || '');
  if (raw.length < minChars) return null;
  const clean = resolveCR(stripAnsi(raw));
  const lines = clean.split('\n');
  const n = lines.length;
  if (n < 40) return null;

  const keep = new Uint8Array(n);
  const HEAD = 6;
  const TAIL = 30;
  for (let i = 0; i < Math.min(HEAD, n); i++) keep[i] = 1;
  for (let i = Math.max(0, n - TAIL); i < n; i++) keep[i] = 1;

  let importantCount = 0;
  let stackRun = 0;
  for (let i = 0; i < n; i++) {
    const l = lines[i];
    if (STACK.test(l)) {
      stackRun++;
      if (stackRun <= 6 && importantCount < 400) keep[i] = 1;
      continue;
    }
    stackRun = 0;
    const imp = IMPORTANT.test(l) && !/^\s*(✓|✔|PASS\b|ok\b)/.test(l);
    const sum = SUMMARY.test(l);
    if (imp || sum) {
      importantCount++;
      if (importantCount > 400) continue;
      const ctx = imp ? 3 : 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + ctx); j++) keep[j] = 1;
    }
  }

  const out = [];
  let omittedLines = 0;
  let i = 0;
  while (i < n) {
    if (keep[i]) { out.push(lines[i]); i++; continue; }
    let j = i;
    let noise = 0;
    while (j < n && !keep[j]) { if (NOISE.test(lines[j])) noise++; j++; }
    const count = j - i;
    omittedLines += count;
    if (count === 1 && lines[i].trim() === '') { i = j; continue; }
    const sample = lines.slice(i, j).find((l) => l.trim()) || '';
    out.push(`… [${count} line${count > 1 ? 's' : ''} omitted${noise >= count * 0.6 ? ', mostly passing/progress output' : ''}${sample ? `, e.g. "${sample.trim().slice(0, 60)}"` : ''}]`);
    i = j;
  }
  // collapse consecutive identical lines
  const collapsed = [];
  for (let k = 0; k < out.length; k++) {
    let r = k;
    while (r + 1 < out.length && out[r + 1] === out[k]) r++;
    if (r > k + 1) { collapsed.push(out[k], `… [previous line repeated ${r - k} more times]`); k = r; } else collapsed.push(out[k]);
  }
  let body = collapsed.join('\n');
  // hard budget: keep the start of the failures and the tail summary
  const budget = Math.max(target * 2, 2000);
  if (body.length > budget) {
    const tailPart = collapsed.slice(-TAIL).join('\n');
    const headRoom = Math.max(800, budget - tailPart.length - 200);
    body = `${body.slice(0, headRoom)}\n… [condensed output truncated]\n${tailPart}`;
  }
  if (body.length > raw.length * 0.8) return null; // not worth it
  const footer = `[Veridone condensed this output: ${raw.length.toLocaleString('en-US')} → ${body.length.toLocaleString('en-US')} chars; ${omittedLines} lines omitted (passing tests/progress). Errors, warnings and the summary are kept.${opts.logPath ? ` Full output: ${opts.logPath}` : ''}]`;
  const textOut = `${body}\n${footer}`;
  return { text: textOut, before: raw.length, after: textOut.length, omitted: omittedLines };
}
