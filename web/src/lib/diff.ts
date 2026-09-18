/**
 * Unified-diff parsing for the evidence pane.
 *
 * The rendering rules this exists to serve:
 *  - +/- are gutter markers, never part of the line's text. Glued to
 *    the content, a "+" in front of a YAML comment renders as "+#" and
 *    reads as a token in the file.
 *  - Both old and new line numbers are kept, so a reviewer can point at
 *    a line in the file and find it.
 *  - Paired -/+ lines get character-level segments, so a threshold edit
 *    highlights "50000" and "25000" rather than two similar lines.
 */

export interface DiffSeg {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  type: "add" | "del" | "ctx" | "hunk";
  oldNo: number | null;
  newNo: number | null;
  content: string;
  segs?: DiffSeg[];
}

export interface DiffFile {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

function pathFrom(line: string): string {
  const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (m) return m[2];
  return line.replace(/^\+\+\+ b?\//, "").trim();
}

/** Longest common prefix/suffix, in code units, avoiding an overlap. */
function commonEdges(a: string, b: string): { pre: number; suf: number } {
  const max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < max - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  return { pre, suf };
}

function segment(oldLine: string, newLine: string): { old: DiffSeg[]; neu: DiffSeg[] } | null {
  if (oldLine === newLine) return null;
  const { pre, suf } = commonEdges(oldLine, newLine);
  const oldMid = oldLine.slice(pre, oldLine.length - suf);
  const newMid = newLine.slice(pre, newLine.length - suf);
  const shared = pre + suf;
  const shorter = Math.min(oldLine.length, newLine.length);
  // If the lines barely overlap, "what changed" is the whole line and
  // highlighting all of it just adds a second background colour.
  if (shorter === 0 || shared / shorter < 0.3) return null;
  const build = (line: string, mid: string): DiffSeg[] => {
    const out: DiffSeg[] = [];
    if (pre) out.push({ text: line.slice(0, pre), changed: false });
    if (mid) out.push({ text: mid, changed: true });
    if (suf) out.push({ text: line.slice(line.length - suf), changed: false });
    return out;
  };
  return { old: build(oldLine, oldMid), neu: build(newLine, newMid) };
}

/** Pairs each run of removals with the additions that replaced it. */
function addWordSegments(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "del") {
      i += 1;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d].type === "del") d += 1;
    let a = d;
    while (a < lines.length && lines[a].type === "add") a += 1;
    const dels = lines.slice(i, d);
    const adds = lines.slice(d, a);
    if (dels.length && dels.length === adds.length) {
      for (let k = 0; k < dels.length; k++) {
        const seg = segment(dels[k].content, adds[k].content);
        if (seg) {
          dels[k].segs = seg.old;
          adds[k].segs = seg.neu;
        }
      }
    }
    i = a > i ? a : i + 1;
  }
}

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of (raw ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: pathFrom(line), lines: [], added: 0, removed: 0 };
      files.push(file);
      continue;
    }
    // `git show` prefixes the commit header; the pane renders that
    // separately, so everything before the first file is skipped.
    if (!file) continue;
    if (/^(index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename |Binary )/.test(line)) continue;

    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      const span = hunk[4] === undefined ? 1 : Number(hunk[4]);
      // "@@ -15,7 +15,7 @@" is git's shorthand, not something an
      // analyst reads. The range it describes is.
      const range = span > 1 ? `lines ${newNo}–${newNo + span - 1}` : `line ${newNo}`;
      const context = hunk[5].trim();
      file.lines.push({ type: "hunk", oldNo: null, newNo: null, content: context ? `${range} · ${context}` : range });
      continue;
    }
    if (line.startsWith("+")) {
      file.lines.push({ type: "add", oldNo: null, newNo: newNo++, content: line.slice(1) });
      file.added += 1;
    } else if (line.startsWith("-")) {
      file.lines.push({ type: "del", oldNo: oldNo++, newNo: null, content: line.slice(1) });
      file.removed += 1;
    } else if (line.startsWith("\\")) {
      continue; // "\ No newline at end of file"
    } else if (line.length || file.lines.length) {
      file.lines.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, content: line.slice(1) });
    }
  }

  for (const f of files) {
    // Trailing blank context line is an artefact of splitting on "\n".
    while (f.lines.length && f.lines[f.lines.length - 1].type === "ctx" && !f.lines[f.lines.length - 1].content) {
      f.lines.pop();
    }
    addWordSegments(f.lines);
  }
  return files.filter((f) => f.lines.length);
}

/** The subject line of a `git show`, when the payload carries one. */
export function commitSubject(raw: string): string | null {
  const lines = (raw ?? "").split("\n");
  const stop = lines.findIndex((l) => l.startsWith("diff --git "));
  const head = (stop === -1 ? lines : lines.slice(0, stop)).map((l) => l.trim()).filter(Boolean);
  const subject = head.find((l) => !/^(commit|Author|Date|Merge):/.test(l));
  return subject ?? null;
}
