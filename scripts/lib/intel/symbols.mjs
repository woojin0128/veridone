// Veridone intel — fast, dependency-free symbol & import extraction for ~20 languages.
// Regex + light structure tracking (brace depth / indentation). Not a compiler,
// but accurate enough to rank files, outline them with line ranges, and follow
// imports — at thousands of files per second.

import { extOf } from './files.mjs';

const LANG = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js', astro: 'js',
  py: 'py', pyi: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'kt', kts: 'kt', scala: 'java', groovy: 'java', cs: 'cs', fs: 'cs',
  rb: 'rb', php: 'php', swift: 'swift', c: 'c', cc: 'c', cpp: 'c', cxx: 'c', h: 'c', hh: 'c', hpp: 'c', m: 'c', mm: 'c',
  dart: 'dart', ex: 'ex', exs: 'ex', lua: 'lua', sh: 'sh', bash: 'sh', zsh: 'sh', sql: 'sql', proto: 'proto', graphql: 'gql', gql: 'gql',
};

export function languageOf(p) { return LANG[extOf(p)] || null; }

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'new', 'await', 'typeof', 'delete', 'void', 'yield', 'case', 'throw', 'super', 'import', 'export', 'from', 'constructor', 'sizeof', 'elif', 'when', 'match', 'loop', 'unless', 'until', 'foreach', 'using', 'lock', 'fixed', 'checked', 'unchecked', 'defer', 'go', 'select']);

/**
 * @typedef {{name:string, kind:string, line:number, endLine:number, signature:string, exported:boolean, parent:string|null, depth:number}} Sym
 * @typedef {{symbols:Sym[], imports:{spec:string, line:number}[], idents:Map<string,number>, lines:number}} FileInfo
 */

