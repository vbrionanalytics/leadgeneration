/** Free mode: OpenStreetMap discovery, rule-based scores, template drafts, no AI and no Google. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/leadgen_free_${Date.now()}`;
process.env.N8N_WEBHOOK_SECRET = 'n8n-shared-secret';
process.env.ANALYZER_URL = 'http://analyzer.test';
process.env.AI_ENABLED = 'false';
delete process.env.GOOGLE_PLACES_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const OSM = { elements: [
  { type: 'node', id: 1, lat: 11.01, lon: 76.96, tags: { name: 'Clarity Imaging Centre', amenity: 'clinic', healthcare: 'clinic', website: 'clarityimaging.net', email: 'claritymri@gmail.com', phone: '+91-422-2234848', 'addr:street': 'Gokale Street' } },
  { type: 'node', id: 2, lat: 11.02, lon: 76.91, tags: { name: 'Microbiological Laboratory', amenity: 'clinic', website: 'https://microlabindia.com/' } },
  { type: 'way', id: 3, center: { lat: 10.94, lon: 76.92 }, tags: { name: 'Corner Dental', amenity: 'dentist' } },
  { type: 'node', id: 4, tags: { name: 'Old Clinic', amenity: 'clinic', 'disused:amenity': 'clinic', disused: 'yes' } },
  { type: 'node', id: 5, tags: { name: 'Microlab Branch', amenity: 'clinic', website: 'https://www.microlabindia.com' } },
  { type: 'node', id: 6, tags: { 'name:en': 'Aashish Dental Clinic', amenity: 'dentist', 'addr:full': 'Edayarpalayam', 'addr:city': 'coimbatore' } },
  { type: 'node', id: 7, tags: { amenity: 'dentist' } },
  { type: 'way', id: 8, tags: { name: 'Biggies Burger', amenity: 'restaurant', website: 'https://maps.app.goo.gl/MMxfUdYNvbvcaMhe6', phone: '+91 93447 36066' } }
] };
const calls: string[] = [];
vi.stubGlobal('fetch', async (url: any, init?: any) => {
  const u = String(url); calls.push(u);
  if (u.includes('overpass')) return new Response(JSON.stringify(OSM), { status: 200 });
  if (u.startsWith('http://analyzer.test')) {
    const target = JSON.parse(init.body).url;
    if (target.includes('clarityimaging')) return new Response(JSON.stringify({ ok: false, url: target, error: 'Unreachable: ConnectError (getaddrinfo ENOTFOUND clarityimaging.net)' }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, url: target, https: true, has_viewport: true, has_analytics: false, seo_issues: ['Missing meta description', 'Missing H1 heading'], has_contact_form: true, emails: [{ value: 'microlabcbe@microlabindia.com', page: target }] }), { status: 200 });
  }
  throw new Error('unexpected fetch ' + u);
});

const { createApp } = await import('./app');
const { handlers } = await import('./jobs/worker');
const { runNext } = await import('./services/queue');
const { buildOverpassQuery } = await import('./services/osm');
const { templateEmail } = await import('./services/templates');
const models = await import('./models');
const app = createApp();
const drain = async () => { while (await runNext(handlers)) { /* */ } };
let H: Record<string, string> = {};

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI!);
  const r = await request(app).post('/api/auth/register').send({ name: 'Prawin', email: 'free@dealpost.test', password: 'secret123', organization: 'Dealpost', country: 'IN' });
  H = { Authorization: `Bearer ${r.body.token}` };
  await request(app).patch('/api/org').set(H).send({ services: [{ name: 'Website Redesign' }, { name: 'SEO Optimisation' }], sender: { name: 'Prawin', email: 'sales@dealpost.test', companyName: 'Dealpost Private Limited', postalAddress: 'Coimbatore, Tamil Nadu, India' } });
});
afterAll(async () => { await mongoose.connection.db?.dropDatabase(); await mongoose.disconnect(); });

