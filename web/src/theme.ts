export type Theme = "dark" | "light";

const KEY = "riskdiff.theme";

/** Dark is the default and the design target. A first visit follows the
 *  OS; after that the analyst's own choice wins and persists. */
export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* private window, blocked storage — fall through to the OS */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* not being able to remember it is not a reason to fail to apply it */
  }
}
