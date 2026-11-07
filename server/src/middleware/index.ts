import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ZodError, ZodSchema } from 'zod';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { ApiKey, Organization, User } from '../models';
import { HttpError, forbidden, logger, safeEqual, sha256, unauthorized } from '../utils';

export interface AuthContext {
  userId?: Types.ObjectId;
  orgId: Types.ObjectId;
  role: 'owner' | 'admin' | 'member' | 'api';
  isPlatformAdmin: boolean;
  scopes?: string[];
  via: 'jwt' | 'api_key';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export const asyncH = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res, next).catch(next);

export function signToken(user: { _id: Types.ObjectId; orgId: Types.ObjectId; tokenVersion?: number }) {
  return jwt.sign({ sub: String(user._id), org: String(user.orgId), v: user.tokenVersion ?? 0 }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as any });
}

/** Accepts `Authorization: Bearer <jwt>` (dashboard) or `X-API-Key: lg_...` (programmatic). */
export const requireAuth = asyncH(async (req, _res, next) => {
  const apiKey = req.header('x-api-key');
  if (apiKey) {
    const key = await ApiKey.findOne({ keyHash: sha256(apiKey), revokedAt: null });
    if (!key) throw unauthorized('Invalid API key');
    const org = await Organization.findById(key.orgId).select('status');
    if (!org || org.status !== 'active') throw forbidden('Organisation is suspended');
    ApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } }).catch(() => undefined);
    req.auth = { orgId: key.orgId, role: 'api', isPlatformAdmin: false, scopes: key.scopes, via: 'api_key' };
    return next();
  }
  const header = req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) throw unauthorized();
  let payload: any;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch {
    throw unauthorized('Session expired. Please sign in again.');
  }
  const user = await User.findById(payload.sub).select('orgId role isPlatformAdmin tokenVersion');
  if (!user || (user.tokenVersion ?? 0) !== payload.v) throw unauthorized('Session revoked');
  const org = await Organization.findById(user.orgId).select('status');
  if (!org) throw unauthorized();
  if (org.status !== 'active' && !user.isPlatformAdmin) throw forbidden('Organisation is suspended');
  req.auth = { userId: user._id, orgId: user.orgId, role: user.role as any, isPlatformAdmin: !!user.isPlatformAdmin, via: 'jwt' };
  next();
});

export const requireRole = (...roles: AuthContext['role'][]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth || !roles.includes(req.auth.role)) return next(forbidden('Your role cannot perform this action.'));
  next();
};

export const requireScope = (scope: string) => (req: Request, _res: Response, next: NextFunction) => {
  if (req.auth?.via === 'api_key' && !req.auth.scopes?.includes(scope)) return next(forbidden(`API key lacks scope ${scope}`));
  next();
};

/** Dashboard-only actions (approvals, billing, keys) — API keys cannot perform them. */
export const requireUser = (req: Request, _res: Response, next: NextFunction) => {
  if (req.auth?.via !== 'jwt') return next(forbidden('This action requires a signed-in user.'));
  next();
};

export const requirePlatformAdmin = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.isPlatformAdmin) return next(forbidden('Platform admin only'));
  next();
};

/** Authenticates calls from n8n using the shared secret header. */
export const requireN8n = (req: Request, _res: Response, next: NextFunction) => {
  const provided = req.header(env.N8N_WEBHOOK_HEADER) || '';
  if (!env.N8N_WEBHOOK_SECRET || !safeEqual(provided, env.N8N_WEBHOOK_SECRET)) return next(unauthorized('Invalid integration credentials'));
  next();
};

export const validate =
  (schema: ZodSchema, where: 'body' | 'query' = 'body') =>
  (req: Request, _res: Response, next: NextFunction) => {
    const r = schema.safeParse(req[where]);
    if (!r.success) return next(new HttpError(400, 'Validation failed', 'validation_error', r.error.flatten().fieldErrors));
    if (where === 'body') req.body = r.data;
    else (req as any).validQuery = r.data;
    next();
  };

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) return res.status(400).json({ error: { code: 'validation_error', message: 'Validation failed', details: err.flatten().fieldErrors } });
  if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  if (err?.code === 11000) return res.status(409).json({ error: { code: 'conflict', message: 'Duplicate record' } });
  if (err?.name === 'CastError') return res.status(400).json({ error: { code: 'bad_id', message: 'Invalid id' } });
  logger.error({ err: err?.message, stack: err?.stack, path: req.path }, 'Unhandled error');
  if (process.env.DEBUG_ERRORS) console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong. It has been logged.' } });
}
