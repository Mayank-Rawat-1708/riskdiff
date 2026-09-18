const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" {...P} />
      <path {...P} d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" />
    </svg>
  );
}

export function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...P} d="M20 13.4A8.2 8.2 0 1 1 10.6 4a6.6 6.6 0 0 0 9.4 9.4Z" />
    </svg>
  );
}
