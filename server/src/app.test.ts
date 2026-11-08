import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.ENCRYPTION_KEY = 'test-encryption-key-test-encryption-key';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || `mongodb://127.0.0.1:27017/leadgen_test_${Date.now()}`;
process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
process.env.N8N_WEBHOOK_SECRET = 'n8n-shared-secret';
process.env.ANALYZER_URL = 'http://analyzer.test';
process.env.PLATFORM_ADMIN_EMAILS = 'admin@leadgen.test';
delete process.env.ANTHROPIC_API_KEY; // AI on but no key: exercises the heuristic fallback
process.env.AI_ENABLED = 'true';      // this suite covers the paid path (Google Places + AI drafts)

const { createApp } = await import('./app');
const { handlers } = await import('./jobs/worker');
const { runNext } = await import('./services/queue');
const models = await import('./models');

const app = createApp();
const drain = async () => { while (await runNext(handlers)) { /* run all queued jobs */ } };

// ---- stub external HTTP (Google Places + website analyzer) ----
const PLACES = [
  { id: 'place_A', displayName: { text: 'Sunrise Dental Clinic' }, formattedAddress: 'RS Puram, Coimbatore', websiteUri: 'https://sunrisedental.example', internationalPhoneNumber: '+91 98765 43210', rating: 4.6, userRatingCount: 240, primaryTypeDisplayName: { text: 'Dentist' }, addressComponents: [{ types: ['locality'], longText: 'Coimbatore' }, { types: ['country'], shortText: 'IN' }], businessStatus: 'OPERATIONAL' },
  { id: 'place_B', displayName: { text: 'Smile Care Dentistry' }, formattedAddress: 'Gandhipuram, Coimbatore', internationalPhoneNumber: '+91 90000 11111', rating: 3.8, userRatingCount: 35, primaryTypeDisplayName: { text: 'Dentist' }, addressComponents: [{ types: ['locality'], longText: 'Coimbatore' }, { types: ['country'], shortText: 'IN' }], businessStatus: 'OPERATIONAL' },
  // same website as A under a different place id → must be detected as a duplicate
  { id: 'place_C', displayName: { text: 'Sunrise Dental (Branch)' }, websiteUri: 'https://www.sunrisedental.example/', addressComponents: [{ types: ['country'], shortText: 'IN' }], businessStatus: 'OPERATIONAL' },
  { id: 'place_D', displayName: { text: 'Closed Clinic' }, businessStatus: 'CLOSED_PERMANENTLY' }
];
const ANALYSIS = {
  ok: true, url: 'https://sunrisedental.example', https: false, has_viewport: false, load_ms: 4200, has_analytics: false, has_contact_form: false,
  has_booking: false, has_ecommerce: false, seo_issues: ['Missing meta description', 'Missing H1'], copyright_year: 2019,
  emails: [{ value: 'info@sunrisedental.example', page: 'https://sunrisedental.example/contact' }], technologies: ['WordPress']
};
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (url: any, init?: any) => {
  const u = String(url);
  if (u.includes('places.googleapis.com')) return new Response(JSON.stringify({ places: PLACES }), { status: 200 });
  if (u.startsWith('http://analyzer.test')) return new Response(JSON.stringify(ANALYSIS), { status: 200 });
  return realFetch(url, init);
});

let token = '';
let buyerToken = '';
let orgId = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI!);
});
afterAll(async () => {
  await mongoose.connection.db?.dropDatabase();
  await mongoose.disconnect();
});

describe('auth & tenancy', () => {
  it('registers an org with welcome credits', async () => {
    const r = await request(app).post('/api/auth/register').send({ name: 'Prawin', email: 'owner@seller.test', password: 'secret123', organization: 'Dealpost', country: 'IN' });
    expect(r.status).toBe(201);
    token = r.body.token;
    orgId = r.body.organization._id;
    expect(r.body.organization.credits).toBe(50);
  });
  it('rejects weak passwords and duplicate emails', async () => {
    expect((await request(app).post('/api/auth/register').send({ name: 'X', email: 'a@b.test', password: 'short', organization: 'Org' })).status).toBe(400);
    expect((await request(app).post('/api/auth/register').send({ name: 'Prawin', email: 'owner@seller.test', password: 'secret123', organization: 'Dup' })).status).toBe(409);
  });
  it('requires auth', async () => {
    expect((await request(app).get('/api/leads')).status).toBe(401);
  });
  it('logs in', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'owner@seller.test', password: 'secret123' });
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('owner');
  });
});