function sig(line, max = 140) {
  let s = line.trim().replace(/\s*\{\s*$/, '').replace(/\s+/g, ' ');
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

/** Remove string/char literals and comments from a line (approximate; keeps length stable-ish). */
function stripLine(line, lang) {
  let out = line.replace(/\\./g, '__');
  out = out.replace(/`[^`]*`|"[^"]*"|'[^']*'/g, (m) => (lang === 'rs' && /^'[^']{2,}/.test(m) ? m : '""'));
  if (lang === 'py' || lang === 'rb' || lang === 'sh' || lang === 'ex') out = out.replace(/#.*$/, '');
  else if (lang === 'lua' || lang === 'sql') out = out.replace(/--.*$/, '');
  else out = out.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
  return out;
}

function braceEnd(lines, start, lang, maxScan = 4000) {
  let depth = 0;
  let seen = false;
  let inBlock = false;
  for (let i = start; i < lines.length && i < start + maxScan; i++) {
    let l = lines[i];
    if (inBlock) { const e = l.indexOf('*/'); if (e < 0) continue; l = l.slice(e + 2); inBlock = false; }
    const bs = l.indexOf('/*');
    if (bs >= 0 && l.indexOf('*/', bs) < 0) { l = l.slice(0, bs); inBlock = true; }
    l = stripLine(l, lang);
    for (const ch of l) {
      if (ch === '{') { depth++; seen = true; } else if (ch === '}') { depth--; if (seen && depth <= 0) return i + 1; }
    }
    if (!seen && i > start + 2 && /;\s*$/.test(l)) return i + 1; // declaration without body
  }
  return seen ? Math.min(lines.length, start + maxScan) : start + 1;
}

function indentEnd(lines, start, indent) {
  let last = start;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const ind = l.length - l.trimStart().length;
    if (ind <= indent && !/^\s*[)\]}]/.test(l) && !/^\s*(#|\/\/)/.test(l)) return last + 1;
    last = i;
  }
  return last + 1;
}

function rubyEnd(lines, start, indent) {
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    const ind = l.length - l.trimStart().length;
    if (/^\s*end\b/.test(l) && ind <= indent) return i + 1;
  }
  return lines.length;
}

const IDENT_STOP = new Set(('the and for not with from this self that true false null none nil undefined return const let var function class def import export default async await new static public private protected void int string bool boolean float double char long short byte object any type interface enum struct impl trait pub mut use mod crate super where let fn match loop while break continue else elif case switch try catch finally throw throws raise except pass lambda yield in is as of do end then begin module require include extends implements package val fun override open data sealed internal func go defer chan map range select interface nil make len cap append string number unknown never readonly keyof typeof instanceof delete void get set constructor props state value values data result results error errors err ctx context req res request response args kwargs options opts config params param item items key keys index idx name names id ids list obj arr str num len count size length path file files dir line lines text msg message event events callback cb fn handler test tests describe expect assert should mock spy todo fixme note log logger console print printf println fmt debug info warn window document global module exports require this'.split(' ')));

/** Extract identifiers used in a file (for cross-file reference ranking). */
export function extractIdents(text) {
  const counts = new Map();
  const re = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;
  let m;
  let n = 0;
  while ((m = re.exec(text)) && n < 200000) {
    n++;
    const w = m[0];
    if (IDENT_STOP.has(w) || IDENT_STOP.has(w.toLowerCase())) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return counts;
}

/**
 * Parse one file.
 * @param {string} relPath
 * @param {string} text
 * @returns {FileInfo}
 */
export function parseFile(relPath, text) {
  const lang = languageOf(relPath);
  const lines = String(text || '').split(/\r?\n/);
  const symbols = [];
  const imports = [];
  if (!lang) return { symbols, imports, idents: new Map(), lines: lines.length };
  const add = (name, kind, i, opts = {}) => {
    if (!name || CONTROL.has(name)) return;
    const endLine = opts.endLine ?? i + 1;
    symbols.push({ name, kind, line: i + 1, endLine, signature: sig(lines[i]), exported: !!opts.exported, parent: opts.parent || null, depth: opts.depth || 0 });
  };

  switch (lang) {
    case 'js': parseJs(lines, add, imports); break;
    case 'py': parsePy(lines, add, imports); break;
    case 'go': parseGo(lines, add, imports); break;
    case 'rs': parseRust(lines, add, imports); break;
    case 'java': case 'kt': case 'cs': parseJvmLike(lines, add, imports, lang); break;
    case 'rb': parseRuby(lines, add, imports); break;
    case 'php': parsePhp(lines, add, imports); break;
    case 'swift': parseSwift(lines, add, imports); break;
    case 'c': parseC(lines, add, imports); break;
    case 'dart': parseDart(lines, add, imports); break;
    case 'ex': parseElixir(lines, add, imports); break;
    case 'lua': parseLua(lines, add); break;
    case 'sh': parseSh(lines, add, imports); break;
    case 'sql': parseSql(lines, add); break;
    case 'proto': case 'gql': parseSchema(lines, add); break;
    default: break;
  }
  return { symbols, imports, idents: extractIdents(text), lines: lines.length };
}

function parseJs(lines, add, imports) {
  const classStack = []; // {name, end, depth}
  let inBlockComment = false;
  let depth = 0; // brace depth at the start of the current line
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineDepth = depth;
    // update depth for the next line
    let scan = raw;
    if (inBlockComment) {
      const e = scan.indexOf('*/');
      if (e < 0) continue;
      scan = scan.slice(e + 2);
      inBlockComment = false;
    }
    const bs = scan.indexOf('/*');
    if (bs >= 0 && scan.indexOf('*/', bs) < 0) { scan = scan.slice(0, bs); inBlockComment = true; }
    const stripped = stripLine(scan, 'js');
    for (const ch of stripped) { if (ch === '{') depth++; else if (ch === '}') depth = Math.max(0, depth - 1); }
    const l = raw;
    if (/^\s*(\/\/|\*)/.test(l)) continue;
    while (classStack.length && i + 1 > classStack[classStack.length - 1].end) classStack.pop();
    let m;
    const reImp = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/g;
    while ((m = reImp.exec(l))) imports.push({ spec: m[2], line: i + 1 });
    const cls = classStack.length ? classStack[classStack.length - 1] : null;
    const topLevel = lineDepth === 0;
    const inClassBody = cls && lineDepth === cls.depth + 1;
    const exported = /^\s*export\b/.test(l);
    if ((topLevel || inClassBody) && (m = /^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(l))) {
      const end = braceEnd(lines, i, 'js');
      add(m[1], 'class', i, { exported, endLine: end, depth: classStack.length });
      classStack.push({ name: m[1], end, depth: lineDepth });
      continue;
    }
    if (topLevel && (m = /^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/.exec(l))) {
      add(m[1], 'function', i, { exported, endLine: braceEnd(lines, i, 'js') });
      continue;
    }
    if ((topLevel || /^\s*declare\b/.test(l)) && (m = /^\s*(?:export\s+)?(?:declare\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(l))) {
      add(m[2], m[1] === 'enum' ? 'enum' : 'type', i, { exported, endLine: m[1] === 'type' && !/\{\s*$/.test(l) ? i + 1 : braceEnd(lines, i, 'js') });
      continue;
    }
    if (topLevel && (m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|\(\s*$|[A-Za-z_$][\w$]*\s*=>|React\.memo|memo\(|forwardRef\(|styled\.|create[A-Z]\w*\()/.exec(l))) {
      add(m[1], 'function', i, { exported, endLine: /[{(]\s*$/.test(l) ? braceEnd(lines, i, 'js') : i + 1 });
      continue;
    }
    if (topLevel && exported && (m = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(l))) {
      add(m[1], 'const', i, { exported: true, endLine: /[{[(]\s*$/.test(l) ? braceEnd(lines, i, 'js') : i + 1 });
      continue;
    }
    if (topLevel && (m = /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/.exec(l))) { add(m[1], 'export', i, { exported: true, endLine: /\{\s*$/.test(l) ? braceEnd(lines, i, 'js') : i + 1 }); continue; }
    if (topLevel && (m = /^([A-Za-z_$][\w$]*)(?:\.prototype)?\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/.exec(l)) && m[1] !== 'module' && m[1] !== 'exports') {
      add(m[2], 'method', i, { parent: m[1], exported: true, endLine: braceEnd(lines, i, 'js'), depth: 1 });
      continue;
    }
    if (inClassBody) {
      // method declarations, including one-line bodies: `query(sql) { return sql; }`
      if ((m = /^\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set|declare)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?\s*(?::\s*[^{=;]+)?\s*(?:\{.*)?$/.exec(l)) && !CONTROL.has(m[1])) {
        add(m[1], 'method', i, { parent: cls.name, endLine: braceEnd(lines, i, 'js'), depth: 1 });
      } else if ((m = /^\s+(?:(?:public|private|protected|static|readonly)\s+)*(#?[A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=]+)?=>/.exec(l))) {
        add(m[1], 'method', i, { parent: cls.name, endLine: braceEnd(lines, i, 'js'), depth: 1 });
      }
    }
  }
}

function parsePy(lines, add, imports) {
  const classStack = []; // {name, indent, end}
  const funcStack = []; // {indent, end}
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const indent = l.length - l.trimStart().length;
    while (classStack.length && (indent <= classStack[classStack.length - 1].indent || i + 1 > classStack[classStack.length - 1].end)) classStack.pop();
    while (funcStack.length && (indent <= funcStack[funcStack.length - 1].indent || i + 1 > funcStack[funcStack.length - 1].end)) funcStack.pop();
    if (funcStack.length && /^\s*(async\s+)?(def|class)\s/.test(l)) continue; // nested inside a function body
    let m;
    if ((m = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/.exec(l))) { for (const s of m[1].split(',')) imports.push({ spec: s.trim(), line: i + 1 }); continue; }
    if ((m = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)/.exec(l))) {
      imports.push({ spec: m[1], line: i + 1, names: m[2].replace(/[()]/g, '').split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean) });
      continue;
    }
    if ((m = /^(\s*)class\s+([A-Za-z_]\w*)/.exec(l))) {
      const end = indentEnd(lines, i, indent);
      add(m[2], 'class', i, { exported: !m[2].startsWith('_') && indent === 0, endLine: end, depth: classStack.length });
      classStack.push({ name: m[2], indent, end });
      continue;
    }
    if ((m = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(l))) {
      const parent = classStack.length ? classStack[classStack.length - 1].name : null;
      if (indent > 0 && !parent) continue; // nested helper function
      const end = indentEnd(lines, i, indent);
      add(m[2], parent ? 'method' : 'function', i, { exported: !m[2].startsWith('_'), parent, endLine: end, depth: parent ? 1 : 0 });
      funcStack.push({ indent, end });
      continue;
    }
    if (indent === 0 && (m = /^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/.exec(l))) add(m[1], 'const', i, { exported: true });
  }
}

function parseGo(lines, add, imports) {
  let inImport = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (/^import\s*\($/.test(l.trim())) { inImport = true; continue; }
    if (inImport) {
      if (/^\s*\)/.test(l)) { inImport = false; continue; }
      if ((m = /"([^"]+)"/.exec(l))) imports.push({ spec: m[1], line: i + 1 });
      continue;
    }
    if ((m = /^import\s+(?:\w+\s+)?"([^"]+)"/.exec(l))) { imports.push({ spec: m[1], line: i + 1 }); continue; }
    if ((m = /^func\s+(?:\(\s*\w*\s*\*?\s*([\w]+)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)\s*[[(]/.exec(l))) {
      add(m[2], m[1] ? 'method' : 'function', i, { exported: /^[A-Z]/.test(m[2]), parent: m[1] || null, endLine: braceEnd(lines, i, 'go'), depth: m[1] ? 1 : 0 });
      continue;
    }
    if ((m = /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface|func|map|chan|\[|\*|\w)/.exec(l))) {
      add(m[1], m[2] === 'interface' ? 'interface' : 'type', i, { exported: /^[A-Z]/.test(m[1]), endLine: /\{\s*$/.test(l) ? braceEnd(lines, i, 'go') : i + 1 });
      continue;
    }
    if ((m = /^(?:const|var)\s+([A-Za-z_]\w*)\b/.exec(l)) && /^[A-Z]/.test(m[1])) add(m[1], 'const', i, { exported: true });
  }
}

function parseRust(lines, add, imports) {
  const implStack = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\/\//.test(l)) continue;
    while (implStack.length && i + 1 > implStack[implStack.length - 1].end) implStack.pop();
    let m;
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:{}*, ]+)/.exec(l))) { imports.push({ spec: m[1].trim(), line: i + 1 }); continue; }
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/.exec(l))) { imports.push({ spec: `mod:${m[1]}`, line: i + 1 }); add(m[1], 'module', i, { exported: /^\s*pub/.test(l) }); continue; }
    if ((m = /^\s*impl(?:<[^>]*>)?\s+(?:([\w:]+)(?:<[^>]*>)?\s+for\s+)?([\w:]+)/.exec(l))) {
      const end = braceEnd(lines, i, 'rs');
      implStack.push({ name: m[2].split('::').pop(), end });
      continue;
    }
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/.exec(l))) {
      const parent = implStack.length ? implStack[implStack.length - 1].name : null;
      add(m[1], parent ? 'method' : 'function', i, { exported: /^\s*pub/.test(l), parent, endLine: braceEnd(lines, i, 'rs'), depth: parent ? 1 : 0 });
      continue;
    }
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|union)\s+([A-Za-z_]\w*)/.exec(l))) {
      add(m[2], m[1] === 'trait' ? 'interface' : 'type', i, { exported: /^\s*pub/.test(l), endLine: /[{(]\s*$/.test(l) ? braceEnd(lines, i, 'rs') : i + 1 });
      continue;
    }
    if ((m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z][A-Z0-9_]*)\s*:/.exec(l))) add(m[1], 'const', i, { exported: /^\s*pub/.test(l) });
  }
}

function parseJvmLike(lines, add, imports, lang) {
  const classStack = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue;
    while (classStack.length && i + 1 > classStack[classStack.length - 1].end) classStack.pop();
    let m;
    if ((m = /^\s*(?:import|using)\s+(?:static\s+)?([\w.*]+)\s*;?/.exec(l)) && !/\(/.test(l)) { imports.push({ spec: m[1], line: i + 1 }); continue; }
    if ((m = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|abstract|final|sealed|static|data|open|partial|inner|enum|annotation|value|record)\s+)*(class|interface|enum|record|object|struct|trait)\s+([A-Za-z_]\w*)/.exec(l))) {
      const end = braceEnd(lines, i, lang);
      add(m[2], m[1] === 'interface' || m[1] === 'trait' ? 'interface' : 'class', i, { exported: !/\bprivate\b/.test(l), endLine: end, depth: classStack.length });
      classStack.push({ name: m[2], end });
      continue;
    }
    if (lang === 'kt' && (m = /^\s*(?:(?:public|private|protected|internal|override|open|suspend|inline|operator|infix|abstract|final)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/.exec(l))) {
      const parent = classStack.length ? classStack[classStack.length - 1].name : null;
      add(m[1], parent ? 'method' : 'function', i, { exported: !/\bprivate\b/.test(l), parent, endLine: /[{=]\s*$/.test(l) || /\{/.test(l) ? braceEnd(lines, i, lang) : i + 1, depth: parent ? 1 : 0 });
      continue;
    }
    if (classStack.length && (m = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|native|default|sealed|new|extern|unsafe|partial)\s+)+[\w<>[\],.?\s]*?\b([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\([^;]*$/.exec(l)) && !CONTROL.has(m[1])) {
      add(m[1], 'method', i, { exported: !/\bprivate\b/.test(l), parent: classStack[classStack.length - 1].name, endLine: braceEnd(lines, i, lang), depth: 1 });
    }
  }
}

function parseRuby(lines, add, imports) {
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*#/.test(l)) continue;
    const indent = l.length - l.trimStart().length;
    while (stack.length && i + 1 > stack[stack.length - 1].end) stack.pop();
    let m;
    if ((m = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/.exec(l))) { imports.push({ spec: m[1], line: i + 1, relative: /require_relative/.test(l) }); continue; }
    if ((m = /^\s*(class|module)\s+([A-Z][\w:]*)/.exec(l))) {
      const end = rubyEnd(lines, i, indent);
      add(m[2], m[1] === 'module' ? 'module' : 'class', i, { exported: true, endLine: end, depth: stack.length });
      stack.push({ name: m[2], end });
      continue;
    }
    if ((m = /^\s*def\s+(self\.)?([A-Za-z_]\w*[?!=]?)/.exec(l))) {
      const parent = stack.length ? stack[stack.length - 1].name : null;
      add(m[2], parent ? 'method' : 'function', i, { exported: true, parent, endLine: /\bend\s*$/.test(l) ? i + 1 : rubyEnd(lines, i, indent), depth: parent ? 1 : 0 });
    }
  }
}

function parsePhp(lines, add, imports) {
  const classStack = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    while (classStack.length && i + 1 > classStack[classStack.length - 1].end) classStack.pop();
    let m;
    if ((m = /^\s*use\s+([\w\\]+)/.exec(l)) && !classStack.length) { imports.push({ spec: m[1], line: i + 1 }); continue; }
    if ((m = /(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/.exec(l))) { imports.push({ spec: m[1], line: i + 1 }); continue; }
    if ((m = /^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/.exec(l))) {
      const end = braceEnd(lines, i, 'php');
      add(m[2], m[1] === 'interface' ? 'interface' : 'class', i, { exported: true, endLine: end });
      classStack.push({ name: m[2], end });
      continue;
    }
    if ((m = /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(/.exec(l))) {
      const parent = classStack.length ? classStack[classStack.length - 1].name : null;
      add(m[1], parent ? 'method' : 'function', i, { exported: !/\bprivate\b/.test(l), parent, endLine: braceEnd(lines, i, 'php'), depth: parent ? 1 : 0 });
    }
  }
}

function parseSwift(lines, add, imports) {
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    while (stack.length && i + 1 > stack[stack.length - 1].end) stack.pop();
    let m;
    if ((m = /^\s*import\s+(\w+)/.exec(l))) { imports.push({ spec: m[1], line: i + 1 }); continue; }
    if ((m = /^\s*(?:(?:public|private|internal|fileprivate|open|final|indirect)\s+)*(class|struct|enum|protocol|extension|actor)\s+([A-Za-z_][\w.]*)/.exec(l))) {
      const end = braceEnd(lines, i, 'swift');
      add(m[2], m[1] === 'protocol' ? 'interface' : m[1] === 'extension' ? 'extension' : 'class', i, { exported: !/\bprivate\b/.test(l), endLine: end });
      stack.push({ name: m[2], end });
      continue;
    }
    if ((m = /^\s*(?:(?:public|private|internal|fileprivate|open|static|class|override|mutating|final|@\w+)\s+)*func\s+([A-Za-z_]\w*)/.exec(l))) {
      const parent = stack.length ? stack[stack.length - 1].name : null;
      add(m[1], parent ? 'method' : 'function', i, { exported: !/\bprivate\b/.test(l), parent, endLine: braceEnd(lines, i, 'swift'), depth: parent ? 1 : 0 });
    }
  }
}

function parseC(lines, add, imports) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(l))) { imports.push({ spec: m[1], line: i + 1, local: l.includes('"') }); continue; }
    if ((m = /^\s*(?:template\s*<[^>]*>\s*)?(class|struct|enum|union|namespace)\s+([A-Za-z_]\w*)\s*(?:final\s*)?(?::[^{;]*)?\{?\s*$/.exec(l))) {
      add(m[2], m[1] === 'namespace' ? 'module' : 'type', i, { exported: true, endLine: braceEnd(lines, i, 'c') });
      continue;
    }
    if (/^[A-Za-z_]/.test(l) && !/;\s*$/.test(l) && (m = /^(?:[\w:*&<>,\s]+?)\b([A-Za-z_][\w:~]*)\s*\([^;]*\)\s*(?:const)?\s*(?:noexcept)?\s*(?:override)?\s*\{?\s*$/.exec(l)) && !CONTROL.has(m[1].split('::').pop())) {
      add(m[1], 'function', i, { exported: !/^static\b/.test(l), endLine: braceEnd(lines, i, 'c') });
    }
  }
}

function parseDart(lines, add, imports) {
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    while (stack.length && i + 1 > stack[stack.length - 1].end) stack.pop();
    let m;
    if ((m = /^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/.exec(l))) { imports.push({ spec: m[1], line: i + 1 }); continue; }
    if ((m = /^\s*(?:abstract\s+|sealed\s+|base\s+|final\s+)*(class|mixin|enum|extension)\s+([A-Za-z_]\w*)/.exec(l))) {
      const end = braceEnd(lines, i, 'dart');
      add(m[2], 'class', i, { exported: !m[2].startsWith('_'), endLine: end });
      stack.push({ name: m[2], end });
      continue;
    }
    if ((m = /^\s*(?:static\s+|external\s+|@override\s+)*(?:[\w<>?,\s]+\s+)?([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:async\s*)?\{?\s*$/.exec(l)) && !CONTROL.has(m[1]) && /[{]\s*$|=>/.test(l)) {
      const parent = stack.length ? stack[stack.length - 1].name : null;
      add(m[1], parent ? 'method' : 'function', i, { exported: !m[1].startsWith('_'), parent, endLine: braceEnd(lines, i, 'dart'), depth: parent ? 1 : 0 });
    }
  }
}

function parseElixir(lines, add, imports) {
  let mod = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^\s*(?:alias|import|use|require)\s+([\w.]+)/.exec(l))) { imports.push({ spec: m[1], line: i + 1 }); continue; }
    if ((m = /^\s*defmodule\s+([\w.]+)/.exec(l))) { mod = m[1]; add(m[1], 'module', i, { exported: true, endLine: lines.length }); continue; }
    if ((m = /^\s*(defp?|defmacrop?)\s+([a-z_]\w*[?!]?)/.exec(l))) add(m[2], 'function', i, { exported: !m[1].endsWith('p'), parent: mod, depth: 1 });
  }
}

function parseLua(lines, add) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(local\s+)?function\s+([\w.:]+)\s*\(/.exec(lines[i]);
    if (m) add(m[2], 'function', i, { exported: !m[1] });
  }
}

function parseSh(lines, add, imports) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^\s*(?:source|\.)\s+([^\s;]+)/.exec(l))) imports.push({ spec: m[1].replace(/["']/g, ''), line: i + 1 });
    if ((m = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/.exec(l))) add(m[1], 'function', i, { exported: true });
  }
}

function parseSql(lines, add) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*create\s+(?:or\s+replace\s+)?(?:temporary\s+|temp\s+)?(table|view|function|procedure|index|trigger|type)\s+(?:if\s+not\s+exists\s+)?([\w."`[\]]+)/i.exec(lines[i]);
    if (m) add(m[2].replace(/[`"[\]]/g, ''), m[1].toLowerCase(), i, { exported: true });
  }
}

function parseSchema(lines, add) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(message|service|enum|rpc|type|input|interface|union|scalar)\s+([A-Za-z_]\w*)/.exec(lines[i]);
    if (m) add(m[2], m[1], i, { exported: true, endLine: /\{\s*$/.test(lines[i]) ? braceEnd(lines, i, 'proto') : i + 1 });
  }
}
