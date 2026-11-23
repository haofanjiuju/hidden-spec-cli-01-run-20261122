// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It does all ten sections of SPEC.md: the command line, the output and exit codes, safe paths, format detection,
// three-tier line matching (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches
// (section 8), JSON edits (section 9), and the all-or-nothing write (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under section 3: its line break, its lines, whether it ends with one. */
function splitFile(text: string): { lines: string[]; br: string; eol: boolean } {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const eol = text.endsWith(br);
  if (eol) lines.pop();
  return { lines, br, eol };
}

function joinFile(lines: string[], br: string, eol: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (eol ? br : '');
}

/** Section 5: a line as a tier reads it. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in the file's lines at a tier. */
function occurrences(fileLines: string[], o: string[], tier: number): number[] {
  const res: number[] = [];
  if (o.length === 0) return res;
  const want = o.map((l) => tierKey(l, tier));
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let good = true;
    for (let j = 0; j < o.length; j++) {
      if (tierKey(fileLines[i + j]!, tier) !== want[j]) {
        good = false;
        break;
      }
    }
    if (good) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at least once, with its occurrences, or null. */
function findTier(fileLines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(fileLines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface OldNewLine {
  text: string;
  ctx: boolean;
}

/**
 * Replace the k matched lines at pos by N (section 5). A context line of N is written as the file's own matched
 * line; at tier 2 every other line of N is re-indented from O's first line's leading whitespace to the file's.
 */
function applyReplace(
  fileLines: string[],
  pos: number,
  o: OldNewLine[],
  n: OldNewLine[],
  tier: number,
): string[] {
  const oCtx: number[] = [];
  o.forEach((l, i) => {
    if (l.ctx) oCtx.push(i);
  });
  let nCtxOrd = 0;
  const firstFile = fileLines[pos] ?? '';
  const f = /^[ \t]*/.exec(firstFile)?.[0] ?? '';
  const p0 = o.length > 0 ? o[0]!.text : '';
  const p = /^[ \t]*/.exec(p0)?.[0] ?? '';
  const repl: string[] = n.map((l) => {
    if (l.ctx) {
      const oi = oCtx[nCtxOrd++]!;
      return oi === undefined ? l.text : fileLines[pos + oi]!;
    }
    if (tier === 2) {
      const t = l.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return l.text;
  });
  const out = [...fileLines];
  out.splice(pos, o.length, ...repl);
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  o: OldNewLine[];
  n: OldNewLine[];
  lastCtxOrNewBackslash: boolean;
  lastPlusBackslash: boolean;
  hasPlus: boolean;
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  plusNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function parseDiffPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

/** One hunk body, starting at `start` (the line after the header). Returns the hunk and the next line index. */
function parseHunk(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      i++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  interface Item {
    kind: 'ctx' | 'old' | 'new';
    text: string;
    bs: boolean;
  }
  const items: Item[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) {
      if (items.length > 0) items[items.length - 1]!.bs = true;
      continue;
    }
    if (l === '') items.push({ kind: 'ctx', text: '', bs: false });
    else if (l.startsWith(' ')) items.push({ kind: 'ctx', text: l.slice(1), bs: false });
    else if (l.startsWith('-')) items.push({ kind: 'old', text: l.slice(1), bs: false });
    else items.push({ kind: 'new', text: l.slice(1), bs: false });
  }
  const o: OldNewLine[] = items.filter((x) => x.kind !== 'new').map((x) => ({ text: x.text, ctx: x.kind === 'ctx' }));
  const n: OldNewLine[] = items.filter((x) => x.kind !== 'old').map((x) => ({ text: x.text, ctx: x.kind === 'ctx' }));
  let lastCtxOrNewBackslash = false;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.kind !== 'old') {
      lastCtxOrNewBackslash = items[k]!.bs;
      break;
    }
  }
  let lastPlusBackslash = false;
  let hasPlus = false;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.kind === 'new') {
      lastPlusBackslash = items[k]!.bs;
      hasPlus = true;
      break;
    }
  }
  return { hunk: { a, o, n, lastCtxOrNewBackslash, lastPlusBackslash, hasPlus }, next: i };
}

