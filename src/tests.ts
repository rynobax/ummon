import type { TestChanges } from "./shared/types.ts";

/**
 * Finds which tests a diff adds, removes and changes, deterministically: test
 * declarations are matched per language with regexes, each one's extent comes
 * from indentation, and a test counts as changed when a diff line lands inside
 * it. A JS `.each` test whose table we can read becomes one test per row, and a
 * row's own lines count as part of that case. No parsing beyond that, so
 * unusual formatting can hide a test.
 */
export function summarizeTests(path: string, before: string | null, after: string | null, patch: string): TestChanges {
  const old = findTests(path, before);
  const now = findTests(path, after);
  const { oldLines, newLines } = changedLines(patch);

  const oldKeys = new Set(old.tests.map((t) => t.key));
  const newKeys = new Set(now.tests.map((t) => t.key));
  const touched = (tests: Test[], lines: Set<number>) =>
    tests.filter((t) => [...lines].some((line) => t.ranges.some(([start, end]) => line >= start && line <= end)));
  const oldGroups = new Set(old.groups.map(keyOf));
  const newGroups = new Set(now.groups.map(keyOf));

  return {
    added: unique(now.tests.filter((t) => !oldKeys.has(t.key))),
    removed: unique(old.tests.filter((t) => !newKeys.has(t.key))),
    changed: unique([
      ...touched(now.tests.filter((t) => oldKeys.has(t.key)), newLines),
      ...touched(old.tests.filter((t) => newKeys.has(t.key)), oldLines),
    ]),
    addedGroups: now.groups.filter((g) => !oldGroups.has(keyOf(g))),
    removedGroups: old.groups.filter((g) => !newGroups.has(keyOf(g))),
  };
}

interface Test {
  /** Enclosing group names, outermost first, then the test's own name. */
  path: string[];
  /** `path` as one string, for comparing tests across the two versions. */
  key: string;
  /** Lines that make up the test, 1-based and inclusive: its block, plus its `.each` row if it has one. */
  ranges: [number, number][];
}

/** A test or group declaration, as one language's syntax finds it. */
interface Declaration {
  name: string;
  /** For `.each` tests with a readable table: one per row. */
  cases?: { title: string; lines: [number, number] }[];
}

interface Syntax {
  /** Each looks at the declaration starting on `lines[i]`, or returns null. */
  group: (lines: string[], i: number) => Declaration | null;
  test: (lines: string[], i: number) => Declaration | null;
}

/** A single-line syntax: only ever looks at the declaration's own line. */
const onLine =
  (match: (line: string) => string | null | undefined) =>
  (lines: string[], i: number): Declaration | null => {
    const name = match(lines[i]);
    return name == null ? null : { name };
  };

