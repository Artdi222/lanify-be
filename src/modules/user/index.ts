import { Elysia, t } from 'elysia';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema';
import { successResponse, errorResponse } from '../../types';
import { authMiddleware } from '../../middleware/auth';
import { uploadFile } from '../../storage/b2';
import crypto from 'crypto';

const PAGE_SIZE = 50;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Image type from magic bytes; null for anything that is not JPEG/PNG/WebP/GIF. */
export function imageType(b: Uint8Array): { mime: string; ext: string } | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (ascii(0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  return null;
}
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
    '/:id/scores',
    async ({ params }) => {
      // Best pp score per ranked beatmap, same set and order that builds users.total_pp (weight 0.95^i).
      // "first" = that score is also the top pp on the beatmap (leaderboards sort by pp).
      const rows = rowsOf(await db.execute(sql`
        WITH best AS (
          SELECT DISTINCT ON (s.beatmap_id) s.id, s.beatmap_id, s.score, s.accuracy, s.max_combo, s.pp, s.rank, s.mods, s.submitted_at
          FROM scores s
          INNER JOIN beatmaps b ON b.id = s.beatmap_id
          WHERE s.user_id = ${params.id} AND b.ranked_status = 'ranked'
          ORDER BY s.beatmap_id, s.pp DESC
        )
        SELECT best.id, best.score, best.accuracy, best.max_combo AS "maxCombo", best.pp, best.rank, best.mods,
               to_json(best.submitted_at AT TIME ZONE 'UTC')#>>'{}' AS "submittedAt",
               b.id AS "beatmapId", b.title, b.artist, b.difficulty_name AS "difficultyName", b.key_count AS "keyCount",
               b.cover_url AS "coverUrl",
               NOT EXISTS (SELECT 1 FROM scores o WHERE o.beatmap_id = best.beatmap_id AND o.pp > best.pp) AS first
        FROM best
        INNER JOIN beatmaps b ON b.id = best.beatmap_id
        ORDER BY best.pp DESC
        LIMIT 100
      `));
      return successResponse(rows.map((r, i) => ({ ...r, weight: Math.pow(0.95, i) })));
    },
    { params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  )
  .get(
    '/:id',
    async ({ params, set }) => {
      // One round trip: the DB is remote (~400 ms per query), so four sequential queries took ~1.7 s.
      const [row] = rowsOf(await db.execute(sql`
        SELECT u.id, u.username, u.avatar_url AS "avatarUrl", u.banner_url AS "bannerUrl", u.country,
               to_json(u.created_at AT TIME ZONE 'UTC')#>>'{}' AS "createdAt", u.total_pp AS "totalPp",
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
  // ── POST /users/me/image — avatar/banner upload for any signed-in user ──
  // (/beatmaps/upload is admin-only.) The type is read from the file's magic bytes, not the client's header,
  // so nothing but a raster image (no SVG/HTML) is ever stored and later served back from this origin.
  .post(
    '/me/image',
    async ({ body, user, set }) => {
      const buffer = Buffer.from(await body.file.arrayBuffer());
      const type = imageType(buffer);
      if (!type) {
        set.status = 400;
        return errorResponse('Only JPEG, PNG, WebP or GIF images are allowed');
      }
      if (buffer.length > MAX_IMAGE_BYTES) {
        set.status = 400;
        return errorResponse('Image must be 5 MB or smaller');
      }
      const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 12);
      try {
        const filePath = await uploadFile(`avatars/${user.id}-${hash}.${type.ext}`, buffer, type.mime);
        return successResponse({ filePath });
      } catch (err: any) {
        set.status = 500;
        return errorResponse(`Upload failed: ${err.message}`);
      }
    },
    { body: t.Object({ file: t.File() }) },
  )
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
