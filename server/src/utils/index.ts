import crypto from 'crypto';
import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-leadgen-key"]', 'req.headers["x-api-key"]', '*.password', '*.passwordHash']
});

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error', public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, 'bad_request', d);
export const unauthorized = (m = 'Unauthorized') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'Forbidden') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const conflict = (m: string) => new HttpError(409, m, 'conflict');
export const paymentRequired = (m = 'Insufficient credits') => new HttpError(402, m, 'insufficient_credits');

// ---------- crypto helpers ----------
export const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const encKey = () => crypto.createHash('sha256').update(env.ENCRYPTION_KEY).digest();

/** AES-256-GCM for secrets stored per organisation (e.g. their own API keys). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}
export function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ---------- dedupe helpers ----------
export function normalizeDomain(url?: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
}
export function normalizePhone(p?: string | null): string | undefined {
  if (!p) return undefined;
  const digits = p.replace(/[^\d+]/g, '');
  return digits.length >= 7 ? digits.replace(/^00/, '+') : undefined;
}
export function normalizeName(n: string): string {
  return n.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Keys used to detect duplicates within an organisation, strongest first. */
export function dedupeKeys(lead: { sourceId?: string; website?: string; phone?: string; name: string; city?: string; country?: string }): string[] {
  const keys: string[] = [];
  if (lead.sourceId) keys.push(`src:${lead.sourceId}`);
  const d = normalizeDomain(lead.website);
  // Ignore shared hosts that many businesses use as their "website"
  if (d && !/(facebook|instagram|linkedin|google|business\.site|wa\.me|justdial|indiamart)\./.test(`${d}.`)) keys.push(`dom:${d}`);
  const p = normalizePhone(lead.phone);
  if (p) keys.push(`tel:${p}`);
  keys.push(`nm:${normalizeName(lead.name)}|${(lead.city || '').toLowerCase()}|${(lead.country || '').toUpperCase()}`);
  return keys;
}

/** A listing's "website" that is really a map, social or directory page means the business has no site of its own. */
export function isOwnWebsite(url?: string | null): boolean {
  const d = normalizeDomain(url);
  if (!d) return false;
  return !/(^|\.)(goo\.gl|google\.[a-z.]+|g\.page|facebook\.com|fb\.me|instagram\.com|linkedin\.com|twitter\.com|x\.com|wa\.me|whatsapp\.com|justdial\.com|indiamart\.com|sulekha\.com|practo\.com|zomato\.com|swiggy\.com|tripadvisor\.[a-z.]+|booking\.com|linktr\.ee)$/.test(d);
}

/** Rejects syntactically broken emails and common top-level-domain typos (gmail.con, .cmo) that would bounce. */
export function isUsableEmail(e: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/i.test(e) && !/\.(con|cmo|comm|ocm|vom|xom|coom|nett?t)$/i.test(e);
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
