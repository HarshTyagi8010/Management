import { stateName } from '@bizmgmt/contracts';
import { amountInWords, dec, formatQty } from '@bizmgmt/domain';
import type { AddressDoc, LegalEntityDoc, PurchaseOrderDoc, WarehouseDoc } from '../models.js';
import { inr } from './sales-print.js';
import {
  PURCHASE_ORDER_TEMPLATE,
  purchaseOrderDocument,
  type PurchaseOrderPrint,
  type PurchaseOrderPrintLine,
} from './templates/purchase-order.js';

export { PURCHASE_ORDER_TEMPLATE, purchaseOrderDocument };

const ddmmyyyy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
const state = (code: string | null) => (code ? `${stateName(code) ?? code} (${code})` : null);
const addressText = (a: AddressDoc | null | undefined) =>
  a ? [a.line1, a.line2, a.city, a.district, `${stateName(a.stateCode) ?? a.stateCode} ${a.pincode}`].filter(Boolean).join(', ') : null;

export function purchaseOrderPrint(
  doc: PurchaseOrderDoc,
  buyerEntity: LegalEntityDoc,
  warehouse: WarehouseDoc,
  logo: { dataUrl: string } | null,
): PurchaseOrderPrint {
  if (!doc.number) throw new Error('Only numbered purchase orders are printed');

  const sup = doc.supplier;
  const buyer = doc.buyer;

  const totals = doc.totals;
  const m = (v: { toString(): string }) => inr(v.toString());
  const nonZero = (v: { toString(): string }) => !dec(v.toString()).isZero();

  const lines: PurchaseOrderPrintLine[] = doc.lines.map((l) => ({
    name: l.item.name,
    sku: l.item.sku,
    hsnSac: l.item.hsnSac || '—',
    qty: formatQty(l.qty.toString(), l.item.decimals),
    uqc: l.item.uqc ?? 'OTH',
    unitPrice: inr(l.unitPrice.toString()),
    discount: l.amounts?.discount ? inr(l.amounts.discount.toString()) : '0.00',
    taxable: inr(l.amounts.taxable.toString()),
    taxRate: l.taxRate ? `${dec(l.taxRate.toString()).toString()}%` : null,
    cgst: inr(l.amounts.cgst.toString()),
    sgst: inr(l.amounts.sgst.toString()),
    igst: inr(l.amounts.igst.toString()),
    cess: inr(l.amounts.cess.toString()),
    total: inr(l.amounts.total.toString()),
  }));

  const grand = m(totals.grand);
  const isInterState = totals.igst && nonZero(totals.igst);
  const supply: 'intra' | 'inter' = isInterState ? 'inter' : 'intra';

  const totalRows: Array<[string, string]> = [
    ['Gross amount', m(totals.gross)],
    ...(nonZero(totals.discount) ? ([['Discount', m(totals.discount)]] as Array<[string, string]>) : []),
    ['Taxable value', m(totals.taxable)],
    ...(supply === 'intra'
      ? ([
          ['CGST', m(totals.cgst)],
          [totals.utgst && nonZero(totals.utgst) ? 'UTGST' : 'SGST', m(totals.utgst && nonZero(totals.utgst) ? totals.utgst : totals.sgst)],
        ] as Array<[string, string]>)
      : ([['IGST', m(totals.igst)]] as Array<[string, string]>)),
    ...(nonZero(totals.cess) ? ([['Cess', m(totals.cess)]] as Array<[string, string]>) : []),
    ...(nonZero(totals.roundOff) ? ([['Round off', m(totals.roundOff)]] as Array<[string, string]>) : []),
  ];

  return {
    title: 'Purchase Order',
    number: doc.number,
    docDate: ddmmyyyy(doc.docDate),
    expectedDate: doc.expectedDeliveryDate ? ddmmyyyy(doc.expectedDeliveryDate) : null,
    buyer: {
      legalName: buyer?.legalName ?? buyerEntity.legalName,
      tradeName: buyer?.tradeName || buyerEntity.tradeName || buyerEntity.legalName,
      gstin: buyer?.gstin ?? '',
      pan: buyer?.pan ?? buyerEntity.pan ?? '',
      address: addressText(buyerEntity.address) ?? '',
      state: state(buyerEntity.address?.stateCode ?? '27') ?? '',
    },
    supplier: {
      name: sup?.name ?? 'Unknown Supplier',
      legalName: sup?.legalName,
      gstin: sup?.gstin ?? null,
      address: addressText(sup?.billingAddress),
      state: state(sup?.billingAddress?.stateCode ?? null),
    },
    shipToWarehouse: {
      name: warehouse.name,
      code: warehouse.code,
      address: addressText(warehouse.address),
    },
    logo,
    supply,
    stateTaxLabel: totals.utgst && nonZero(totals.utgst) ? 'UTGST' : 'SGST',
    lines,
    totals: totalRows,
    grand,
    amountInWords: amountInWords(totals.grand.toString()),
    hsnSummary: (doc.hsnSummary ?? []).map((h) => ({
      hsnSac: h.hsnSac,
      taxable: m(h.taxable),
      rate: h.rate ? `${dec(h.rate.toString()).toString()}%` : '—',
      cgst: m(h.cgst),
      sgst: m(h.sgst),
      igst: m(h.igst),
      cess: m(h.cess),
      tax: m(dec(h.cgst.toString()).plus(dec(h.sgst.toString())).plus(dec(h.igst.toString())).plus(dec(h.cess.toString())).toFixed(2)),
    })),
    notes: doc.notes || '',
    terms: doc.terms || '',
    signatory: 'Authorized Signatory',
  };
}
