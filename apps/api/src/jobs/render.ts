import { createHash } from 'node:crypto';
import { trusted, Types } from 'mongoose';
import type { DocumentDefinition } from 'pdfmake';
import type { Models, OutboxDoc } from '../models.js';
import type { OutboxEvents } from '../platform/outbox.js';
import type { ObjectStorage } from '../platform/storage.js';
import { isDuplicateKey } from '../platform/values.js';
import { renderPdf } from '../pdf/render.js';
import { salesPrint, templateFor } from '../pdf/sales-print.js';
import { STOCK_TRANSFER_TEMPLATE, stockTransferDocument } from '../pdf/templates/stock-transfer.js';
import { salesDocument } from '../pdf/templates/sales.js';
import { PURCHASE_ORDER_TEMPLATE, purchaseOrderDocument } from '../pdf/templates/purchase-order.js';
import { purchaseOrderPrint } from '../pdf/purchases-print.js';

const addressLine = (a: { line1: string; line2: string; city: string; pincode: string } | null) => (a ? [a.line1, a.line2, `${a.city} ${a.pincode}`].filter(Boolean).join(', ') : null);

type Payload = OutboxEvents['document.render'];
interface Built {
  definition: DocumentDefinition;
  title: string;
  /** The PDF's creation date: when the document was numbered, not when it was rendered. */
  createdAt: Date;
  purpose: string;
}

async function stockTransferNote(models: Models, tenantId: Types.ObjectId, docId: Types.ObjectId): Promise<Built> {
  const transfer = await models.StockTransfer.findOne({ tenantId, _id: docId }).lean();
  if (!transfer?.dispatchedAt) throw new Error('Transfer not found or not dispatched');
  const [entity, warehouses, items] = await Promise.all([
    models.LegalEntity.findOne({ tenantId, _id: transfer.legalEntityId }).lean(),
    models.Warehouse.find({ tenantId, _id: trusted({ $in: [transfer.fromWarehouseId, transfer.toWarehouseId] }) }).lean(),
    models.Item.find({ tenantId, _id: trusted({ $in: transfer.lines.map((l) => l.itemId) }) }).lean(),
  ]);
  const units = await models.Unit.find({ tenantId, _id: trusted({ $in: items.map((i) => i.baseUnitId) }) }).lean();
  const from = warehouses.find((w) => w._id.equals(transfer.fromWarehouseId));
  const to = warehouses.find((w) => w._id.equals(transfer.toWarehouseId));
  if (!entity || !from || !to) throw new Error('Transfer references are missing');
  const registration = from.gstRegistrationId ? await models.GstRegistration.findOne({ tenantId, _id: from.gstRegistrationId }, { gstin: 1 }).lean() : null;
  return {
    definition: stockTransferDocument({
      number: transfer.number,
      docDate: transfer.docDate,
      entity: { legalName: entity.legalName, gstin: registration?.gstin ?? null },
      from: { code: from.code, name: from.name, address: addressLine(from.address) },
      to: { code: to.code, name: to.name, address: addressLine(to.address) },
      note: transfer.note,
      dispatchedAt: transfer.dispatchedAt,
      lines: transfer.lines.map((l) => {
        const item = items.find((i) => i._id.equals(l.itemId));
        const unit = units.find((u) => item && u._id.equals(item.baseUnitId));
        return { sku: item?.sku ?? '?', name: item?.name ?? 'Unknown item', hsnSac: item?.hsnSac ?? '', qty: l.qty.toString(), unit: unit?.uqc ?? '' };
      }),
    }),
    title: `Stock transfer note ${transfer.number}`,
    createdAt: transfer.dispatchedAt,
    purpose: 'stock_transfer_note',
  };
}

/**
 * A numbered sales document, printed from its frozen snapshot (and the logo
 * file frozen with it), so rendering again later gives the same document.
 */
async function salesDoc(models: Models, storage: ObjectStorage, tenantId: Types.ObjectId, payload: Payload): Promise<Built> {
  const model = { quotation: models.Quotation, dispatch: models.Dispatch, sales_invoice: models.SalesInvoice }[payload.docType as 'quotation' | 'dispatch' | 'sales_invoice'];
  const doc = await model.findOne({ tenantId, _id: new Types.ObjectId(payload.docId) }).lean();
  if (!doc?.number || !doc.issuedAt) throw new Error('Document not found or not numbered');
  if (doc.templateVersion !== payload.templateVersion || templateFor(doc) !== payload.templateVersion) throw new Error(`Template ${payload.templateVersion} does not match the document`);
  let logo = null;
  if (doc.logoFileId) {
    const file = await models.File.findOne({ tenantId, _id: doc.logoFileId }).lean();
    if (!file) throw new Error('Logo file missing');
    logo = { dataUrl: `data:${file.mime};base64,${(await storage.get(file.storageKey)).toString('base64')}` };
  }
  // Whether e-invoicing applied was frozen on the invoice as its regulatory sub-state.
  const print = salesPrint(doc, logo, { einvoiceApplicable: doc.einvoiceStatus === 'not_submitted' });
  return { definition: salesDocument(print), title: `${print.title} ${doc.number}`, createdAt: doc.issuedAt, purpose: payload.docType };
}

