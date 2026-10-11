import { Elysia, t } from 'elysia';
import { jwt } from '@elysiajs/jwt';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db } from '../../db';
import { users } from '../../db/schema';
import { successResponse, errorResponse } from '../../types';
import { authMiddleware } from '../../middleware/auth';

export const authModule = new Elysia({ prefix: '/auth' })

  // Register the JWT plugin here too (for sign operations on public routes)
  .use(
    jwt({
      name: 'jwt',
      secret: process.env.JWT_SECRET!,
    }),
  )

  // ── POST /auth/register ────────────────────────────────────────────────
  .post(
    '/register',
    async ({ body, jwt, set }) => {
      const { username, email, password } = body;

      // Check if user already exists
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing.length > 0) {
        set.status = 409;
        return errorResponse('Email is already registered');
      }

      const existingUsername = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username))
        .limit(1);

      if (existingUsername.length > 0) {
        set.status = 409;
        return errorResponse('Username is already taken');
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 12);

      // Insert user
      const [newUser] = await db
        .insert(users)
        .values({ username, email, passwordHash, role: 'user' })
        .returning({
          id:        users.id,
          username:  users.username,
          email:     users.email,
          role:      users.role,
          createdAt: users.createdAt,
        });

      // Sign JWT
      const token = await jwt.sign({
        sub:      newUser!.id,
        username: newUser!.username,
        role:     newUser!.role,
      });

      return successResponse({ user: newUser, token });
    },
    {
      body: t.Object({
        username: t.String({ minLength: 3, maxLength: 50 }),
        email:    t.String({ format: 'email' }),
        password: t.String({ minLength: 8, maxLength: 128 }),
      }),
    },
  )

  // ── POST /auth/login ───────────────────────────────────────────────────
  .post(
    '/login',
    async ({ body, jwt, set }) => {
      const { email, password } = body;

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (!user) {
        set.status = 401;
        return errorResponse('Invalid email or password');
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        set.status = 401;
        return errorResponse('Invalid email or password');
      }

      const token = await jwt.sign({
        sub:      user.id,
        username: user.username,
        role:     user.role,
      });

      return successResponse({
        user: {
          id:        user.id,
          username:  user.username,
          email:     user.email,
          role:      user.role,
          avatarUrl: user.avatarUrl,
          bannerUrl: user.bannerUrl,
          country:   user.country,
          createdAt: user.createdAt,
        },
        token,
      });
    },
    {
      body: t.Object({
        email:    t.String({ format: 'email' }),
        password: t.String({ minLength: 1 }),
      }),
    },
  )

  // ── GET /auth/me (protected) ───────────────────────────────────────────
  .use(authMiddleware)
  .get('/me', async ({ user, set }) => {
    const [found] = await db
      .select({
        id:        users.id,
        username:  users.username,
        email:     users.email,
        role:      users.role,
        avatarUrl: users.avatarUrl,
        bannerUrl: users.bannerUrl,
        country:   users.country,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    if (!found) {
      set.status = 404;
      return errorResponse('User not found');
    }

    return successResponse(found);
  });
