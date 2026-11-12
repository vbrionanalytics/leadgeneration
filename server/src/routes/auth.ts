import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { adminEmails } from '../config/env';
import { PLANS, PlanId } from '../config/plans';
import { Organization, User } from '../models';
import { asyncH, requireAuth, requireUser, signToken, validate } from '../middleware';
import { addCredits } from '../services/credits';
import { audit } from '../services/integrations';
import { badRequest, conflict, randomToken, unauthorized } from '../utils';

/** Organisation as the browser sees it: no secrets, plus the plan's limits (results per search, seats). */
const withPlan = (o: any) => (o ? { ...o.toObject(), planDetails: PLANS[o.plan as PlanId] } : o);

const r = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

const password = z.string().min(8, 'At least 8 characters').max(128).regex(/[A-Za-z]/, 'Must contain a letter').regex(/\d/, 'Must contain a number');

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org';

r.post(
  '/register',
  limiter,
  validate(z.object({ name: z.string().min(2).max(80), email: z.string().email(), password, organization: z.string().min(2).max(80), country: z.string().length(2).default('IN') })),
  asyncH(async (req, res) => {
    const { name, email, password: pw, organization, country } = req.body;
    if (await User.exists({ email: email.toLowerCase() })) throw conflict('An account with this email already exists.');
    const org = await Organization.create({
      name: organization, slug: `${slugify(organization)}-${randomToken(3).toLowerCase()}`, plan: 'free', defaultCountry: country.toUpperCase(),
      sender: { name, email, companyName: organization }
    });
    const user = await User.create({
      orgId: org._id, email, name, role: 'owner', passwordHash: await bcrypt.hash(pw, 12), isPlatformAdmin: adminEmails.includes(email.toLowerCase())
    });
    await addCredits(org._id, PLANS.free.monthlyCredits, 'grant', 'Welcome credits (Free plan)', undefined, `welcome:${org._id}`);
    await audit('auth.register', { orgId: org._id, userId: user._id, req });
    res.status(201).json({ token: signToken(user), user: publicUser(user), organization: withPlan(await Organization.findById(org._id).select('-secrets')) });
  })
);

r.post(
  '/login',
  limiter,
  validate(z.object({ email: z.string().email(), password: z.string().min(1) })),
  asyncH(async (req, res) => {
    const user = await User.findOne({ email: req.body.email.toLowerCase() }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(req.body.password, user.passwordHash))) throw unauthorized('Incorrect email or password.');
    if (adminEmails.includes(user.email) && !user.isPlatformAdmin) user.isPlatformAdmin = true;
    user.lastLoginAt = new Date();
    await user.save();
    await audit('auth.login', { orgId: user.orgId, userId: user._id, req });
    res.json({ token: signToken(user), user: publicUser(user), organization: withPlan(await Organization.findById(user.orgId).select('-secrets')) });
  })
);

r.get(
  '/me',
  requireAuth,
  requireUser,
  asyncH(async (req, res) => {
    const [user, org] = await Promise.all([User.findById(req.auth!.userId), Organization.findById(req.auth!.orgId).select('-secrets')]);
    res.json({ user: publicUser(user!), organization: withPlan(org) });
  })
);

r.post(
  '/change-password',
  requireAuth,
  requireUser,
  validate(z.object({ currentPassword: z.string(), newPassword: password })),
  asyncH(async (req, res) => {
    const user = await User.findById(req.auth!.userId).select('+passwordHash');
    if (!user || !(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) throw badRequest('Current password is incorrect.');
    user.passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    user.tokenVersion = (user.tokenVersion ?? 0) + 1; // revoke other sessions
    await user.save();
    await audit('auth.change_password', { orgId: user.orgId, userId: user._id, req });
    res.json({ token: signToken(user) });
  })
);

r.post(
  '/logout-all',
  requireAuth,
  requireUser,
  asyncH(async (req, res) => {
    await User.updateOne({ _id: req.auth!.userId }, { $inc: { tokenVersion: 1 } });
    res.json({ ok: true });
  })
);

export function publicUser(u: any) {
  return { id: String(u._id), name: u.name, email: u.email, role: u.role, isPlatformAdmin: !!u.isPlatformAdmin, orgId: String(u.orgId) };
}

export default r;
