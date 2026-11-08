import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../config/env';
import { HttpError, logger } from '../utils';

export interface WebsiteAnalysis {
  ok: boolean;
  url?: string;
  final_url?: string;
  error?: string;
  robots_allowed?: boolean;
  https?: boolean;
  status_code?: number;
  load_ms?: number;
  page_size_kb?: number;
  title?: string;
  meta_description?: string;
  h1?: string[];
  word_count?: number;
  has_viewport?: boolean;
  technologies?: string[];
  has_analytics?: boolean;
  has_contact_form?: boolean;
  has_booking?: boolean;
  has_ecommerce?: boolean;
  has_chat_widget?: boolean;
  has_whatsapp?: boolean;
  social_links?: Record<string, string>;
  emails?: { value: string; page: string }[];
  phones?: { value: string; page: string }[];
  seo_issues?: string[];
  copyright_year?: number | null;
  pages_checked?: string[];
}

export interface LeadContext {
  name: string;
  category?: string;
  city?: string;
  country?: string;
  website?: string;
  rating?: number;
  reviewCount?: number;
  businessStatus?: string;
}

// ------------------------------------------------------------------ scoring schema
export const ScoreSchema = z.object({
  score: z.number().min(0).max(100),
  breakdown: z.object({
    need: z.number().min(0).max(100), // how much they need the services we sell
    ability_to_pay: z.number().min(0).max(100),
    reachability: z.number().min(0).max(100),
    fit: z.number().min(0).max(100)
  }),
  summary: z.string().max(600),
  evidence: z.array(z.object({ signal: z.string(), detail: z.string(), source: z.enum(['website', 'google_places', 'derived']), impact: z.number().min(-30).max(30) })).max(12),
  opportunities: z.array(z.object({ title: z.string(), description: z.string(), priority: z.enum(['high', 'medium', 'low']) })).max(6),
  recommended_services: z.array(z.object({ name: z.string(), reason: z.string() })).max(5)
});
export type ScoreResult = z.infer<typeof ScoreSchema> & { scoredBy: 'claude' | 'heuristic' };

export const DraftSchema = z.object({ subject: z.string().min(3).max(120), body: z.string().min(40).max(2500) });

let client: Anthropic | null = null;
const getClient = (apiKey?: string) => {
  const key = apiKey || env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (apiKey) return new Anthropic({ apiKey });
  return (client ??= new Anthropic({ apiKey: key }));
};

