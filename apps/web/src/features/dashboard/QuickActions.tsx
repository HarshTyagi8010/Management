import { FilePlus2, FileText, PackagePlus, ShoppingCart, Wallet } from 'lucide-react';
import { useId } from 'react';
import { Link } from 'react-router';
import { Card, CardHeader } from '@bizmgmt/ui';

const ACTIONS = [
  { label: 'New invoice', to: '/sales/invoices', icon: <FileText size={18} /> },
  { label: 'New quotation', to: '/sales/quotations', icon: <FilePlus2 size={18} /> },
  { label: 'Record receipt', to: '/money/receipts', icon: <Wallet size={18} /> },
  { label: 'New purchase', to: '/purchases/bills', icon: <ShoppingCart size={18} /> },
  { label: 'Add product', to: '/inventory/items', icon: <PackagePlus size={18} /> },
];

export function QuickActions() {
  const headingId = useId();
  return (
    <Card aria-labelledby={headingId} className="min-w-0">
      <CardHeader id={headingId} title="Quick actions" />
      <ul className="grid grid-cols-2 gap-2 p-5 sm:grid-cols-3 xl:grid-cols-2">
        {ACTIONS.map((a) => (
          <li key={a.to}>
            <Link
              to={a.to}
              className="flex min-h-12 items-center gap-2.5 rounded-md border border-border px-3 text-[0.8125rem] font-medium transition-colors hover:border-accent hover:bg-accent-soft"
            >
              <span aria-hidden="true" className="text-accent">
                {a.icon}
              </span>
              {a.label}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
