import { Types } from 'mongoose';
import { basisSatisfies, ConsentBasis, ContactKind, ruleFor } from '../config/compliance';
import { Suppression } from '../models';

const GENERIC_LOCALPARTS = new Set([
  'info', 'contact', 'hello', 'hi', 'sales', 'enquiry', 'enquiries', 'inquiry', 'admin', 'office', 'support', 'booking',
  'bookings', 'reservations', 'mail', 'team', 'care', 'customercare', 'business', 'marketing', 'help', 'service', 'services',
  'reception', 'frontdesk', 'orders', 'shop', 'store', 'general', 'connect', 'partners', 'partnerships'
]);

export function classifyEmail(email: string): ContactKind {
  const local = email.split('@')[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  if (!local) return 'unknown';
  return GENERIC_LOCALPARTS.has(local) ? 'generic_business' : 'personal_named';
}

/**
 * Consent basis we can claim for a contact. Website-published business addresses count as
 * "published"; if the organisation documented a legitimate-interest assessment, they rise to LI.
 */
export function deriveBasis(source: string, kind: ContactKind, liAssessed: boolean): ConsentBasis {
  if (source === 'consent_form') return 'express_consent';
  if (source === 'website_public' || source === 'google_places') {
    if (kind === 'generic_business' && liAssessed) return 'legitimate_interest';
    return 'published_business_address';
  }
  return 'none';
}

export async function isSuppressed(orgId: Types.ObjectId | string, email: string): Promise<string | null> {
  const e = email.toLowerCase();
  const domain = `@${e.split('@')[1]}`;
  const hit = await Suppression.findOne({ value: { $in: [e, domain] }, $or: [{ orgId }, { orgId: null }] }).lean();
  return hit ? hit.reason : null;
}

export interface ComplianceInput {
  orgId: Types.ObjectId | string;
  country?: string | null;
  email: string;
  contactSource: string;
  contactBasis?: ConsentBasis;
  leadStatus?: string | null;
  sender: { name?: string | null; email?: string | null; postalAddress?: string | null; companyName?: string | null } | undefined | null;
  liAssessed: boolean;
}

export interface ComplianceResult {
  allowed: boolean;
  reasons: string[];
  country: string;
  law: string;
  basis: ConsentBasis;
  required: string;
}

export async function assessOutreach(i: ComplianceInput): Promise<ComplianceResult> {
  const rule = ruleFor(i.country);
  const kind = classifyEmail(i.email);
  const derived = deriveBasis(i.contactSource, kind, i.liAssessed);
  const basis: ConsentBasis = i.contactBasis && i.contactBasis !== 'none' ? i.contactBasis : derived;
  const need = rule.coldEmailBasis[kind];
  const reasons: string[] = [];

  if (i.leadStatus === 'do_not_contact') reasons.push('Lead is marked Do Not Contact.');
  const sup = await isSuppressed(i.orgId, i.email);
  if (sup) reasons.push(`Recipient is on the suppression list (${sup}).`);
  if (!i.sender?.email || !i.sender?.name) reasons.push('Sender name and email are not configured in Settings.');
  if (rule.requiresPhysicalAddress && !i.sender?.postalAddress) reasons.push(`${rule.law} requires a physical postal address in the footer; add it in Settings.`);
  if (!['website_public', 'google_places', 'consent_form', 'manual', 'marketplace'].includes(i.contactSource)) reasons.push('Contact has no verified source.');
  if (!basisSatisfies(basis, need)) {
    reasons.push(
      need === 'express_consent'
        ? `${rule.name} (${rule.law}) requires prior consent for this type of address.`
        : `${rule.name} (${rule.law}) requires "${need.replace(/_/g, ' ')}" basis; contact only has "${basis.replace(/_/g, ' ')}".`
    );
  }
  return { allowed: reasons.length === 0, reasons, country: rule.code, law: rule.law, basis, required: need };
}