describe('discovery, dedupe, analysis', () => {
  let leadAId = '';
  it('runs a search job in the background and dedupes', async () => {
    await request(app).patch('/api/org').set(auth()).send({ services: [{ name: 'Website Redesign' }, { name: 'SEO Optimisation' }, { name: 'Mobile App' }] }).expect(200);
    const r = await request(app).post('/api/searches').set(auth()).send({ category: 'dentist', country: 'IN', city: 'Coimbatore', maxResults: 20, provider: 'google_places' });
    expect(r.status).toBe(202);
    await drain();
    const job = (await request(app).get(`/api/searches/${r.body._id}`).set(auth())).body;
    expect(job.status).toBe('completed');
    expect(job.stats.created).toBe(2); // A and B; C is a website-duplicate of A; D closed
    expect(job.stats.duplicates).toBeGreaterThanOrEqual(1);
    const bal = (await request(app).get('/api/billing/balance').set(auth())).body;
    expect(bal.credits).toBe(48);
  });
  it('a repeated search creates no duplicates', async () => {
    const r = await request(app).post('/api/searches').set(auth()).send({ category: 'dentist', country: 'IN', city: 'Coimbatore', maxResults: 20, provider: 'google_places' });
    await drain();
    const job = (await request(app).get(`/api/searches/${r.body._id}`).set(auth())).body;
    expect(job.stats.created).toBe(0);
    const list = (await request(app).get('/api/leads').set(auth())).body;
    expect(list.total).toBe(2);
    leadAId = list.items.find((l: any) => l.sourceId === 'place_A')._id;
  });
  it('analyses a website, scores with evidence and only adds published emails', async () => {
    await request(app).post('/api/leads/analyze').set(auth()).send({ leadIds: [leadAId] }).expect(202);
    await drain();
    const lead = (await request(app).get(`/api/leads/${leadAId}`).set(auth())).body;
    expect(lead.analysisStatus).toBe('done');
    expect(lead.scoredBy).toBe('heuristic');
    expect(lead.score).toBeGreaterThan(0);
    expect(lead.score).toBeLessThanOrEqual(100);
    expect(lead.evidence.length).toBeGreaterThan(3);
    expect(lead.recommendedServices.every((s: any) => ['Website Redesign', 'SEO Optimisation', 'Mobile App'].includes(s.name))).toBe(true);
    const email = lead.contacts.find((c: any) => c.type === 'email');
    expect(email).toMatchObject({ value: 'info@sunrisedental.example', source: 'website_public', kind: 'generic_business', sourceUrl: 'https://sunrisedental.example/contact' });
  });
  it('filters and exports to Excel', async () => {
    const f = (await request(app).get('/api/leads?hasEmail=true&minScore=1').set(auth())).body;
    expect(f.total).toBe(1);
    const x = await request(app).get('/api/leads/export').set(auth()).buffer(true).parse((res, cb) => { const d: Buffer[] = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect((x.body as Buffer).subarray(0, 2).toString()).toBe('PK');
  });
});

describe('email generation, compliance & approval', () => {
  let emailId = '';
  let leadId = '';
  it('blocks approval when sender postal address is missing', async () => {
    const lead = (await request(app).get('/api/leads?hasEmail=true').set(auth())).body.items[0];
    leadId = lead._id;
    const e = await models.Email.create({
      orgId, leadId, to: 'info@sunrisedental.example', subject: 'Quick idea for Sunrise Dental', body: 'Hi Sunrise Dental team, I noticed your site is not mobile friendly and lacks HTTPS. We could fix that quickly. Open to a short call?',
      status: 'pending_approval', trackingId: 'trk_test_1', unsubscribeToken: 'unsub_test_1'
    });
    emailId = String(e._id);
    const r = await request(app).post(`/api/emails/${emailId}/approve`).set(auth()).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/postal address/);
  });
  it('approves after settings are complete; n8n precheck returns compliant render', async () => {
    await request(app).patch('/api/org').set(auth()).send({ sender: { name: 'Prawin', email: 'sales@dealpost.test', companyName: 'Dealpost Pvt Ltd', postalAddress: 'Coimbatore, Tamil Nadu, India' } }).expect(200);
    const r = await request(app).post(`/api/emails/${emailId}/approve`).set(auth()).send({});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('queued');
    // n8n must authenticate
    expect((await request(app).post(`/api/integrations/n8n/emails/${emailId}/precheck`)).status).toBe(401);
    const p = await request(app).post(`/api/integrations/n8n/emails/${emailId}/precheck`).set('X-LeadGen-Key', 'n8n-shared-secret');
    expect(p.body.allowed).toBe(true);
    expect(p.body.text).toContain('Unsubscribe');
    expect(p.body.text).toContain('Coimbatore, Tamil Nadu, India');
    expect(p.body.headers['List-Unsubscribe']).toContain('/u/unsub_test_1');
    const s = await request(app).post(`/api/integrations/n8n/emails/${emailId}/status`).set('X-LeadGen-Key', 'n8n-shared-secret').send({ status: 'sent', providerMessageId: 'gmail-123' });
    expect(s.body.status).toBe('sent');
    expect((await request(app).get(`/api/leads/${leadId}`).set(auth())).body.status).toBe('contacted');
  });
  it('tracks opens and unsubscribes; suppressed recipients are blocked', async () => {
    const px = await request(app).get('/t/o/trk_test_1.gif');
    expect(px.headers['content-type']).toBe('image/gif');
    expect((await models.Email.findById(emailId))!.opens).toBe(1);
    await request(app).post('/u/unsub_test_1').expect(200);
    expect(await models.Suppression.exists({ value: 'info@sunrisedental.example', reason: 'unsubscribed' })).toBeTruthy();
    const e2 = await models.Email.create({ orgId, leadId, to: 'info@sunrisedental.example', subject: 'Follow up', body: 'Following up on my earlier note about your website improvements and booking.', status: 'pending_approval', trackingId: 't2', unsubscribeToken: 'u2' });
    const r = await request(app).post(`/api/emails/${e2._id}/approve`).set(auth()).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/suppression|Do Not Contact/);
  });
  it('n8n draft callback stores a draft for human approval (never auto-sends)', async () => {
    const lead = await models.Lead.findOne({ orgId, sourceId: 'place_B' });
    lead!.contacts.push({ type: 'email', value: 'hello@smilecare.example', kind: 'generic_business', source: 'website_public', sourceUrl: 'https://smilecare.example', consentBasis: 'published_business_address' } as any);
    await lead!.save();
    const g = await request(app).post('/api/emails/generate').set(auth()).send({ leadIds: [String(lead!._id)] });
    const id = g.body.results[0].emailId;
    expect(id).toBeTruthy();
    const d = await request(app).post(`/api/integrations/n8n/emails/${id}/draft`).set('X-LeadGen-Key', 'n8n-shared-secret').send({ subject: 'Ideas for Smile Care', body: 'Hi Smile Care team, your Google rating of 3.8 suggests room to improve reviews. We help clinics with that. Worth a 15-minute chat?' });
    expect(d.body.status).toBe('pending_approval');
  });
});

