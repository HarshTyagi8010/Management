import { ChevronDown, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useRef, useState, type ReactNode } from 'react';
import { cn } from '../cn';

export interface NavLeaf {
  label: string;
  to: string;
}

export interface NavGroup {
  label: string;
  icon: ReactNode;
  /** Landing route; for single-item groups this is the only link. */
  to: string;
  items?: NavLeaf[];
}

/** Router-agnostic link renderer supplied by the app (e.g. react-router's Link). */
export type RenderLink = (props: {
  to: string;
  className: string;
  children: ReactNode;
  'aria-current'?: 'page';
  onClick?: () => void;
  title?: string;
}) => ReactNode;

export function isActivePath(currentPath: string, to: string): boolean {
  if (to === '/') return currentPath === '/';
  return currentPath === to || currentPath.startsWith(`${to}/`);
}

function groupActive(group: NavGroup, currentPath: string) {
  return isActivePath(currentPath, group.to) || (group.items ?? []).some((i) => isActivePath(currentPath, i.to));
}

interface NavProps {
  nav: NavGroup[];
  currentPath: string;
  renderLink: RenderLink;
  /** Icon-only presentation (1024–1279 px). */
  collapsed?: boolean;
  onNavigate?: () => void;
}

const linkBase = 'flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors';
const linkIdle = 'text-muted hover:bg-surface-muted hover:text-text';
const linkActive = 'bg-accent-soft text-accent';

function NavGroupItem({ group, currentPath, renderLink, collapsed, onNavigate }: NavProps & { group: NavGroup }) {
  const active = groupActive(group, currentPath);
  const [open, setOpen] = useState(active);
  const icon = (
    <span aria-hidden="true" className="inline-flex shrink-0">
      {group.icon}
    </span>
  );

  if (collapsed || !group.items?.length) {
    const current = isActivePath(currentPath, group.to) && !group.items?.length;
    return (
      <li>
        {renderLink({
          to: group.to,
          className: cn(linkBase, active ? linkActive : linkIdle, collapsed && 'justify-center px-0'),
          ...(current ? { 'aria-current': 'page' as const } : {}),
          ...(onNavigate ? { onClick: onNavigate } : {}),
          ...(collapsed ? { title: group.label } : {}),
          children: (
            <>
              {icon}
              <span className={cn(collapsed && 'sr-only')}>{group.label}</span>
            </>
          ),
        })}
      </li>
    );
  }

  const listId = `nav-${group.to.replace(/[^a-z0-9]/gi, '-')}`;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className={cn(linkBase, 'w-full cursor-pointer', active ? 'text-text' : linkIdle)}
      >
        {icon}
        <span className="flex-1 text-left">{group.label}</span>
        <ChevronDown aria-hidden="true" size={16} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      <ul id={listId} hidden={!open} className="mt-0.5 mb-1 ml-[1.375rem] border-l border-border pl-3">
        {group.items.map((item) => {
          const current = isActivePath(currentPath, item.to);
          return (
            <li key={item.to}>
              {renderLink({
                to: item.to,
                className: cn('flex min-h-9 items-center rounded-md px-3 text-[0.8125rem] transition-colors', current ? 'font-medium text-accent' : linkIdle),
                ...(current ? { 'aria-current': 'page' as const } : {}),
                ...(onNavigate ? { onClick: onNavigate } : {}),
                children: item.label,
              })}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function SidebarNav(props: NavProps) {
  return (
    <ul className="flex flex-col gap-0.5">
      {props.nav.map((group) => (
        <NavGroupItem key={group.to} group={group} {...props} />
      ))}
    </ul>
  );
}

export interface AppShellProps {
  brand: ReactNode;
  /** Compact brand mark for the collapsed sidebar. */
  brandMark: ReactNode;
  nav: NavGroup[];
  currentPath: string;
  renderLink: RenderLink;
  /** Header content; receives a control that opens the mobile navigation. */
  header: (openNav: () => void) => ReactNode;
  sidebarFooter?: ReactNode;
  children: ReactNode;
}

/**
 * Responsive application shell (design-system.md §7):
 *  ≥ 1280 expanded sidebar · 1024–1279 icon sidebar · < 1024 off-canvas drawer.
 */
export function AppShell({ brand, brandMark, nav, currentPath, renderLink, header, sidebarFooter, children }: AppShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const close = () => setMobileOpen(false);
  // The drawer is opened from a header control rather than a Dialog.Trigger, so restore focus to it ourselves.
  const opener = useRef<HTMLElement | null>(null);
  const openNav = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMobileOpen(true);
  };

  return (
    <div className="min-h-dvh bg-bg">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-surface px-4 py-2 font-medium shadow-card focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to main content
      </a>

      {/* Icon sidebar (lg) */}
      <div
        className="fixed inset-y-0 left-0 z-30 hidden w-sidebar-collapsed flex-col border-r border-border bg-surface lg:flex xl:hidden"
      >
        <div className="flex h-header items-center justify-center">{brandMark}</div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
          <SidebarNav nav={nav} currentPath={currentPath} renderLink={renderLink} collapsed />
        </nav>
      </div>

      {/* Expanded sidebar (xl) */}
      <div
        className="fixed inset-y-0 left-0 z-30 hidden w-sidebar flex-col border-r border-border bg-surface xl:flex"
      >
        <div className="flex h-header items-center px-5">{brand}</div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
          <SidebarNav nav={nav} currentPath={currentPath} renderLink={renderLink} />
        </nav>
        {sidebarFooter && <div className="border-t border-border px-5 py-3">{sidebarFooter}</div>}
      </div>

      {/* Off-canvas drawer (< lg) */}
      <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 lg:hidden" />
          <Dialog.Content
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              if (opener.current?.isConnected) {
                event.preventDefault();
                opener.current.focus();
              }
            }}
            className="fixed inset-y-0 left-0 z-50 flex w-[min(85vw,var(--spacing-sidebar))] flex-col bg-surface shadow-card focus:outline-none lg:hidden"
          >
            <div className="flex h-header items-center justify-between px-5">
              <Dialog.Title asChild>
                <div>{brand}</div>
              </Dialog.Title>
              <Dialog.Close
                aria-label="Close navigation"
                className="inline-flex size-10 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-surface-muted"
              >
                <X aria-hidden="true" size={20} />
              </Dialog.Close>
            </div>
            <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
              <SidebarNav nav={nav} currentPath={currentPath} renderLink={renderLink} onNavigate={close} />
            </nav>
            {sidebarFooter && <div className="border-t border-border px-5 py-3">{sidebarFooter}</div>}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="lg:pl-sidebar-collapsed xl:pl-sidebar">
        <header className="sticky top-0 z-20 flex h-header items-center gap-2 border-b border-border bg-surface/95 px-4 backdrop-blur md:px-6">
          {header(openNav)}
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1600px] px-4 py-6 focus:outline-none md:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
