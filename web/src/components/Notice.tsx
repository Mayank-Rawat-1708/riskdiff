import type { ReactNode } from "react";

export function Notice({
  kind = "info",
  title,
  children,
}: {
  kind?: "info" | "pending" | "error";
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={`notice ${kind}`} role={kind === "error" ? "alert" : undefined}>
      <div className="body">
        <strong>{title}</strong>
        {children}
      </div>
    </div>
  );
}
