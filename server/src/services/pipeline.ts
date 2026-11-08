/**
 * Core business operations shared by the in-process worker (direct mode) and the
 * n8n callback endpoints (n8n mode). Keeping them here means both paths enforce the
 * same dedupe, credit and compliance rules.
 */
import { Types } from 'mongoose';
import { CREDIT_COSTS } from '../config/plans';
import { Campaign, Email, Lead, Organization, SearchJob, LeadDoc } from '../models';
import { badRequest, dedupeKeys, isOwnWebsite, isUsableEmail, logger, notFound, randomToken } from '../utils';
import { classifyEmail, deriveBasis, assessOutreach } from './compliance';
import { reserveUpTo, settleReservation, spendCredits } from './credits';
import type { DiscoveredPlace } from './places';
import { ScoreResult, WebsiteAnalysis } from './ai';
import { enqueue } from './queue';
import { renderEmail } from './email';
import { templateEmail } from './templates';
import { env } from '../config/env';

// ============================================================ Discovery
export async function ingestDiscoveryResults(jobId: string, places: DiscoveredPlace[], final: boolean) {
  const job = await SearchJob.findById(jobId);
  if (!job) throw notFound('Search job not found');
  if (['completed', 'failed', 'cancelled'].includes(job.status)) return { created: 0, duplicates: 0, skipped: places.length };

  const orgId = job.orgId;
  // 1) de-duplicate within this batch
  const seen = new Set<string>();
  const unique: (DiscoveredPlace & { keys: string[] })[] = [];
  for (const p of places) {
    if (!p?.sourceId || !p?.name) continue;
    const keys = dedupeKeys(p);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    unique.push({ ...p, keys });
  }
  // 2) de-duplicate against existing org leads (place_id, domain, phone, name+city)
  const allKeys = unique.flatMap((u) => u.keys);
  const existing = allKeys.length ? await Lead.find({ orgId, dedupeKeys: { $in: allKeys } }).select('dedupeKeys').lean() : [];
  const existingKeys = new Set(existing.flatMap((e: any) => e.dedupeKeys));
  const fresh = unique.filter((u) => !u.keys.some((k) => existingKeys.has(k)));
  const duplicates = places.length - fresh.length;

  // 3) credits: 1 per new lead; create as many as the balance allows
  const reserved = await reserveUpTo(orgId, fresh.length * CREDIT_COSTS.discoveredLead);
  const toCreate = fresh.slice(0, Math.floor(reserved / CREDIT_COSTS.discoveredLead));
  const now = new Date();
  const org = await Organization.findById(orgId).select('compliance');
  const li = !!org?.compliance?.legitimateInterestAssessed;
  const docs = toCreate.map((p) => {
    const source = p.provider === 'openstreetmap' ? 'openstreetmap' : 'google_places';
    const contacts: any[] = [];
    if (p.phone) contacts.push({ type: 'phone', value: p.phone, kind: 'generic_business', source, sourceUrl: p.listingUrl, consentBasis: 'published_business_address' });
    // Only OpenStreetMap carries emails, and only ones the business listing publishes
    if (p.email && isUsableEmail(p.email)) {
      const kind = classifyEmail(p.email);
      contacts.push({ type: 'email', value: p.email, kind, source, sourceUrl: p.listingUrl, consentBasis: deriveBasis(source, kind, li) });
    }
    return {
      orgId, searchJobId: job._id, source, sourceId: p.sourceId, name: p.name, category: p.category || job.query!.category,
      address: p.address, city: p.city || job.query!.city, country: (p.country || job.query!.country || '').toUpperCase(), phone: p.phone,
      website: isOwnWebsite(p.website) ? p.website : undefined, rating: p.rating, reviewCount: p.reviewCount, location: p.location, googleMapsUrl: p.googleMapsUrl,
      listingUrl: p.listingUrl, businessStatus: p.businessStatus,
      // Google content must be refreshed or purged after the cache window; OSM data has no such limit
      placesFetchedAt: source === 'google_places' ? now : undefined,
      dedupeKeys: p.keys, contacts
    };
  });
  const created = docs.length ? await Lead.insertMany(docs) : [];
  await settleReservation(orgId, reserved, created.length * CREDIT_COSTS.discoveredLead, `Discovery: ${created.length} new leads`, String(job._id));

  job.stats!.found += places.length;
  job.stats!.created += created.length;
  job.stats!.duplicates += duplicates;
  job.stats!.creditsUsed += created.length * CREDIT_COSTS.discoveredLead;
  const outOfCredits = toCreate.length < fresh.length;
  if (outOfCredits) job.error = `Stopped early: insufficient credits (${fresh.length - toCreate.length} leads not saved).`;
  if (final || outOfCredits) {
    job.status = 'completed';
    job.finishedAt = new Date();
  }
  await job.save();

  if (job.autoAnalyze && created.length) await requestAnalysis(orgId, created.map((l) => l._id));
  return { created: created.length, duplicates, skipped: fresh.length - toCreate.length };
}