/** Apply a section's hunks in order to a file's text. `path` names the file for failure lines. */
function applyHunks(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  let { lines, br, eol } = splitFile(content);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const insAt = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = insAt === lines.length;
      const add = h.n.map((x) => x.text);
      lines.splice(insAt, 0, ...add);
      if (atEnd) eol = !h.lastPlusBackslash;
      d += h.n.length;
    } else {
      const found = findTier(lines, h.o.map((x) => x.text), strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const runsToEnd = best + h.o.length === lines.length;
      lines = applyReplace(lines, best, h.o, h.n, found.tier);
      if (runsToEnd) eol = !h.lastCtxOrNewBackslash;
      d += h.n.length - h.o.length;
    }
  }
  return joinFile(lines, br, eol);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const fresh = (): UniSection => ({
    diffOld: null,
    diffNew: null,
    pairOld: null,
    pairNew: null,
    plusNew: null,
    renameFrom: null,
    renameTo: null,
    create: false,
    del: false,
    hunks: [],
  });
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = parseDiffPath(line);
      const newP = parseDiffPath(lines[i + 1]!);
      if (!cur || !inHeader) {
        cur = fresh();
        sections.push(cur);
        inHeader = true;
      }
      cur.pairOld = oldP;
      cur.pairNew = newP;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunk(lines, i + 1, Number(m[1]));
      cur.hunks.push(parsed.hunk);
      inHeader = false;
      i = parsed.next;
      continue;
    }
    if (inHeader && cur) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.plusNew = parseDiffPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((sec) => {
    const oldP = sec.pairOld ?? sec.renameFrom ?? sec.diffOld ?? '';
    const newP = sec.pairNew ?? sec.renameTo ?? sec.plusNew ?? sec.diffNew ?? '';
    const isCreate = oldP === '/dev/null' || sec.create;
    const isDelete = newP === '/dev/null' || sec.del;
    const checkPaths = (): void => {
      const paths: string[] = [];
      if (oldP !== '/dev/null') paths.push(oldP);
      if (newP !== '/dev/null' && newP !== oldP) paths.push(newP);
      for (const p of paths) {
        if (!safe(p)) throw new Fail('unsafe', p);
      }
    };
    if (isCreate) {
      return (tree: Tree) => {
        checkPaths();
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let lastPlusBs = false;
        for (const h of sec.hunks) {
          for (const x of h.n) if (!x.ctx) plus.push(x.text);
          if (h.hasPlus) lastPlusBs = h.lastPlusBackslash;
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBs ? '' : '\n'));
      };
    }
    if (isDelete) {
      return (tree: Tree) => {
        checkPaths();
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
      };
    }
    if (oldP !== newP) {
      return (tree: Tree) => {
        checkPaths();
        const content = tree.get(oldP);
        if (content === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const result = applyHunks(content, sec.hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, result);
        tree.moves.push([oldP, newP]);
      };
    }
    return (tree: Tree) => {
      checkPaths();
      const content = tree.get(oldP);
      if (content === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, applyHunks(content, sec.hunks, strict, oldP));
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep + 1;
      i = rep + 1;
      continue;
    }
    i++;
  }
  return blocks.map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const content = tree.get(b.path);
      if (content === null) throw new Fail('missing', b.path);
      const { lines: fileLines, br, eol } = splitFile(content);
      const found = findTier(fileLines, b.oldLines, strict);
      if (!found) throw new Fail('no-match', b.path);
      if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
      const o = b.oldLines.map((t) => ({ text: t, ctx: false }));
      const n = b.newLines.map((t) => ({ text: t, ctx: false }));
      const out = applyReplace(fileLines, found.occ[0]!, o, n, found.tier);
      tree.now.set(b.path, joinFile(out, br, eol));
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  o: OldNewLine[];
  n: OldNewLine[];
}

type V4aSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

const isV4aSectionStart = (line: string): boolean =>
  line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');

