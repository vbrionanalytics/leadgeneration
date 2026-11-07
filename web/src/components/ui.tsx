import { ReactNode, useEffect } from 'react';
import { X, Loader2 } from 'lucide-react';

/** Lead temperature from score: the product's signature visual. */
export function temperature(score?: number) {
  if (score == null) return { label: 'Unscored', color: '#94A3B8', tone: 'bg-slate-100 text-slate-600' };
  if (score >= 70) return { label: 'Hot', color: 'var(--color-hot)', tone: 'bg-[#FCE7E3] text-[#B23A27]' };
  if (score >= 45) return { label: 'Warm', color: 'var(--color-warm)', tone: 'bg-[#FCF1DE] text-[#93600F]' };
  return { label: 'Cold', color: 'var(--color-cold)', tone: 'bg-[#E6EEFD] text-[#2F5DC0]' };
}

export function ScoreRing({ score, size = 44 }: { score?: number; size?: number }) {
  const t = temperature(score);
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const pct = score == null ? 0 : score / 100;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} title={`${t.label}${score != null ? `, ${score} out of 100` : ''}`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E8ECF1" strokeWidth={4} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={t.color} strokeWidth={4} strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} />
      </svg>
      <span className="absolute inset-0 grid place-items-center font-display font-bold" style={{ fontSize: size * 0.32 }}>
        {score ?? '–'}
      </span>
    </div>
  );
}

export function TempChip({ score }: { score?: number }) {
  const t = temperature(score);
  return <span className={`chip ${t.tone}`}>{t.label}</span>;
}

const STATUS_TONES: Record<string, string> = {
  new: 'bg-slate-100 text-slate-700', qualified: 'bg-teal-50 text-teal-800', contacted: 'bg-indigo-50 text-indigo-700',
  replied: 'bg-violet-50 text-violet-700', won: 'bg-emerald-50 text-emerald-700', lost: 'bg-slate-100 text-slate-500',
  do_not_contact: 'bg-red-50 text-red-700', pending_approval: 'bg-amber-50 text-amber-800', queued: 'bg-indigo-50 text-indigo-700',
  sent: 'bg-emerald-50 text-emerald-700', failed: 'bg-red-50 text-red-700', blocked: 'bg-red-50 text-red-700', rejected: 'bg-slate-100 text-slate-500',
  generating: 'bg-slate-100 text-slate-600', running: 'bg-indigo-50 text-indigo-700', completed: 'bg-emerald-50 text-emerald-700',
  active: 'bg-emerald-50 text-emerald-700', pending_review: 'bg-amber-50 text-amber-800', sold_out: 'bg-slate-100 text-slate-600',
  withdrawn: 'bg-slate-100 text-slate-500', expired: 'bg-slate-100 text-slate-500', cancelled: 'bg-slate-100 text-slate-500',
  done: 'bg-emerald-50 text-emerald-700', none: 'bg-slate-100 text-slate-500'
};
export function StatusChip({ status }: { status: string }) {
  return <span className={`chip ${STATUS_TONES[status] || 'bg-slate-100 text-slate-600'}`}>{status.replace(/_/g, ' ')}</span>;
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold sm:text-[28px]">{title}</h1>
        {sub && <p className="mt-1 max-w-2xl text-sm text-ink-2">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="panel grid place-items-center px-6 py-14 text-center">
      <div>
        <h3 className="text-lg font-bold">{title}</h3>
        {children && <p className="mx-auto mt-1 max-w-md text-sm text-ink-2">{children}</p>}
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <Loader2 className={`h-4 w-4 animate-spin ${className}`} aria-label="Loading" />;
}

export function Loading() {
  return <div className="grid place-items-center py-20 text-ink-2"><Spinner className="h-6 w-6" /></div>;
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'info' | 'success' | 'warn'; children: ReactNode }) {
  const t = { error: 'border-red-200 bg-red-50 text-red-800', info: 'border-sky-200 bg-sky-50 text-sky-900', success: 'border-emerald-200 bg-emerald-50 text-emerald-800', warn: 'border-amber-200 bg-amber-50 text-amber-900' }[tone];
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2 text-sm ${t}`}>{children}</div>;
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    if (open) window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal aria-label={title} className={`panel max-h-[90vh] w-full overflow-auto p-5 shadow-xl ${wide ? 'max-w-3xl' : 'max-w-lg'}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button className="btn-ghost p-1" onClick={onClose} aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="panel p-4">
      <div className="text-sm text-ink-2">{label}</div>
      <div className="mt-1 font-display text-2xl font-bold">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-2">{hint}</div>}
    </div>
  );
}

export const fmtDate = (d?: string) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
export const fmtTime = (d?: string) => (d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
