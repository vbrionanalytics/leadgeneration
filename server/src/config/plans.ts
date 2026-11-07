export type PlanId = 'free' | 'starter' | 'growth' | 'agency';

export interface Plan {
  id: PlanId;
  name: string;
  priceInrMonthly: number; // in paise-free rupees
  monthlyCredits: number;
  seats: number;
  maxResultsPerSearch: number;
  features: string[];
  marketplaceSelling: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free', name: 'Free', priceInrMonthly: 0, monthlyCredits: 50, seats: 1, maxResultsPerSearch: 20,
    features: ['Business discovery', 'AI lead scoring', 'Excel export'], marketplaceSelling: false
  },
  starter: {
    id: 'starter', name: 'Starter', priceInrMonthly: 1999, monthlyCredits: 1000, seats: 3, maxResultsPerSearch: 60,
    features: ['Everything in Free', 'AI email generation', 'Campaign tracking'], marketplaceSelling: false
  },
  growth: {
    id: 'growth', name: 'Growth', priceInrMonthly: 4999, monthlyCredits: 4000, seats: 10, maxResultsPerSearch: 200,
    features: ['Everything in Starter', 'Marketplace selling', 'API access'], marketplaceSelling: true
  },
  agency: {
    id: 'agency', name: 'Agency', priceInrMonthly: 12999, monthlyCredits: 12000, seats: 50, maxResultsPerSearch: 500,
    features: ['Everything in Growth', 'Priority processing', 'Dedicated support'], marketplaceSelling: true
  }
};

/** Credit cost per operation. Charged only on success. */
export const CREDIT_COSTS = {
  discoveredLead: 1, // per NEW (non-duplicate) lead saved
  analysis: 2,
  emailDraft: 1,
  emailSend: 0
} as const;

export const CREDIT_PACKS = [
  { id: 'pack_500', credits: 500, priceInr: 999 },
  { id: 'pack_2000', credits: 2000, priceInr: 3499 },
  { id: 'pack_10000', credits: 10000, priceInr: 14999 }
];
