/**
 * Background worker. Each job type either dispatches to the matching n8n workflow
 * (AUTOMATION_MODE=n8n) or runs the same logic in-process (AUTOMATION_MODE=direct).
 * Retries with exponential backoff are handled by the queue.
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { Email, Lead, MarketplaceListing, MarketplacePurchase, Organization, SearchJob } from '../models';
import { draftEmail, scoreLead } from '../services/ai';
import { sendSmtp } from '../services/email';
import { analyzeWebsite, dispatchToN8n } from '../services/integrations';
import { applyReview, reviewPreview, runMaintenance } from '../services/marketplace';
import { applyAnalysis, draftContext, failAnalysis, failSearchJob, ingestDiscoveryResults, markEmailResult, precheckSend, saveDraft } from '../services/pipeline';
import { PLACES_MAX_PER_QUERY, searchPlaces } from '../services/places';
import { buildOverpassQuery, searchOsm } from '../services/osm';
import { Handler, JobType, PermanentError, enqueue, runNext } from '../services/queue';
import { decrypt, logger, sleep } from '../utils';

const n8n = () => env.AUTOMATION_MODE === 'n8n';
const orgKey = (org: any, k: 'googlePlacesKey' | 'anthropicKey') => (org?.secrets?.[k] ? decrypt(org.secrets[k]) : undefined);

const discovery: Handler = async ({ jobId }) => {
  const job = await SearchJob.findById(jobId);
  // A retry must not reopen a search that n8n already completed (or that was cancelled/failed)
  if (!job || !['queued', 'running'].includes(job.status)) return;
  await SearchJob.updateOne({ _id: jobId, status: 'queued' }, { $set: { status: 'running', startedAt: new Date() } });
  const org = await Organization.findById(job.orgId);
  const q = job.query!;
  // Large searches are split into keyword sub-queries of ≤60 (Places Text Search page limit)
  const subQueries = q.maxResults! > PLACES_MAX_PER_QUERY
    ? ['', 'best', 'top rated', 'near city centre', 'new', 'affordable', 'premium', 'local'].slice(0, Math.ceil(q.maxResults! / PLACES_MAX_PER_QUERY))
    : [''];
  const provider = q.provider || 'openstreetmap';
  if (provider === 'openstreetmap') {
    const overpassQuery = buildOverpassQuery({ category: q.category, city: q.city, country: q.country, keywords: q.keywords });
    if (n8n()) {
      await dispatchToN8n('discovery', { jobId, orgId: String(job.orgId), provider, overpassQuery, maxResults: q.maxResults });
      return;
    }
    const places = await searchOsm({ category: q.category, city: q.city, country: q.country, keywords: q.keywords, max: q.maxResults! });
    await ingestDiscoveryResults(jobId, places, true);
    return;
  }
  if (n8n()) {
    await dispatchToN8n('discovery', {
      jobId, orgId: String(job.orgId), provider, category: q.category, city: q.city || '', country: q.country,
      keywords: q.keywords || '', maxResults: q.maxResults, subQueries
    });
    return;
  }
  let remaining = q.maxResults!;
  for (let i = 0; i < subQueries.length && remaining > 0; i++) {
    const places = await searchPlaces({
      category: q.category, city: q.city ?? undefined, country: q.country, keywords: [subQueries[i], q.keywords].filter(Boolean).join(' '),
      max: Math.min(remaining, PLACES_MAX_PER_QUERY), apiKey: orgKey(org, 'googlePlacesKey')
    });
    const r = await ingestDiscoveryResults(jobId, places, i === subQueries.length - 1 || places.length === 0);
    remaining -= r.created;
    if (r.skipped) break; // out of credits
  }
  const after = await SearchJob.findById(jobId);
  if (after?.status === 'running') await SearchJob.updateOne({ _id: jobId }, { $set: { status: 'completed', finishedAt: new Date() } });
};
(discovery as any).onFinalFailure = (p: any, err: Error) => failSearchJob(p.jobId, err.message);

const analysis: Handler = async ({ leadId }) => {
  const lead = await Lead.findById(leadId);
  // Skip if the result already arrived (e.g. this is a retry after a slow n8n response)
  if (!lead || !['queued', 'running'].includes(lead.analysisStatus)) return;
  await Lead.updateOne({ _id: leadId }, { $set: { analysisStatus: 'running' } });
  const org = await Organization.findById(lead.orgId);
  const services = (org?.services || []).map((s: any) => ({ name: s.name, description: s.description }));
  const ctx = { name: lead.name, category: lead.category ?? undefined, city: lead.city ?? undefined, country: lead.country ?? undefined, website: lead.website ?? undefined, rating: lead.rating ?? undefined, reviewCount: lead.reviewCount ?? undefined, businessStatus: lead.businessStatus ?? undefined };
  if (n8n()) {
    // useAi=false makes workflow 2 skip Claude; the backend then scores with transparent rules
    await dispatchToN8n('analysis', { leadId, orgId: String(lead.orgId), lead: ctx, services, analyzerUrl: env.ANALYZER_PUBLIC_URL || env.ANALYZER_URL, useAi: env.AI_ENABLED });
    return;
  }
  const a = lead.website ? await analyzeWebsite(lead.website) : null;
  const score = await scoreLead(ctx, a, services, orgKey(org, 'anthropicKey'));
  await applyAnalysis(leadId, a, score);
};
(analysis as any).onFinalFailure = (p: any, err: Error) => failAnalysis(p.leadId, err.message);

const emailGenerate: Handler = async ({ emailId }) => {
  const { email, org, input } = await draftContext(emailId);
  if (email.status !== 'generating') return;
  if (n8n()) {
    await dispatchToN8n('emailGenerate', { emailId, orgId: String(email.orgId), context: input });
    return;
  }
  const d = await draftEmail(input as any, orgKey(org, 'anthropicKey'));
  await saveDraft(emailId, d.subject, d.body);
};
(emailGenerate as any).onFinalFailure = (p: any, err: Error) =>
  Email.updateOne({ _id: p.emailId, status: 'generating' }, { $set: { status: 'failed', error: `Draft generation failed: ${err.message}` } });

const emailSend: Handler = async ({ emailId }) => {
  if (n8n()) {
    await dispatchToN8n('emailSend', { emailId });
    return;
  }
  const msg = await precheckSend(emailId);
  if (!msg.allowed) throw new PermanentError(`Blocked: ${(msg as any).reasons.join(' ')}`);
  const m = msg as any;
  try {
    const id = await sendSmtp({ from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html, headers: m.headers });
    await markEmailResult(emailId, { status: 'sent', providerMessageId: id });
  } catch (e: any) {
    await markEmailResult(emailId, { status: 'failed', error: e.message });
    throw new PermanentError(e.message);
  }
};

const marketplaceReview: Handler = async (p) => {
  if (p.event === 'purchase_completed') {
    if (n8n()) {
      const purchase = await MarketplacePurchase.findById(p.purchaseId).lean();
      if (purchase) await dispatchToN8n('marketplace', { event: 'purchase_completed', purchaseId: p.purchaseId, listingId: String(purchase.listingId), buyerOrgId: String(purchase.buyerOrgId), sellerOrgId: String(purchase.sellerOrgId), priceCredits: purchase.priceCredits });
    }
    return;
  }
  const listing = await MarketplaceListing.findById(p.listingId).lean();
  if (!listing) return;
  if (n8n()) {
    await dispatchToN8n('marketplace', { event: 'listing_created', listingId: p.listingId, preview: listing.preview, priceCredits: listing.priceCredits });
    return;
  }
  const issues = reviewPreview(listing.preview);
  await applyReview(p.listingId, issues.length === 0, issues, 'rules');
};

const maintenance: Handler = async () => {
  const r = await runMaintenance(env.PLACES_CACHE_DAYS);
  logger.info(r, 'maintenance done');
};

export const handlers: Record<JobType, Handler> = {
  discovery, analysis, email_generate: emailGenerate, email_send: emailSend, marketplace_review: marketplaceReview, maintenance
};

export function startWorker(concurrency = 3) {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const worked = await runNext(handlers);
        if (!worked) await sleep(1500);
      } catch (e: any) {
        logger.error({ err: e.message }, 'worker loop error');
        await sleep(3000);
      }
    }
  };
  for (let i = 0; i < concurrency; i++) loop();
  // Daily maintenance (direct mode; in n8n mode Workflow 5's schedule calls the endpoint)
  const timer = setInterval(() => { if (!n8n()) enqueue('maintenance', {}).catch(() => undefined); }, 24 * 3600_000);
  logger.info(`Worker started (concurrency ${concurrency})`);
  return () => { stopped = true; clearInterval(timer); };
}

// Standalone worker process: `node dist/jobs/worker.js`
if (require.main === module) {
  mongoose.connect(env.MONGODB_URI).then(() => startWorker(5));
}
