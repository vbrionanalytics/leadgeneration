import { Router } from 'express';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { PLANS, PlanId } from '../config/plans';
import { Lead, Organization, SearchJob } from '../models';
import { asyncH, requireScope, validate } from '../middleware';
import { classifyEmail, deriveBasis } from '../services/compliance';
import { audit } from '../services/integrations';
import { requestAnalysis } from '../services/pipeline';
import { enqueue } from '../services/queue';
import { badRequest, escapeRegex, notFound } from '../utils';
import { env } from '../config/env';

const googleAvailable = () => env.GOOGLE_PLACES_ENABLED || (env.AUTOMATION_MODE === 'direct' && !!env.GOOGLE_PLACES_API_KEY);
import { Types } from 'mongoose';

// ============================================================ Search jobs
export const searchRouter = Router();

searchRouter.post('/', requireScope('search:write'), validate(z.object({
  category: z.string().min(2).max(80),
  country: z.string().length(2),
  city: z.string().max(80).optional(),
  keywords: z.string().max(80).optional(),
  maxResults: z.number().int().min(1).max(500).default(20),
  autoAnalyze: z.boolean().default(false),
  provider: z.enum(['openstreetmap', 'google_places']).default('openstreetmap')
})), asyncH(async (req, res) => {
  if (req.body.provider === 'google_places' && !googleAvailable()) throw badRequest('Google Places isn\'t set up yet. Use OpenStreetMap (free) or ask your admin to add a Google Places key.');
  if (req.body.provider === 'openstreetmap' && !req.body.city) throw badRequest('Enter a city to search OpenStreetMap.');
  const org = await Organization.findById(req.auth!.orgId);
  const plan = PLANS[org!.plan as PlanId];
  if (req.body.maxResults > plan.maxResultsPerSearch) throw badRequest(`Your plan allows up to ${plan.maxResultsPerSearch} results per search.`);
  if (org!.credits < 1) throw badRequest('You have no credits left. Top up to run searches.');
  const running = await SearchJob.countDocuments({ orgId: req.auth!.orgId, status: { $in: ['queued', 'running'] } });
  if (running >= 3) throw badRequest('You already have 3 searches running. Wait for one to finish.');
  const { autoAnalyze, ...query } = req.body;
  query.country = query.country.toUpperCase();
  const job = await SearchJob.create({ orgId: req.auth!.orgId, userId: req.auth!.userId, query, autoAnalyze });
  // Public map servers are often busy for a few minutes; keep retrying (30s, 1m, 2m, 4m, 8m)
  await enqueue('discovery', { jobId: String(job._id) }, req.auth!.orgId, 0, 6);
  await audit('search.create', { orgId: req.auth!.orgId, userId: req.auth!.userId, target: String(job._id), meta: query, req });
  res.status(202).json(job);
}));

searchRouter.get('/providers', (_req, res) => {
  res.json({
    providers: [
      { id: 'openstreetmap', name: 'OpenStreetMap', free: true, available: true, note: 'Free. Coverage depends on local mapping; best in larger cities.' },
      { id: 'google_places', name: 'Google Places', free: false, available: googleAvailable(), note: 'Most complete business data. Billed per search by Google.' }
    ],
    aiEnabled: env.AI_ENABLED
  });
});

searchRouter.get('/', asyncH(async (req, res) => {
  res.json(await SearchJob.find({ orgId: req.auth!.orgId }).sort({ createdAt: -1 }).limit(50));
}));

searchRouter.get('/:id', asyncH(async (req, res) => {
  const job = await SearchJob.findOne({ _id: req.params.id, orgId: req.auth!.orgId });
  if (!job) throw notFound();
  res.json(job);
}));

searchRouter.post('/:id/cancel', asyncH(async (req, res) => {
  await SearchJob.updateOne({ _id: req.params.id, orgId: req.auth!.orgId, status: { $in: ['queued', 'running'] } }, { $set: { status: 'cancelled', finishedAt: new Date() } });
  res.json({ ok: true });
}));

// ============================================================ Leads
export const leadsRouter = Router();

const listQuery = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  minScore: z.coerce.number().optional(),
  maxScore: z.coerce.number().optional(),
  country: z.string().optional(),
  city: z.string().optional(),
  category: z.string().optional(),
  analysisStatus: z.string().optional(),
  hasEmail: z.enum(['true', 'false']).optional(),
  hasWebsite: z.enum(['true', 'false']).optional(),
  searchJobId: z.string().optional(),
  tag: z.string().optional(),
  sort: z.enum(['-score', 'score', '-createdAt', 'createdAt', 'name']).default('-createdAt'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25)
});

