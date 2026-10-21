import { AlertTriangle, CheckCircle2, CircleDashed, Info, XCircle } from 'lucide-react';
import { cn } from '../cn';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const tones: Record<StatusTone, { className: string; Icon: typeof Info }> = {
  neutral: { className: 'bg-surface-muted text-muted', Icon: CircleDashed },
  info: { className: 'bg-info-soft text-info', Icon: Info },
  success: { className: 'bg-success-soft text-success', Icon: CheckCircle2 },
  warning: { className: 'bg-warning-soft text-warning', Icon: AlertTriangle },
  danger: { className: 'bg-danger-soft text-danger', Icon: XCircle },
};

/** Status is always conveyed by icon + text, never colour alone. */
export function StatusBadge({ tone, label, className }: { tone: StatusTone; label: string; className?: string }) {
  const { className: toneClass, Icon } = tones[tone];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', toneClass, className)}>
      <Icon aria-hidden="true" size={12} strokeWidth={2.5} />
      {label}
    </span>
  );
}
