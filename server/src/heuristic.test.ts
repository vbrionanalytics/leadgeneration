import { describe, expect, it } from 'vitest';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
const { heuristicScore, matchServices } = await import('./services/ai');
const svc = [{ name: 'Website Redesign' }, { name: 'SEO Optimisation' }];
const lead = { name: 'X', website: 'https://x.test' };

describe('rule-based score', () => {
  it('treats a dead or broken website as high need', () => {
    const dead = heuristicScore(lead, { ok: false, url: lead.website, error: 'getaddrinfo ENOTFOUND x.test' }, svc);
    const fine = heuristicScore(lead, { ok: true, https: true, has_viewport: true, has_analytics: true, seo_issues: [], has_contact_form: true }, svc);
    expect(dead.breakdown.need).toBeGreaterThan(fine.breakdown.need + 30);
    expect(dead.evidence[0].signal).toBe('Website is broken');
    expect(dead.recommended_services.map((s) => s.name)).toContain('Website Redesign');
  });
  it('does not treat a robots.txt refusal as a broken site', () => {
    const r = heuristicScore(lead, { ok: false, error: 'Disallowed by robots.txt' }, svc);
    expect(r.evidence[0].signal).toBe('Website not analysed');
  });
});

describe('service matching', () => {
  const vbrion = require('../../deploy/orgs/vbrion.json').services as { name: string; description?: string }[];
  it('offers healthcare, not education, analytics to a hospital', () => {
    const r = matchServices(['Enable HTTPS', 'Set up analytics', 'SEO fixes'], 'hospital', vbrion).map((s) => s.name);
    expect(r[0]).toBe('Healthcare Analytics');
    expect(r).toContain('Website & Digital Product Development');
    expect(r).not.toContain('Education Analytics');
  });
  it('offers web work for SEO-only findings', () => {
    expect(matchServices(['SEO fixes'], 'hospital', vbrion).map((s) => s.name)).toEqual(['Website & Digital Product Development']);
  });
  it('offers education analytics to a school', () => {
    expect(matchServices(['Set up analytics'], 'school', vbrion).map((s) => s.name)[0]).toBe('Education Analytics');
  });
});

describe('OpenStreetMap search terms', () => {
  it('finds cities whatever the case or common spelling', async () => {
    const { cityNames, buildOverpassQuery, categoryFilters } = await import('./services/osm');
    expect(cityNames('erode')).toEqual(['Erode']);
    expect(cityNames('banglore')).toContain('Bengaluru');
    expect(buildOverpassQuery({ category: 'Restaurants', city: 'erode', country: 'IN' })).toContain('["name"="Erode"]');
    expect(categoryFilters('IT')[0]).toContain('"office"');
    expect(categoryFilters('lodges')[0]).toContain('tourism');
  });
});
