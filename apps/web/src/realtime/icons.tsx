import type { SVGProps } from 'react';

/** Same drawing conventions as components/Icons.tsx (16px grid, 1.5 stroke). */
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

export const InfoIcon = (p: IconProps) => (
  <Icon width={13} height={13} {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v4M8 4.9v.1" />
  </Icon>
);

export const BackIcon = (p: IconProps) => (
  <Icon strokeWidth={1.75} {...p}>
    <path d="M10 3.5L5.5 8l4.5 4.5" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon strokeWidth={1.75} {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

/** Points up; rotate to the direction the wind blows toward. */
export const ArrowIcon = (p: IconProps) => (
  <Icon strokeWidth={1.75} {...p}>
    <path d="M8 13.5V2.75M4.25 6.5L8 2.75l3.75 3.75" />
  </Icon>
);

export const PlayIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 3.25v9.5L12.5 8 5 3.25z" fill="currentColor" />
  </Icon>
);

export const PauseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.25 3.5v9M10.75 3.5v9" strokeWidth={2.25} />
  </Icon>
);

export const StopIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1.25" fill="currentColor" />
  </Icon>
);

export const ChatIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.75 4.25a1.5 1.5 0 0 1 1.5-1.5h7.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5h0a1.25 1.25 0 0 1-1.25-1.25v-5.25z" />
  </Icon>
);

export const SendIcon = (p: IconProps) => (
  <Icon strokeWidth={1.75} {...p}>
    <path d="M8 13V3.25M3.75 7.5L8 3.25l4.25 4.25" />
  </Icon>
);
