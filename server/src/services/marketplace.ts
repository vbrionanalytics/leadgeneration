/**
 * Lead marketplace. Licensing rule: Google Places content (address, phone, rating, reviews)
 * may not be resold, so only the seller's own work product travels with a sale —
 * the place_id (storable), website, AI analysis, and contacts the seller found on the
 * business's own public website or collected with consent. Buyers refresh Places data
 * with their own key.
 */
import { Types } from 'mongoose';
import { env } from '../config/env';
import { PLANS, PlanId } from '../config/plans';
import { ruleFor } from '../config/compliance';
import { Lead, MarketplaceListing, MarketplacePurchase, Organization, CreditTxn } from '../models';
import { badRequest, conflict, dedupeKeys, forbidden, notFound } from '../utils';
import { addCredits, spendCredits } from './credits';
import { enqueue } from './queue';

const TRANSFERABLE_SOURCES = ['website_public', 'consent_form'];

export function eligibility(lead: any): string[] {
  const issues: string[] = [];
  if (lead.analysisStatus !== 'done' || lead.score == null) issues.push('Lead must be analysed and scored before listing.');
  if (lead.status === 'do_not_contact') issues.push('Lead is marked Do Not Contact.');
  if (lead.source === 'marketplace' || lead.purchasedFromListingId) issues.push('Purchased leads cannot be resold.');
  if (!lead.contacts?.some((c: any) => TRANSFERABLE_SOURCES.includes(c.source))) issues.push('Lead needs at least one contact found on the business website or collected with consent (Places data is not resellable).');
  const rule = ruleFor(lead.country);
  if (rule.coldEmailBasis.generic_business === 'express_consent' && !lead.contacts?.some((c: any) => c.consentBasis === 'express_consent'))
    issues.push(`${rule.name} requires express consent for marketing email; only consent-based leads can be sold there.`);
  return issues;
}

const PII = /([\w.+-]+@[\w-]+\.[\w.]+)|(\+?\d[\d\s-]{7,}\d)/;

export function reviewPreview(preview: any): string[] {
  const issues: string[] = [];
  const text = JSON.stringify(preview);
  if (PII.test(text)) issues.push('Preview contains contact details.');
  if (!preview.category || !preview.country) issues.push('Preview is missing category or country.');
  return issues;
}

export async function createListing(orgId: Types.ObjectId | string, input: { leadId: string; priceCredits: number; exclusive?: boolean; maxSales?: number }) {
  const org = await Organization.findById(orgId);
  if (!org) throw notFound();
  if (!PLANS[org.plan as PlanId].marketplaceSelling) throw forbidden('Marketplace selling requires the Growth plan or higher.');
  const lead = await Lead.findOne({ _id: input.leadId, orgId });
  if (!lead) throw notFound('Lead not found');
  const issues = eligibility(lead);
  if (issues.length) throw badRequest('Lead is not eligible for the marketplace.', issues);
  if (await MarketplaceListing.exists({ leadId: lead._id, status: { $in: ['pending_review', 'active'] } })) throw conflict('Lead is already listed.');

  const preview = {
    title: `${lead.category || 'Business'} in ${lead.city || lead.country}`,
    category: lead.category, city: lead.city, country: lead.country, score: lead.score,
    opportunities: (lead.opportunities || []).map((o: any) => o.title).slice(0, 4),
    hasEmail: lead.contacts.some((c: any) => c.type === 'email' && TRANSFERABLE_SOURCES.includes(c.source)),
    hasPhone: lead.contacts.some((c: any) => c.type === 'phone' && TRANSFERABLE_SOURCES.includes(c.source)),
    hasWebsite: !!lead.website
  };
  const listing = await MarketplaceListing.create({
    sellerOrgId: orgId, leadId: lead._id, preview, priceCredits: input.priceCredits,
    exclusive: !!input.exclusive, maxSales: input.exclusive ? 1 : input.maxSales ?? 5,
    expiresAt: new Date(Date.now() + 30 * 86400_000)
  });
  await enqueue('marketplace_review', { listingId: String(listing._id) }, orgId);
  return listing;
}

export async function applyReview(listingId: string, passed: boolean, issues: string[], by: string) {
  const listing = await MarketplaceListing.findById(listingId);
  if (!listing) throw notFound('Listing not found');
  if (listing.status !== 'pending_review') return listing;
  const ruleIssues = reviewPreview(listing.preview);
  const allIssues = [...issues, ...ruleIssues];
  const ok = passed && ruleIssues.length === 0;
  listing.status = ok ? 'active' : 'rejected';
  listing.review = { passed: ok, issues: allIssues, reviewedAt: new Date(), by } as any;
  await listing.save();
  return listing;
}

