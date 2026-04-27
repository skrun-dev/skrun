// Design system icons — 16px viewBox, 1.5 stroke weight, matched visual weight.
// From Claude Design handoff (shell.jsx).

type IconProps = React.SVGProps<SVGSVGElement>;

export function IconHome(p: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M2 7l6-5 6 5v6.5a1 1 0 01-1 1H9.5V10h-3v4.5H3a1 1 0 01-1-1V7z" />
    </svg>
  );
}

export function IconAgents(p: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M8 1.5L14 4v8l-6 2.5L2 12V4l6-2.5zM8 1.5v13M2 4l6 2.5L14 4" />
    </svg>
  );
}

export function IconRuns(p: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M4 3l8 5-8 5V3z" />
    </svg>
  );
}

export function IconSettings(p: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconBook(p: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M2 2.5h4.5A2 2 0 018.5 4.5V14M14 2.5H9.5A2 2 0 007.5 4.5V14M2 2.5V13h4.5M14 2.5V13H9.5" />
    </svg>
  );
}

export function IconExternal(p: IconProps) {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M5 2H2v8h8V7M7 2h3v3M10 2L5.5 6.5" />
    </svg>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      {...p}
    >
      <path d="M6 2v8M2 6h8" />
    </svg>
  );
}

export function IconPlay(p: IconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="currentColor" {...p}>
      <path d="M3 2l7 4-7 4V2z" />
    </svg>
  );
}

export function IconChevRight(p: IconProps) {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M4.5 2.5L8 6l-3.5 3.5" />
    </svg>
  );
}

export function IconChevDown(p: IconProps) {
  return (
    <svg viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <path d="M2 3.5L4.5 6 7 3.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconChevLeft(p: IconProps) {
  return (
    <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <path d="M6 2L3 5l3 3" />
    </svg>
  );
}

export function IconFilter(p: IconProps) {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M1.5 2h9l-3.5 4.5v3.5L5 11V6.5L1.5 2z" />
    </svg>
  );
}

export function IconCopy(p: IconProps) {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
      <path d="M8 4V2.5A1 1 0 007 1.5H2.5A1 1 0 001.5 2.5V7a1 1 0 001 1H4" />
    </svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M2.5 6.5L5 9l4.5-5.5" />
    </svg>
  );
}

export function IconDots(p: IconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="currentColor" {...p}>
      <circle cx="3" cy="6" r="1" />
      <circle cx="6" cy="6" r="1" />
      <circle cx="9" cy="6" r="1" />
    </svg>
  );
}

export function IconSearch(p: IconProps) {
  return (
    <svg viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <circle cx="5.5" cy="5.5" r="3.5" />
      <path d="M11 11L8.2 8.2" strokeLinecap="round" />
    </svg>
  );
}

export function IconSun(p: IconProps) {
  return (
    <svg
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      {...p}
    >
      <circle cx="7" cy="7" r="2.5" />
      <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.75 2.75l1.06 1.06M10.19 10.19l1.06 1.06M2.75 11.25l1.06-1.06M10.19 3.81l1.06-1.06" />
    </svg>
  );
}

export function IconMoon(p: IconProps) {
  return (
    <svg
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M12.5 8.5A5 5 0 015.5 1.5a5.5 5.5 0 107 7z" />
    </svg>
  );
}

export function IconLock(p: IconProps) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}>
      <rect x="2" y="5" width="8" height="5" rx="1" />
      <path d="M4 5V3.5a2 2 0 014 0V5" />
    </svg>
  );
}

export function IconError(p: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5.5v3M8 10.5h.01" />
    </svg>
  );
}

export function IconClock(p: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5v4l2.5 1.5" />
    </svg>
  );
}

export function IconSpark(p: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      <path d="M8 2v3M8 11v3M2 8h3M11 8h3M3.75 3.75l2 2M10.25 10.25l2 2M3.75 12.25l2-2M10.25 5.75l2-2" />
    </svg>
  );
}
