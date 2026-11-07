/**
 * Country marketing-compliance rules for cold B2B email outreach.
 * This encodes conservative defaults; it is NOT legal advice. Review with counsel
 * before operating in a jurisdiction.
 */
export type ConsentBasis = 'none' | 'published_business_address' | 'legitimate_interest' | 'express_consent';
export type ContactKind = 'generic_business' | 'personal_named' | 'unknown';

export interface CountryRule {
  code: string;
  name: string;
  law: string;
  /** Minimum consent basis needed to send a first B2B cold email. */
  coldEmailBasis: Record<ContactKind, ConsentBasis | 'blocked'>;
  requiresPhysicalAddress: boolean;
  requiresUnsubscribe: boolean;
  unsubscribeHonorDays: number;
  notes: string;
}

const STANDARD = { requiresPhysicalAddress: true, requiresUnsubscribe: true };

export const COUNTRY_RULES: Record<string, CountryRule> = {
  IN: {
    code: 'IN', name: 'India', law: 'DPDP Act 2023 / IT Act', ...STANDARD, unsubscribeHonorDays: 7,
    coldEmailBasis: { generic_business: 'published_business_address', personal_named: 'legitimate_interest', unknown: 'published_business_address' },
    notes: 'Identify sender, honour opt-outs promptly, process only publicly published business contact data.'
  },
  US: {
    code: 'US', name: 'United States', law: 'CAN-SPAM Act', ...STANDARD, unsubscribeHonorDays: 10,
    coldEmailBasis: { generic_business: 'none', personal_named: 'none', unknown: 'none' },
    notes: 'Accurate headers, non-deceptive subject, physical postal address, working opt-out honoured within 10 business days.'
  },
  GB: {
    code: 'GB', name: 'United Kingdom', law: 'UK GDPR / PECR', ...STANDARD, unsubscribeHonorDays: 7,
    coldEmailBasis: { generic_business: 'legitimate_interest', personal_named: 'legitimate_interest', unknown: 'legitimate_interest' },
    notes: 'Corporate subscribers may be emailed under legitimate interest; sole traders/partnerships need consent. Provide privacy notice.'
  },
  DE: {
    code: 'DE', name: 'Germany', law: 'GDPR / UWG §7', ...STANDARD, unsubscribeHonorDays: 1,
    coldEmailBasis: { generic_business: 'express_consent', personal_named: 'express_consent', unknown: 'express_consent' },
    notes: 'UWG requires prior consent for advertising email, including B2B. Cold email is blocked.'
  },
  CA: {
    code: 'CA', name: 'Canada', law: 'CASL', ...STANDARD, unsubscribeHonorDays: 10,
    coldEmailBasis: { generic_business: 'published_business_address', personal_named: 'express_consent', unknown: 'published_business_address' },
    notes: 'Implied consent only if address conspicuously published, not marked "no unsolicited email", and message relevant to role.'
  },
  AU: {
    code: 'AU', name: 'Australia', law: 'Spam Act 2003', ...STANDARD, unsubscribeHonorDays: 5,
    coldEmailBasis: { generic_business: 'published_business_address', personal_named: 'express_consent', unknown: 'published_business_address' },
    notes: 'Inferred consent requires conspicuous publication and relevance to the recipient\'s business role.'
  },
  AE: {
    code: 'AE', name: 'United Arab Emirates', law: 'PDPL / TDRA', ...STANDARD, unsubscribeHonorDays: 7,
    coldEmailBasis: { generic_business: 'legitimate_interest', personal_named: 'express_consent', unknown: 'legitimate_interest' },
    notes: 'Prefer generic business addresses; honour opt-outs.'
  },
  SG: {
    code: 'SG', name: 'Singapore', law: 'PDPA / Spam Control Act', ...STANDARD, unsubscribeHonorDays: 10,
    coldEmailBasis: { generic_business: 'published_business_address', personal_named: 'legitimate_interest', unknown: 'published_business_address' },
    notes: 'Include <ADV> label requirements may apply for bulk unsolicited messages; honour unsubscribe within 10 business days.'
  }
};

/** EU countries default to the conservative GDPR/ePrivacy rule. */
const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
for (const code of EU) {
  COUNTRY_RULES[code] ??= {
    code, name: code, law: 'GDPR / ePrivacy (national)', ...STANDARD, unsubscribeHonorDays: 7,
    coldEmailBasis: { generic_business: 'legitimate_interest', personal_named: 'express_consent', unknown: 'express_consent' },
    notes: 'National ePrivacy rules vary; personal named addresses require consent. Review per country.'
  };
}

export const DEFAULT_RULE: CountryRule = {
  code: '*', name: 'Other', law: 'Unknown — conservative default', ...STANDARD, unsubscribeHonorDays: 7,
  coldEmailBasis: { generic_business: 'published_business_address', personal_named: 'express_consent', unknown: 'express_consent' },
  notes: 'No specific rule configured; only generic, publicly published business addresses are allowed.'
};

const BASIS_RANK: Record<ConsentBasis, number> = {
  none: 0, published_business_address: 1, legitimate_interest: 2, express_consent: 3
};

export function ruleFor(country?: string | null): CountryRule {
  return (country && COUNTRY_RULES[country.toUpperCase()]) || DEFAULT_RULE;
}

export function basisSatisfies(have: ConsentBasis, need: ConsentBasis | 'blocked'): boolean {
  if (need === 'blocked') return false;
  return BASIS_RANK[have] >= BASIS_RANK[need];
}