function buildFilter(orgId: Types.ObjectId, q: z.infer<typeof listQuery>) {
  const f: Record<string, any> = { orgId };
  if (q.q) f.name = { $regex: escapeRegex(q.q), $options: 'i' };
  if (q.status) f.status = { $in: q.status.split(',') };
  if (q.minScore != null || q.maxScore != null) f.score = { ...(q.minScore != null ? { $gte: q.minScore } : {}), ...(q.maxScore != null ? { $lte: q.maxScore } : {}) };
  if (q.country) f.country = q.country.toUpperCase();
  if (q.city) f.city = { $regex: `^${escapeRegex(q.city)}`, $options: 'i' };
  if (q.category) f.category = { $regex: escapeRegex(q.category), $options: 'i' };
  if (q.analysisStatus) f.analysisStatus = q.analysisStatus;
  if (q.hasEmail === 'true') f['contacts.type'] = 'email';
  if (q.hasEmail === 'false') f['contacts.type'] = { $ne: 'email' };
  if (q.hasWebsite === 'true') f.website = { $exists: true, $nin: [null, ''] };
  if (q.hasWebsite === 'false') f.$or = [{ website: { $exists: false } }, { website: null }, { website: '' }];
  if (q.searchJobId) f.searchJobId = q.searchJobId;
  if (q.tag) f.tags = q.tag;
  return f;
}

leadsRouter.get('/', requireScope('leads:read'), validate(listQuery, 'query'), asyncH(async (req, res) => {
  const q = (req as any).validQuery as z.infer<typeof listQuery>;
  const filter = buildFilter(req.auth!.orgId, q);
  const sortField = q.sort.replace('-', '');
  const sort: Record<string, 1 | -1> = { [sortField]: q.sort.startsWith('-') ? -1 : 1, _id: -1 };
  const [items, total] = await Promise.all([
    Lead.find(filter).select('-website_analysis -dedupeKeys').sort(sort).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Lead.countDocuments(filter)
  ]);
  res.json({ items, total, page: q.page, pages: Math.ceil(total / q.limit) });
}));

leadsRouter.get('/stats', asyncH(async (req, res) => {
  const orgId = req.auth!.orgId;
  const leads = await Lead.find({ orgId }).select('status score country analysisStatus createdAt').lean();
  const byStatus: Record<string, number> = {};
  const byCountry: Record<string, number> = {};
  const scoreBuckets = [0, 0, 0, 0, 0];
  let analysed = 0;
  for (const l of leads) {
    byStatus[l.status] = (byStatus[l.status] || 0) + 1;
    if (l.country) byCountry[l.country] = (byCountry[l.country] || 0) + 1;
    if (l.score != null) { scoreBuckets[Math.min(4, Math.floor(l.score / 20))]++; analysed++; }
  }
  const since = new Date(Date.now() - 13 * 86400_000);
  const daily: Record<string, number> = {};
  for (let i = 0; i < 14; i++) daily[new Date(since.getTime() + i * 86400_000).toISOString().slice(0, 10)] = 0;
  for (const l of leads) { const d = new Date(l.createdAt as any).toISOString().slice(0, 10); if (d in daily) daily[d]++; }
  res.json({ total: leads.length, analysed, byStatus, byCountry, scoreBuckets, daily });
}));

leadsRouter.get('/export', requireScope('leads:read'), validate(listQuery.omit({ page: true, limit: true }), 'query'), asyncH(async (req, res) => {
  const q = (req as any).validQuery;
  const leads = await Lead.find(buildFilter(req.auth!.orgId, q)).sort({ score: -1 }).limit(10000).lean();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AI LeadGen';
  const ws = wb.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Business', key: 'name', width: 32 }, { header: 'Category', key: 'category', width: 20 }, { header: 'City', key: 'city', width: 16 },
    { header: 'Country', key: 'country', width: 9 }, { header: 'Score', key: 'score', width: 8 }, { header: 'Status', key: 'status', width: 12 },
    { header: 'Website', key: 'website', width: 30 }, { header: 'Phone', key: 'phone', width: 18 }, { header: 'Emails', key: 'emails', width: 32 },
    { header: 'Email source', key: 'emailSource', width: 34 }, { header: 'Top opportunities', key: 'opps', width: 44 },
    { header: 'Recommended services', key: 'services', width: 34 }, { header: 'Score summary', key: 'summary', width: 50 },
    { header: 'Scored by', key: 'scoredBy', width: 10 }, { header: 'Listing', key: 'maps', width: 34 }, { header: 'Source', key: 'source', width: 14 }, { header: 'Added', key: 'createdAt', width: 12 }
  ];
  for (const l of leads as any[]) {
    const emails = (l.contacts || []).filter((c: any) => c.type === 'email');
    ws.addRow({
      ...l, emails: emails.map((e: any) => e.value).join(', '), emailSource: emails.map((e: any) => e.sourceUrl || e.source).join(', '),
      opps: (l.opportunities || []).map((o: any) => o.title).join('; '), services: (l.recommendedServices || []).map((s: any) => s.name).join('; '),
      summary: l.scoreSummary, maps: l.googleMapsUrl || l.listingUrl, source: l.source === 'openstreetmap' ? 'OpenStreetMap' : l.source === 'google_places' ? 'Google Places' : l.source, createdAt: new Date(l.createdAt)
    });
  }
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  ws.autoFilter = { from: 'A1', to: 'Q1' };
  if ((leads as any[]).some((x) => x.source === 'openstreetmap')) {
    ws.addRow([]);
    ws.addRow(['Business data from OpenStreetMap: © OpenStreetMap contributors, available under the Open Database Licence (ODbL).']);
  }
  await audit('leads.export', { orgId: req.auth!.orgId, userId: req.auth!.userId, meta: { count: leads.length }, req });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

leadsRouter.get('/:id', requireScope('leads:read'), asyncH(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, orgId: req.auth!.orgId }).select('-dedupeKeys');
  if (!lead) throw notFound();
  res.json(lead);
}));

