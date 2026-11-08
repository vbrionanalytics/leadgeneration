/**
 * Free email drafts written from a lead's recorded evidence, without AI.
 * Every sentence is chosen from an observed signal; nothing is invented.
 * Drafts still go to the approval queue like AI drafts.
 */
export interface TemplateInput {
  lead: { name: string; category?: string | null; city?: string | null; website?: string | null; rating?: number | null; reviewCount?: number | null };
  evidence?: { signal: string; detail: string; impact: number }[] | null;
  opportunities?: { title: string; priority?: string }[] | null;
  recommended?: { name: string }[] | null;
  sender: { name?: string | null; company?: string | null };
  campaign?: { goal?: string | null; tone?: string | null } | null;
}

const domainOf = (url?: string | null) => {
  if (!url) return '';
  const m = url.match(/^https?:\/\/([^/?#:]+)/i);
  return (m ? m[1] : url).replace(/^www\./, '');
};

function listJoin(items: string[]) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

interface Line { key: string; subject: (n: string, d: string) => string; sentence: (n: string, d: string, detail: string) => string }

/** Observations in priority order. Keys match signals produced by the scorer. */
const LINES: Line[] = [
  {
    key: 'Website is broken',
    subject: (_n, d) => `${d} isn't loading`,
    sentence: (_n, d, detail) => {
      const why = /does not resolve/.test(detail) ? 'the domain no longer seems to be active' : /SSL/.test(detail) ? 'the browser shows a security certificate error' : 'the page returns an error';
      return `I tried to visit ${d} this week and it didn't load: ${why}. Anyone who finds you online and clicks through hits that dead end.`;
    }
  },
  {
    key: 'No website',
    subject: (n) => `A website for ${n}`,
    sentence: (n) => `I came across ${n} on a map listing and noticed it doesn't link to a website, so people who find you there only see the basics.`
  },
  {
    key: 'Not mobile-friendly',
    subject: (n) => `${n}'s website on phones`,
    sentence: (_n, d) => `I opened ${d || 'your website'} and noticed it isn't set up to resize for phone screens, so it's hard to read on a mobile.`
  },
  {
    key: 'No HTTPS',
    subject: (n) => `A quick fix for ${n}'s website`,
    sentence: (_n, d) => `${d || 'Your website'} loads without HTTPS, so browsers can label it "Not secure" for visitors.`
  },
  {
    key: 'No online conversion path',
    subject: (n) => `Online enquiries for ${n}`,
    sentence: () => `I couldn't find a way to book or send an enquiry from your homepage, so interested visitors have to call or leave.`
  },
  {
    key: 'SEO issues',
    subject: (n) => `Helping ${n} show up on Google`,
    sentence: (_n, _d, detail) => `Your homepage is missing a few basics that search engines look for: ${detail.replace(/\.$/, '').split('; ').map((x) => x.charAt(0).toLowerCase() + x.slice(1)).join(', ')}.`
  },
  {
    key: 'Outdated site',
    subject: (n) => `Refreshing ${n}'s website`,
    sentence: (_n, _d, detail) => `The site footer still shows ${detail.replace(/^Copyright year /, '').replace(/\.$/, '')}, which can make visitors wonder if the details are current.`
  },
  {
    key: 'Reputation gap',
    subject: (n) => `${n}'s Google reviews`,
    sentence: (_n, _d, detail) => `I noticed your Google rating is ${(detail.match(/\d+(\.\d+)?/) || ['below 4'])[0]}, and thought you might want help turning more happy customers into reviews.`
  },
  {
    key: 'No analytics',
    subject: (n) => `Knowing who visits ${n}'s website`,
    sentence: () => `I couldn't see any analytics on your website, so it's hard to know how many people visit or where they come from.`
  }
];

const OPENERS: Record<string, (n: string) => string> = {
  professional: (n) => `Hi ${n} team,`,
  friendly: (n) => `Hi ${n} team,`,
  concise: (n) => `Hi ${n} team,`,
  consultative: (n) => `Hi ${n} team,`
};

const CTAS: Record<string, string> = {
  professional: 'Would a 15-minute call this week be useful? I can walk you through what I would fix first.',
  friendly: 'Happy to have a quick 15-minute chat if that helps. I can show you what I would fix first.',
  concise: 'Open to a 15-minute call this week?',
  consultative: 'If it helps, I can send a short note on what I would change first, or we could talk for 15 minutes this week.'
};

export function templateEmail(input: TemplateInput): { subject: string; body: string } {
  const n = input.lead.name.trim();
  const d = domainOf(input.lead.website);
  const tone = input.campaign?.tone && CTAS[input.campaign.tone] ? input.campaign.tone : 'professional';
  const ev = (input.evidence || []).filter((e) => e.impact > 0);
  const picked: { line: Line; detail: string }[] = [];
  for (const line of LINES) {
    const hit = ev.find((e) => e.signal === line.key);
    if (hit) picked.push({ line, detail: hit.detail });
    if (picked.length === 2) break;
  }

  const subject = (picked[0]?.line.subject(n, d) || `A quick idea for ${n}`).slice(0, 70);
  const observations = picked.length
    ? picked.map((p) => p.line.sentence(n, d, p.detail)).join(' ')
    : `I came across ${n}${input.lead.city && !n.toLowerCase().includes(input.lead.city.toLowerCase()) ? ` in ${input.lead.city}` : ''} and had a look at how you show up online.`;

  const services = (input.recommended || []).map((s) => s.name).slice(0, 2);
  // Freelancers (no separate company name) speak for themselves; agencies speak as the company
  const company = input.sender.company?.trim();
  const solo = !company || company.toLowerCase() === (input.sender.name || '').trim().toLowerCase();
  const who = solo ? 'I' : `At ${company}, we`;
  const offer = services.length
    ? `${who} help businesses like yours with ${listJoin(services)}${picked[0]?.line.key === 'Website is broken' ? ', and getting a site back online is usually quick' : ''}.`
    : `${who} help local businesses get more from their website and online listings.`;

  const body = [OPENERS[tone](n), '', observations, '', offer, '', CTAS[tone]].join('\n');
  return { subject, body };
}
