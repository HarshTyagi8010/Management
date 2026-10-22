import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { ComplianceCapabilitiesResponse } from '@bizmgmt/contracts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusBadge,
} from '@bizmgmt/ui';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';

export function ComplianceCapabilitiesPage() {
  usePageTitle('Compliance Capabilities');

  const queryKey = useTenantQueryKey('compliance', 'capabilities');
  const capsQuery = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      return api<ComplianceCapabilitiesResponse>('/compliance/capabilities', { signal });
    },
  });

  const caps = capsQuery.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PageHeader
          title="Compliance & Statutory Capabilities"
          description="Statutory preparation registers and regulatory boundaries for Goods and Services Tax (GST) within India."
        />
        <StatusBadge label="PREPARATION ONLY — NOT FILED" tone="warning" />
      </div>

      {/* Prominent Statutory Disclaimer */}
      <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="font-bold">Statutory Boundary Notice</p>
        <p className="mt-1 text-xs">
          This system prepares internal accounting and statutory worksheets for review. It does <strong>NOT</strong> file returns with the GSTN portal,
          generate IRNs or QR codes from live IRPs, or perform automated GSTR-2B external statement matching. All figures represent internal accounting preparation only.
        </p>
      </div>

      {capsQuery.isPending && (
        <div className="space-y-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}

      {capsQuery.isError && (
        <Card>
          <CardBody>
            <ErrorState
              message={errorMessage(capsQuery.error)}
              onRetry={() => void capsQuery.refetch()}
            />
          </CardBody>
        </Card>
      )}

      {caps && (
        <div className="space-y-6">
          {/* Quick Links */}
          <Card>
            <CardHeader title="Available Statutory Registers & Tools" description="Direct access to verified statutory preparation registers." />
            <CardBody className="flex flex-wrap gap-3">
              <Link to="/reports/outward-register">
                <Button variant="secondary" size="sm">Outward Supply Register (GSTR-1)</Button>
              </Link>
              <Link to="/reports/purchase-register">
                <Button variant="secondary" size="sm">Purchase Register (ITC Review)</Button>
              </Link>
              <Link to="/reports/hsn-summary">
                <Button variant="secondary" size="sm">HSN/SAC Summary (Table 12)</Button>
              </Link>
              <Link to="/reports/document-summary">
                <Button variant="secondary" size="sm">Documents Issued (Table 13)</Button>
              </Link>
              <Link to="/reports/reconciliation">
                <Button variant="secondary" size="sm">Financial Control Reconciliation</Button>
              </Link>
              <Link to="/settings/period-locks">
                <Button variant="secondary" size="sm">Period-Close Readiness</Button>
              </Link>
            </CardBody>
          </Card>

          {/* Supported Capabilities */}
          <Card>
            <CardHeader
              title="Supported Capabilities"
              description="Features implemented and verified against CBIC notifications and statutory rules."
            />
            <CardBody className="divide-y divide-border">
              {caps.supportedCapabilities.map((cap, i) => (
                <div key={i} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{cap.feature}</p>
                    <StatusBadge label="SUPPORTED" tone="success" />
                  </div>
                  <p className="mt-1 text-xs text-muted">{cap.description}</p>
                  <p className="mt-1 text-xs text-muted"><strong>Scope:</strong> {cap.scope}</p>
                </div>
              ))}
            </CardBody>
          </Card>

          {/* Unsupported Capabilities */}
          <Card>
            <CardHeader
              title="Unsupported Capabilities & Boundaries"
              description="Capabilities intentionally excluded from MVP scope to prevent unverified or illegal filing actions."
            />
            <CardBody className="divide-y divide-border">
              {caps.unsupportedCapabilities.map((cap, i) => (
                <div key={i} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{cap.feature}</p>
                    <StatusBadge label="NOT SUPPORTED" tone="neutral" />
                  </div>
                  <p className="mt-1 text-xs text-muted"><strong>Rationale:</strong> {cap.reason}</p>
                  <p className="mt-1 text-xs text-muted"><strong>Path Forward:</strong> {cap.futureConsideration}</p>
                </div>
              ))}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