const ANNOTATION = /^\s*(@\w|\[\w)/;
const TEST_ANNOTATION = /(^|\s)(@Test|@ParameterizedTest|\[(Test|Fact|Theory|TestMethod|TestCase)\b)/;

const JS_GROUP = /^\s*(?:describe|context|suite)\b/;
const JS_TEST = /^\s*(?:it|test|specify)\b/;

const SYNTAXES: { extensions: RegExp; syntax: Syntax }[] = [
  {
    extensions: /\.(m|c)?(j|t)sx?$/,
    syntax: { group: (lines, i) => jsCall(lines, i, JS_GROUP), test: (lines, i) => jsCall(lines, i, JS_TEST) },
  },
  {
    extensions: /\.py$/,
    syntax: {
      group: onLine((l) => l.match(/^\s*class\s+(Test\w*)/)?.[1]),
      test: onLine((l) => l.match(/^\s*(?:async\s+)?def\s+(test\w*)\s*\(/)?.[1]),
    },
  },
  {
    extensions: /\.go$/,
    syntax: { group: () => null, test: onLine((l) => l.match(/^func\s+((?:Test|Benchmark|Fuzz|Example)\w*)\s*\(/)?.[1]) },
  },
  {
    extensions: /\.rb$/,
    syntax: {
      group: onLine((l) => l.match(/^\s*(?:RSpec\.)?(?:describe|context)\s+(?:(['"])(.*?)\1|([\w:]+))/)?.slice(2).find(Boolean)),
      test: onLine((l) => l.match(/^\s*(?:it|specify|scenario)\s+(['"])(.*?)\1/)?.[2] ?? l.match(/^\s*def\s+(test_\w+)/)?.[1]),
    },
  },
  {
    // JUnit, Kotlin, C# (NUnit/xUnit/MSTest): an attribute line, then the method.
    extensions: /\.(java|kt|cs)$/,
    syntax: {
      group: () => null,
      test: (lines, i) => {
        const l = lines[i];
        const previous = lines.slice(Math.max(0, i - 5), i).filter((p) => p.trim() !== "");
        const kotlin = l.match(/\bfun\s+`?([^`(]+?)`?\s*\(/)?.[1];
        // The method must sit directly under its annotations, or a call a few
        // lines into a test body would read as another test.
        if (!kotlin && ANNOTATION.test(l)) return null;
        const annotations = [];
        for (let k = previous.length - 1; k >= 0 && ANNOTATION.test(previous[k]); k--) annotations.push(previous[k]);
        if (![...annotations, l].some((a) => TEST_ANNOTATION.test(a))) return null;
        const name = kotlin ?? l.match(/\b(\w+)\s*\([^)]*\)\s*(\{|throws\b|$)/)?.[1];
        return name ? { name } : null;
      },
    },
  },
  {
    extensions: /\.swift$/,
    syntax: { group: () => null, test: onLine((l) => l.match(/^\s*func\s+(test\w*)\s*\(/)?.[1]) },
  },
];

function findTests(path: string, content: string | null): { tests: Test[]; groups: string[][] } {
  const syntax = SYNTAXES.find((s) => s.extensions.test(path))?.syntax;
  if (!syntax || content === null) return { tests: [], groups: [] };
  const lines = content.split("\n");
  // A declaration and its block's lines, 1-based and inclusive.
  type Span = Declaration & { start: number; end: number };
  const groups: Span[] = [];
  const tests: Span[] = [];

  lines.forEach((_, i) => {
    const group = syntax.group(lines, i);
    const test = group === null ? syntax.test(lines, i) : null;
    const found = group ?? test;
    if (found === null) return;
    (group !== null ? groups : tests).push({ ...found, start: i + 1, end: blockEnd(lines, i) });
  });

  const enclosing = (start: number, end: number) =>
    groups.filter((g) => g.start < start && g.end >= end).map((g) => g.name);
  return {
    tests: tests.flatMap(({ name, cases, start, end }) => {
      const outer = enclosing(start, end);
      const block: [number, number] = [start, end];
      if (!cases?.length) return [test([...outer, name], [block])];
      return cases.map((c) => test([...outer, c.title], [block, c.lines]));
    }),
    groups: groups.map((g) => [...enclosing(g.start, g.end), g.name]),
  };
}

function test(path: string[], ranges: [number, number][]): Test {
  return { path, key: keyOf(path), ranges };
}

function keyOf(path: string[]): string {
  return path.join("\0");
}

/**
 * The JS test call starting on `lines[i]`, such as `it("name", …)`,
 * `test.only(\n  "name", …)` or `it.each(table)("name %s", …)`. Prettier wraps
 * long names onto the next line, so this reads on past the keyword's line.
 */
function jsCall(lines: string[], i: number, keyword: RegExp): Declaration | null {
  const head = lines[i].match(keyword);
  if (!head) return null;
  const text = lines.slice(i).join("\n");
  const lineAt = (offset: number) => i + 1 + newlinesBefore(text, offset);
  let at = head[0].length;
  let rows: Row[] | undefined;
  const skipSpace = () => {
    while (/\s/.test(text[at] ?? "")) at++;
  };

  // Modifiers: .only, .skip, .concurrent, … and .each(table) or .each`table`.
  for (let modifier; (modifier = text.slice(at).match(/^\s*\.\s*(\w+)/)); ) {
    at += modifier[0].length;
    if (modifier[1] !== "each") continue;
    skipSpace();
    const end = text[at] === "`" ? stringEnd(text, at) : text[at] === "(" ? groupEnd(text, at) : -1;
    if (end < 0) return null;
    rows = text[at] === "`" ? taggedRows(text, at, end, lineAt) : eachRows(lines, i, text, at, end, lineAt);
    at = end + 1;
  }

  skipSpace();
  if (text[at] !== "(") return null;
  at++;
  skipSpace();
  if (!`'"\``.includes(text[at] ?? "x")) return null;
  const end = stringEnd(text, at);
  if (end < 0) return null;
  const name = text.slice(at + 1, end).replace(/\\(.)/g, "$1");
  return { name, cases: rows?.map((row, index) => ({ title: caseTitle(name, row, index), lines: row.lines })) };
}

/** One row of an `.each` table, with its values as display text. */
interface Row {
  /** Positional values, for `%s`-style placeholders. */
  values: string[];
  /** Named values, for `$name` placeholders: object rows and tagged-template columns. */
  fields?: Map<string, string>;
  /** The value taken as the title when the name has no placeholders. */
  first: string;
  lines: [number, number];
}

/**
 * A case's title, filled in the way Jest does: `%s`, `%i`, … take the row's
 * values in order, `$name` its named values, and `%#`/`$#` its index. A name
 * with no placeholders gets the row's first value appended, so cases still read
 * apart.
 */
function caseTitle(template: string, row: Row, index: number): string {
  let used = false;
  let next = 0;
  let title = template.replace(/%([sdifjop#$%])/g, (match, kind: string) => {
    if (kind === "%") return "%";
    used = true;
    if (kind === "#") return String(index);
    if (kind === "$") return String(index + 1);
    return next < row.values.length ? row.values[next++] : match;
  });
  title = title.replace(/\$(#|[A-Za-z_]\w*)/g, (match, key: string) => {
    if (key === "#") return (used = true), String(index);
    if (!row.fields?.has(key)) return match;
    used = true;
    return row.fields.get(key)!;
  });
  return used ? title : `${template} (${row.first})`;
}

/**
 * The rows of `.each(argument)`, where the argument spans `open`–`close` in
 * `text`: an array literal written inline, or a variable holding one, declared
 * in the same file. Anything else (a function call, an import) has no rows we
 * can read.
 */
function eachRows(
  lines: string[],
  i: number,
  text: string,
  open: number,
  close: number,
  lineAt: (offset: number) => number,
): Row[] | undefined {
  const argument = text.slice(open + 1, close);
  const source = argument.trim();
  const start = open + 1 + argument.indexOf(source);
  if (source.startsWith("[")) return arrayRows(text, start, start + source.length - 1, lineAt);
  if (!/^[A-Za-z_$][\w$]*$/.test(source)) return undefined;

  const content = lines.join("\n");
  const contentLineAt = (offset: number) => 1 + newlinesBefore(content, offset);
  // The closest declaration above the test, else the first one in the file.
  const found = [...content.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${source.replace(/\$/g, "\\$")}\\b`, "g"))];
  const declaration = found.filter((m) => contentLineAt(m.index) <= i + 1).at(-1) ?? found[0];
  if (!declaration) return undefined;

  // Past any type annotation, which can hold brackets and `=>`, to the `=`.
  let at = declaration.index + declaration[0].length;
  for (let depth = 0; at < content.length; at++) {
    const skipped = skipLiteral(content, at);
    if (skipped !== at) at = skipped;
    else if ("([{".includes(content[at])) depth++;
    else if (")]}".includes(content[at])) depth--;
    else if (depth === 0 && content[at] === "=" && content[at + 1] !== ">") break;
    else if (depth === 0 && content[at] === ";") return undefined;
  }
  at++;
  while (/\s/.test(content[at] ?? "")) at++;
  if (content[at] !== "[") return undefined;
  const end = groupEnd(content, at);
  return end < 0 ? undefined : arrayRows(content, at, end, contentLineAt);
}

/** The rows of the array literal spanning `open`–`close`: `[[a, …], …]`, `[{ x: a, … }, …]` or `[a, b, …]`. */
function arrayRows(text: string, open: number, close: number, lineAt: (offset: number) => number): Row[] {
  return splitTopLevel(text, open + 1, close).map(({ text: item, at }) => {
    const lines: [number, number] = [lineAt(at), lineAt(at + item.length - 1)];
    if (item.startsWith("[")) {
      const values = splitTopLevel(item, 1, item.length - 1).map((v) => literalText(v.text));
      return { values, first: values[0] ?? "", lines };
    }
    if (item.startsWith("{")) {
      const fields = new Map<string, string>();
      for (const { text: property } of splitTopLevel(item, 1, item.length - 1)) {
        if (property.startsWith("...")) continue;
        const keyEnd = /^['"]/.test(property) ? stringEnd(property, 0) : 0;
        const colon = property.indexOf(":", Math.max(keyEnd, 0));
        const key = literalText(colon < 0 ? property : property.slice(0, colon));
        fields.set(key, literalText(colon < 0 ? property : property.slice(colon + 1)));
      }
      return { values: [literalText(item)], fields, first: [...fields.values()][0] ?? "", lines };
    }
    const value = literalText(item);
    return { values: [value], first: value, lines };
  });
}

/** The rows of a tagged-template table spanning `open`–`close`, named by its header row. */
function taggedRows(text: string, open: number, close: number, lineAt: (offset: number) => number): Row[] {
  const rows: { cells: string[]; at: number }[] = [];
  let at = open + 1;
  for (const line of text.slice(open + 1, close).split("\n")) {
    if (line.trim()) rows.push({ cells: line.split("|").map((cell) => cell.trim()), at });
    at += line.length + 1;
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map(({ cells, at }) => {
    const values = cells.map((cell) => literalText(cell.replace(/^\$\{([\s\S]*)\}$/, "$1")));
    const fields = new Map(header.cells.map((name, k) => [name, values[k] ?? ""]));
    return { values, fields, first: values[0] ?? "", lines: [lineAt(at), lineAt(at)] };
  });
}

/**
 * Top-level comma-separated items in `source` between `from` and `to`
 * (exclusive), with leading comments and whitespace dropped. `at` is where each
 * item's text starts in `source`.
 */
function splitTopLevel(source: string, from: number, to: number): { text: string; at: number }[] {
  const items: { text: string; at: number }[] = [];
  let depth = 0;
  let start = from;
  for (let j = from; j <= to; j++) {
    const skipped = j < to ? skipLiteral(source, j) : j;
    if (skipped !== j) j = skipped;
    else if (j < to && "([{".includes(source[j])) depth++;
    else if (j < to && ")]}".includes(source[j])) depth--;
    else if (j === to || (depth === 0 && source[j] === ",")) {
      const raw = source.slice(start, j);
      const lead = raw.match(/^(\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/)![0].length;
      const text = raw.slice(lead).trimEnd();
      if (text) items.push({ text, at: start + lead });
      start = j + 1;
    }
  }
  return items;
}

/** A string literal's contents; anything else as its source on one line. */
function literalText(source: string): string {
  const text = source.trim();
  if (/^['"`]/.test(text) && stringEnd(text, 0) === text.length - 1) return text.slice(1, -1).replace(/\\(.)/g, "$1");
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

function newlinesBefore(text: string, offset: number): number {
  let count = 0;
  for (let j = text.indexOf("\n"); j >= 0 && j < offset; j = text.indexOf("\n", j + 1)) count++;
  return count;
}

/** If a string or comment starts at `j`, the index of its last character; otherwise `j`. */
function skipLiteral(text: string, j: number): number {
  if (`'"\``.includes(text[j])) {
    const end = stringEnd(text, j);
    return end < 0 ? text.length - 1 : end;
  }
  if (text.startsWith("//", j)) {
    const end = text.indexOf("\n", j);
    return end < 0 ? text.length - 1 : end - 1;
  }
  if (text.startsWith("/*", j)) {
    const end = text.indexOf("*/", j + 2);
    return end < 0 ? text.length - 1 : end + 1;
  }
  return j;
}

/** Index of the quote closing the string literal that opens at `start`, or -1. */
function stringEnd(text: string, start: number): number {
  for (let j = start + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === text[start]) return j;
  }
  return -1;
}

/** Index of the bracket closing the one at `start`, skipping strings, comments and nested brackets, or -1. */
function groupEnd(text: string, start: number): number {
  let depth = 0;
  for (let j = start; j < text.length; j++) {
    const skipped = skipLiteral(text, j);
    if (skipped !== j) j = skipped;
    else if ("([{".includes(text[j])) depth++;
    else if (")]}".includes(text[j]) && --depth === 0) return j;
  }
  return -1;
}

/**
 * The last line of the block declared on line `i`: everything after it that is
 * blank or indented deeper, plus a closing line at the same indentation
 * (`});`, `}`, `end`), so brace and indentation languages both work.
 */
function blockEnd(lines: string[], i: number): number {
  const indent = indentOf(lines[i]);
  let end = i;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === "") continue;
    const depth = indentOf(lines[j]);
    if (depth > indent) {
      end = j;
      continue;
    }
    if (depth === indent && /^\s*([)}\]]|end\b)/.test(lines[j])) end = j;
    break;
  }
  return end + 1;
}

function indentOf(line: string): number {
  return line.match(/^[ \t]*/)![0].replace(/\t/g, "    ").length;
}

/** Old- and new-side line numbers of every removed and added line in a patch. */
function changedLines(patch: string) {
  const oldLines = new Set<number>();
  const newLines = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
    } else if (!inHunk || line.startsWith("\\")) {
      continue;
    } else if (line.startsWith("-")) {
      oldLines.add(oldLine++);
    } else if (line.startsWith("+")) {
      newLines.add(newLine++);
    } else {
      oldLine++;
      newLine++;
    }
  }
  return { oldLines, newLines };
}

/** Each test's path once, in first-seen order. */
function unique(tests: Test[]): string[][] {
  return [...new Map(tests.map((t) => [t.key, t.path])).values()];
}