export async function failSearchJob(jobId: string, error: string) {
  await SearchJob.updateOne({ _id: jobId, status: { $in: ['queued', 'running'] } }, { $set: { status: 'failed', error: error.slice(0, 500), finishedAt: new Date() } });
}

// ============================================================ Analysis & scoring
export async function requestAnalysis(orgId: Types.ObjectId | string, leadIds: (Types.ObjectId | string)[]) {
  const org = await Organization.findById(orgId).select('credits');
  const need = leadIds.length * CREDIT_COSTS.analysis;
  if (!org || org.credits < need) throw badRequest(`Analysing ${leadIds.length} lead(s) needs ${need} credits; you have ${org?.credits ?? 0}.`);
  const res = await Lead.updateMany({ _id: { $in: leadIds }, orgId, analysisStatus: { $ne: 'running' } }, { $set: { analysisStatus: 'queued' } });
  for (const id of leadIds) await enqueue('analysis', { leadId: String(id) }, orgId);
  return res.modifiedCount;
}

export async function applyAnalysis(leadId: string, analysis: WebsiteAnalysis | null, score: ScoreResult) {
  // Claim the pending analysis atomically so a duplicate callback (n8n retry) can't charge twice.
  const claimed = await Lead.findOneAndUpdate(
    { _id: leadId, analysisStatus: { $in: ['queued', 'running'] } },
    { $set: { analysisStatus: 'done' } },
    { returnDocument: 'after' }
  );
  if (!claimed) {
    const existing = await Lead.findById(leadId);
    if (!existing) throw notFound('Lead not found');
    return existing; // already applied, or never requested
  }
  const lead = claimed;
  const org = await Organization.findById(lead.orgId).select('compliance');
  const li = !!org?.compliance?.legitimateInterestAssessed;

  try {
    await spendCredits(lead.orgId, CREDIT_COSTS.analysis, `Analysis: ${lead.name}`, String(lead._id));
  } catch (e) {
    await Lead.updateOne({ _id: lead._id }, { $set: { analysisStatus: 'failed', 'website_analysis.error': 'Not enough credits to save the analysis.' } });
    throw e;
  }

  lead.website_analysis = analysis ?? undefined;
  lead.score = score.score;
  lead.scoreBreakdown = new Map(Object.entries(score.breakdown)) as any;
  lead.scoreSummary = score.summary;
  lead.scoredBy = score.scoredBy;
  lead.evidence = score.evidence as any;
  lead.opportunities = score.opportunities as any;
  lead.recommendedServices = score.recommended_services as any;
  lead.analysisStatus = 'done';
  lead.analyzedAt = new Date();
  if (lead.status === 'new' && score.score >= 60) lead.status = 'qualified';

  // Only emails actually published on the business's own website are added — never guessed.
  const known = new Set(lead.contacts.map((c: any) => `${c.type}:${c.value.toLowerCase()}`));
  for (const e of analysis?.emails ?? []) {
    const value = e.value.toLowerCase();
    if (known.has(`email:${value}`) || !isUsableEmail(value)) continue;
    const kind = classifyEmail(value);
    lead.contacts.push({ type: 'email', value, kind, source: 'website_public', sourceUrl: e.page, consentBasis: deriveBasis('website_public', kind, li) } as any);
    known.add(`email:${value}`);
  }
  await lead.save();
  return lead;
}

