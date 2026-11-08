/**
 * Re-apply the current rule-based scoring to leads that were already analysed, using the
 * website analysis saved on each lead. No websites are fetched and no credits are charged.
 *   node scripts/rescore.js            (all organisations)
 *   node scripts/rescore.js info@vbrion.com   (one organisation, by owner email)
 * Only leads scored by the rules ("heuristic") are touched; AI-scored leads are left alone.
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const { User, Organization, Lead } = require('../dist/models');
  const { heuristicScore } = require('../dist/services/ai');

  const filter = { analysisStatus: 'done', scoredBy: 'heuristic' };
  if (process.argv[2]) {
    const owner = await User.findOne({ email: process.argv[2].toLowerCase() });
    if (!owner) throw new Error(`No user ${process.argv[2]}`);
    filter.orgId = owner.orgId;
  }
  const orgs = new Map();
  let n = 0;
  for await (const lead of Lead.find(filter).cursor()) {
    const key = String(lead.orgId);
    if (!orgs.has(key)) orgs.set(key, await Organization.findById(lead.orgId).select('services').lean());
    const services = (orgs.get(key)?.services || []).map((s) => ({ name: s.name, description: s.description }));
    const ctx = { name: lead.name, category: lead.category, city: lead.city, country: lead.country, website: lead.website, rating: lead.rating, reviewCount: lead.reviewCount };
    const analysis = lead.website_analysis && lead.website_analysis.toObject ? lead.website_analysis.toObject() : lead.website_analysis;
    const r = heuristicScore(ctx, lead.website ? analysis || null : null, services);
    lead.score = r.score;
    lead.scoreBreakdown = new Map(Object.entries(r.breakdown));
    lead.scoreSummary = r.summary;
    lead.evidence = r.evidence;
    lead.opportunities = r.opportunities;
    lead.recommendedServices = r.recommended_services;
    if (lead.status === 'new' && r.score >= 60) lead.status = 'qualified';
    await lead.save();
    n++;
    console.log(`${String(r.score).padStart(3)}  ${lead.name}  ->  ${r.recommended_services.map((s) => s.name).join('; ') || '(no service match)'}`);
  }
  console.log(`\nRe-scored ${n} lead(s). No credits used.`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
