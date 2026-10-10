import { Elysia, t } from 'elysia';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { users, scores } from '../../db/schema';
import { successResponse, errorResponse } from '../../types';
import { authMiddleware } from '../../middleware/auth';

const PAGE_SIZE = 50;
const rowsOf = (res: unknown) => ((res as any).rows ?? res) as any[];

export const userModule = new Elysia({ prefix: '/users' })
  // Static routes first so they never fall into '/:id'.
  .get(
    '/rankings',
    async ({ query }) => {
      const page = Math.max(1, query.page ?? 1);
      const country = query.country?.toUpperCase();
      // ponytail: accuracy/play count over all submitted scores, same as the profile endpoint.
      const res = await db.execute(sql`
        SELECT u.id, u.username, u.avatar_url AS "avatarUrl", u.country, u.total_pp AS "totalPp",
               COALESCE(ROUND(AVG(s.accuracy)::numeric, 2), 0)::float AS accuracy,
               COUNT(s.id)::int AS "playCount",
               COUNT(*) FILTER (WHERE s.rank = 'SS')::int AS ss,
               COUNT(*) FILTER (WHERE s.rank = 'S')::int AS s,
               COUNT(*) FILTER (WHERE s.rank = 'A')::int AS a,
               (SELECT COUNT(*) FROM users ${country ? sql`WHERE country = ${country}` : sql``})::int AS total
        FROM users u
        LEFT JOIN scores s ON s.user_id = u.id
        ${country ? sql`WHERE u.country = ${country}` : sql``}
        GROUP BY u.id
        ORDER BY u.total_pp DESC, u.created_at ASC
        LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
      `);
      const rows = rowsOf(res);
      const total = Number(rows[0]?.total ?? 0);
      return successResponse({
        page,
        pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
        entries: rows.map(({ total: _t, ...r }, i) => ({ ...r, rank: (page - 1) * PAGE_SIZE + i + 1 })),
      });
    },
    {
      query: t.Object({
        page: t.Optional(t.Numeric({ minimum: 1 })),
        country: t.Optional(t.String({ pattern: '^[A-Za-z]{2}$' })),
      }),
    },
  )
  .get('/rankings/countries', async () => {
    const res = await db.execute(sql`
      SELECT u.country,
             COUNT(DISTINCT u.id)::int AS "activeUsers",
             COUNT(s.id)::int AS "playCount",
             (SELECT SUM(total_pp) FROM users WHERE country = u.country)::float AS performance
      FROM users u
      LEFT JOIN scores s ON s.user_id = u.id
      WHERE u.country IS NOT NULL
      GROUP BY u.country
      ORDER BY performance DESC
    `);
    return successResponse(
      rowsOf(res).map((r, i) => ({ ...r, rank: i + 1, avgPerformance: r.activeUsers ? r.performance / r.activeUsers : 0 })),
    );
  })
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
