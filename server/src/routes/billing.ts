import { Router, raw } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { env } from '../config/env';
import { CREDIT_COSTS, CREDIT_PACKS, PLANS, PlanId } from '../config/plans';
import { CreditTxn, Organization, Payment } from '../models';
import { asyncH, requireAuth, requireRole, requireUser, validate } from '../middleware';
import { addCredits } from '../services/credits';
import { audit } from '../services/integrations';
import { HttpError, badRequest, logger, safeEqual } from '../utils';

const r = Router();

r.get('/plans', (_req, res) => res.json({
  plans: Object.values(PLANS), packs: CREDIT_PACKS, paymentsEnabled: !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
  // Template drafts (free mode) cost nothing to produce, so they cost no credits
  costs: { ...CREDIT_COSTS, emailDraft: env.AI_ENABLED ? CREDIT_COSTS.emailDraft : 0 }
}));

r.get('/balance', requireAuth, asyncH(async (req, res) => {
  const org = await Organization.findById(req.auth!.orgId).select('credits plan planRenewsAt');
  res.json(org);
}));

r.get('/transactions', requireAuth, requireUser, asyncH(async (req, res) => {
  res.json(await CreditTxn.find({ orgId: req.auth!.orgId }).sort({ createdAt: -1 }).limit(200));
}));

/** Create a Razorpay order for a plan or credit pack. Credits are granted only by the verified webhook. */
r.post('/checkout', requireAuth, requireUser, requireRole('owner', 'admin'), validate(z.object({ kind: z.enum(['plan', 'credit_pack']), itemId: z.string() })), asyncH(async (req, res) => {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) throw new HttpError(503, 'Online payments are not configured yet. Contact support to upgrade.', 'payments_disabled');
  const { kind, itemId } = req.body;
  const amountInr = kind === 'plan' ? PLANS[itemId as PlanId]?.priceInrMonthly : CREDIT_PACKS.find((p) => p.id === itemId)?.priceInr;
  if (!amountInr) throw badRequest('Unknown plan or pack');
  const resp = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}` },
    body: JSON.stringify({ amount: amountInr * 100, currency: 'INR', receipt: `${req.auth!.orgId}-${Date.now()}`, notes: { orgId: String(req.auth!.orgId), kind, itemId } })
  });
  if (!resp.ok) throw new HttpError(502, 'Payment provider error', 'payment_error');
  const order: any = await resp.json();
  await Payment.create({ orgId: req.auth!.orgId, providerOrderId: order.id, kind, itemId, amountInr });
  res.json({ orderId: order.id, amount: order.amount, currency: 'INR', keyId: env.RAZORPAY_KEY_ID });
}));

/** Razorpay webhook (payment.captured). Mounted with raw body for signature verification. */
export const razorpayWebhook = Router().post('/', raw({ type: 'application/json' }), asyncH(async (req, res) => {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return res.status(503).end();
  const sig = req.header('x-razorpay-signature') || '';
  const expected = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(req.body).digest('hex');
  if (!safeEqual(sig, expected)) return res.status(401).end();
  const evt = JSON.parse(req.body.toString());
  if (evt.event !== 'payment.captured') return res.json({ ignored: true });
  const p = evt.payload.payment.entity;
  const pay = await Payment.findOne({ providerOrderId: p.order_id });
  if (!pay || pay.status === 'paid') return res.json({ ok: true });
  pay.status = 'paid';
  pay.providerPaymentId = p.id;
  await pay.save();
  if (pay.kind === 'plan') {
    const plan = PLANS[pay.itemId as PlanId];
    await Organization.updateOne({ _id: pay.orgId }, { $set: { plan: plan.id, planRenewsAt: new Date(Date.now() + 30 * 86400_000) } });
    await addCredits(pay.orgId, plan.monthlyCredits, 'purchase', `${plan.name} plan credits`, p.id, `pay:${p.id}`);
  } else {
    const pack = CREDIT_PACKS.find((x) => x.id === pay.itemId)!;
    await addCredits(pay.orgId, pack.credits, 'purchase', `Credit pack ${pack.credits}`, p.id, `pay:${p.id}`);
  }
  await audit('billing.payment_captured', { orgId: pay.orgId, meta: { orderId: p.order_id, amount: p.amount } });
  logger.info({ orgId: String(pay.orgId) }, 'payment applied');
  res.json({ ok: true });
}));

export default r;