describe('OpenStreetMap queries', () => {
  it('maps common categories to OSM tags and falls back to a name search', () => {
    expect(buildOverpassQuery({ category: 'Dental clinics', city: 'Coimbatore', country: 'IN' })).toContain('["amenity"="dentist"]');
    expect(buildOverpassQuery({ category: 'Boutique hotels', city: 'Kochi', country: 'IN' })).toContain('"tourism"~"^(hotel');
    expect(buildOverpassQuery({ category: 'Saree shops', city: 'Erode', country: 'IN' })).toContain('"shop"~"^(clothes');
    expect(buildOverpassQuery({ category: 'Bike rentals', city: 'Ooty', country: 'IN' })).toContain('["name"~"Bike rental",i]');
    expect(() => buildOverpassQuery({ category: 'x', city: '', country: 'IN' })).toThrow(/city/);
  });
  it('lists providers: OpenStreetMap free, Google not set up', async () => {
    const r = await request(app).get('/api/searches/providers').set(H);
    expect(r.body.providers.find((p: any) => p.id === 'openstreetmap').available).toBe(true);
    expect(r.body.providers.find((p: any) => p.id === 'google_places').available).toBe(false);
    expect(r.body.aiEnabled).toBe(false);
  });
  it('refuses Google searches until a key is configured', async () => {
    const r = await request(app).post('/api/searches').set(H).send({ category: 'dentist', country: 'IN', city: 'Coimbatore', provider: 'google_places' });
    expect(r.status).toBe(400);
  });
});

describe('free pipeline', () => {
  it('discovers from OpenStreetMap, dedupes by domain and skips closed places', async () => {
    const r = await request(app).post('/api/searches').set(H).send({ category: 'clinics', country: 'IN', city: 'Coimbatore', maxResults: 20, autoAnalyze: true });
    expect(r.status).toBe(202);
    await drain();
    const job = (await request(app).get(`/api/searches/${r.body._id}`).set(H)).body;
    expect(job.status).toBe('completed');
    expect(job.stats.created).toBe(5); // 4 is disused, 5 duplicates 2's domain, 7 has no name
    const leads = (await request(app).get('/api/leads?sort=name').set(H)).body.items;
    const clarity = leads.find((l: any) => l.name === 'Clarity Imaging Centre');
    expect(clarity.source).toBe('openstreetmap');
    expect(clarity.listingUrl).toBe('https://www.openstreetmap.org/node/1');
    expect(clarity.website).toBe('https://clarityimaging.net');
    const biggies = leads.find((l: any) => l.name === 'Biggies Burger');
    expect(biggies.website).toBeUndefined(); // a map link is not their own website
    expect(biggies.opportunities?.[0]?.title ?? 'Build a website').toBe('Build a website');
    const aashish = leads.find((l: any) => l.name === 'Aashish Dental Clinic');
    expect(aashish).toMatchObject({ city: 'Coimbatore', address: 'Edayarpalayam' });
    expect(clarity.contacts.find((c: any) => c.type === 'email')).toMatchObject({ value: 'claritymri@gmail.com', source: 'openstreetmap', sourceUrl: 'https://www.openstreetmap.org/node/1' });
  });
  it('auto-analysis scores with rules, and a dead website ranks high', async () => {
    const leads = (await request(app).get('/api/leads?sort=-score').set(H)).body.items;
    const clarity = leads.find((l: any) => l.name === 'Clarity Imaging Centre');
    expect(clarity.analysisStatus).toBe('done');
    expect(clarity.scoredBy).toBe('heuristic');
    expect(clarity.opportunities[0].title).toBe('Fix or rebuild the broken website');
    const lab = leads.find((l: any) => l.name === 'Microbiological Laboratory');
    expect(lab.recommendedServices.map((s: any) => s.name)).toContain('SEO Optimisation');
    expect(lab.contacts.some((c: any) => c.value === 'microlabcbe@microlabindia.com' && c.source === 'website_public')).toBe(true);
  });
  it('writes template drafts instantly, free of credits, held for approval', async () => {
    const before = (await request(app).get('/api/billing/balance').set(H)).body.credits;
    const leads = (await request(app).get('/api/leads?hasEmail=true').set(H)).body.items;
    const g = await request(app).post('/api/emails/generate').set(H).send({ leadIds: leads.map((l: any) => l._id) });
    expect(g.body.results.every((r: any) => r.emailId)).toBe(true);
    expect((await request(app).get('/api/billing/balance').set(H)).body.credits).toBe(before);
    const emails = (await request(app).get('/api/emails').set(H)).body.items;
    const clarity = emails.find((e: any) => e.to === 'claritymri@gmail.com');
    expect(clarity.status).toBe('pending_approval');
    expect(clarity.generatedBy).toBe('template');
    expect(clarity.subject).toBe("clarityimaging.net isn't loading");
    expect(clarity.body).toMatch(/^Hi Clarity Imaging Centre team,/);
    expect(clarity.body).toContain('the domain no longer seems to be active');
    expect(clarity.body).toContain('At Dealpost Private Limited, we help businesses like yours with Website Redesign');
    expect(clarity.body).not.toMatch(/undefined|null|\$\{/);
    const ap = await request(app).post(`/api/emails/${clarity._id}/approve`).set(H).send({});
    expect(ap.body.error?.message ?? ap.body.status).toBe('queued'); // India: self-published business emails are allowed
  });
  it('accepts raw OpenStreetMap elements from n8n workflow 1', async () => {
    await models.Lead.deleteMany({});
    const job = await models.SearchJob.create({ orgId: (await models.Organization.findOne())!._id, query: { category: 'clinic', city: 'Coimbatore', country: 'IN', maxResults: 2, provider: 'openstreetmap' }, status: 'running' });
    const r = await request(app).post(`/api/integrations/n8n/discovery/${job._id}/results`).set('X-LeadGen-Key', 'n8n-shared-secret').send({ places: OSM.elements, final: true });
    expect(r.body.created).toBe(2); // capped at maxResults, websites first
    expect(await models.Lead.countDocuments({ source: 'openstreetmap', website: { $exists: true } })).toBe(2);
  });
});

describe('busy OpenStreetMap server', () => {
  it('falls back to the mirror when the main server is at capacity', async () => {
    const { searchOsm } = await import('./services/osm');
    const seen: string[] = [];
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: any) => {
      seen.push(String(url));
      return String(url).includes('overpass-api.de') ? new Response('at capacity', { status: 502 }) : new Response(JSON.stringify(OSM), { status: 200 });
    });
    const r = await searchOsm({ category: 'clinic', city: 'Coimbatore', country: 'IN', max: 5 });
    vi.stubGlobal('fetch', prev);
    expect(seen.map((u) => new URL(u).host)).toEqual(['overpass-api.de', 'overpass.kumi.systems']);
    expect(r.length).toBeGreaterThan(0);
  });
});

