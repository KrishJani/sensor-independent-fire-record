import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const ChevronLeft = (p: IconProps) => (
  <Icon strokeWidth={1.75} {...p}>
    <path d="M10 3.5L5.5 8l4.5 4.5" />
  </Icon>
);

export const ChevronRight = (p: IconProps) => (
  <Icon strokeWidth={1.75} {...p}>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </Icon>
);

export const ChevronDown = (p: IconProps) => (
  <Icon strokeWidth={1.75} {...p}>
    <path d="M4.5 6.25L8 9.75l3.5-3.5" />
  </Icon>
);

export const CalendarIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="2" />
    <path d="M2.25 6.5h11.5M5.25 1.75v2.5M10.75 1.75v2.5" />
  </Icon>
);

export const Plus = (p: IconProps) => (
  <Icon strokeWidth={1.75} {...p}>
    <path d="M8 3.25v9.5M3.25 8h9.5" />
  </Icon>
);

export const Minus = (p: IconProps) => (
  <Icon strokeWidth={1.75} {...p}>
    <path d="M3.25 8h9.5" />
  </Icon>
);

export const LayersIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.25l5.75 3L8 8.25l-5.75-3L8 2.25z" />
    <path d="M2.25 8L8 11l5.75-3" />
    <path d="M2.25 10.75L8 13.75l5.75-3" />
  </Icon>
);

export const CompassNeedle = (p: IconProps) => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" {...p}>
    <path d="M9 2.5l2.4 6.5H6.6L9 2.5z" fill="#ff3b30" />
    <path d="M9 15.5L6.6 9h4.8L9 15.5z" fill="currentColor" opacity="0.5" />
  </svg>
);
