import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn('rounded-lg border border-border bg-surface shadow-card', className)} {...props} />;
}

export interface CardHeaderProps {
  title: ReactNode;
  /** Heading level for the title; keep the page outline valid (one h1 per page). */
  level?: 2 | 3;
  description?: ReactNode;
  action?: ReactNode;
  id?: string;
}

export function CardHeader({ title, level = 2, description, action, id }: CardHeaderProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-5">
      <div className="min-w-0">
        <Heading id={id} className="text-base font-semibold">
          {title}
        </Heading>
        {description && <p className="mt-0.5 text-[0.8125rem] text-muted">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5', className)} {...props} />;
}
