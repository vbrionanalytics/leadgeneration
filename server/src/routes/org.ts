import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { PLANS, PlanId } from '../config/plans';
import { COUNTRY_RULES, DEFAULT_RULE } from '../config/compliance';
import { ApiKey, Organization, Suppression, User } from '../models';
import { asyncH, requireRole, requireUser, validate } from '../middleware';
import { audit } from '../services/integrations';
import { badRequest, conflict, encrypt, notFound, randomToken, sha256 } from '../utils';
import { publicUser } from './auth';

const r = Router();
r.use(requireUser);

r.get('/', asyncH(async (req, res) => {
  const org = await Organization.findById(req.auth!.orgId).lean();
  if (!org) throw notFound();
  const { secrets, ...rest } = org as any;
  res.json({ ...rest, secretsConfigured: { googlePlacesKey: !!secrets?.googlePlacesKey, anthropicKey: !!secrets?.anthropicKey }, planDetails: PLANS[org.plan as PlanId] });
}));

const settingsSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  defaultCountry: z.string().length(2).optional(),
  sender: z.object({
    name: z.string().max(80).optional(), email: z.string().email().optional(), companyName: z.string().max(120).optional(),
    postalAddress: z.string().max(300).optional(), website: z.string().url().optional().or(z.literal('')), signature: z.string().max(500).optional()
  }).optional(),
  services: z.array(z.object({ name: z.string().min(2).max(80), description: z.string().max(300).optional(), priceHint: z.string().max(60).optional() })).max(30).optional(),
  compliance: z.object({ legitimateInterestAssessed: z.boolean().optional(), privacyNoticeUrl: z.string().url().optional().or(z.literal('')) }).optional()
});

r.patch('/', requireRole('owner', 'admin'), validate(settingsSchema), asyncH(async (req, res) => {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) set[`${k}.${k2}`] = v2;
    else set[k] = v;
  }
  if (set.defaultCountry) set.defaultCountry = String(set.defaultCountry).toUpperCase();
  await Organization.updateOne({ _id: req.auth!.orgId }, { $set: set });
  const org = await Organization.findById(req.auth!.orgId).select('-secrets');
  await audit('org.update', { orgId: req.auth!.orgId, userId: req.auth!.userId, meta: Object.keys(set), req });
  res.json(org);
}));

