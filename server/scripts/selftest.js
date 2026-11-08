/**
 * End-to-end self-test of a running AI LeadGen install. Run from the server folder:
 *   node scripts/selftest.js
 * Checks: API + database, analyzer (with its token), a live free OpenStreetMap search,
 * the email login (SMTP), and that each workspace has the details outreach needs.
 * Sends no email and creates no data.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const results = [];
const ok = (name, detail) => results.push(['✓', name, detail]);
const bad = (name, detail) => results.push(['✗', name, detail]);
const warn = (name, detail) => results.push(['!', name, detail]);
const port = process.env.PORT || 4000;

async function step(name, fn) {
  try { await fn(); } catch (e) { bad(name, e.message); }
}

(async () => {
  await step('API + database', async () => {
    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    h.ok && h.db ? ok('API + database', `mode ${h.mode}`) : bad('API + database', JSON.stringify(h));
  });

  await step('Website analyzer', async () => {
    const base = process.env.ANALYZER_URL || 'http://127.0.0.1:8000';
    const r = await fetch(`${base}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ANALYZER_TOKEN || ''}` },
      body: JSON.stringify({ url: 'https://example.com' }),
      signal: AbortSignal.timeout(45000)
    });
    const a = await r.json();
    a.ok ? ok('Website analyzer', `read ${a.url}, ${a.pages_checked?.length || 1} page(s)`) : bad('Website analyzer', a.error || `HTTP ${r.status}`);
  });

  await step('OpenStreetMap search', async () => {
    const { searchOsm } = require('../dist/services/osm');
    const t0 = Date.now();
    const places = await searchOsm({ category: 'hospitals', city: process.env.SELFTEST_CITY || 'Erode', country: 'IN', max: 50 });
    ok('OpenStreetMap search', `${places.length} hospitals in ${process.env.SELFTEST_CITY || 'Erode'} (${Math.round((Date.now() - t0) / 1000)}s), ${places.filter((p) => p.website).length} with websites`);
  });

  await step('Email sending (SMTP)', async () => {
    if (process.env.AUTOMATION_MODE === 'n8n') return ok('Email sending', 'handled by n8n workflow 4 (Gmail credential)');
    if (!process.env.SMTP_URL) return bad('Email sending (SMTP)', 'SMTP_URL is not set in server/.env');
    const t = require('nodemailer').createTransport(process.env.SMTP_URL);
    await t.verify();
    const user = decodeURIComponent(new URL(process.env.SMTP_URL).username);
    ok('Email sending (SMTP)', `logged in as ${user}`);
  });

  await step('Workspaces', async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const { Organization } = require('../dist/models');
    const orgs = await Organization.find().lean();
    if (!orgs.length) return warn('Workspaces', 'none yet: sign up at the site');
    for (const o of orgs) {
      const missing = [];
      if (!o.sender?.name || !o.sender?.email) missing.push('sender name/email');
      if (!o.sender?.postalAddress) missing.push('postal address');
      if (!o.services?.length) missing.push('services');
      (missing.length ? warn : ok)(`Workspace "${o.name}"`, missing.length ? `missing ${missing.join(', ')}` : `${o.plan} plan, ${o.credits} credits, ${o.services.length} services`);
    }
    await mongoose.disconnect();
  });

  console.log('\nAI LeadGen self-test');
  for (const [mark, name, detail] of results) console.log(`  ${mark} ${name}: ${detail}`);
  const failed = results.filter((r) => r[0] === '✗').length;
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})();
