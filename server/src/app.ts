import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import mongoose from 'mongoose';
import { env } from './config/env';
import { errorHandler, requireAuth, requirePlatformAdmin } from './middleware';
import { logger } from './utils';
import authRoutes from './routes/auth';
import orgRoutes from './routes/org';
import billingRoutes, { razorpayWebhook } from './routes/billing';
import marketRoutes from './routes/market';
import { leadsRouter, searchRouter } from './routes/leads';
import { campaignsRouter, emailsRouter } from './routes/outreach';
import { adminRouter, n8nRouter, publicRouter } from './routes/system';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind Nginx
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' || req.url!.startsWith('/t/') } }));

  // Webhooks needing the raw body come before the JSON parser
  app.use('/api/billing/webhook/razorpay', razorpayWebhook);
  app.use(express.json({ limit: '2mb' }));

  // Public endpoints used inside emails (no CORS needed)
  app.use(publicRouter);

  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim());
  app.use('/api', cors({ origin: origins, credentials: true }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1, mode: env.AUTOMATION_MODE }));

  app.use('/api/auth', authRoutes);
  app.use('/api/integrations/n8n', n8nRouter);
  app.use('/api/billing', billingRoutes);
  app.use('/api/org', requireAuth, orgRoutes);
  app.use('/api/searches', requireAuth, searchRouter);
  app.use('/api/leads', requireAuth, leadsRouter);
  app.use('/api/emails', requireAuth, emailsRouter);
  app.use('/api/campaigns', requireAuth, campaignsRouter);
  app.use('/api/marketplace', requireAuth, marketRoutes);
  app.use('/api/admin', requireAuth, requirePlatformAdmin, adminRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } }));
  app.use(errorHandler);
  return app;
}
