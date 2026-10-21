import { Link, useSearchParams } from 'react-router';
import type { LegalEntity } from '@bizmgmt/contracts';
import { Card, EmptyState, ErrorState, FormField, Select, Skeleton } from '@bizmgmt/ui';
import { errorMessage, useLegalEntities } from '../../lib/queries';

/**
 * Chooses which business entity a settings page works on. The choice lives in
 * the URL (?entity=…), so it survives reloads and can be linked.
 */
export function useEntityChoice(): { entity: LegalEntity | undefined; picker: React.ReactNode; state: React.ReactNode | null } {
  const entities = useLegalEntities();
  const [params, setParams] = useSearchParams();
  if (entities.isPending) return { entity: undefined, picker: null, state: <Skeleton className="mt-6 h-40" /> };
  if (entities.isError) {
    return {
      entity: undefined,
      picker: null,
      state: (
        <Card className="mt-6">
          <ErrorState message={errorMessage(entities.error)} onRetry={() => void entities.refetch()} />
        </Card>
      ),
    };
  }
  if (entities.data.length === 0) {
    return {
      entity: undefined,
      picker: null,
      state: (
        <Card className="mt-6">
          <EmptyState title="Add a business entity first" description="These settings belong to a business entity (PAN)." action={<Link className="font-medium text-accent underline-offset-2 hover:underline" to="/settings/company">Go to Company & GST</Link>} />
        </Card>
      ),
    };
  }
  const chosen = entities.data.find((e) => e.id === params.get('entity')) ?? entities.data[0];
  const picker =
    entities.data.length > 1 ? (
      <div className="mt-6 sm:max-w-sm">
        <FormField label="Business entity">
          {(f) => (
            <Select {...f} value={chosen?.id} onChange={(e) => setParams({ entity: e.target.value }, { replace: true })}>
              {entities.data.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.legalName}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>
    ) : null;
  return { entity: chosen, picker, state: null };
}
