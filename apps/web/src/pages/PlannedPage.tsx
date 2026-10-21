import { Construction } from 'lucide-react';
import { Link } from 'react-router';
import { Button, Card, EmptyState } from '@bizmgmt/ui';
import type { PlannedRoute } from '../app/nav';
import { usePageTitle } from './usePageTitle';

/** Honest placeholder for modules that are specified but not implemented yet. */
export function PlannedPage({ route }: { route: PlannedRoute }) {
  usePageTitle(route.title);
  return (
    <>
      <h1 className="text-xl font-semibold">{route.title}</h1>
      <Card className="mt-6">
        <EmptyState
          icon={<Construction size={22} />}
          title={`Planned for Phase ${route.phase}`}
          description={`${route.description} This screen is not built yet; nothing here reads or changes data.`}
          action={
            <Button variant="secondary" asChild>
              <Link to="/">Back to dashboard</Link>
            </Button>
          }
        />
      </Card>
    </>
  );
}

export function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <Card className="mt-6">
        <EmptyState
          title="We couldn’t find that page"
          description="Check the address, or use the navigation to find what you need."
          action={
            <Button variant="secondary" asChild>
              <Link to="/">Go to dashboard</Link>
            </Button>
          }
        />
      </Card>
    </>
  );
}