async function purchaseOrderDoc(models: Models, storage: ObjectStorage, tenantId: Types.ObjectId, payload: Payload): Promise<Built> {
  const doc = await models.PurchaseOrder.findOne({ tenantId, _id: new Types.ObjectId(payload.docId) }).lean();
  if (!doc?.number) throw new Error('Purchase order not found or not numbered');
  const [entity, warehouse] = await Promise.all([
    models.LegalEntity.findOne({ tenantId, _id: doc.legalEntityId }).lean(),
    models.Warehouse.findOne({ tenantId, _id: doc.warehouseId }).lean(),
  ]);
  if (!entity || !warehouse) throw new Error('Entity or warehouse missing for purchase order');
  let logo = null;
  const logoFileId = entity.logo?.fileId;
  if (logoFileId) {
    const file = await models.File.findOne({ tenantId, _id: logoFileId }).lean();
    if (file) {
      logo = { dataUrl: `data:${file.mime};base64,${(await storage.get(file.storageKey)).toString('base64')}` };
    }
  }
  const print = purchaseOrderPrint(doc, entity, warehouse, logo);
  return {
    definition: purchaseOrderDocument(print),
    title: `Purchase Order ${doc.number}`,
    createdAt: doc.issuedAt ?? doc.createdAt,
    purpose: 'purchase_order',
  };
}

/**
 * `document.render` handler. Idempotent: a document that is already rendered is
 * left alone (the original is never regenerated, AC-DOC-1).
 */
export function renderDocumentHandler(deps: { models: Models; storage: ObjectStorage; now?: () => Date }) {
  const now = () => deps.now?.() ?? new Date();
  return async (event: OutboxDoc) => {
    const payload = event.payload as unknown as Payload;
    const known =
      payload.docType === 'stock_transfer'
        ? payload.templateVersion === STOCK_TRANSFER_TEMPLATE
        : payload.docType === 'purchase_order'
        ? payload.templateVersion === PURCHASE_ORDER_TEMPLATE
        : ['quotation', 'dispatch', 'sales_invoice'].includes(payload.docType);
    if (!known) throw new Error(`Unknown document ${payload.docType}/${payload.templateVersion}`);
    const { models, storage } = deps;
    const tenantId = event.tenantId;
    const docId = new Types.ObjectId(payload.docId);
    const key = { tenantId, docType: payload.docType, docId, templateVersion: payload.templateVersion };
    await models.DocumentArtifact.create([{ ...key, status: 'pending', fileId: null, attempts: 0, lastError: null, createdAt: now(), updatedAt: now() }]).catch((err: unknown) => {
      if (!isDuplicateKey(err)) throw err;
    });
    const artifact = await models.DocumentArtifact.findOneAndUpdate({ ...key, status: trusted({ $ne: 'ready' }) }, { $inc: { attempts: 1 }, $set: { updatedAt: now() } }, { returnDocument: 'after' }).lean();
    if (!artifact) return; // already rendered

    try {
      const built =
        payload.docType === 'stock_transfer'
          ? await stockTransferNote(models, tenantId, docId)
          : payload.docType === 'purchase_order'
          ? await purchaseOrderDoc(models, storage, tenantId, payload)
          : await salesDoc(models, storage, tenantId, payload);
      const pdf = await renderPdf(built.definition, { title: built.title, createdAt: built.createdAt });
      const storageKey = storage.newKey('pdf');
      await storage.put(storageKey, pdf);
      const [file] = await models.File.create([{ tenantId, storageKey, mime: 'application/pdf', size: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'), purpose: built.purpose, createdAt: now() }]);
      await models.DocumentArtifact.updateOne({ tenantId, _id: artifact._id, status: trusted({ $ne: 'ready' }) }, { $set: { status: 'ready', fileId: file?._id ?? null, lastError: null, updatedAt: now() } });
    } catch (err) {
      await models.DocumentArtifact.updateOne({ tenantId, _id: artifact._id }, { $set: { status: 'failed', lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500), updatedAt: now() } });
      throw err;
    }
  };
}