describe('n8n analysis callback validates AI output', () => {
  it('drops hallucinated services and falls back on invalid scores', async () => {
    const lead = await models.Lead.findOne({ orgId, sourceId: 'place_B' });
    await models.Lead.updateOne({ _id: lead!._id }, { $set: { analysisStatus: 'queued' } }); // as requestAnalysis does
    const good = await request(app).post(`/api/integrations/n8n/analysis/${lead!._id}`).set('X-LeadGen-Key', 'n8n-shared-secret').send({
      analysis: null,
      score: { score: 71, breakdown: { need: 80, ability_to_pay: 50, reachability: 60, fit: 70 }, summary: 'No website; decent reviews.', evidence: [{ signal: 'No website', detail: 'Listing has no website', source: 'google_places', impact: 20 }], opportunities: [{ title: 'Website', description: 'None listed', priority: 'high' }], recommended_services: [{ name: 'Website Redesign', reason: 'x' }, { name: 'Invented Service', reason: 'y' }] }
    });
    expect(good.body.score).toBe(71);
    const l = await models.Lead.findById(lead!._id);
    expect(l!.recommendedServices.map((s: any) => s.name)).toEqual(['Website Redesign']);
    await models.Lead.updateOne({ _id: lead!._id }, { $set: { analysisStatus: 'queued' } });
    const bad = await request(app).post(`/api/integrations/n8n/analysis/${lead!._id}`).set('X-LeadGen-Key', 'n8n-shared-secret').send({ analysis: null, score: { score: 500 } });
    expect(bad.body.scoredBy).toBe('heuristic');
  });
});

