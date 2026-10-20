import type { QuotaView } from '@shared/types';
import { cx } from './ui';

export function QuotaMeter({ quota }: { quota: QuotaView }) {
  const pct = quota.limit > 0 ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0;
  const exhausted = quota.remaining === 0;

  return (
    <div className="flex items-center gap-2.5" title={`Resets at ${quota.resetsAt}`}>
      <div className="flex items-center gap-1" aria-hidden>
        {Array.from({ length: quota.limit }).map((_, index) => (
          <span
            key={index}
            className={cx(
              'h-1.5 w-3.5 rounded-full transition-colors',
              index < quota.used ? 'bg-emerald-400' : 'bg-white/12',
            )}
          />
        ))}
      </div>
      <span
        className={cx(
          'text-[11px] font-semibold tracking-wide',
          exhausted ? 'text-amber-300' : 'text-zinc-400',
        )}
      >
        {quota.remaining}/{quota.limit} today
      </span>
      <span className="sr-only">{pct}% of daily tasks used</span>
    </div>
  );
}
