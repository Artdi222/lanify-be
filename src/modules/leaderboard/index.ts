import { Elysia, t } from 'elysia';
import { desc, sql } from 'drizzle-orm';
import { db } from '../../db';
import { scores, users } from '../../db/schema';
import { successResponse } from '../../types';
import { authMiddleware } from '../../middleware/auth';

export const leaderboardModule = new Elysia({ prefix: '/leaderboard' })
  .get('/global', async () => {
    const results = await db
      .select({
        userId:     users.id,
        username:   users.username,
        avatarUrl:  users.avatarUrl,
        totalPp:    users.totalPp,
      })
      .from(users)
      .where(sql`${users.totalPp} > 0`)
      .orderBy(desc(users.totalPp))
      .limit(100);

    const ranked = results.map((row, i) => ({ position: i + 1, ...row }));
    return successResponse(ranked);
  })
  .get(
    '/:beatmapId',
    async ({ params }) => {
      const results = await db.execute(sql`
        SELECT * FROM (
          SELECT DISTINCT ON (s.user_id)
            s.id, s.user_id, u.username, u.avatar_url,
            s.score, s.pp, s.accuracy, s.max_combo, s.rank, s.mods,
            to_json(s.submitted_at AT TIME ZONE 'UTC')#>>'{}' AS submitted_at,
            s.marvelous, s.perfect, s.great, s.good, s.bad, s.miss
          FROM scores s
          INNER JOIN users u ON s.user_id = u.id
          WHERE s.beatmap_id = ${params.beatmapId}
          ORDER BY s.user_id, s.pp DESC
        ) sub
        ORDER BY pp DESC
        LIMIT 50
      `);

      const rows = (results as any).rows ?? results;
      const sorted = (rows as any[])
        .map((row: any, i: number) => ({
          position: i + 1,
          id: row.id,
          userId: row.user_id,
          username: row.username,
          avatarUrl: row.avatar_url,
          score: row.score,
          pp: row.pp,
          accuracy: row.accuracy,
          maxCombo: row.max_combo,
          rank: row.rank,
          mods: row.mods,
          submittedAt: row.submitted_at,
          judgements: {
            marvelous: row.marvelous,
            perfect: row.perfect,
            great: row.great,
            good: row.good,
            bad: row.bad,
            miss: row.miss,
          },
          // Graph data (~140 KB per score) is fetched per score via GET /scores/detail/:id.
          accuracyHistory: null,
          hitErrors: null,
        }));

      return successResponse(sorted);
    },
    { params: t.Object({ beatmapId: t.String({ format: 'uuid' }) }) },
  )
  .use(authMiddleware)
  .get(
    '/:beatmapId/local',
    async ({ params, user }) => {
      const results = await db.execute(sql`
        SELECT
          s.id, s.user_id, u.username, u.avatar_url,
          s.score, s.pp, s.accuracy, s.max_combo, s.rank, s.mods,
          to_json(s.submitted_at AT TIME ZONE 'UTC')#>>'{}' AS submitted_at,
          s.marvelous, s.perfect, s.great, s.good, s.bad, s.miss
        FROM scores s
        INNER JOIN users u ON s.user_id = u.id
        WHERE s.beatmap_id = ${params.beatmapId} AND s.user_id = ${user.id}
        ORDER BY s.pp DESC, s.submitted_at DESC
        LIMIT 50
      `);

      const rows = (results as any).rows ?? results;
      const sorted = (rows as any[])
        .map((row: any, i: number) => ({
          position: i + 1,
          id: row.id,
          userId: row.user_id,
          username: row.username,
          avatarUrl: row.avatar_url,
          score: row.score,
          pp: row.pp,
          accuracy: row.accuracy,
          maxCombo: row.max_combo,
          rank: row.rank,
          mods: row.mods,
          submittedAt: row.submitted_at,
          judgements: {
            marvelous: row.marvelous,
            perfect: row.perfect,
            great: row.great,
            good: row.good,
            bad: row.bad,
            miss: row.miss,
          },
          // Graph data (~140 KB per score) is fetched per score via GET /scores/detail/:id.
          accuracyHistory: null,
          hitErrors: null,
        }));

      return successResponse(sorted);
    },
    { params: t.Object({ beatmapId: t.String({ format: 'uuid' }) }) },
  );
