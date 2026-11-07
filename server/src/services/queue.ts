import { Types } from 'mongoose';
import { Job } from '../models';
import { logger } from '../utils';

export type JobType = 'discovery' | 'analysis' | 'email_generate' | 'email_send' | 'marketplace_review' | 'maintenance';

export async function enqueue(type: JobType, payload: Record<string, unknown>, orgId?: Types.ObjectId | string, delayMs = 0) {
  return Job.create({ type, payload, orgId, runAt: new Date(Date.now() + delayMs) });
}

export type Handler = (payload: any, job: { _id: Types.ObjectId; attempts: number }) => Promise<void>;

/** Claim and run one due job. Returns false when the queue is empty. */
export async function runNext(handlers: Partial<Record<JobType, Handler>>): Promise<boolean> {
  const staleLock = new Date(Date.now() - 10 * 60_000);
  const job = await Job.findOneAndUpdate(
    {
      runAt: { $lte: new Date() },
      $or: [{ status: 'pending' }, { status: 'running', lockedAt: { $lt: staleLock } }]
    },
    { $set: { status: 'running', lockedAt: new Date() }, $inc: { attempts: 1 } },
    { returnDocument: 'after', sort: { runAt: 1 } }
  );
  if (!job) return false;
  const handler = handlers[job.type as JobType];
  try {
    if (!handler) throw new Error(`No handler for job type ${job.type}`);
    await handler(job.payload, { _id: job._id, attempts: job.attempts });
    await Job.updateOne({ _id: job._id }, { $set: { status: 'done', lockedAt: null } });
  } catch (err: any) {
    const final = job.attempts >= job.maxAttempts || err?.permanent;
    logger.error({ jobId: String(job._id), type: job.type, attempt: job.attempts, err: err?.message }, 'job failed');
    await Job.updateOne(
      { _id: job._id },
      {
        $set: {
          status: final ? 'failed' : 'pending',
          lastError: String(err?.message || err).slice(0, 1000),
          runAt: new Date(Date.now() + 2 ** job.attempts * 15_000), // exponential backoff
          lockedAt: null
        }
      }
    );
    if (final && handler && (handler as any).onFinalFailure) await (handler as any).onFinalFailure(job.payload, err);
  }
  return true;
}

export class PermanentError extends Error {
  permanent = true;
}
