// Veridone — line diffs: Myers O(ND) with prefix/suffix trimming, plus parsers for
// Claude Code's structuredPatch and git unified diffs.

import { splitLines } from './util.mjs';

/**
 * @typedef {{line:number, text:string}} DLine
 * @typedef {{added:DLine[], removed:DLine[]}} LineDiff
 */

/**
 * Compute added/removed lines between two texts.
 * @param {string|null|undefined} oldText
 * @param {string|null|undefined} newText
 * @param {{maxD?:number}} [opts]
 * @returns {LineDiff}
 */
export function diffLines(oldText, newText, opts = {}) {
  const a = splitLines(oldText || '');
  const b = splitLines(newText || '');
  const added = [];
  const removed = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  if (!midA.length) {
    midB.forEach((t, i) => added.push({ line: start + i + 1, text: t }));
    return { added, removed };
  }
  if (!midB.length) {
    midA.forEach((t, i) => removed.push({ line: start + i + 1, text: t }));
    return { added, removed };
  }
  const script = myers(midA, midB, opts.maxD ?? 4000);
  if (!script) {
    // Too different: fall back to multiset difference (order-insensitive but safe).
    const count = new Map();
    for (const t of midA) count.set(t, (count.get(t) || 0) + 1);
    midB.forEach((t, i) => {
      const c = count.get(t) || 0;
      if (c > 0) count.set(t, c - 1);
      else added.push({ line: start + i + 1, text: t });
    });
    const countB = new Map();
    for (const t of midB) countB.set(t, (countB.get(t) || 0) + 1);
    midA.forEach((t, i) => {
      const c = countB.get(t) || 0;
      if (c > 0) countB.set(t, c - 1);
      else removed.push({ line: start + i + 1, text: t });
    });
    return { added, removed };
  }
  for (const op of script) {
    if (op.type === '+') added.push({ line: start + op.bIndex + 1, text: midB[op.bIndex] });
    else if (op.type === '-') removed.push({ line: start + op.aIndex + 1, text: midA[op.aIndex] });
  }
  return { added, removed };
}

/** Myers shortest edit script. Returns null if D exceeds maxD. */
function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  v.fill(-1);
  v[offset + 1] = 0;
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, a, b, offset, d, v);
      }
    }
  }
  return null;
}

function backtrack(trace, a, b, offset, dFinal, vFinal) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = dFinal; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; }
    if (x === prevX) ops.push({ type: '+', bIndex: prevY });
    else ops.push({ type: '-', aIndex: prevX });
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/**
 * Convert Claude Code's structuredPatch hunks into added/removed lines.
 * @param {{oldStart:number, newStart:number, lines:string[]}[]} hunks
 * @returns {LineDiff}
 */
export function fromStructuredPatch(hunks) {
  const added = [];
  const removed = [];
  for (const h of hunks || []) {
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    for (const l of h.lines || []) {
      const tag = l[0];
      const text = l.slice(1);
      if (tag === '+') { added.push({ line: newLine, text }); newLine++; }
      else if (tag === '-') { removed.push({ line: oldLine, text }); oldLine++; }
      else if (tag === '\\') continue; // "\ No newline at end of file"
      else { oldLine++; newLine++; }
    }
  }
  return { added, removed };
}

/**
 * Parse a git unified diff (e.g. `git diff -U0`) into per-file line diffs.
 * @param {string} text
 * @returns {Map<string, LineDiff & {oldPath:string|null, newPath:string|null, status:'added'|'deleted'|'modified'|'renamed'}>}
 */
export function parseUnifiedDiff(text) {
  const files = new Map();
  let cur = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false; // file headers (---/+++) only occur before the first hunk of a file
  for (const raw of String(text || '').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      cur = { added: [], removed: [], oldPath: m ? m[1] : null, newPath: m ? m[2] : null, status: 'modified' };
      files.set(cur.newPath || cur.oldPath || String(files.size), cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk && raw.startsWith('new file mode')) { cur.status = 'added'; continue; }
    if (!inHunk && raw.startsWith('deleted file mode')) { cur.status = 'deleted'; continue; }
    if (!inHunk && (raw.startsWith('rename from') || raw.startsWith('rename to'))) { cur.status = 'renamed'; continue; }
    if (!inHunk && (raw.startsWith('--- ') || raw.startsWith('+++ '))) {
      if (raw.startsWith('+++ ') && raw !== '+++ /dev/null') {
        const p = raw.slice(4).replace(/^b\//, '');
        if (p !== cur.newPath) {
          files.delete(cur.newPath);
          cur.newPath = p;
          files.set(p, cur);
        }
      }
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) { oldLine = Number(m[1]); newLine = Number(m[2]); inHunk = true; }
      continue;
    }
    if (raw.startsWith('+')) { cur.added.push({ line: newLine, text: raw.slice(1) }); newLine++; continue; }
    if (raw.startsWith('-')) { cur.removed.push({ line: oldLine, text: raw.slice(1) }); oldLine++; continue; }
    if (raw.startsWith(' ')) { oldLine++; newLine++; continue; }
  }
  return files;
}
