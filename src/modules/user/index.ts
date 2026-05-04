import { Elysia, t } from 'elysia';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { users, scores } from '../../db/schema';
import { successResponse, errorResponse } from '../../types';
import { authMiddleware } from '../../middleware/auth';

export const userModule = new Elysia({ prefix: '/users' })
  .get(
    '/:id',
    async ({ params, set }) => {
      const [user] = await db
        .select({
          id: users.id,
          username: users.username,
          avatarUrl: users.avatarUrl,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, params.id))
        .limit(1);

      if (!user) {
        set.status = 404;
        return errorResponse('User not found');
      }

      const [stats] = await db
        .select({
          totalScore:  sql<number>`coalesce(sum(${scores.score}), 0)::bigint`,
          playCount:   sql<number>`count(${scores.id})::int`,
          avgAccuracy: sql<number>`round(coalesce(avg(${scores.accuracy}), 0)::numeric, 2)`,
        })
        .from(scores)
        .where(eq(scores.userId, params.id));

      return successResponse({
        ...user,
        stats: {
          totalScore:  Number(stats?.totalScore ?? 0),
          playCount:   Number(stats?.playCount ?? 0),
          avgAccuracy: Number(stats?.avgAccuracy ?? 0),
        },
      });
    },
    { params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  )
  .use(authMiddleware)
  .put(
    '/me',
    async ({ body, user, set }) => {
      const updateData: Record<string, string> = {};
      if (body.username !== undefined) updateData.username = body.username;
      if (body.avatarUrl !== undefined) updateData.avatarUrl = body.avatarUrl;

      const [updated] = await db
        .update(users)
        .set(updateData)
        .where(eq(users.id, user.id))
        .returning({
          id: users.id,
          username: users.username,
          email: users.email,
          role: users.role,
          avatarUrl: users.avatarUrl,
          createdAt: users.createdAt,
        });

      if (!updated) {
        set.status = 404;
        return errorResponse('User not found');
      }

      return successResponse(updated);
    },
    {
      body: t.Object({
        username: t.Optional(t.String({ minLength: 3, maxLength: 50 })),
        avatarUrl: t.Optional(t.String()),
      }),
    },
  );
