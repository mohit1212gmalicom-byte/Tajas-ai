interface PlanBadgeProps {
  compact?: boolean;
}

export function PlanBadge({ compact = false }: PlanBadgeProps) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-neutral-100 px-2 py-0.5 font-mono text-[11px] font-semibold tracking-wide text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 whitespace-nowrap shrink-0">
      <span>FREE</span>
      {!compact && <span className="font-normal opacity-75">· UNLIMITED</span>}
    </span>
  );
}
