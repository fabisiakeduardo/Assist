// Ícones em stroke 1.8, viewBox 24 — alinhados pela viewBox, não por margin.

type P = { size?: number; className?: string };
const S = ({ size = 16, className, children, filled }: P & { children: React.ReactNode; filled?: boolean }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={filled ? "currentColor" : "none"}
    stroke={filled ? "none" : "currentColor"}
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const IconLogo = ({ size = 20 }: P) => (
  <svg width={size} height={size} viewBox="0 0 28 25" fill="none" aria-hidden="true">
    <rect width="28" height="25" rx="6" fill="#0285F7" />
    <path
      d="M8 18.5V6.8c0-.6.7-1 1.2-.6l9.6 11c.4.5-.1 1.3-.7 1.3h-2.2"
      stroke="#fff"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const IconChat = (p: P) => (
  <S {...p}>
    <path d="M21 12a8 8 0 0 1-8 8c-1.4 0-2.7-.35-3.9-.97L4 20l1.05-4.2A8 8 0 1 1 21 12Z" />
  </S>
);

export const IconUser = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20.5c1.5-3.3 4.3-5 7.5-5s6 1.7 7.5 5" />
  </S>
);

export const IconLogout = (p: P) => (
  <S {...p}>
    <path d="M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
    <path d="M10 12h10m0 0-3.5-3.5M20 12l-3.5 3.5" />
  </S>
);

export const IconSend = (p: P) => (
  <S {...p}>
    <path d="M21 3 10.5 13.5M21 3l-7 18-3.5-7.5L3 10l18-7Z" />
  </S>
);

export const IconCheck = (p: P) => (
  <S {...p}>
    <path d="m4.5 12.5 5 5 10-11" />
  </S>
);

export const IconChecks = (p: P) => (
  <S {...p}>
    <path d="m2.5 13 4.5 4.5L15 9" />
    <path d="m12 16.5 1.5 1.5L21.5 9.5" />
  </S>
);

export const IconSearch = (p: P) => (
  <S {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20.5 20.5-4.6-4.6" />
  </S>
);

export const IconDots = (p: P) => (
  <S {...p} filled>
    <circle cx="12" cy="5" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="19" r="1.7" />
  </S>
);

export const IconArrowRight = (p: P) => (
  <S {...p}>
    <path d="M4 12h16m0 0-6-6m6 6-6 6" />
  </S>
);

export const IconEye = (p: P) => (
  <S {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </S>
);

export const IconEyeOff = (p: P) => (
  <S {...p}>
    <path d="M4 4l16 16M9.9 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.4 17.4 0 0 1-3.2 4M6 7.5A16.7 16.7 0 0 0 2.5 12S6 18.5 12 18.5c1.2 0 2.3-.2 3.3-.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </S>
);

export const IconMail = (p: P) => (
  <S {...p}>
    <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
    <path d="m4 7.5 8 6 8-6" />
  </S>
);

export const IconLock = (p: P) => (
  <S {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2.5" />
    <path d="M8 11V8a4 4 0 1 1 8 0v3" />
  </S>
);

export const IconUserPlus = (p: P) => (
  <S {...p}>
    <circle cx="10" cy="8" r="3.5" />
    <path d="M3.5 19.5c1.2-2.8 3.6-4.2 6.5-4.2 1.4 0 2.7.3 3.8 1" />
    <path d="M18.5 14v6M15.5 17h6" />
  </S>
);

export const IconRotate = (p: P) => (
  <S {...p}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6M20 3v4h-4" />
  </S>
);

export const IconX = (p: P) => (
  <S {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </S>
);

export const IconChevronR = (p: P) => (
  <S {...p}>
    <path d="m9 6 6 6-6 6" />
  </S>
);

export const IconTicket = (p: P) => (
  <S {...p}>
    <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h11A2.5 2.5 0 0 1 20 8.5v1.7a2.3 2.3 0 0 0 0 4.4v1.9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-1.9a2.3 2.3 0 0 0 0-4.4V8.5Z" />
    <path d="M13.5 7v2m0 3v2m0 3v1.5" strokeDasharray="1 3" />
  </S>
);

export const IconInfo = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8v.01" />
  </S>
);

export const IconSparkle = (p: P) => (
  <S {...p}>
    <path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.4l-1.9-5.6L4.5 10.9 10.1 9 12 3.5Z" />
    <path d="M19 16.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6Z" />
  </S>
);

export const IconClock = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </S>
);

export const IconPause = (p: P) => (
  <S {...p}>
    <rect x="7" y="5" width="3.5" height="14" rx="1" />
    <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
  </S>
);

export const IconBadge = (p: P) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="11" r="2" />
    <path d="M14.5 10h4M14.5 13h4M7 16.5h10" />
  </S>
);
