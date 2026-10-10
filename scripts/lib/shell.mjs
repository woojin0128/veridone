// Veridone — POSIX/bash command-line tokenizer and parser.
//
// Produces "simple commands" (argv + assignments + redirections) grouped into
// pipelines, and records every nested command source it finds ($(...), `...`,
// <(...), >(...)) so the guard can analyze what really runs. The parser is
// deliberately lenient: it never throws on malformed input, because a hook that
// crashes is a hook that silently lets everything through.

const META = new Set([';', '&', '|', '<', '>', '(', ')']);
const WS = new Set([' ', '\t', '\r']);
const RESERVED_SKIP = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '{', '}', '!', 'time', 'coproc', '[[', ']]']);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

/**
 * @typedef {{kind:'cmd'|'proc', src:string}} Sub
 * @typedef {{type:'word', value:string, raw:string, quoted:boolean, dynamic:boolean, glob:boolean, tilde:boolean, subs:Sub[]}} Word
 * @typedef {{type:'op', value:string}} Op
 * @typedef {{type:'redir', op:string, fd:number|null, target:Word|null, heredoc?:string, heredocQuoted?:boolean}} Redir
 */

// ---------------------------------------------------------------------------
// Low level scanners
// ---------------------------------------------------------------------------

/** i points just after an opening '(' of $( or <( — returns index of matching ')' or src.length. */
export function scanParen(src, i) {
  let depth = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) return n;
      i = j + 1;
      continue;
    }
    if (c === '"') { i = scanDouble(src, i + 1); continue; }
    if (c === '`') { i = scanBacktick(src, i + 1); continue; }
    if (c === '#' && (i === 0 || WS.has(src[i - 1]) || src[i - 1] === '\n') && src[i - 1] !== '$') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return n;
}

/** i points just after an opening '"' — returns index just after the closing '"'. */
export function scanDouble(src, i) {
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"') return i + 1;
    if (c === '$' && src[i + 1] === '(') { i = scanParen(src, i + 2) + 1; continue; }
    if (c === '$' && src[i + 1] === '{') { i = scanBrace(src, i + 2) + 1; continue; }
    if (c === '`') { i = scanBacktick(src, i + 1); continue; }
    i++;
  }
  return n;
}

/** i points just after an opening '`' — returns index just after the closing '`'. */
export function scanBacktick(src, i) {
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    i++;
  }
  return n;
}

