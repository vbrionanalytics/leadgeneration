import { Router, urlencoded } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { PLANS, PlanId } from '../config/plans';
import { AuditLog, Email, Job, Lead, MarketplaceListing, MarketplacePurchase, Organization, SearchJob, Suppression, User } from '../models';
import { asyncH, requireN8n, requirePlatformAdmin, validate } from '../middleware';
import { DraftSchema, ScoreResult, sanitizeScore, heuristicScore } from '../services/ai';
import { addCredits } from '../services/credits';
import { audit } from '../services/integrations';
import { applyReview, runMaintenance } from '../services/marketplace';
import { applyAnalysis, failAnalysis, failSearchJob, ingestDiscoveryResults, markEmailResult, precheckSend, saveDraft } from '../services/pipeline';
import { mapPlace } from '../services/places';
import { badRequest, logger, notFound } from '../utils';

// ============================================================ n8n → backend callbacks
export const n8nRouter = Router();
n8nRouter.use(requireN8n);

n8nRouter.get('/health', (_req, res) => res.json({ ok: true, service: 'ai-leadgen', time: new Date().toISOString() }));

/** Workflow 1: discovery results. Accepts raw Places API objects or pre-normalised records. */
n8nRouter.post('/discovery/:jobId/results', validate(z.object({ places: z.array(z.any()).max(500).default([]), final: z.boolean().default(true) })), asyncH(async (req, res) => {
  const job = await SearchJob.findById(req.params.jobId).select('query status');
  if (!job) throw notFound('Job not found');
  if (job.status === 'queued') await SearchJob.updateOne({ _id: job._id }, { $set: { status: 'running', startedAt: new Date() } });
  const places = req.body.places
    .map((p: any) => (p?.displayName ? mapPlace(p, job.query!.country) : p))
    .filter((p: any) => p?.sourceId && p?.name && p.businessStatus !== 'CLOSED_PERMANENTLY');
  const result = await ingestDiscoveryResults(String(req.params.jobId), places, req.body.final);
  res.json(result);
}));

n8nRouter.post('/discovery/:jobId/failed', validate(z.object({ error: z.string().default('Unknown error') })), asyncH(async (req, res) => {
  await failSearchJob(String(req.params.jobId), `n8n: ${req.body.error}`);
  res.json({ ok: true });
}));

/** Workflow 2: analysis + AI score. The score is re-validated server-side. */
n8nRouter.post('/analysis/:leadId', validate(z.object({ analysis: z.any().nullable(), score: z.any().optional() })), asyncH(async (req, res) => {
  const lead = await Lead.findById(req.params.leadId);
  if (!lead) throw notFound('Lead not found');
  const org = await Organization.findById(lead.orgId).select('services');
  const services = (org?.services || []).map((s: any) => ({ name: s.name, description: s.description }));
  const analysis = req.body.analysis && typeof req.body.analysis === 'object' ? req.body.analysis : null;
  let score: ScoreResult;
  try {
    score = { ...sanitizeScore(typeof req.body.score === 'string' ? JSON.parse(req.body.score) : req.body.score, services), scoredBy: 'claude' };
  } catch (e: any) {
    logger.warn({ leadId: req.params.leadId, err: e.message }, 'Invalid AI score from n8n; using heuristic');
    score = heuristicScore(lead.toObject() as any, analysis, services);
  }
  const updated = await applyAnalysis(String(req.params.leadId), analysis, score);
  res.json({ ok: true, score: updated.score, scoredBy: updated.scoredBy });
}));

n8nRouter.post('/analysis/:leadId/failed', validate(z.object({ error: z.string().default('Unknown error') })), asyncH(async (req, res) => {
  await failAnalysis(String(req.params.leadId), req.body.error);
  res.json({ ok: true });
}));

/** Workflow 3: AI draft. Stored as pending_approval; never sent automatically. */
n8nRouter.post('/emails/:emailId/draft', asyncH(async (req, res) => {
  const raw = typeof req.body.draft === 'string' ? JSON.parse(req.body.draft) : req.body.draft ?? req.body;
  const d = DraftSchema.safeParse(raw);
  if (!d.success) throw badRequest('Invalid draft', d.error.flatten().fieldErrors);
  const e = await saveDraft(String(req.params.emailId), d.data.subject, d.data.body);
  res.json({ ok: true, status: e.status });
}));