function extractJson(text: string): unknown {
  const tagged = text.match(/<json>([\s\S]*?)<\/json>/);
  const raw = tagged ? tagged[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

async function askClaude(system: string, user: string, maxTokens: number, apiKey?: string): Promise<unknown> {
  const c = getClient(apiKey);
  if (!c) throw new HttpError(503, 'Claude API key is not configured.', 'ai_not_configured');
  const res = await c.messages.create({ model: env.CLAUDE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return extractJson(text);
}

export const SCORING_SYSTEM = `You are a B2B sales analyst. Score how good a sales lead a business is for the SELLER, 0-100.
Rules:
- Use ONLY the facts given in the input. Never invent facts, contacts, revenue, owners or URLs.
- Every evidence item must quote or describe a specific input field. source is "website" (from website_analysis), "google_places" (from listing data) or "derived" (a reasoned combination of given facts).
- impact is how much that signal moved the score (-30..30).
- recommended_services MUST be chosen only from the seller's services list (exact names). If none fit, return an empty list.
- breakdown: need (gap the seller can fill), ability_to_pay (size/reputation proxies), reachability (public business contact channels present), fit (match to seller services).
- If the website could not be analysed, say so in evidence and do not guess its contents.
Return ONLY JSON inside <json></json> matching:
{"score":0,"breakdown":{"need":0,"ability_to_pay":0,"reachability":0,"fit":0},"summary":"","evidence":[{"signal":"","detail":"","source":"website","impact":0}],"opportunities":[{"title":"","description":"","priority":"high"}],"recommended_services":[{"name":"","reason":""}]}`;

export function buildScoringInput(lead: LeadContext, analysis: WebsiteAnalysis | null, services: { name: string; description?: string }[]) {
  return JSON.stringify({ lead, website_analysis: analysis, seller_services: services }, null, 1);
}

/** Validate/clean an AI score result so hallucinated services are dropped. Used for n8n callbacks too. */
export function sanitizeScore(raw: unknown, services: { name: string }[]): z.infer<typeof ScoreSchema> {
  const parsed = ScoreSchema.parse(raw);
  const allowed = new Set(services.map((s) => s.name.toLowerCase()));
  parsed.recommended_services = parsed.recommended_services.filter((s) => allowed.has(s.name.toLowerCase()));
  parsed.score = Math.round(parsed.score);
  return parsed;
}

/** Transparent rule-based score used when Claude is unavailable. Every point is backed by evidence. */
export function heuristicScore(lead: LeadContext, a: WebsiteAnalysis | null, services: { name: string; description?: string }[]): ScoreResult {
  const evidence: ScoreResult['evidence'] = [];
  const opp: ScoreResult['opportunities'] = [];
  let need = 40, pay = 40, reach = 20;
  const add = (signal: string, detail: string, source: 'website' | 'google_places' | 'derived', impact: number) => evidence.push({ signal, detail, source, impact });

  if (!lead.website) {
    need += 35; add('No website', 'Listing has no website URL.', 'google_places', 20);
    opp.push({ title: 'Build a website', description: 'Business has no website listed.', priority: 'high' });
  } else if (a && !a.ok && /ENOTFOUND|NXDOMAIN|ConnectError|Unreachable|HTTP [45]\d\d|SSL|certificate/i.test(a.error || '') && !/robots/i.test(a.error || '')) {
    // The listed website is down or broken: an observed fact, and the clearest need a web agency can fill
    need += 40;
    const why = /ENOTFOUND|NXDOMAIN/i.test(a.error!) ? 'domain does not resolve' : /SSL|certificate/i.test(a.error!) ? 'SSL certificate error' : a.error!;
    add('Website is broken', `Listed website ${a.url || lead.website} failed to load (${why}).`, 'website', 25);
    opp.push({ title: 'Fix or rebuild the broken website', description: `Their listed site fails to load (${why}); customers who look them up hit a dead end.`, priority: 'high' });
  } else if (!a || !a.ok) {
    add('Website not analysed', a?.error ? `Analysis failed: ${a.error}` : 'Website could not be analysed.', 'website', 0);
  } else {
    if (!a.https) { need += 10; add('No HTTPS', 'Site does not use HTTPS.', 'website', 8); opp.push({ title: 'Enable HTTPS', description: 'Site served without TLS.', priority: 'medium' }); }
    if (!a.has_viewport) { need += 10; add('Not mobile-friendly', 'No responsive viewport meta tag.', 'website', 8); opp.push({ title: 'Mobile-responsive redesign', description: 'No viewport meta tag found.', priority: 'high' }); }
    if ((a.load_ms ?? 0) > 3000) { need += 5; add('Slow homepage', `Homepage took ${a.load_ms} ms to load.`, 'website', 5); }
    if (!a.has_analytics) { need += 5; add('No analytics', 'No analytics/tag manager detected.', 'website', 4); opp.push({ title: 'Set up analytics', description: 'No analytics detected.', priority: 'low' }); }
    if ((a.seo_issues?.length ?? 0) >= 2) { need += 8; add('SEO issues', a.seo_issues!.slice(0, 3).join('; '), 'website', 6); opp.push({ title: 'SEO fixes', description: a.seo_issues!.slice(0, 3).join('; '), priority: 'medium' }); }
    if (!a.has_booking && !a.has_ecommerce && !a.has_contact_form) { need += 5; add('No online conversion path', 'No booking, store or contact form found.', 'website', 5); }
    if (a.copyright_year && a.copyright_year < new Date().getFullYear() - 2) { need += 5; add('Outdated site', `Copyright year ${a.copyright_year}.`, 'website', 4); }
    if (a.emails?.length) { reach += 40; add('Public business email', `${a.emails.length} email(s) published on website.`, 'website', 8); }
    if (a.has_whatsapp || a.has_contact_form) { reach += 10; }
  }
  if (lead.rating != null && lead.reviewCount != null) {
    if (lead.reviewCount >= 100) { pay += 25; add('Established business', `${lead.reviewCount} Google reviews (rating ${lead.rating}).`, 'google_places', 8); }
    else if (lead.reviewCount >= 20) { pay += 12; add('Active customer base', `${lead.reviewCount} Google reviews.`, 'google_places', 4); }
    if (lead.rating < 4) { need += 5; add('Reputation gap', `Rating ${lead.rating} below 4.0.`, 'google_places', 4); opp.push({ title: 'Reputation management', description: `Rating ${lead.rating}.`, priority: 'medium' }); }
  }
  // phone from listing counts toward reachability
  reach += 20;
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  const oppText = opp.map((o) => o.title.toLowerCase()).join(' ');
  const recommended = services
    .filter((s) => s.name.toLowerCase().split(/\W+/).some((w) => w.length >= 3 && !["and", "the", "for"].includes(w) && oppText.includes(w)))
    .slice(0, 3)
    .map((s) => ({ name: s.name, reason: 'Matches detected opportunities.' }));
  const fit = clamp(services.length ? 30 + recommended.length * 20 : 50);
  const breakdown = { need: clamp(need), ability_to_pay: clamp(pay), reachability: clamp(reach), fit };
  const score = clamp(breakdown.need * 0.35 + breakdown.ability_to_pay * 0.25 + breakdown.reachability * 0.2 + breakdown.fit * 0.2);
  return {
    score, breakdown, evidence, opportunities: opp.slice(0, 6), recommended_services: recommended,
    summary: `Rule-based score from ${evidence.length} observed signal(s).`, scoredBy: 'heuristic'
  };
}

export async function scoreLead(lead: LeadContext, analysis: WebsiteAnalysis | null, services: { name: string; description?: string }[], apiKey?: string): Promise<ScoreResult> {
  try {
    const raw = await askClaude(SCORING_SYSTEM, buildScoringInput(lead, analysis, services), 1500, apiKey);
    return { ...sanitizeScore(raw, services), scoredBy: 'claude' };
  } catch (err: any) {
    if (err instanceof HttpError && err.code === 'ai_not_configured') return heuristicScore(lead, analysis, services);
    logger.warn({ err: err?.message }, 'Claude scoring failed; using heuristic');
    return heuristicScore(lead, analysis, services);
  }
}

// ------------------------------------------------------------------ email drafting
export const EMAIL_SYSTEM = `You write short, honest, personalised B2B cold emails.
Rules:
- 70-140 words, plain text, no markdown, no emojis, no fake urgency, no false claims, no invented statistics or references to past conversations.
- Mention 1-2 SPECIFIC observations from the provided evidence/opportunities about the recipient's business.
- Offer only services from the seller's list. One clear, low-friction call to action (e.g. a short call).
- Greet generically ("Hi <Business> team,") unless a contact name is provided. Never guess a person's name.
- Do NOT include a signature, address, or unsubscribe text — they are appended automatically.
- Subject: under 60 characters, specific, not clickbait.
Return ONLY JSON in <json></json>: {"subject":"","body":""}`;

export function buildEmailInput(ctx: { lead: LeadContext; summary?: string; evidence?: unknown; opportunities?: unknown; recommended?: unknown; sender: unknown; campaign?: { goal?: string; tone?: string } }) {
  return JSON.stringify(ctx, null, 1);
}

export async function draftEmail(input: Parameters<typeof buildEmailInput>[0], apiKey?: string) {
  const raw = await askClaude(EMAIL_SYSTEM, buildEmailInput(input), 800, apiKey);
  return DraftSchema.parse(raw);
}