/** i points just after '${' — returns index of matching '}'. */
export function scanBrace(src, i) {
  let depth = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); i = j < 0 ? n : j + 1; continue; }
    if (c === '"') { i = scanDouble(src, i + 1); continue; }
    if (c === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
    if (c === '$' && src[i + 1] === '(') { i = scanParen(src, i + 2) + 1; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return n;
}

function unescapeBacktickBody(body) {
  // Inside backticks, \$ \` \\ are escapes.
  return body.replace(/\\([$`\\])/g, '$1');
}

function ansiC(body) {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (m, e) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }[e] ?? e;
  });
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const REDIR_OPS = ['&>>', '<<<', '<<-', '&>', '>>', '>|', '<>', '<<', '>&', '<&', '<', '>'];
const CTRL_OPS = [';;&', ';;', ';&', '&&', '||', '|&', ';', '&', '|', '(', ')'];

/**
 * @param {string} src
 * @returns {(Word|Op|Redir)[]}
 */
export function tokenize(src) {
  src = String(src ?? '');
  const tokens = [];
  const n = src.length;
  let i = 0;
  /** @type {Redir[]} */
  let pendingHeredocs = [];

  const readHeredocBodies = () => {
    for (const hd of pendingHeredocs) {
      const delim = hd._delim;
      const strip = hd.op === '<<-';
      const lines = [];
      while (i < n) {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        let line = src.slice(i, j);
        i = j < n ? j + 1 : n;
        const cmp = strip ? line.replace(/^\t+/, '') : line;
        if (cmp === delim) break;
        if (strip) line = line.replace(/^\t+/, '');
        lines.push(line);
      }
      hd.heredoc = lines.join('\n');
      delete hd._delim;
    }
    pendingHeredocs = [];
  };

  while (i < n) {
    const c = src[i];
    // line continuation
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '\n') {
      tokens.push({ type: 'op', value: '\n' });
      i++;
      if (pendingHeredocs.length) readHeredocBodies();
      continue;
    }
    if (WS.has(c)) { i++; continue; }
    if (c === '#') {
      // comment (we are at a word boundary here)
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    // fd-prefixed redirection, e.g. 2>&1, 1>>log
    const fdMatch = /^(\d+)(?=[<>])/.exec(src.slice(i, i + 12));
    if (fdMatch) {
      const after = i + fdMatch[1].length;
      const op = REDIR_OPS.find((o) => src.startsWith(o, after) && !o.startsWith('&'));
      if (op) {
        i = after + op.length;
        i = pushRedir(op, Number(fdMatch[1]));
        continue;
      }
    }

    // process substitution <( ... ) / >( ... ) — part of a word
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const w = readWord();
      tokens.push(w);
      continue;
    }

    const redirOp = REDIR_OPS.find((o) => src.startsWith(o, i));
    if (redirOp) {
      i += redirOp.length;
      i = pushRedir(redirOp, null);
      continue;
    }
    const ctrlOp = CTRL_OPS.find((o) => src.startsWith(o, i));
    if (ctrlOp) {
      tokens.push({ type: 'op', value: ctrlOp });
      i += ctrlOp.length;
      continue;
    }
    tokens.push(readWord());
  }
  if (pendingHeredocs.length) {
    // Heredoc without trailing newline: treat rest as body
    for (const hd of pendingHeredocs) { hd.heredoc = hd.heredoc ?? ''; delete hd._delim; }
  }
  return tokens;

  function pushRedir(op, fd) {
    // skip whitespace before target
    while (i < n && WS.has(src[i])) i++;
    let target = null;
    if (i < n && src[i] !== '\n' && !(META.has(src[i]) && !(src[i] === '<' && src[i + 1] === '(') && !(src[i] === '>' && src[i + 1] === '('))) {
      target = readWord();
    } else if ((op === '>&' || op === '<&') && src[i] === '-') {
      target = readWord();
    }
    /** @type {Redir} */
    const r = { type: 'redir', op, fd, target };
    if ((op === '<<' || op === '<<-') && target) {
      r._delim = target.value;
      r.heredocQuoted = target.quoted;
      pendingHeredocs.push(r);
    }
    if (op === '<<<' && target) r.herestring = target.value;
    tokens.push(r);
    return i;
  }

  function readWord() {
    /** @type {Word} */
    const w = { type: 'word', value: '', raw: '', quoted: false, dynamic: false, glob: false, tilde: false, subs: [] };
    const start = i;
    if (src[i] === '~') w.tilde = true;
    while (i < n) {
      const ch = src[i];
      if (WS.has(ch) || ch === '\n') break;
      if ((ch === '<' || ch === '>') && src[i + 1] === '(') {
        const end = scanParen(src, i + 2);
        w.subs.push({ kind: 'proc', src: src.slice(i + 2, end) });
        w.value += src.slice(i, Math.min(end + 1, n));
        w.dynamic = true;
        i = end + 1;
        continue;
      }
      if (META.has(ch)) break;
      if (ch === "'") {
        const j = src.indexOf("'", i + 1);
        const end = j < 0 ? n : j;
        w.value += src.slice(i + 1, end);
        w.quoted = true;
        i = end + 1;
        continue;
      }
      if (ch === '$' && src[i + 1] === "'") {
        let j = i + 2;
        while (j < n && src[j] !== "'") { if (src[j] === '\\') j++; j++; }
        w.value += ansiC(src.slice(i + 2, j));
        w.quoted = true;
        i = j + 1;
        continue;
      }
      if (ch === '"') {
        w.quoted = true;
        i = readDoubleInto(w, i + 1);
        continue;
      }
      if (ch === '`') {
        const end = scanBacktick(src, i + 1);
        const body = src.slice(i + 1, Math.max(i + 1, end - 1));
        w.subs.push({ kind: 'cmd', src: unescapeBacktickBody(body) });
        w.value += src.slice(i, end);
        w.dynamic = true;
        i = end;
        continue;
      }
      if (ch === '$') {
        i = readDollarInto(w, i);
        continue;
      }
      if (ch === '\\') {
        if (i + 1 < n) w.value += src[i + 1];
        w.quoted = w.quoted || false;
        i += 2;
        continue;
      }
      if (ch === '*' || ch === '?' || ch === '[') w.glob = true;
      w.value += ch;
      i++;
    }
    w.raw = src.slice(start, i);
    return w;
  }

  function readDollarInto(w, pos) {
    const nx = src[pos + 1];
    if (nx === '(' && src[pos + 2] === '(') {
      // arithmetic expansion $(( ... ))
      const end = scanParen(src, pos + 2);
      const close = src[end + 1] === ')' ? end + 2 : end + 1;
      w.value += src.slice(pos, close);
      w.dynamic = true;
      return close;
    }
    if (nx === '(') {
      const end = scanParen(src, pos + 2);
      w.subs.push({ kind: 'cmd', src: src.slice(pos + 2, end) });
      w.value += src.slice(pos, Math.min(end + 1, n));
      w.dynamic = true;
      return end + 1;
    }
    if (nx === '{') {
      const end = scanBrace(src, pos + 2);
      const inner = src.slice(pos + 2, end);
      // nested command substitutions inside ${var:-$(cmd)}
      collectSubs(inner, w.subs);
      w.value += src.slice(pos, Math.min(end + 1, n));
      w.dynamic = true;
      return end + 1;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9@*#?$!-]/.exec(src.slice(pos + 1, pos + 128));
    if (m) {
      w.value += '$' + m[0];
      w.dynamic = true;
      return pos + 1 + m[0].length;
    }
    w.value += '$';
    return pos + 1;
  }

  function readDoubleInto(w, pos) {
    while (pos < n) {
      const ch = src[pos];
      if (ch === '\\') {
        const nx = src[pos + 1];
        if (nx === '$' || nx === '`' || nx === '"' || nx === '\\') { w.value += nx; pos += 2; continue; }
        if (nx === '\n') { pos += 2; continue; }
        w.value += ch;
        pos++;
        continue;
      }
      if (ch === '"') return pos + 1;
      if (ch === '`') {
        const end = scanBacktick(src, pos + 1);
        const body = src.slice(pos + 1, Math.max(pos + 1, end - 1));
        w.subs.push({ kind: 'cmd', src: unescapeBacktickBody(body) });
        w.value += src.slice(pos, end);
        w.dynamic = true;
        pos = end;
        continue;
      }
      if (ch === '$') {
        pos = readDollarInto(w, pos);
        continue;
      }
      w.value += ch;
      pos++;
    }
    return pos;
  }
}

/** Collect $(...) and `...` bodies found anywhere in a string (used for ${...} and heredocs). */
export function collectSubs(text, out = []) {
  const s = String(text ?? '');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); i = j < 0 ? s.length : j + 1; continue; }
    if (c === '$' && s[i + 1] === '(' && s[i + 2] !== '(') {
      const end = scanParen(s, i + 2);
      out.push({ kind: 'cmd', src: s.slice(i + 2, end) });
      i = end + 1;
      continue;
    }
    if (c === '`') {
      const end = scanBacktick(s, i + 1);
      out.push({ kind: 'cmd', src: unescapeBacktickBody(s.slice(i + 1, Math.max(i + 1, end - 1))) });
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * @typedef {{argv: Word[], assigns: {name:string, value:string, word:Word}[], redirects: Redir[],
 *   pipelineId:number, pipeIndex:number, background:boolean, connectorBefore:string|null}} SimpleCommand
 */

/**
 * Parse a shell source string into simple commands.
 * @param {string} src
 * @returns {{commands: SimpleCommand[], tokens: any[]}}
 */
export function parse(src) {
  const tokens = tokenize(src);
  /** @type {SimpleCommand[]} */
  const commands = [];
  let pipelineId = 0;
  let pipeIndex = 0;
  let connectorBefore = null;
  let cur = null;
  let skipHeader = false; // `for x in ...` / `select` headers
  let caseState = 0; // 0 none | 1 after `case` until `in` | 2 expecting pattern | 3 in body
  let skipNextWord = false; // after `function`

  const newCmd = () => ({ argv: [], assigns: [], redirects: [], pipelineId, pipeIndex, background: false, connectorBefore });
  const finish = () => {
    if (cur && (cur.argv.length || cur.redirects.length || cur.assigns.length)) commands.push(cur);
    cur = null;
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'op') {
      const v = t.value;
      if (v === '|' || v === '|&') {
        finish();
        pipeIndex++;
        continue;
      }
      if (v === '&') {
        if (cur) cur.background = true;
        finish();
        pipelineId++;
        pipeIndex = 0;
        connectorBefore = '&';
        skipHeader = false;
        continue;
      }
      if (v === ';;' || v === ';&' || v === ';;&') {
        finish();
        pipelineId++;
        pipeIndex = 0;
        if (caseState) caseState = 2;
        continue;
      }
      if (v === '(') {
        // function definition: name ( )
        const prev = tokens[k - 1];
        const next = tokens[k + 1];
        if (cur && cur.argv.length === 1 && prev && prev.type === 'word' && next && next.type === 'op' && next.value === ')') {
          cur = null;
          k++; // skip ')'
          continue;
        }
        finish();
        continue;
      }
      if (v === ')') {
        if (caseState === 2) { cur = null; caseState = 3; continue; }
        finish();
        continue;
      }
      // ; \n && ||
      finish();
      pipelineId++;
      pipeIndex = 0;
      connectorBefore = v === '\n' ? ';' : v;
      skipHeader = false;
      continue;
    }

    if (!cur) cur = newCmd();
    if (t.type === 'redir') {
      cur.redirects.push(t);
      continue;
    }
    // word
    if (skipNextWord) { skipNextWord = false; continue; }
    if (skipHeader) continue;
    if (caseState === 1) {
      if (!t.quoted && t.value === 'in') caseState = 2;
      continue;
    }
    if (caseState === 2) {
      if (!t.quoted && t.value === 'esac') { caseState = 0; cur = null; }
      continue; // pattern words
    }
    if (cur.argv.length === 0) {
      if (!t.quoted && caseState === 3 && t.value === 'esac') { caseState = 0; continue; }
      // NAME=value with an unquoted NAME; the value may be quoted (FOO="a b" cmd).
      if (ASSIGN_RE.test(t.raw)) {
        const eq = t.value.indexOf('=');
        cur.assigns.push({ name: t.value.slice(0, eq).replace(/\+$/, ''), value: t.value.slice(eq + 1), word: t });
        continue;
      }
      if (!t.quoted) {
        if (RESERVED_SKIP.has(t.value)) continue;
        if (t.value === 'for' || t.value === 'select') { skipHeader = true; continue; }
        if (t.value === 'case') { caseState = 1; continue; }
        if (t.value === 'function') { skipNextWord = true; continue; }
      }
    }
    cur.argv.push(t);
  }
  finish();
  return { commands, tokens };
}

/** Convenience: argv values of a simple command. */
export function argvValues(cmd) {
  return cmd.argv.map((w) => w.value);
}

/** All nested command sources referenced by a simple command (words, assignments, redirect targets). */
export function nestedSources(cmd) {
  const out = [];
  for (const w of cmd.argv) for (const s of w.subs) out.push(s);
  for (const a of cmd.assigns) for (const s of a.word.subs) out.push(s);
  for (const r of cmd.redirects) {
    if (r.target) for (const s of r.target.subs) out.push(s);
    if (r.heredoc && !r.heredocQuoted) collectSubs(r.heredoc, out);
  }
  return out;
}
