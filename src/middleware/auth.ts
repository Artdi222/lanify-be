import { Elysia } from 'elysia';
import { jwt } from '@elysiajs/jwt';
import { bearer } from '@elysiajs/bearer';
import type { AuthUser, UserRole } from '../types';

/**
 * Auth middleware — registers JWT + Bearer plugins, then derives
 * `user: AuthUser` onto the context. Routes using this plugin
 * get typed access to `user`.
 */
export const authMiddleware = new Elysia({ name: 'auth-middleware' })
  .use(
    jwt({
      name: 'jwt',
      secret: process.env.JWT_SECRET!,
    }),
  )
  .use(bearer())
  .derive({ as: 'scoped' }, async ({ jwt, bearer, set }) => {
    if (!bearer) {
      set.status = 401;
      throw new Error('Authentication required — no token provided');
    }

    const payload = await jwt.verify(bearer);

    if (!payload) {
      set.status = 401;
      throw new Error('Invalid or expired token');
    }

    const user: AuthUser = {
      id:       payload.sub as string,
      username: payload.username as string,
      role:     (payload.role as UserRole) ?? 'user',
    };

    return { user };
  });

/**
 * Higher-order guard that checks the derived `user.role`.
 * Usage: applied inside handler logic with role checks.
 */
export const requireRole = (role: UserRole) => {
  return ({ user, set }: { user: AuthUser; set: { status: number } }) => {
    if (user.role !== role) {
      set.status = 403;
      throw new Error(`Forbidden — requires '${role}' role`);
    }
  };
};