leadsRouter.patch('/:id', requireScope('leads:write'), validate(z.object({
  status: z.enum(['new', 'qualified', 'contacted', 'replied', 'won', 'lost', 'do_not_contact']).optional(),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(30)).max(20).optional()
})), asyncH(async (req, res) => {
  const lead = await Lead.findOneAndUpdate({ _id: req.params.id, orgId: req.auth!.orgId }, { $set: req.body }, { returnDocument: 'after' });
  if (!lead) throw notFound();
  res.json(lead);
}));

leadsRouter.post('/:id/contacts', requireScope('leads:write'), validate(z.object({
  type: z.enum(['email', 'phone', 'whatsapp', 'linkedin']),
  value: z.string().min(3).max(200),
  source: z.enum(['manual', 'consent_form', 'website_public']),
  sourceUrl: z.string().url().optional(),
  consentConfirmed: z.boolean().optional()
})), asyncH(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, orgId: req.auth!.orgId });
  if (!lead) throw notFound();
  const b = req.body;
  if (b.type === 'email' && !z.string().email().safeParse(b.value).success) throw badRequest('Invalid email');
  if (b.source === 'website_public' && !b.sourceUrl) throw badRequest('Provide the page URL where this contact is published.');
  if (b.source === 'consent_form' && !b.consentConfirmed) throw badRequest('Confirm you hold recorded consent for this contact.');
  const org = await Organization.findById(req.auth!.orgId).select('compliance');
  const kind = b.type === 'email' ? classifyEmail(b.value) : 'unknown';
  lead.contacts.push({ ...b, value: b.type === 'email' ? b.value.toLowerCase() : b.value, kind, consentBasis: deriveBasis(b.source, kind, !!org?.compliance?.legitimateInterestAssessed) });
  await lead.save();
  await audit('lead.contact_add', { orgId: req.auth!.orgId, userId: req.auth!.userId, target: String(lead._id), meta: { source: b.source }, req });
  res.status(201).json(lead);
}));

leadsRouter.delete('/:id/contacts/:contactId', requireScope('leads:write'), asyncH(async (req, res) => {
  await Lead.updateOne({ _id: req.params.id, orgId: req.auth!.orgId }, { $pull: { contacts: { _id: req.params.contactId } } });
  res.json({ ok: true });
}));

leadsRouter.post('/analyze', requireScope('leads:write'), validate(z.object({ leadIds: z.array(z.string()).min(1).max(200) })), asyncH(async (req, res) => {
  const owned = await Lead.find({ _id: { $in: req.body.leadIds }, orgId: req.auth!.orgId }).select('_id');
  const n = await requestAnalysis(req.auth!.orgId, owned.map((l) => l._id));
  res.status(202).json({ queued: n });
}));

leadsRouter.post('/bulk', requireScope('leads:write'), validate(z.object({
  leadIds: z.array(z.string()).min(1).max(500),
  action: z.enum(['status', 'tag', 'delete']),
  status: z.string().optional(),
  tag: z.string().max(30).optional()
})), asyncH(async (req, res) => {
  const filter = { _id: { $in: req.body.leadIds }, orgId: req.auth!.orgId };
  let n = 0;
  if (req.body.action === 'status') n = (await Lead.updateMany(filter, { $set: { status: req.body.status } })).modifiedCount;
  if (req.body.action === 'tag') n = (await Lead.updateMany(filter, { $addToSet: { tags: req.body.tag } })).modifiedCount;
  if (req.body.action === 'delete') n = (await Lead.deleteMany(filter)).deletedCount;
  await audit(`leads.bulk_${req.body.action}`, { orgId: req.auth!.orgId, userId: req.auth!.userId, meta: { n }, req });
  res.json({ affected: n });
}));

leadsRouter.delete('/:id', requireScope('leads:write'), asyncH(async (req, res) => {
  const r = await Lead.deleteOne({ _id: req.params.id, orgId: req.auth!.orgId });
  if (!r.deletedCount) throw notFound();
  res.json({ ok: true });
}));