describe('retries are idempotent', () => {
  it('a duplicate analysis callback does not charge twice', async () => {
    const lead = await models.Lead.findOne({ orgId, sourceId: 'place_B' });
    await models.Lead.updateOne({ _id: lead!._id }, { $set: { analysisStatus: 'queued' } });
    const score = { score: 60, breakdown: { need: 60, ability_to_pay: 60, reachability: 60, fit: 60 }, summary: 's', evidence: [], opportunities: [], recommended_services: [] };
    const before = (await models.Organization.findById(orgId))!.credits;
    const send = () => request(app).post(`/api/integrations/n8n/analysis/${lead!._id}`).set('X-LeadGen-Key', 'n8n-shared-secret').send({ analysis: null, score });
    await send(); await send();
    expect((await models.Organization.findById(orgId))!.credits).toBe(before - 2);
  });
  it('a retried discovery job does not reopen a completed search', async () => {
    const job = await models.SearchJob.findOne({ orgId, status: 'completed' });
    await handlers.discovery({ jobId: String(job!._id) }, { _id: job!._id, attempts: 2 });
    expect((await models.SearchJob.findById(job!._id))!.status).toBe('completed');
  });
});

describe('marketplace', () => {
  it('requires Growth plan, reviews and sells without Places data', async () => {
    const lead = await models.Lead.findOne({ orgId, sourceId: 'place_B' });
    expect((await request(app).post('/api/marketplace/my-listings').set(auth()).send({ leadId: String(lead!._id), priceCredits: 10 })).status).toBe(403);
    await models.Organization.updateOne({ _id: orgId }, { $set: { plan: 'growth' } });
    const l = await request(app).post('/api/marketplace/my-listings').set(auth()).send({ leadId: String(lead!._id), priceCredits: 10 });
    expect(l.status).toBe(201);
    await drain(); // rules review
    expect((await models.MarketplaceListing.findById(l.body._id))!.status).toBe('active');

    const b = await request(app).post('/api/auth/register').send({ name: 'Buyer', email: 'buyer@agency.test', password: 'secret123', organization: 'Agency' });
    buyerToken = b.body.token;
    const browse = await request(app).get('/api/marketplace/listings').set({ Authorization: `Bearer ${buyerToken}` });
    expect(browse.body.total).toBe(1);
    expect(JSON.stringify(browse.body.items[0])).not.toMatch(/@|\+91/);
    const p = await request(app).post(`/api/marketplace/listings/${l.body._id}/purchase`).set({ Authorization: `Bearer ${buyerToken}` });
    expect(p.status).toBe(201);
    expect(p.body.lead.phone).toBeUndefined(); // Places phone not transferred
    expect(p.body.lead.rating).toBeUndefined();
    expect(p.body.lead.contacts.map((c: any) => c.value)).toEqual(['hello@smilecare.example']);
    expect((await request(app).post(`/api/marketplace/listings/${l.body._id}/purchase`).set({ Authorization: `Bearer ${buyerToken}` })).status).toBe(409);
    const seller = await models.Organization.findById(orgId);
    const buyer = await models.Organization.findOne({ name: 'Agency' });
    expect(buyer!.credits).toBe(40);
    expect(seller!.credits).toBeGreaterThan(0);
  });
  it('purchased leads cannot be resold', async () => {
    const bought = await models.Lead.findOne({ source: 'marketplace' });
    const r = await request(app).get(`/api/marketplace/eligibility/${bought!._id}`).set({ Authorization: `Bearer ${buyerToken}` });
    expect(r.body.eligible).toBe(false);
  });
});

describe('isolation, API keys, admin', () => {
  it('tenants cannot see each other\'s leads', async () => {
    const lead = await models.Lead.findOne({ orgId, sourceId: 'place_A' });
    expect((await request(app).get(`/api/leads/${lead!._id}`).set({ Authorization: `Bearer ${buyerToken}` })).status).toBe(404);
  });
  it('API keys work with scopes and cannot approve emails', async () => {
    const k = await request(app).post('/api/org/api-keys').set(auth()).send({ name: 'CRM sync', scopes: ['leads:read'] });
    expect(k.status).toBe(201);
    const key = k.body.key;
    expect((await request(app).get('/api/leads').set('X-API-Key', key)).status).toBe(200);
    expect((await request(app).post('/api/searches').set('X-API-Key', key).send({ category: 'x', country: 'IN' })).status).toBe(403);
    expect((await request(app).get('/api/emails').set('X-API-Key', key)).status).toBe(403);
  });
  it('platform admin only', async () => {
    expect((await request(app).get('/api/admin/overview').set(auth())).status).toBe(403);
    const a = await request(app).post('/api/auth/register').send({ name: 'Admin', email: 'admin@leadgen.test', password: 'secret123', organization: 'Platform' });
    const o = await request(app).get('/api/admin/overview').set({ Authorization: `Bearer ${a.body.token}` });
    expect(o.status).toBe(200);
    expect(o.body.orgs).toBeGreaterThanOrEqual(3);
  });
});
