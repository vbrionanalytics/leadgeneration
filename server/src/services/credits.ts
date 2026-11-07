import { Types } from 'mongoose';
import { CreditTxn, Organization } from '../models';
import { paymentRequired } from '../utils';

type TxnType = 'grant' | 'purchase' | 'spend' | 'refund' | 'adjustment' | 'marketplace_sale' | 'marketplace_purchase';

/**
 * Atomically debit credits. Throws 402 if the balance is insufficient.
 * The conditional update prevents double-spending under concurrency.
 */
export async function spendCredits(orgId: Types.ObjectId | string, amount: number, reason: string, refId?: string, type: TxnType = 'spend') {
  if (amount <= 0) return null;
  const org = await Organization.findOneAndUpdate(
    { _id: orgId, credits: { $gte: amount } },
    { $inc: { credits: -amount } },
    { returnDocument: 'after' }
  );
  if (!org) throw paymentRequired(`This action needs ${amount} credit(s). Top up or upgrade your plan.`);
  await CreditTxn.create({ orgId, amount: -amount, balanceAfter: org.credits, type, reason, refId });
  return org.credits;
}

/** Spend up to `max` credits, returning how many were actually available (for batch lead creation). */
export async function reserveUpTo(orgId: Types.ObjectId | string, max: number): Promise<number> {
  const org = await Organization.findById(orgId).select('credits');
  const n = Math.min(max, org?.credits ?? 0);
  if (n <= 0) return 0;
  const updated = await Organization.findOneAndUpdate({ _id: orgId, credits: { $gte: n } }, { $inc: { credits: -n } }, { returnDocument: 'after' });
  return updated ? n : 0;
}

export async function addCredits(orgId: Types.ObjectId | string, amount: number, type: TxnType, reason: string, refId?: string, idempotencyKey?: string) {
  if (idempotencyKey && (await CreditTxn.exists({ idempotencyKey }))) return null;
  const org = await Organization.findByIdAndUpdate(orgId, { $inc: { credits: amount } }, { returnDocument: 'after' });
  if (!org) return null;
  await CreditTxn.create({ orgId, amount, balanceAfter: org.credits, type, reason, refId, idempotencyKey });
  return org.credits;
}

/** Record a ledger line for credits that were reserved in bulk (reserveUpTo) and then used/refunded. */
export async function settleReservation(orgId: Types.ObjectId | string, reserved: number, used: number, reason: string, refId?: string) {
  const org = await Organization.findById(orgId).select('credits');
  if (used > 0) await CreditTxn.create({ orgId, amount: -used, balanceAfter: (org?.credits ?? 0) + (reserved - used), type: 'spend', reason, refId });
  if (reserved > used) await Organization.updateOne({ _id: orgId }, { $inc: { credits: reserved - used } });
}
