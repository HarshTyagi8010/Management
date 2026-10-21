import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, IconButton } from './Button';
import { DataTable } from './DataTable';
import { FormField, Input } from './FormField';
import { KpiCard } from './KpiCard';
import { ErrorState, PermissionDenied } from './States';
import { StatusBadge } from './StatusBadge';

afterEach(cleanup);

describe('Button', () => {
  it('defaults to type="button" so it never submits forms by accident', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('type')).toBe('button');
  });

  it('gives icon-only buttons an accessible name', () => {
    render(<IconButton label="Close" icon={<svg />} />);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });
});

describe('FormField', () => {
  it('links label, hint and error to the control', () => {
    render(
      <FormField label="GSTIN" hint="15 characters" error="Invalid checksum" required>
        {(p) => <Input {...p} />}
      </FormField>,
    );
    const input = screen.getByLabelText(/GSTIN/);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-required')).toBe('true');
    const describedBy = input.getAttribute('aria-describedby')?.split(' ') ?? [];
    const texts = describedBy.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toEqual(['15 characters', 'Invalid checksum']);
  });
});

describe('StatusBadge', () => {
  it('conveys status with text, not colour alone', () => {
    render(<StatusBadge tone="danger" label="Overdue" />);
    expect(screen.getByText('Overdue')).toBeTruthy();
  });
});

describe('KpiCard', () => {
  it('shows the compact figure visually and the exact value for assistive tech', () => {
    render(<KpiCard label="Receivables" value="962450.00" definition="Outstanding…" asOf="As of 19-10-2026" />);
    expect(screen.getByRole('heading', { name: 'Receivables' })).toBeTruthy();
    expect(screen.getByText('₹9.62 L')).toBeTruthy();
    expect(screen.getAllByText('₹9,62,450.00').length).toBe(2);
    expect(screen.getByRole('button', { name: 'What is “Receivables”?' })).toBeTruthy();
  });
});

describe('DataTable', () => {
  it('renders a captioned table with column headers', () => {
    render(
      <DataTable
        caption="Invoices"
        rows={[{ id: '1', n: 'INV-1', amt: '₹10.00' }]}
        rowKey={(r) => r.id}
        columns={[
          { key: 'n', header: 'Number', primary: true, render: (r) => r.n },
          { key: 'a', header: 'Amount', align: 'end', render: (r) => r.amt },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Invoices' });
    expect(table.querySelectorAll('th[scope="col"]').length).toBe(2);
  });

  it('renders the empty state when there are no rows', () => {
    render(<DataTable caption="x" rows={[]} rowKey={() => ''} columns={[]} empty={<p>No invoices yet</p>} />);
    expect(screen.getByText('No invoices yet')).toBeTruthy();
  });
});

describe('States', () => {
  it('error state is announced and shows the request reference', () => {
    render(<ErrorState requestId="req-123" />);
    expect(screen.getByRole('alert').textContent).toContain('req-123');
  });

  it('permission denied names the missing permission', () => {
    render(<PermissionDenied permission="invoice.issue" />);
    expect(screen.getByText('invoice.issue')).toBeTruthy();
  });
});