describe('template writer', () => {
  it('falls back to a neutral opener when there is no evidence', () => {
    const t = templateEmail({ lead: { name: 'Kovai Mess', city: 'Coimbatore' }, sender: { company: 'Dealpost' } });
    expect(t.subject).toBe('A quick idea for Kovai Mess');
    expect(t.body).toContain('I came across Kovai Mess in Coimbatore');
    expect(templateEmail({ lead: { name: 'Merlis Hotel, Coimbatore', city: 'Coimbatore' }, sender: {} }).body).toContain('I came across Merlis Hotel, Coimbatore and');
  });
  it('writes in the first person for freelancers', () => {
    const ev = [{ signal: 'No website', detail: 'Listing has no website URL.', impact: 20 }];
    const solo = templateEmail({ lead: { name: 'Kovai Mess' }, evidence: ev, recommended: [{ name: 'Website Redesign' }], sender: { name: 'Prawin Kumar N', company: '' } });
    expect(solo.body).toContain('I help businesses like yours with Website Redesign');
    const same = templateEmail({ lead: { name: 'Kovai Mess' }, sender: { name: 'Prawin Kumar N', company: 'Prawin Kumar N' } });
    expect(same.body).toContain('I help local businesses');
    const agency = templateEmail({ lead: { name: 'Kovai Mess' }, sender: { name: 'Prawin', company: 'Acme Web Studio' } });
    expect(agency.body).toContain('At Acme Web Studio, we help');
  });
  it('uses the campaign tone for the call to action', () => {
    const t = templateEmail({ lead: { name: 'X' }, sender: {}, campaign: { tone: 'concise' } });
    expect(t.body.trim().endsWith('Open to a 15-minute call this week?')).toBe(true);
  });
});