function parseV4aUpdate(
  path: string,
  raw: Array<{ text: string; num: number }>,
  sectionLine: number,
): V4aSection {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  interface Cur {
    anchor: string | null;
    eof: boolean;
    body: Array<{ text: string; num: number }>;
  }
  let cur: Cur | null = null;
  const finish = (c: Cur): V4aChunk => {
    const o: OldNewLine[] = [];
    const n: OldNewLine[] = [];
    for (const b of c.body) {
      const t = b.text;
      if (t === '') {
        o.push({ text: '', ctx: true });
        n.push({ text: '', ctx: true });
      } else if (t.startsWith(' ')) {
        o.push({ text: t.slice(1), ctx: true });
        n.push({ text: t.slice(1), ctx: true });
      } else if (t.startsWith('-')) {
        o.push({ text: t.slice(1), ctx: false });
      } else if (t.startsWith('+')) {
        n.push({ text: t.slice(1), ctx: false });
      }
    }
    return { anchor: c.anchor, eof: c.eof, o, n };
  };
  for (let k = idx; k < raw.length; k++) {
    const { text, num } = raw[k]!;
    if (text.startsWith('@@')) {
      if (cur) chunks.push(finish(cur));
      cur = { anchor: text.slice(2).trim(), eof: false, body: [] };
      continue;
    }
    if (text === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${num}`);
      cur.eof = true;
      chunks.push(finish(cur));
      cur = null;
      continue;
    }
    if (text.startsWith('*** ')) throw new Exit2(`error: parse ${num}`);
    if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (!cur) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${num}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      cur.body.push({ text, num });
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  if (cur) chunks.push(finish(cur));
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
  return { kind: 'update', path, moveTo, chunks };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    const sectionLine = i + 1;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const isAdd = line.startsWith('*** Add File: ');
      const isDel = line.startsWith('*** Delete File: ');
      const prefix = isAdd ? '*** Add File: ' : isDel ? '*** Delete File: ' : '*** Update File: ';
      const path = line.slice(prefix.length).trim();
      const raw: Array<{ text: string; num: number }> = [];
      i++;
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, num: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      if (isAdd) {
        for (const r of raw) {
          if (r.text !== '' && !r.text.startsWith('+')) throw new Exit2(`error: parse ${r.num}`);
        }
        sections.push({ kind: 'add', path, lines: raw.map((r) => (r.text === '' ? '' : r.text.slice(1))) });
      } else if (isDel) {
        for (const r of raw) {
          if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
        }
        sections.push({ kind: 'delete', path });
      } else {
        sections.push(parseV4aUpdate(path, raw, sectionLine));
      }
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => {
    if (s.kind === 'add') {
      return (tree: Tree) => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      };
    }
    if (s.kind === 'delete') {
      return (tree: Tree) => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) === null) throw new Fail('missing', s.path);
        tree.now.set(s.path, null);
      };
    }
    return (tree: Tree) => {
      const paths = s.moveTo === null ? [s.path] : [s.path, s.moveTo];
      for (const p of paths) {
        if (!safe(p)) throw new Fail('unsafe', p);
      }
      const content = tree.get(s.path);
      if (content === null) throw new Fail('missing', s.path);
      if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      let { lines: fileLines, br, eol } = splitFile(content);
      let cursor = 0;
      for (const ch of s.chunks) {
        if (ch.anchor !== null && ch.anchor !== '') {
          let foundIdx = -1;
          const top = strict ? 0 : 2;
          for (let t = 0; t <= top && foundIdx < 0; t++) {
            for (let j = cursor; j < fileLines.length; j++) {
              if (tierKey(fileLines[j]!, t) === tierKey(ch.anchor, t)) {
                foundIdx = j;
                break;
              }
            }
          }
          if (foundIdx < 0) throw new Fail('no-match', s.path);
          cursor = foundIdx + 1;
        }
        if (ch.o.length === 0) {
          const insAt = ch.eof ? fileLines.length : cursor;
          const add = ch.n.map((x) => x.text);
          fileLines.splice(insAt, 0, ...add);
          cursor = insAt + add.length;
        } else {
          const oTexts = ch.o.map((x) => x.text);
          let found: { tier: number; pos: number } | null = null;
          const top = strict ? 0 : 2;
          for (let t = 0; t <= top; t++) {
            const occ = occurrences(fileLines, oTexts, t).filter(
              (p) => p >= cursor && (!ch.eof || p + oTexts.length === fileLines.length),
            );
            if (occ.length > 0) {
              found = { tier: t, pos: occ[0]! };
              break;
            }
          }
          if (!found) throw new Fail('no-match', s.path);
          fileLines = applyReplace(fileLines, found.pos, ch.o, ch.n, found.tier);
          cursor = found.pos + ch.n.length;
        }
      }
      const result = joinFile(fileLines, br, eol);
      if (s.moveTo !== null) {
        tree.now.set(s.path, null);
        tree.now.set(s.moveTo, result);
        tree.moves.push([s.path, s.moveTo]);
      } else {
        tree.now.set(s.path, result);
      }
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 1, 2 and 10: invocation, output, atomicity                  */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...movesBefore);
      fails.push(e);
    }
  }
  if (fails.length > 0)
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()]) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const rows: { key: string; line: string }[] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.original(newP) === null &&
      tree.now.get(oldP) === null &&
      tree.now.get(newP) !== null
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      rOld.add(oldP);
      rNew.add(newP);
    }
  }
  for (const p of changed) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
