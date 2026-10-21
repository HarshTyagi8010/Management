import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { AppShell, type RenderLink } from '@bizmgmt/ui';
import { fetchHealth } from '../api';
import { NAV } from './nav';
import { TopBar } from './TopBar';

const renderLink: RenderLink = ({ to, children, ...rest }) => (
  <Link to={to} {...rest}>
    {children}
  </Link>
);

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 rounded-md">
      <BrandMarkIcon />
      <span className="text-base font-semibold tracking-tight">BizMgmt</span>
    </Link>
  );
}

function BrandMarkIcon() {
  return (
    <span aria-hidden="true" className="inline-flex size-8 items-center justify-center rounded-md bg-accent text-sm font-bold text-accent-contrast">
      B
    </span>
  );
}

function ApiStatus() {
  const health = useQuery({ queryKey: ['health'], queryFn: ({ signal }) => fetchHealth(signal), retry: false });
  const label = health.isPending ? 'Checking…' : health.isSuccess ? `OK · v${health.data.version}` : 'Unreachable';
  const dot = health.isSuccess ? 'bg-success' : health.isError ? 'bg-danger' : 'bg-border-strong';
  return (
    <p className="flex items-center gap-2 text-xs text-muted" aria-live="polite">
      <span aria-hidden="true" className={`size-2 rounded-full ${dot}`} />
      API: <span data-testid="api-status">{label}</span>
    </p>
  );
}

export function Layout() {
  const location = useLocation();

  // Move focus to main content after client-side navigation so keyboard and screen-reader users land on the new page.
  useEffect(() => {
    if (location.key !== 'default') document.getElementById('main')?.focus();
  }, [location.key]);

  return (
    <AppShell
      brand={<Brand />}
      brandMark={
        <Link to="/" aria-label="BizMgmt home" className="rounded-md">
          <BrandMarkIcon />
        </Link>
      }
      nav={NAV}
      currentPath={location.pathname}
      renderLink={renderLink}
      header={(openNav) => <TopBar onOpenNav={openNav} />}
      sidebarFooter={<ApiStatus />}
    >
      <Outlet />
    </AppShell>
  );
}
