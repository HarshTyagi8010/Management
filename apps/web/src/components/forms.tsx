import type { ReactNode } from 'react';
import { INDIAN_STATES, pinMatchesState, type Address } from '@bizmgmt/contracts';
import { FormField, Input, Select } from '@bizmgmt/ui';

export const EMPTY_ADDRESS: Address = { line1: '', line2: '', city: '', district: '', stateCode: '', pincode: '' };

/** States offered for new addresses (legacy codes stay valid on existing records). */
const STATE_OPTIONS = INDIAN_STATES.filter((s) => !s.legacy);

export function StateSelect({ value, onChange, disabledExcept, ...field }: { value: string; onChange: (code: string) => void; disabledExcept?: string; id?: string; 'aria-describedby'?: string; 'aria-invalid'?: true; 'aria-required'?: true }) {
  return (
    <Select {...field} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabledExcept !== undefined}>
      <option value="">Choose a state</option>
      {STATE_OPTIONS.map((s) => (
        <option key={s.code} value={s.code}>
          {s.code} · {s.name}
        </option>
      ))}
    </Select>
  );
}

/**
 * Address fieldset. `errors` uses server paths relative to the address
 * (e.g. "pincode"); a PIN that falls outside the state's published range gets a
 * gentle hint, not an error (ranges overlap near borders).
 */
export function AddressFields({
  value,
  onChange,
  errors = {},
  legend = 'Address',
  lockState,
}: {
  value: Address;
  onChange: (next: Address) => void;
  errors?: Record<string, string>;
  legend?: string;
  /** Fixes the state, e.g. to the GSTIN’s state for a registration address. */
  lockState?: string | undefined;
}) {
  const set = (key: keyof Address) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [key]: e.target.value });
  const pinHint = value.pincode.length === 6 && value.stateCode && !pinMatchesState(value.pincode, value.stateCode) ? 'This PIN code is usually in another state. Check it.' : undefined;
  return (
    <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <legend className="mb-1 text-[0.8125rem] font-semibold">{legend}</legend>
      <FormField label="Address line 1" required error={errors.line1} className="sm:col-span-2">
        {(f) => <Input {...f} autoComplete="address-line1" value={value.line1} onChange={set('line1')} />}
      </FormField>
      <FormField label="Address line 2" error={errors.line2} className="sm:col-span-2">
        {(f) => <Input {...f} autoComplete="address-line2" value={value.line2} onChange={set('line2')} />}
      </FormField>
      <FormField label="City or town" required error={errors.city}>
        {(f) => <Input {...f} autoComplete="address-level2" value={value.city} onChange={set('city')} />}
      </FormField>
      <FormField label="District" error={errors.district}>
        {(f) => <Input {...f} value={value.district} onChange={set('district')} />}
      </FormField>
      <FormField label="State" required error={errors.stateCode} hint={lockState ? 'Set by the GSTIN' : undefined}>
        {(f) => <StateSelect {...f} value={lockState ?? value.stateCode} onChange={(stateCode) => onChange({ ...value, stateCode })} {...(lockState ? { disabledExcept: lockState } : {})} />}
      </FormField>
      <FormField label="PIN code" required error={errors.pincode} hint={pinHint}>
        {(f) => <Input {...f} inputMode="numeric" autoComplete="postal-code" maxLength={6} value={value.pincode} onChange={set('pincode')} />}
      </FormField>
    </fieldset>
  );
}

/** Prefix-filters a flat field-error map ("address.pincode" → "pincode"). */
export function errorsUnder(errors: Record<string, string>, prefix: string): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).flatMap(([k, v]) => (k.startsWith(`${prefix}.`) ? [[k.slice(prefix.length + 1), v]] : [])));
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Formats a Zod/server path list into a readable form-level message. */
export function describeIssues(errors: Record<string, string>): string | null {
  const entries = Object.entries(errors);
  return entries.length ? entries.map(([path, message]) => (path ? `${path}: ${message}` : message)).join(' · ') : null;
}
