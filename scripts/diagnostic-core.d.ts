export interface DiagnosticResult {
  cutoff: string;
  scope: {
    tenantsCount: number;
    legalEntitiesCount: number;
    invoicesCount: number;
    billsCount: number;
    paymentsCount: number;
    creditNotesCount: number;
    debitNotesCount: number;
    refundsCount: number;
    journalsCount: number;
  };
  issuesCount: number;
  issues: Array<{ kind: string; id: string; detail: string }>;
}

export function runFinancialDiagnostic(db: any): Promise<DiagnosticResult>;