n8nRouter.post('/emails/:emailId/draft-failed', validate(z.object({ error: z.string().default('Unknown error') })), asyncH(async (req, res) => {
  await Email.updateOne({ _id: req.params.emailId, status: 'generating' }, { $set: { status: 'failed', error: `Draft generation failed: ${req.body.error}` } });
  res.json({ ok: true });
}));

/** Workflow 4: final pre-send gate (approval + suppression + compliance), returns the rendered message. */
n8nRouter.post('/emails/:emailId/precheck', asyncH(async (req, res) => {
  res.json(await precheckSend(String(req.params.emailId)));
}));

n8nRouter.post('/emails/:emailId/status', validate(z.object({ status: z.enum(['sent', 'failed']), providerMessageId: z.string().optional(), error: z.string().optional() })), asyncH(async (req, res) => {
  const e = await markEmailResult(String(req.params.emailId), req.body);
  res.json({ ok: true, status: e.status });
}));

/** Workflow 5: marketplace review outcome. Rule checks are re-applied server-side. */
n8nRouter.post('/marketplace/listings/:id/review', validate(z.object({ passed: z.boolean(), issues: z.array(z.string()).default([]) })), asyncH(async (req, res) => {
  const l = await applyReview(String(req.params.id), req.body.passed, req.body.issues, 'n8n');
  res.json({ ok: true, status: l.status });
}));

n8nRouter.post('/maintenance/run', asyncH(async (_req, res) => {
  res.json(await runMaintenance(env.PLACES_CACHE_DAYS));
}));

// ============================================================ Public: unsubscribe & tracking
export const publicRouter = Router();
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

publicRouter.get('/t/o/:id.gif', asyncH(async (req, res) => {
  const now = new Date();
  await Email.updateOne({ trackingId: req.params.id }, { $inc: { opens: 1 } });
  await Email.updateOne({ trackingId: req.params.id, firstOpenedAt: null }, { $set: { firstOpenedAt: now } });
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' }).send(PIXEL);
}));

async function unsubscribe(token: string) {
  const email = await Email.findOne({ unsubscribeToken: token });
  if (!email) return null;
  await Suppression.updateOne({ orgId: email.orgId, value: email.to }, { $set: { type: 'email', reason: 'unsubscribed', source: 'link' } }, { upsert: true });
  await Lead.updateOne({ _id: email.leadId }, { $set: { status: 'do_not_contact' } });
  await audit('email.unsubscribe', { orgId: email.orgId, target: email.to });
  return email;
}

