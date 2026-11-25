interface TejasMarkProps {
  size?: number;
  className?: string;
}

export function TejasMark({ size = 24, className = '' }: TejasMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect
        x="2"
        y="2"
        width="28"
        height="28"
        rx="7"
        stroke="currentColor"
        strokeWidth="2.2"
      />
      <path
        d="M10 11H22M16 11V22"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="21.5" cy="20.5" r="1.75" fill="currentColor" />
    </svg>
  );
}
