import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { HttpError } from './errors';

export type Role = 'admin' | 'operator' | 'viewer';
export interface AuthUser {
  id: number;
  email: string;
  role: Role;
}

const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const signToken = (user: AuthUser, secret: string) =>
  jwt.sign({ sub: user.id, email: user.email, role: user.role }, secret, { expiresIn: '12h' });

export function verifyToken(token: string, secret: string): AuthUser {
  const p = jwt.verify(token, secret) as any;
  return { id: Number(p.sub), email: p.email, role: p.role };
}

export const authenticate = (secret: string) => (req: Request, _res: Response, next: NextFunction) => {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return next(new HttpError(401, 'Missing bearer token'));
  try {
    req.user = verifyToken(h.slice(7), secret);
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired token'));
  }
};

/** Minimum-role check: admin > operator > viewer. */
export const requireRole = (min: Role) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(new HttpError(401, 'Unauthenticated'));
  if (RANK[req.user.role] < RANK[min]) return next(new HttpError(403, `Requires ${min} role`));
  next();
};
