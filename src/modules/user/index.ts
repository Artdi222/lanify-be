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
          bannerUrl: users.bannerUrl,
          country: users.country,
          createdAt: users.createdAt,
          totalPp: users.totalPp,
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
          playCount:   sql<number>`count(${scores.id})::int`,
          avgAccuracy: sql<number>`round(coalesce(avg(${scores.accuracy}), 0)::numeric, 2)`,
        })
        .from(scores)
        .where(eq(scores.userId, params.id));

      const rankRes = await db.execute(sql`
        SELECT COUNT(*) + 1 as rank
        FROM users
        WHERE total_pp > ${user.totalPp}
      `);

      const rankRows = (rankRes as any).rows ?? rankRes;
      const globalRank = rankRows[0]?.rank ?? 0;

      let countryRank: number | null = null;
      if (user.country) {
        const cr = await db.execute(sql`
          SELECT COUNT(*) + 1 as rank
          FROM users
          WHERE country = ${user.country} AND total_pp > ${user.totalPp}
        `);
        const crRows = (cr as any).rows ?? cr;
        countryRank = Number(crRows[0]?.rank ?? 0);
      }

      return successResponse({
        ...user,
        globalRank: Number(globalRank),
        countryRank,
        stats: {
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
      if (body.bannerUrl !== undefined) updateData.bannerUrl = body.bannerUrl;
      if (body.country !== undefined) updateData.country = body.country.toUpperCase();

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
          bannerUrl: users.bannerUrl,
          country: users.country,
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
        bannerUrl: t.Optional(t.String()),
        country: t.Optional(t.String({ pattern: '^[A-Za-z]{2}$' })),
      }),
    },
  );
