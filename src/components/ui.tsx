import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { TaskStatus } from '@shared/types';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  fullWidth?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-emerald-400 text-emerald-950 hover:bg-emerald-300 active:bg-emerald-500 disabled:bg-emerald-400/40',
  secondary:
    'bg-white/8 text-zinc-100 border border-white/10 hover:bg-white/12 active:bg-white/16',
  ghost: 'bg-transparent text-zinc-300 hover:bg-white/6 active:bg-white/10',
  danger: 'bg-red-500/15 text-red-300 border border-red-500/25 hover:bg-red-500/25',
};

export function Button({
  variant = 'primary',
  loading = false,
  fullWidth = false,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl px-5 text-[15px] font-semibold',
        'transition-colors duration-150 select-none disabled:cursor-not-allowed disabled:opacity-70',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400',
        VARIANTS[variant],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        'size-4 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
    />
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'rounded-3xl border border-white/8 bg-[#101218]/80 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]',
        className,
      )}
    >
      {children}
    </div>
  );
}

const STATUS_STYLES: Record<TaskStatus, { label: string; className: string; dot: string }> = {
  queued: {
    label: 'Queued',
    className: 'bg-white/6 text-zinc-300 border-white/10',
    dot: 'bg-zinc-400',
  },
  running: {
    label: 'Working',
    className: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/25',
    dot: 'bg-emerald-400 animate-pulse',
  },
  succeeded: {
    label: 'Committed',
    className: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/25',
    dot: 'bg-emerald-400',
  },
  failed: {
    label: 'Failed',
    className: 'bg-red-500/10 text-red-300 border-red-500/25',
    dot: 'bg-red-400',
  },
};

export function StatusPill({ status }: { status: TaskStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide uppercase',
        style.className,
      )}
    >
      <span className={cx('size-1.5 rounded-full', style.dot)} />
      {style.label}
    </span>
  );
}

export function Banner({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'warning' | 'info';
  children: ReactNode;
}) {
  const tones = {
    error: 'border-red-500/25 bg-red-500/10 text-red-200',
    warning: 'border-amber-400/25 bg-amber-400/10 text-amber-200',
    info: 'border-white/10 bg-white/5 text-zinc-300',
  } as const;

  return (
    <div className={cx('rounded-2xl border px-4 py-3 text-sm leading-relaxed', tones[tone])}>
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-1 text-[11px] font-semibold tracking-[0.14em] text-zinc-500 uppercase">
      {children}
    </p>
  );
}
