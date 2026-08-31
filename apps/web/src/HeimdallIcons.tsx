/** One authored icon set. 16px grid, 1.5 stroke, currentColor. No emoji anywhere. */
const s = {
  width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
  stroke: "currentColor", strokeWidth: 1.5,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  "aria-hidden": true, focusable: false,
};

export const IconShield = () => (
  <svg {...s}><path d="M8 1.75 13.25 3.5v4.1c0 3.1-2.1 5.4-5.25 6.65C4.85 13 2.75 10.7 2.75 7.6V3.5z" /><path d="m5.9 7.9 1.5 1.5 2.9-3.1" /></svg>
);
export const IconShieldOff = () => (
  <svg {...s}><path d="M8 1.75 13.25 3.5v4.1c0 3.1-2.1 5.4-5.25 6.65C4.85 13 2.75 10.7 2.75 7.6V3.5z" /><path d="M6.1 6.1 9.9 9.9M9.9 6.1 6.1 9.9" /></svg>
);
export const IconFile = () => (
  <svg {...s}><path d="M9 1.75H4.5a.75.75 0 0 0-.75.75v11a.75.75 0 0 0 .75.75h7a.75.75 0 0 0 .75-.75V5z" /><path d="M9 1.75V5h3.25" /></svg>
);
export const IconTerminal = () => (
  <svg {...s}><path d="m3.25 4.5 3 3.5-3 3.5M8.25 11.5h4.5" /></svg>
);
export const IconGlobe = () => (
  <svg {...s}><circle cx="8" cy="8" r="6.25" /><path d="M1.75 8h12.5M8 1.75c1.7 1.9 2.6 4 2.6 6.25S9.7 12.35 8 14.25C6.3 12.35 5.4 10.25 5.4 8S6.3 3.65 8 1.75Z" /></svg>
);
export const IconAlert = () => (
  <svg {...s}><path d="M8 2.6 14.2 13H1.8z" /><path d="M8 6.4v3M8 11.4h.01" /></svg>
);
export const IconArrow = () => (
  <svg {...s}><path d="M3.5 3.5v4a2 2 0 0 0 2 2h7" /><path d="m10 6.75 2.75 2.75L10 12.25" /></svg>
);
export const IconClock = () => (
  <svg {...s}><circle cx="8" cy="8" r="6.25" /><path d="M8 4.5V8l2.25 1.5" /></svg>
);
export const IconEye = () => (
  <svg {...s}><path d="M1.75 8S4.25 3.5 8 3.5 14.25 8 14.25 8 11.75 12.5 8 12.5 1.75 8 1.75 8Z" /><circle cx="8" cy="8" r="1.9" /></svg>
);
export const IconFolder = () => (
  <svg {...s}><path d="M1.75 4.25a1 1 0 0 1 1-1h2.6l1.3 1.5h6.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" /></svg>
);
export const IconSearch = () => (
  <svg {...s}><circle cx="6.9" cy="6.9" r="4.15" /><path d="m12.75 12.75-2.9-2.9" /></svg>
);
export const IconCopy = () => (
  <svg {...s}><rect x="5.5" y="5.5" width="8.75" height="8.75" rx="1.25" /><path d="M3.25 10.25h-.5a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1h7.5a1 1 0 0 1 1 1v.5" /></svg>
);
export const IconRefresh = () => (
  <svg {...s}><path d="M13.25 8a5.25 5.25 0 1 1-1.6-3.78" /><path d="M13.25 2.75V6.5H9.5" /></svg>
);
export const IconStop = () => (
  <svg {...s}><rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1.5" /></svg>
);
export const IconPlay = () => (
  <svg {...s}><path d="M4.25 2.9v10.2a.6.6 0 0 0 .9.52l8.6-5.1a.6.6 0 0 0 0-1.04l-8.6-5.1a.6.6 0 0 0-.9.52Z" /></svg>
);
export const IconChevronRight = () => (
  <svg {...s}><path d="m6 3.5 5 4.5-5 4.5" /></svg>
);
export const IconChevronDown = () => (
  <svg {...s}><path d="m3.5 6 4.5 5 4.5-5" /></svg>
);
export const IconX = () => (
  <svg {...s}><path d="m4 4 8 8M12 4l-8 8" /></svg>
);
export const IconBox = () => (
  <svg {...s}><path d="M2 4.75 8 1.75l6 3v6.5L8 14.25l-6-3z" /><path d="M2 4.75 8 7.75l6-3M8 7.75v6.5" /></svg>
);
export const IconPlus = () => (
  <svg {...s}><path d="M8 3v10M3 8h10" /></svg>
);
export const IconMinus = () => (
  <svg {...s}><path d="M3 8h10" /></svg>
);
export const IconPanel = () => (
  <svg {...s}><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" /><path d="M9.75 2.75v10.5" /></svg>
);
export const IconLoader = () => (
  <svg {...s}><path d="M8 1.75v2.5M8 11.75v2.5M14.25 8h-2.5M4.25 8h-2.5M12.1 12.1l-1.75-1.75M5.65 5.65 3.9 3.9M12.1 3.9l-1.75 1.75M5.65 10.35 3.9 12.1" opacity="0.9" /></svg>
);