export async function purchase(buyerOrgId: Types.ObjectId | string, listingId: string) {
  const listing = await MarketplaceListing.findById(listingId);
  if (!listing || listing.status !== 'active') throw notFound('Listing is not available.');
  if (String(listing.sellerOrgId) === String(buyerOrgId)) throw badRequest('You cannot buy your own listing.');
  if (listing.expiresAt && listing.expiresAt < new Date()) throw badRequest('Listing has expired.');
  if (await MarketplacePurchase.exists({ listingId: listing._id, buyerOrgId })) throw conflict('You already bought this lead.');
  const src = await Lead.findById(listing.leadId);
  if (!src) throw notFound('Source lead no longer exists.');

  const keys = dedupeKeys({ sourceId: src.sourceId ?? undefined, website: src.website ?? undefined, name: src.name, city: src.city ?? undefined, country: src.country ?? undefined });
  if (await Lead.exists({ orgId: buyerOrgId, dedupeKeys: { $in: keys } })) throw conflict('You already have this business in your leads.');

  // Reserve a sale slot atomically
  const slot = await MarketplaceListing.findOneAndUpdate(
    { _id: listing._id, status: 'active', salesCount: { $lt: listing.maxSales } },
    { $inc: { salesCount: 1 } },
    { returnDocument: 'after' }
  );
  if (!slot) throw conflict('Listing just sold out.');

  try {
    await spendCredits(buyerOrgId, listing.priceCredits, `Marketplace purchase ${listing.preview?.title}`, String(listing._id), 'marketplace_purchase');
  } catch (e) {
    await MarketplaceListing.updateOne({ _id: listing._id }, { $inc: { salesCount: -1 } });
    throw e;
  }
  const fee = Math.ceil((listing.priceCredits * env.MARKETPLACE_FEE_PERCENT) / 100);
  await addCredits(listing.sellerOrgId, listing.priceCredits - fee, 'marketplace_sale', `Sold: ${listing.preview?.title}`, String(listing._id));
  if (slot.salesCount >= slot.maxSales) await MarketplaceListing.updateOne({ _id: listing._id }, { $set: { status: 'sold_out' } });

  const delivered = await Lead.create({
    orgId: buyerOrgId, source: 'marketplace', sourceId: src.sourceId, name: src.name, category: src.category, city: src.city,
    country: src.country, website: src.website, dedupeKeys: keys, purchasedFromListingId: listing._id,
    contacts: src.contacts.filter((c: any) => TRANSFERABLE_SOURCES.includes(c.source)).map((c: any) => ({
      type: c.type, value: c.value, kind: c.kind, source: c.source === 'consent_form' ? 'consent_form' : 'marketplace', sourceUrl: c.sourceUrl, consentBasis: c.consentBasis
    })),
    score: src.score, scoreBreakdown: src.scoreBreakdown, scoreSummary: src.scoreSummary, scoredBy: src.scoredBy,
    evidence: (src.evidence || []).filter((e: any) => e.source !== 'google_places'),
    opportunities: src.opportunities, analysisStatus: 'done', analyzedAt: src.analyzedAt, website_analysis: src.website_analysis,
    tags: ['marketplace']
  });
  const p = await MarketplacePurchase.create({
    listingId: listing._id, buyerOrgId, sellerOrgId: listing.sellerOrgId, priceCredits: listing.priceCredits, feeCredits: fee, deliveredLeadId: delivered._id
  });
  await enqueue('marketplace_review', { event: 'purchase_completed', purchaseId: String(p._id) }, buyerOrgId);
  return { purchase: p, lead: delivered };
}

export async function sellerStats(orgId: Types.ObjectId | string) {
  const [listings, sales, earned] = await Promise.all([
    MarketplaceListing.countDocuments({ sellerOrgId: orgId, status: 'active' }),
    MarketplacePurchase.countDocuments({ sellerOrgId: orgId }),
    CreditTxn.find({ orgId, type: 'marketplace_sale' }).select('amount').lean()
  ]);
  return { activeListings: listings, sales, creditsEarned: earned.reduce((a, t) => a + t.amount, 0) };
}

/** Daily maintenance: expire listings and purge cached Places content past the retention window. */
export async function runMaintenance(placesCacheDays: number) {
  const expired = await MarketplaceListing.updateMany({ status: 'active', expiresAt: { $lt: new Date() } }, { $set: { status: 'expired' } });
  const cutoff = new Date(Date.now() - placesCacheDays * 86400_000);
  const purged = await Lead.updateMany(
    { source: 'google_places', placesFetchedAt: { $lt: cutoff } },
    { $unset: { address: 1, rating: 1, reviewCount: 1, location: 1, businessStatus: 1 }, $set: { placesFetchedAt: null } }
  );
  return { expiredListings: expired.modifiedCount, purgedPlacesRecords: purged.modifiedCount };
}
