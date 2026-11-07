import { Request } from 'express';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { AuditLog } from '../models';
import { HttpError, logger } from '../utils';
import type { WebsiteAnalysis } from './ai';

// ------------------------------------------------------------------ website analyzer (FastAPI)
export async function analyzeWebsite(url: string): Promise<WebsiteAnalysis> {
  try {
    const res = await fetch(`${env.ANALYZER_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(env.ANALYZER_TOKEN ? { Authorization: `Bearer ${env.ANALYZER_TOKEN}` } : {}) },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(45_000)
    });
    if (!res.ok) return { ok: false, url, error: `Analyzer HTTP ${res.status}` };
    return (await res.json()) as WebsiteAnalysis;
  } catch (e: any) {
    return { ok: false, url, error: `Analyzer unreachable: ${e.message}` };
  }
}

// ------------------------------------------------------------------ n8n webhooks
export const N8N_PATHS = {
  discovery: 'leadgen-discovery',
  analysis: 'leadgen-analysis',
  emailGenerate: 'leadgen-email-generate',
  emailSend: 'leadgen-email-send',
  marketplace: 'leadgen-marketplace'
} as const;
export type N8nFlow = keyof typeof N8N_PATHS;

export async function dispatchToN8n(flow: N8nFlow, payload: Record<string, unknown>) {
  if (!env.N8N_WEBHOOK_SECRET) throw new HttpError(503, 'N8N_WEBHOOK_SECRET is not configured', 'n8n_not_configured');
  const url = `${env.N8N_BASE_URL.replace(/\/$/, '')}/webhook/${N8N_PATHS[flow]}`;
  const body = { ...payload, callbackBaseUrl: `${env.API_URL.replace(/\/$/, '')}/api/integrations/n8n` };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [env.N8N_WEBHOOK_HEADER]: env.N8N_WEBHOOK_SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  });
  if (!res.ok) throw new Error(`n8n ${flow} webhook responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  logger.info({ flow }, 'Dispatched to n8n');
}

// ------------------------------------------------------------------ audit
export async function audit(action: string, opts: { orgId?: Types.ObjectId | string; userId?: Types.ObjectId | string; target?: string; meta?: unknown; req?: Request }) {
  try {
    await AuditLog.create({ action, orgId: opts.orgId, userId: opts.userId, target: opts.target, meta: opts.meta, ip: opts.req?.ip });
  } catch (e: any) {
    logger.error({ err: e.message }, 'audit write failed');
  }
}
