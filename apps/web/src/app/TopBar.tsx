import { Bell, Building2, Check, ChevronDown, LogOut, Menu, Monitor, Moon, Plus, Search, ShieldCheck, Sun } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { Link, useNavigate } from 'react-router';
import { Button, IconButton } from '@bizmgmt/ui';
import { useSession } from '../auth/session';
import { api } from '../lib/api';
import { applyTheme, nextTheme, type ThemePreference } from './theme';

const QUICK_ACTIONS = [
  { label: 'Invoice', to: '/sales/invoices' },
  { label: 'Quotation', to: '/sales/quotations' },
  { label: 'Receipt', to: '/money/receipts' },
  { label: 'Supplier bill', to: '/purchases/bills' },
  { label: 'Product', to: '/inventory/items' },
];

const themeIcon: Record<ThemePreference, React.ReactNode> = {
  system: <Monitor size={18} />,
  light: <Sun size={18} />,
  dark: <Moon size={18} />,
};

const menuContent = 'z-50 min-w-48 rounded-md border border-border bg-surface p-1 shadow-card';
const menuItem = 'flex min-h-9 cursor-pointer items-center gap-2 rounded-sm px-3 text-sm outline-none data-[highlighted]:bg-surface-muted';

/** First letters of the first and last words that start with a letter ("Asha Verma (test)" → "AV"). */
export function initials(name: string): string {
  const words = name.split(/\s+/).flatMap((w) => w.match(/^\p{L}/u)?.[0] ?? []);
  return ((words[0] ?? '') + (words.length > 1 ? (words.at(-1) ?? '') : '')).toUpperCase() || '?';
}

function BusinessSwitcher() {
  const { session, tenantId, tenantContext, switchTenant } = useSession();
  if (session.status !== 'authenticated') return null;
  const current = session.tenants.find((t) => t.id === tenantId);
  const name = tenantContext?.tenant.name ?? current?.name ?? 'Business';
  const label = (
    <>
      <Building2 aria-hidden="true" size={16} className="shrink-0 text-muted" />
      <span className="max-w-40 truncate text-[0.8125rem] font-medium">{name}</span>
    </>
  );
  if (session.tenants.length < 2) {
    return <span className="hidden items-center gap-2 rounded-md border border-border px-3 py-1.5 sm:inline-flex">{label}</span>;
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="secondary" size="md" className="hidden px-3 sm:inline-flex" aria-label={`Business: ${name} (switch)`}>
          {label}
          <ChevronDown aria-hidden="true" size={16} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={menuContent}>
          <DropdownMenu.Label className="px-3 py-1.5 text-xs text-muted">Switch business</DropdownMenu.Label>
          {session.tenants.map((t) => (
            <DropdownMenu.Item key={t.id} className={menuItem} onSelect={() => t.id !== tenantId && void switchTenant(t.id)}>
              <span aria-hidden="true" className="inline-flex w-4">
                {t.id === tenantId && <Check size={16} />}
              </span>
              {t.name}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function UserMenu() {
  const { session, signOut } = useSession();
  const navigate = useNavigate();
  if (session.status !== 'authenticated') return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {/* The accessible name starts with the visible initials (WCAG 2.5.3 label in name). */}
        <button type="button" className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full bg-accent-soft text-[0.8125rem] font-semibold text-accent">
          {initials(session.user.name)}
          <span className="sr-only">, account menu for {session.user.name}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={menuContent}>
          <div className="px-3 py-2">
            <p className="text-sm font-medium">{session.user.name}</p>
            <p className="text-xs break-all text-muted">{session.user.email}</p>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item asChild className={menuItem}>
            <Link to="/account">
              <ShieldCheck aria-hidden="true" size={16} />
              Account &amp; security
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={menuItem}
            onSelect={() => {
              void signOut().then(() => navigate('/login', { replace: true }));
            }}
          >
            <LogOut aria-hidden="true" size={16} />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function TopBar({ onOpenNav }: { onOpenNav: () => void }) {
  const { session, setSession } = useSession();
  const theme: ThemePreference = session.status === 'authenticated' ? session.user.preferences.theme : 'system';

  const changeTheme = () => {
    const next = nextTheme(theme);
    applyTheme(next);
    if (session.status === 'authenticated') {
      setSession({ ...session, user: { ...session.user, preferences: { theme: next } } });
      // Saved to the account (not browser storage); a failed save only affects other devices.
      void api('/auth/preferences', { method: 'PATCH', body: { theme: next } }).catch(() => undefined);
    }
  };

  return (
    <>
      <IconButton label="Open navigation" icon={<Menu size={20} />} onClick={onOpenNav} className="lg:hidden" />
      <Link to="/" className="rounded-md text-base font-semibold tracking-tight lg:hidden">
        BizMgmt
      </Link>

      {/* Global search ships with reporting/search work; the control is shown disabled, not faked. */}
      <div className="relative hidden max-w-sm flex-1 md:block">
        <label htmlFor="global-search" className="sr-only">
          Search (not available yet)
        </label>
        <Search aria-hidden="true" size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <input
          id="global-search"
          type="search"
          disabled
          placeholder="Search — coming soon"
          className="h-10 w-full rounded-md border border-border bg-surface-muted pr-3 pl-9 text-sm text-muted placeholder:text-muted disabled:cursor-not-allowed"
        />
      </div>

      <div className="ml-auto flex items-center gap-1 md:gap-2">
        <BusinessSwitcher />

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button size="md" className="px-3">
              <Plus aria-hidden="true" size={18} />
              <span className="hidden sm:inline">New</span>
              <span className="sr-only sm:hidden">New document</span>
              <ChevronDown aria-hidden="true" size={16} className="hidden sm:inline" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6} className={menuContent}>
              {QUICK_ACTIONS.map((a) => (
                <DropdownMenu.Item key={a.to} asChild className={menuItem}>
                  <Link to={a.to}>{a.label}</Link>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <IconButton label={`Theme: ${theme} (change)`} icon={themeIcon[theme]} onClick={changeTheme} />
        <IconButton label="Notifications (none)" icon={<Bell size={18} />} />
        <UserMenu />
      </div>
    </>
  );
}
