import axios, { AxiosError } from 'axios';

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api' });

api.interceptors.request.use((cfg) => {
  const t = localStorage.getItem('lg_token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

api.interceptors.response.use(
  (r) => r,
  (err: AxiosError<any>) => {
    if (err.response?.status === 401 && !err.config?.url?.includes('/auth/')) {
      localStorage.removeItem('lg_token');
      if (!location.pathname.startsWith('/login')) location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export function errMsg(e: unknown): string {
  const ax = e as AxiosError<any>;
  const d = ax?.response?.data?.error;
  if (d?.details && Array.isArray(d.details)) return `${d.message}: ${d.details.join(' ')}`;
  if (d?.details && typeof d.details === 'object') {
    const first = Object.entries(d.details)[0] as [string, string[]] | undefined;
    if (first) return `${first[0]}: ${first[1][0]}`;
  }
  return d?.message || ax?.message || 'Something went wrong';
}

// ------------------------------------------------------------- types
export interface Contact { _id: string; type: string; value: string; kind: string; source: string; sourceUrl?: string; consentBasis: string }
export interface Lead {
  _id: string; name: string; category?: string; address?: string; city?: string; country?: string; phone?: string; website?: string;
  rating?: number; reviewCount?: number; googleMapsUrl?: string; listingUrl?: string; status: string; analysisStatus: string; score?: number;
  scoreBreakdown?: Record<string, number>; scoreSummary?: string; scoredBy?: string;
  evidence?: { signal: string; detail: string; source: string; impact: number }[];
  opportunities?: { title: string; description: string; priority: string }[];
  recommendedServices?: { name: string; reason: string }[];
  website_analysis?: any; contacts: Contact[]; tags: string[]; notes?: string; source: string; createdAt: string;
}
export interface Org {
  _id: string; name: string; plan: string; credits: number; defaultCountry: string;
  sender?: { name?: string; email?: string; companyName?: string; postalAddress?: string; website?: string; signature?: string };
  services?: { name: string; description?: string; priceHint?: string }[];
  compliance?: { legitimateInterestAssessed?: boolean; privacyNoticeUrl?: string };
  planDetails?: any; secretsConfigured?: Record<string, boolean>;
}
export interface User { id: string; name: string; email: string; role: string; isPlatformAdmin: boolean }
export interface EmailMsg {
  _id: string; leadId: any; to: string; subject: string; body: string; status: string; compliance?: { allowed: boolean; reasons: string[]; law: string; country: string };
  opens: number; clicks: number; sentAt?: string; createdAt: string; error?: string; repliedAt?: string; campaignId?: string; generatedBy?: string;
}

export const COUNTRIES: [string, string][] = [
  ['IN', 'India'], ['US', 'United States'], ['GB', 'United Kingdom'], ['AE', 'UAE'], ['SG', 'Singapore'], ['AU', 'Australia'],
  ['CA', 'Canada'], ['DE', 'Germany'], ['FR', 'France'], ['NL', 'Netherlands'], ['IE', 'Ireland']
];
