import { useMemo } from "react";
import { parseDiff, type DiffLine } from "../lib/diff";

function Line({ line }: { line: DiffLine }) {
  const mark = line.type === "add" ? "+" : line.type === "del" ? "−" : line.type === "hunk" ? "" : "";
  return (
    <div className={`dl ${line.type}`}>
      <span className="gutter" aria-hidden="true">
        <span className="ln">{line.oldNo ?? ""}</span>
        <span className="ln">{line.newNo ?? ""}</span>
        <span className="mark">{mark}</span>
      </span>
      <span className="code">
        {line.segs
          ? line.segs.map((s, i) =>
              s.changed ? (
                <span className="w" key={i}>
                  {s.text}
                </span>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )
          : line.content || " "}
      </span>
    </div>
  );
}

export function DiffView({ diff, emptyLabel }: { diff: string; emptyLabel: string }) {
  const files = useMemo(() => parseDiff(diff), [diff]);

  if (!files.length) {
    return (
      <div className="diff">
        <div className="diff-empty">{emptyLabel}</div>
      </div>
    );
  }

  return (
    <>
      {files.map((file) => (
        <div className="diff" key={file.path}>
          <div className="diff-file">
            <span className="grow" title={file.path}>
              {file.path}
            </span>
            <span className="plus">+{file.added}</span>
            <span className="minus">−{file.removed}</span>
          </div>
          <div className="diff-body" role="region" aria-label={`Diff of ${file.path}`} tabIndex={0}>
            {file.lines.map((line, i) => (
              <Line line={line} key={i} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