const page = (title: string, msg: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;padding:32px;border-radius:12px;max-width:420px;box-shadow:0 1px 3px #0001;text-align:center}button{background:#4f46e5;color:#fff;border:0;padding:10px 18px;border-radius:8px;font-size:15px;cursor:pointer}</style></head><body><main>${msg}</main></body></html>`;

publicRouter.get('/u/:token', asyncH(async (req, res) => {
  const email = await Email.findOne({ unsubscribeToken: req.params.token }).select('to');
  if (!email) return res.status(404).send(page('Not found', '<h2>Link not found</h2><p>This unsubscribe link is invalid or has expired.</p>'));
  res.send(page('Unsubscribe', `<h2>Unsubscribe</h2><p>Stop all future emails to <b>${email.to.replace(/</g, '')}</b> from this sender?</p><form method="post"><button>Unsubscribe</button></form>`));
}));

// Handles both the confirmation form and RFC 8058 one-click (List-Unsubscribe-Post)
publicRouter.post('/u/:token', urlencoded({ extended: false }), asyncH(async (req, res) => {
  const ok = await unsubscribe(String(req.params.token));
  if (!ok) return res.status(404).send(page('Not found', '<h2>Link not found</h2>'));
  res.send(page('Unsubscribed', '<h2>You are unsubscribed</h2><p>You will not receive further emails from this sender.</p>'));
}));

// ============================================================ Platform admin
export const adminRouter = Router();
adminRouter.use(requirePlatformAdmin);

adminRouter.get('/overview', asyncH(async (_req, res) => {
  const [orgs, users, leads, emailsSent, searches, listings, purchases, failedJobs, planCounts] = await Promise.all([
    Organization.countDocuments(), User.countDocuments(), Lead.countDocuments(), Email.countDocuments({ status: 'sent' }),
    SearchJob.countDocuments(), MarketplaceListing.countDocuments({ status: 'active' }), MarketplacePurchase.countDocuments(),
    Job.countDocuments({ status: 'failed' }), Organization.find().select('plan').lean()
  ]);
  const plans: Record<string, number> = {};
  for (const o of planCounts) plans[o.plan] = (plans[o.plan] || 0) + 1;
  const mrr = Object.entries(plans).reduce((s, [p, n]) => s + (PLANS[p as PlanId]?.priceInrMonthly || 0) * n, 0);
  res.json({ orgs, users, leads, emailsSent, searches, activeListings: listings, purchases, failedJobs, plans, mrrInr: mrr, automationMode: env.AUTOMATION_MODE });
}));

adminRouter.get('/organizations', asyncH(async (_req, res) => {
  const orgs = await Organization.find().select('-secrets').sort({ createdAt: -1 }).limit(500).lean();
  const leadCounts = await Lead.aggregate([{ $group: { _id: '$orgId', n: { $sum: 1 } } }]);
  const map = new Map(leadCounts.map((l) => [String(l._id), l.n]));
  res.json(orgs.map((o) => ({ ...o, leadCount: map.get(String(o._id)) || 0 })));
}));

adminRouter.patch('/organizations/:id', validate(z.object({ plan: z.enum(['free', 'starter', 'growth', 'agency']).optional(), status: z.enum(['active', 'suspended']).optional() })), asyncH(async (req, res) => {
  await Organization.updateOne({ _id: req.params.id }, { $set: req.body });
  const o = await Organization.findById(req.params.id).select('-secrets');
  if (!o) throw notFound();
  await audit('admin.org_update', { userId: req.auth!.userId, target: String(o._id), meta: req.body, req });
  res.json(o);
}));

adminRouter.post('/organizations/:id/credits', validate(z.object({ amount: z.number().int().min(-100000).max(100000), reason: z.string().min(3) })), asyncH(async (req, res) => {
  const bal = await addCredits(String(req.params.id), req.body.amount, 'adjustment', `Admin: ${req.body.reason}`);
  await audit('admin.credits', { userId: req.auth!.userId, target: String(req.params.id), meta: req.body, req });
  res.json({ credits: bal });
}));

adminRouter.get('/jobs', asyncH(async (_req, res) => {
  res.json(await Job.find({ status: { $in: ['failed', 'running', 'pending'] } }).sort({ updatedAt: -1 }).limit(100).lean());
}));

adminRouter.post('/jobs/:id/retry', asyncH(async (req, res) => {
  await Job.updateOne({ _id: req.params.id, status: 'failed' }, { $set: { status: 'pending', attempts: 0, runAt: new Date() } });
  res.json({ ok: true });
}));

adminRouter.get('/audit', asyncH(async (_req, res) => {
  res.json(await AuditLog.find().sort({ createdAt: -1 }).limit(300).lean());
}));

adminRouter.get('/listings', asyncH(async (_req, res) => {
  res.json(await MarketplaceListing.find().sort({ createdAt: -1 }).limit(200).lean());
}));

adminRouter.post('/listings/:id/review', validate(z.object({ passed: z.boolean(), issues: z.array(z.string()).default([]) })), asyncH(async (req, res) => {
  res.json(await applyReview(String(req.params.id), req.body.passed, req.body.issues, `admin:${req.auth!.userId}`));
}));

adminRouter.post('/suppressions', validate(z.object({ value: z.string().min(3), reason: z.enum(['legal_request', 'complaint', 'manual']) })), asyncH(async (req, res) => {
  const v = req.body.value.toLowerCase();
  // Global suppression: applies to every tenant
  await Suppression.updateOne({ orgId: null, value: v }, { $set: { type: v.startsWith('@') ? 'domain' : 'email', reason: req.body.reason, source: 'admin' } }, { upsert: true });
  await audit('admin.global_suppression', { userId: req.auth!.userId, target: v, req });
  res.status(201).json({ ok: true });
}));
