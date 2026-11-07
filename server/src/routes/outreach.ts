import { Router } from 'express';
import { z } from 'zod';
import { Campaign, Email, Lead } from '../models';
import { asyncH, requireUser, validate } from '../middleware';
import { audit } from '../services/integrations';
import { approveEmail, createEmailDraft } from '../services/pipeline';
import { badRequest, notFound } from '../utils';

// ============================================================ Emails
export const emailsRouter = Router();
emailsRouter.use(requireUser);

emailsRouter.post('/generate', validate(z.object({ leadIds: z.array(z.string()).min(1).max(100), campaignId: z.string().optional() })), asyncH(async (req, res) => {
  const results: { leadId: string; emailId?: string; error?: string }[] = [];
  for (const leadId of req.body.leadIds) {
    try {
      const e = await createEmailDraft({ orgId: req.auth!.orgId, leadId, campaignId: req.body.campaignId });
      results.push({ leadId, emailId: String(e._id) });
    } catch (err: any) {
      results.push({ leadId, error: err.message });
      if (err.status === 402) break; // out of credits
    }
  }
  res.status(202).json({ results });
}));

emailsRouter.get('/', validate(z.object({ status: z.string().optional(), campaignId: z.string().optional(), leadId: z.string().optional(), page: z.coerce.number().default(1) }), 'query'), asyncH(async (req, res) => {
  const q = (req as any).validQuery;
  const f: Record<string, unknown> = { orgId: req.auth!.orgId };
  if (q.status) f.status = { $in: q.status.split(',') };
  if (q.campaignId) f.campaignId = q.campaignId;
  if (q.leadId) f.leadId = q.leadId;
  const [items, total] = await Promise.all([
    Email.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * 50).limit(50).populate('leadId', 'name city country score website').lean(),
    Email.countDocuments(f)
  ]);
  res.json({ items, total });
}));

emailsRouter.get('/stats', asyncH(async (req, res) => {
  const emails = await Email.find({ orgId: req.auth!.orgId }).select('status opens clicks repliedAt').lean();
  const s = { total: emails.length, pending: 0, sent: 0, opened: 0, clicked: 0, replied: 0, blocked: 0, failed: 0 };
  for (const e of emails) {
    if (e.status === 'pending_approval') s.pending++;
    if (e.status === 'sent') s.sent++;
    if (e.status === 'blocked') s.blocked++;
    if (e.status === 'failed') s.failed++;
    if ((e.opens ?? 0) > 0) s.opened++;
    if ((e.clicks ?? 0) > 0) s.clicked++;
    if (e.repliedAt) s.replied++;
  }
  res.json(s);
}));

emailsRouter.get('/:id', asyncH(async (req, res) => {
  const e = await Email.findOne({ _id: req.params.id, orgId: req.auth!.orgId }).populate('leadId', 'name city country score website evidence opportunities');
  if (!e) throw notFound();
  res.json(e);
}));

emailsRouter.patch('/:id', validate(z.object({ subject: z.string().min(3).max(120), body: z.string().min(20).max(5000) })), asyncH(async (req, res) => {
  const e = await Email.findOneAndUpdate({ _id: req.params.id, orgId: req.auth!.orgId, status: 'pending_approval' }, { $set: { ...req.body, generatedBy: 'manual' } }, { returnDocument: 'after' });
  if (!e) throw badRequest('Only pending drafts can be edited.');
  res.json(e);
}));

// Human approval gate — the only way an email can be sent.
emailsRouter.post('/:id/approve', validate(z.object({ subject: z.string().min(3).max(120).optional(), body: z.string().min(20).max(5000).optional() })), asyncH(async (req, res) => {
  const e = await approveEmail(String(req.params.id), req.auth!.orgId, req.auth!.userId!, req.body);
  await audit('email.approve', { orgId: req.auth!.orgId, userId: req.auth!.userId, target: String(e._id), req });
  res.json(e);
}));

emailsRouter.post('/:id/reject', validate(z.object({ reason: z.string().max(300).optional() })), asyncH(async (req, res) => {
  const e = await Email.findOneAndUpdate({ _id: req.params.id, orgId: req.auth!.orgId, status: 'pending_approval' }, { $set: { status: 'rejected', rejectedReason: req.body.reason } }, { returnDocument: 'after' });
  if (!e) throw badRequest('Only pending drafts can be rejected.');
  await audit('email.reject', { orgId: req.auth!.orgId, userId: req.auth!.userId, target: String(e._id), req });
  res.json(e);
}));

emailsRouter.post('/:id/mark-replied', asyncH(async (req, res) => {
  const e = await Email.findOneAndUpdate({ _id: req.params.id, orgId: req.auth!.orgId, status: 'sent' }, { $set: { repliedAt: new Date() } }, { returnDocument: 'after' });
  if (!e) throw notFound();
  await Lead.updateOne({ _id: e.leadId }, { $set: { status: 'replied' } });
  res.json(e);
}));

// ============================================================ Campaigns
export const campaignsRouter = Router();
campaignsRouter.use(requireUser);

const campaignSchema = z.object({ name: z.string().min(2).max(100), goal: z.string().max(500).optional(), tone: z.enum(['professional', 'friendly', 'concise', 'consultative']).default('professional') });

campaignsRouter.get('/', asyncH(async (req, res) => {
  const campaigns = await Campaign.find({ orgId: req.auth!.orgId }).sort({ createdAt: -1 }).lean();
  const emails = await Email.find({ orgId: req.auth!.orgId, campaignId: { $in: campaigns.map((c) => c._id) } }).select('campaignId status opens clicks repliedAt').lean();
  const stats: Record<string, any> = {};
  for (const e of emails) {
    const s = (stats[String(e.campaignId)] ??= { total: 0, pending: 0, sent: 0, opened: 0, clicked: 0, replied: 0 });
    s.total++;
    if (e.status === 'pending_approval') s.pending++;
    if (e.status === 'sent') s.sent++;
    if ((e.opens ?? 0) > 0) s.opened++;
    if ((e.clicks ?? 0) > 0) s.clicked++;
    if (e.repliedAt) s.replied++;
  }
  res.json(campaigns.map((c) => ({ ...c, stats: stats[String(c._id)] || { total: 0, pending: 0, sent: 0, opened: 0, clicked: 0, replied: 0 } })));
}));

campaignsRouter.post('/', validate(campaignSchema), asyncH(async (req, res) => {
  res.status(201).json(await Campaign.create({ ...req.body, orgId: req.auth!.orgId, createdBy: req.auth!.userId }));
}));

campaignsRouter.patch('/:id', validate(campaignSchema.partial().extend({ status: z.enum(['draft', 'active', 'paused', 'completed']).optional() })), asyncH(async (req, res) => {
  const c = await Campaign.findOneAndUpdate({ _id: req.params.id, orgId: req.auth!.orgId }, { $set: req.body }, { returnDocument: 'after' });
  if (!c) throw notFound();
  res.json(c);
}));

campaignsRouter.delete('/:id', asyncH(async (req, res) => {
  const pending = await Email.countDocuments({ campaignId: req.params.id, status: { $in: ['queued'] } });
  if (pending) throw badRequest('Campaign has emails being sent.');
  await Campaign.deleteOne({ _id: req.params.id, orgId: req.auth!.orgId });
  res.json({ ok: true });
}));
