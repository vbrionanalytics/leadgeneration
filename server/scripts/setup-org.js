/**
 * Configure an organisation from a JSON file, directly on the server (no browser needed).
 *   node scripts/setup-org.js ../deploy/orgs/vbrion.json
 * The file names the owner's email; that user must have signed up already.
 * Safe to re-run: profile and services are overwritten, credits are topped up only to `creditsAtLeast`.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scripts/setup-org.js <org.json>'); process.exit(1); }
  const cfg = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  await mongoose.connect(process.env.MONGODB_URI);
  const { User, Organization } = require('../dist/models');
  const { addCredits } = require('../dist/services/credits');

  const owner = await User.findOne({ email: cfg.ownerEmail.toLowerCase() });
  if (!owner) {
    console.error(`✗ No account for ${cfg.ownerEmail}. Sign up at the site with that email first, then re-run.`);
    process.exit(2);
  }
  const set = {};
  if (cfg.name) set.name = cfg.name;
  if (cfg.defaultCountry) set.defaultCountry = cfg.defaultCountry;
  if (cfg.plan) set.plan = cfg.plan;
  if (cfg.sender) set.sender = cfg.sender;
  if (cfg.services) set.services = cfg.services;
  if (cfg.compliance) set.compliance = cfg.compliance;
  await Organization.updateOne({ _id: owner.orgId }, { $set: set });

  let org = await Organization.findById(owner.orgId);
  if (cfg.creditsAtLeast && org.credits < cfg.creditsAtLeast) {
    await addCredits(org._id, cfg.creditsAtLeast - org.credits, 'adjustment', 'Initial allocation (setup-org)');
    org = await Organization.findById(owner.orgId);
  }
  console.log(`✓ ${org.name}: plan ${org.plan}, ${org.credits} credits, ${org.services.length} services, sender ${org.sender?.name} <${org.sender?.email}>`);
  console.log(`✓ footer address: ${org.sender?.postalAddress ? 'set' : 'MISSING'}`);
  await mongoose.disconnect();
})().catch((e) => { console.error('✗ setup-org failed:', e.message); process.exit(1); });
