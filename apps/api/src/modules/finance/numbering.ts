import { Types, type ClientSession } from 'mongoose';
import { financialYear, formatDocumentNumber, seriesCapacity } from '@bizmgmt/contracts';
import { AppError } from '../../errors.js';
import type { DocumentSeriesDoc, Models } from '../../models.js';
import { isDuplicateKey } from '../../platform/values.js';

export interface IssuedNumber {
  number: string;
  /** The counter value used, e.g. 12 for "INV/26-27/0012". */
  sequence: number;
  /** Financial year the number belongs to (GST-01: numbering restarts each April). */
  fy: string;
  seriesId: Types.ObjectId;
  scopeId: Types.ObjectId;
}

/**
 * Gap-free document numbers (architecture §8, AC-NUM-1).
 *
 * The counter is incremented inside the issuing transaction. Concurrent
 * issuers write the same counter document, so the database serialises them
 * (write conflicts are retried by the driver); an aborted transaction rolls the
 * increment back, so a failed issue never consumes a number and no number is
 * ever handed out twice.
 */
export class NumberingService {
  constructor(private readonly models: Models) {}

  private async series(tenantId: Types.ObjectId, seriesId: Types.ObjectId, session?: ClientSession): Promise<DocumentSeriesDoc> {
    const series = await this.models.DocumentSeries.findOne({ tenantId, _id: seriesId }, null, session ? { session } : {}).lean();
    if (!series) throw new AppError('NOT_FOUND', 'Document series not found');
    if (!series.active) throw new AppError('BUSINESS_RULE', `The series "${series.name}" is not active`);
    return series;
  }

  /**
   * Creates the counter for the financial year before the transaction. Two
   * first issues racing to create it inside transactions would fail on the
   * unique index instead of being retried; creating it up front avoids that.
   * Creating the counter does not lock the series; issuing a number does.
   */
  async prepare(tenantId: Types.ObjectId, seriesId: Types.ObjectId, docDate: string): Promise<void> {
    const series = await this.series(tenantId, seriesId);
    const fy = financialYear(docDate);
    await this.models.Sequence.updateOne({ tenantId, seriesId, fy }, { $setOnInsert: { next: series.startNumber, issuedCount: 0 } }, { upsert: true }).catch((err: unknown) => {
      if (!isDuplicateKey(err)) throw err;
    });
  }

  /** Takes the next number inside `session`. Call `prepare` first (outside the transaction). */
  async take(session: ClientSession, tenantId: Types.ObjectId, seriesId: Types.ObjectId, docDate: string): Promise<IssuedNumber> {
    const series = await this.series(tenantId, seriesId, session);
    const fy = financialYear(docDate);
    const counter = await this.models.Sequence.findOneAndUpdate({ tenantId, seriesId, fy }, { $inc: { next: 1, issuedCount: 1 } }, { session, returnDocument: 'before' }).lean();
    if (!counter) throw new Error('Sequence counter missing; prepare() was not called');
    if (counter.next > seriesCapacity(series)) {
      throw new AppError('BUSINESS_RULE', `The series "${series.name}" has used every number that fits in 16 characters for ${fy}. Start a new series.`);
    }
    return { number: formatDocumentNumber(series, counter.next, fy), sequence: counter.next, fy, seriesId: series._id, scopeId: series.scopeId };
  }
}