export async function failAnalysis(leadId: string, error: string) {
  await Lead.updateOne({ _id: leadId }, { $set: { analysisStatus: 'failed', 'website_analysis.error': error.slice(0, 300) } });
}

// ============================================================ Email drafts
export async function createEmailDraft(opts: { orgId: Types.ObjectId | string; leadId: string; contactId?: string; campaignId?: string }) {
  const lead = await Lead.findOne({ _id: opts.leadId, orgId: opts.orgId });
  if (!lead) throw notFound('Lead not found');
  const contact: any = opts.contactId ? lead.contacts.id(opts.contactId) : lead.contacts.find((c: any) => c.type === 'email');
  if (!contact || contact.type !== 'email') throw badRequest('This lead has no verified email address. Analyse the website or add one manually with its source.');
  const org = await Organization.findById(opts.orgId);
  const comp = await assessOutreach({
    orgId: opts.orgId, country: lead.country, email: contact.value, contactSource: contact.source, contactBasis: contact.consentBasis,
    leadStatus: lead.status, sender: org?.sender, liAssessed: !!org?.compliance?.legitimateInterestAssessed
  });
  const existing = await Email.findOne({ orgId: opts.orgId, leadId: lead._id, to: contact.value, status: { $in: ['generating', 'pending_approval', 'approved', 'queued'] } });
  if (existing) return existing;

  if (!env.AI_ENABLED) {
    // Free mode: write the draft from the lead's evidence right away. No AI, no credits.
    const campaign = opts.campaignId ? await Campaign.findOne({ _id: opts.campaignId, orgId: opts.orgId }).lean() : null;
    const t = templateEmail({
      lead: lead.toObject() as any, evidence: lead.evidence as any, opportunities: lead.opportunities as any, recommended: lead.recommendedServices as any,
      sender: { name: org?.sender?.name, company: org?.sender?.companyName }, campaign
    });
    return Email.create({
      orgId: opts.orgId, leadId: lead._id, campaignId: opts.campaignId, to: contact.value, contactId: contact._id,
      subject: t.subject, body: t.body, status: 'pending_approval', compliance: comp, generatedBy: 'template',
      trackingId: randomToken(16), unsubscribeToken: randomToken(18)
    });
  }

  await spendCredits(opts.orgId, CREDIT_COSTS.emailDraft, `Email draft: ${lead.name}`, String(lead._id));
  const email = await Email.create({
    orgId: opts.orgId, leadId: lead._id, campaignId: opts.campaignId, to: contact.value, contactId: contact._id,
    subject: '(generating…)', body: '(generating…)', status: 'generating', compliance: comp,
    trackingId: randomToken(16), unsubscribeToken: randomToken(18)
  });
  await enqueue('email_generate', { emailId: String(email._id) }, opts.orgId);
  return email;
}

export async function saveDraft(emailId: string, subject: string, body: string) {
  const email = await Email.findById(emailId);
  if (!email) throw notFound('Email not found');
  if (email.status !== 'generating') return email; // idempotent
  email.subject = subject;
  email.body = body;
  email.status = 'pending_approval';
  await email.save();
  return email;
}

