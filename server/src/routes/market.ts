import { Router } from 'express';
import { z } from 'zod';
import { Lead, MarketplaceListing, MarketplacePurchase } from '../models';
import { asyncH, requireUser, validate } from '../middleware';
import { audit } from '../services/integrations';
import { createListing, eligibility, purchase, sellerStats } from '../services/marketplace';
import { escapeRegex, notFound } from '../utils';

const r = Router();
r.use(requireUser);

// Buyer: browse active listings from other organisations (previews only, no contact data)
r.get('/listings', validate(z.object({ category: z.string().optional(), country: z.string().optional(), city: z.string().optional(), minScore: z.coerce.number().optional(), page: z.coerce.number().default(1) }), 'query'), asyncH(async (req, res) => {
  const q = (req as any).validQuery;
  const f: Record<string, any> = { status: 'active', sellerOrgId: { $ne: req.auth!.orgId }, expiresAt: { $gt: new Date() } };
  if (q.category) f['preview.category'] = { $regex: escapeRegex(q.category), $options: 'i' };
  if (q.country) f['preview.country'] = q.country.toUpperCase();
  if (q.city) f['preview.city'] = { $regex: `^${escapeRegex(q.city)}`, $options: 'i' };
  if (q.minScore) f['preview.score'] = { $gte: q.minScore };
  const bought = await MarketplacePurchase.find({ buyerOrgId: req.auth!.orgId }).select('listingId').lean();
  const boughtIds = new Set(bought.map((b) => String(b.listingId)));
  const [items, total] = await Promise.all([
    MarketplaceListing.find(f).select('preview priceCredits exclusive maxSales salesCount createdAt expiresAt').sort({ 'preview.score': -1 }).skip((q.page - 1) * 24).limit(24).lean(),
    MarketplaceListing.countDocuments(f)
  ]);
  res.json({ items: items.map((i) => ({ ...i, purchased: boughtIds.has(String(i._id)) })), total });
}));

r.post('/listings/:id/purchase', asyncH(async (req, res) => {
  const result = await purchase(req.auth!.orgId, String(req.params.id));
  await audit('marketplace.purchase', { orgId: req.auth!.orgId, userId: req.auth!.userId, target: String(req.params.id), req });
  res.status(201).json(result);
}));

r.get('/purchases', asyncH(async (req, res) => {
  res.json(await MarketplacePurchase.find({ buyerOrgId: req.auth!.orgId }).sort({ createdAt: -1 }).populate('deliveredLeadId', 'name city country score').populate('listingId', 'preview').lean());
}));

// Seller
r.get('/eligibility/:leadId', asyncH(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.leadId, orgId: req.auth!.orgId });
  if (!lead) throw notFound();
  const issues = eligibility(lead);
  res.json({ eligible: issues.length === 0, issues });
}));

r.post('/my-listings', validate(z.object({ leadId: z.string(), priceCredits: z.number().int().min(1).max(1000), exclusive: z.boolean().default(false), maxSales: z.number().int().min(1).max(20).default(5) })), asyncH(async (req, res) => {
  const listing = await createListing(req.auth!.orgId, req.body);
  await audit('marketplace.list', { orgId: req.auth!.orgId, userId: req.auth!.userId, target: String(listing._id), req });
  res.status(201).json(listing);
}));

r.get('/my-listings', asyncH(async (req, res) => {
  res.json(await MarketplaceListing.find({ sellerOrgId: req.auth!.orgId }).sort({ createdAt: -1 }).lean());
}));

r.post('/my-listings/:id/withdraw', asyncH(async (req, res) => {
  const l = await MarketplaceListing.findOneAndUpdate({ _id: req.params.id, sellerOrgId: req.auth!.orgId, status: { $in: ['pending_review', 'active'] } }, { $set: { status: 'withdrawn' } }, { returnDocument: 'after' });
  if (!l) throw notFound();
  res.json(l);
}));

r.get('/seller-stats', asyncH(async (req, res) => res.json(await sellerStats(req.auth!.orgId))));

export default r;