r.put('/secrets', requireRole('owner'), validate(z.object({ googlePlacesKey: z.string().min(10).optional().or(z.literal('')), anthropicKey: z.string().min(10).optional().or(z.literal('')) })), asyncH(async (req, res) => {
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  for (const k of ['googlePlacesKey', 'anthropicKey'] as const) {
    if (req.body[k] === '') unset[`secrets.${k}`] = 1;
    else if (req.body[k]) set[`secrets.${k}`] = encrypt(req.body[k]);
  }
  await Organization.updateOne({ _id: req.auth!.orgId }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  await audit('org.secrets_update', { orgId: req.auth!.orgId, userId: req.auth!.userId, meta: Object.keys(req.body), req });
  res.json({ ok: true });
}));

r.get('/compliance-rules', (_req, res) => res.json({ rules: Object.values(COUNTRY_RULES), default: DEFAULT_RULE, disclaimer: 'Conservative defaults, not legal advice.' }));

// ------------------------------------------------ members
r.get('/members', asyncH(async (req, res) => {
  const users = await User.find({ orgId: req.auth!.orgId }).sort({ createdAt: 1 });
  res.json(users.map(publicUser));
}));

r.post('/members', requireRole('owner', 'admin'), validate(z.object({ name: z.string().min(2), email: z.string().email(), role: z.enum(['admin', 'member']).default('member') })), asyncH(async (req, res) => {
  const org = await Organization.findById(req.auth!.orgId);
  const count = await User.countDocuments({ orgId: req.auth!.orgId });
  if (count >= PLANS[org!.plan as PlanId].seats) throw badRequest(`Your plan allows ${PLANS[org!.plan as PlanId].seats} seat(s).`);
  if (await User.exists({ email: req.body.email.toLowerCase() })) throw conflict('This email already has an account.');
  const tempPassword = `${randomToken(9)}9a`;
  const user = await User.create({ orgId: req.auth!.orgId, name: req.body.name, email: req.body.email, role: req.body.role, passwordHash: await bcrypt.hash(tempPassword, 12) });
  await audit('org.member_add', { orgId: req.auth!.orgId, userId: req.auth!.userId, target: String(user._id), req });
  // Temporary password is shown once to the inviter to share securely; the user should change it on first login.
  res.status(201).json({ user: publicUser(user), tempPassword });
}));

r.delete('/members/:id', requireRole('owner', 'admin'), asyncH(async (req, res) => {
  if (req.params.id === String(req.auth!.userId)) throw badRequest('You cannot remove yourself.');
  const u = await User.findOne({ _id: req.params.id, orgId: req.auth!.orgId });
  if (!u) throw notFound();
  if (u.role === 'owner') throw badRequest('The owner cannot be removed.');
  await u.deleteOne();
  await audit('org.member_remove', { orgId: req.auth!.orgId, userId: req.auth!.userId, target: String(req.params.id), req });
  res.json({ ok: true });
}));

// ------------------------------------------------ API keys
r.get('/api-keys', requireRole('owner', 'admin'), asyncH(async (req, res) => {
  res.json(await ApiKey.find({ orgId: req.auth!.orgId, revokedAt: null }).select('-keyHash').sort({ createdAt: -1 }));
}));

r.post('/api-keys', requireRole('owner', 'admin'), validate(z.object({
  name: z.string().min(2).max(60),
  scopes: z.array(z.enum(['leads:read', 'leads:write', 'search:write'])).min(1).default(['leads:read'])
})), asyncH(async (req, res) => {
  const org = await Organization.findById(req.auth!.orgId);
  if (!['growth', 'agency'].includes(org!.plan)) throw badRequest('API access requires the Growth plan or higher.');
  const raw = `lg_${randomToken(24)}`;
  const key = await ApiKey.create({ orgId: req.auth!.orgId, createdBy: req.auth!.userId, name: req.body.name, prefix: raw.slice(0, 8), keyHash: sha256(raw), scopes: req.body.scopes });
  await audit('org.api_key_create', { orgId: req.auth!.orgId, userId: req.auth!.userId, target: String(key._id), req });
  res.status(201).json({ id: key._id, name: key.name, prefix: key.prefix, scopes: key.scopes, key: raw }); // shown once
}));

r.delete('/api-keys/:id', requireRole('owner', 'admin'), asyncH(async (req, res) => {
  await ApiKey.updateOne({ _id: req.params.id, orgId: req.auth!.orgId }, { $set: { revokedAt: new Date() } });
  await audit('org.api_key_revoke', { orgId: req.auth!.orgId, userId: req.auth!.userId, target: String(req.params.id), req });
  res.json({ ok: true });
}));

// ------------------------------------------------ suppression list
r.get('/suppressions', asyncH(async (req, res) => {
  res.json(await Suppression.find({ orgId: req.auth!.orgId }).sort({ createdAt: -1 }).limit(1000));
}));

r.post('/suppressions', validate(z.object({ value: z.string().min(3), reason: z.enum(['manual', 'legal_request', 'complaint']).default('manual') })), asyncH(async (req, res) => {
  const v = req.body.value.trim().toLowerCase();
  const type = v.startsWith('@') ? 'domain' : 'email';
  if (type === 'email' && !z.string().email().safeParse(v).success) throw badRequest('Enter an email or @domain.com');
  const doc = await Suppression.findOneAndUpdate({ orgId: req.auth!.orgId, value: v }, { $set: { type, reason: req.body.reason, source: 'dashboard' } }, { upsert: true, returnDocument: 'after' });
  res.status(201).json(doc);
}));

r.delete('/suppressions/:id', requireRole('owner', 'admin'), asyncH(async (req, res) => {
  const s = await Suppression.findOne({ _id: req.params.id, orgId: req.auth!.orgId });
  if (!s) throw notFound();
  if (s.reason === 'unsubscribed' || s.reason === 'complaint') throw badRequest('Recipient opt-outs cannot be removed.');
  await s.deleteOne();
  res.json({ ok: true });
}));

export default r;
