import { Elysia, t } from 'elysia';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema';
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
      // One round trip: the DB is remote (~400 ms per query), so four sequential queries took ~1.7 s.
      const [row] = rowsOf(await db.execute(sql`
        SELECT u.id, u.username, u.avatar_url AS "avatarUrl", u.banner_url AS "bannerUrl", u.country,
               to_json(u.created_at)#>>'{}' AS "createdAt", u.total_pp AS "totalPp",
               (SELECT COUNT(*) FROM scores s WHERE s.user_id = u.id)::int AS "playCount",
               (SELECT ROUND(COALESCE(AVG(s.accuracy), 0)::numeric, 2) FROM scores s WHERE s.user_id = u.id)::float AS "avgAccuracy",
               (SELECT COUNT(*) + 1 FROM users o WHERE o.total_pp > u.total_pp)::int AS "globalRank",
               CASE WHEN u.country IS NULL THEN NULL
                    ELSE (SELECT COUNT(*) + 1 FROM users o WHERE o.country = u.country AND o.total_pp > u.total_pp)::int
               END AS "countryRank"
        FROM users u
        WHERE u.id = ${params.id}
      `));

      if (!row) {
        set.status = 404;
        return errorResponse('User not found');
      }

      const { playCount, avgAccuracy, ...user } = row;
      return successResponse({ ...user, stats: { playCount, avgAccuracy } });
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
