import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/ai_leadgen'),

  // Public URLs
  APP_URL: z.string().url().default('http://localhost:5173'), // frontend
  API_URL: z.string().url().default('http://localhost:4000'), // backend public base (used in tracking/unsubscribe links & n8n callbacks)
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY must be at least 32 chars'),

  // AI. When false the platform runs free: rule-based scores and template email drafts.
  AI_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-sonnet-5-5'),

  // Discovery
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  /** n8n mode: set true once workflow 1 has a Google Places credential. Direct mode: a key enables it. */
  GOOGLE_PLACES_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  PLACES_CACHE_DAYS: z.coerce.number().default(30),

  // Website analyzer (FastAPI)
  ANALYZER_URL: z.string().default('http://127.0.0.1:8000'),
  ANALYZER_TOKEN: z.string().optional(),
  ANALYZER_PUBLIC_URL: z.string().optional(), // URL n8n uses to reach the analyzer, if different

  // Automation
  AUTOMATION_MODE: z.enum(['n8n', 'direct']).default('direct'),
  N8N_BASE_URL: z.string().default('https://n8n.dealpost.co.in'),
  N8N_WEBHOOK_SECRET: z.string().optional(), // shared secret header value used both directions
  N8N_WEBHOOK_HEADER: z.string().default('X-LeadGen-Key'),

  // Billing (Razorpay; optional)
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Platform
  PLATFORM_ADMIN_EMAILS: z.string().default(''),
  MARKETPLACE_FEE_PERCENT: z.coerce.number().default(15),
  LOG_LEVEL: z.string().default('info')
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const adminEmails = env.PLATFORM_ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