/** Build everything needed to load-context for drafting (used by both modes). */
export async function draftContext(emailId: string) {
  const email = await Email.findById(emailId);
  if (!email) throw notFound('Email not found');
  const [lead, org] = await Promise.all([Lead.findById(email.leadId), Organization.findById(email.orgId)]);
  if (!lead || !org) throw notFound('Lead or organisation missing');
  const campaign = email.campaignId ? await Campaign.findById(email.campaignId).lean() : null;
  return {
    email, lead, org,
    input: {
      lead: { name: lead.name, category: lead.category, city: lead.city, country: lead.country, website: lead.website, rating: lead.rating, reviewCount: lead.reviewCount },
      summary: lead.scoreSummary, evidence: lead.evidence, opportunities: lead.opportunities, recommended: lead.recommendedServices,
      sender: { name: org.sender?.name, company: org.sender?.companyName, website: org.sender?.website, services: org.services },
      campaign: campaign ? { goal: campaign.goal, tone: campaign.tone } : undefined
    }
  };
}

// ============================================================ Approval & sending
export async function approveEmail(emailId: string, orgId: Types.ObjectId | string, userId: Types.ObjectId | string, edits?: { subject?: string; body?: string }) {
  const email = await Email.findOne({ _id: emailId, orgId });
  if (!email) throw notFound('Email not found');
  if (email.status !== 'pending_approval') throw badRequest(`Email is ${email.status}; only pending emails can be approved.`);
  if (edits?.subject) email.subject = edits.subject;
  if (edits?.body) email.body = edits.body;
  const comp = await recheckCompliance(email);
  if (!comp.allowed) {
    email.compliance = comp as any;
    await email.save();
    throw badRequest(`Blocked by compliance: ${comp.reasons.join(' ')}`);
  }
  email.status = 'queued';
  email.approvedBy = userId as any;
  email.approvedAt = new Date();
  await email.save();
  await enqueue('email_send', { emailId: String(email._id) }, orgId);
  return email;
}

async function recheckCompliance(email: any) {
  const [lead, org] = await Promise.all([Lead.findById(email.leadId), Organization.findById(email.orgId)]);
  const contact: any = lead?.contacts.find((c: any) => c.type === 'email' && c.value === email.to);
  return assessOutreach({
    orgId: email.orgId, country: lead?.country, email: email.to, contactSource: contact?.source ?? 'unknown', contactBasis: contact?.consentBasis,
    leadStatus: lead?.status, sender: org?.sender, liAssessed: !!org?.compliance?.legitimateInterestAssessed
  });
}

/** Final gate right before sending (called by n8n Workflow 4 or the direct sender). */
export async function precheckSend(emailId: string) {
  const email = await Email.findById(emailId);
  if (!email) throw notFound('Email not found');
  if (!email.approvedAt || !['queued', 'approved'].includes(email.status)) return { allowed: false, reasons: ['Email has not been approved by a human.'] };
  const comp = await recheckCompliance(email);
  if (!comp.allowed) {
    email.status = 'blocked';
    email.compliance = comp as any;
    email.error = comp.reasons.join(' ');
    await email.save();
    return { allowed: false, reasons: comp.reasons };
  }
  const org = await Organization.findById(email.orgId);
  const rendered = renderEmail({ body: email.body, sender: org!.sender || {}, unsubscribeToken: email.unsubscribeToken!, trackingId: email.trackingId!, basis: comp.basis });
  return {
    allowed: true,
    emailId: String(email._id),
    from: `${org!.sender?.name} <${org!.sender?.email}>`,
    fromName: org!.sender?.name,
    to: email.to,
    subject: email.subject,
    ...rendered
  };
}

export async function markEmailResult(emailId: string, r: { status: 'sent' | 'failed'; providerMessageId?: string; error?: string }) {
  const email = await Email.findById(emailId);
  if (!email) throw notFound('Email not found');
  if (email.status === 'sent') return email; // idempotent
  email.status = r.status;
  if (r.status === 'sent') {
    email.sentAt = new Date();
    email.providerMessageId = r.providerMessageId;
    await Lead.updateOne({ _id: email.leadId, status: { $in: ['new', 'qualified'] } }, { $set: { status: 'contacted' } });
  } else {
    email.error = r.error?.slice(0, 500);
  }
  await email.save();
  logger.info({ emailId, status: r.status }, 'email result recorded');
  return email;
}

export type { LeadDoc };
