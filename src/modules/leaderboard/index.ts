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
        userId:     scores.userId,
        username:   users.username,
        avatarUrl:  users.avatarUrl,
        totalScore: sql<number>`sum(${scores.score})::bigint`.as('total_score'),
        playCount:  sql<number>`count(${scores.id})::int`.as('play_count'),
        avgAccuracy: sql<number>`round(avg(${scores.accuracy})::numeric, 2)`.as('avg_accuracy'),
      })
      .from(scores)
      .innerJoin(users, sql`${scores.userId} = ${users.id}`)
      .groupBy(scores.userId, users.username, users.avatarUrl)
      .orderBy(desc(sql`total_score`))
      .limit(100);

    const ranked = results.map((row, i) => ({ position: i + 1, ...row }));
    return successResponse(ranked);
  })
  .get(
    '/:beatmapId',
    async ({ params }) => {
      const results = await db.execute(sql`
        SELECT DISTINCT ON (s.user_id)
          s.id, s.user_id, u.username, u.avatar_url,
          s.score, s.accuracy, s.max_combo, s.rank, s.mods, s.submitted_at,
          s.marvelous, s.perfect, s.great, s.good, s.bad, s.miss,
          s.accuracy_history, s.hit_errors
        FROM scores s
        INNER JOIN users u ON s.user_id = u.id
        WHERE s.beatmap_id = ${params.beatmapId}
        ORDER BY s.user_id, s.score DESC
      `);

      const rows = (results as any).rows ?? results;
      const sorted = (rows as any[])
        .sort((a: any, b: any) => Number(b.score) - Number(a.score))
        .slice(0, 50)
        .map((row: any, i: number) => ({
          position: i + 1,
          id: row.id,
          userId: row.user_id,
          username: row.username,
          avatarUrl: row.avatar_url,
          score: row.score,
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
          accuracyHistory: row.accuracy_history,
          hitErrors: row.hit_errors,
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
        SELECT DISTINCT ON (s.score)
          s.id, s.user_id, u.username, u.avatar_url,
          s.score, s.accuracy, s.max_combo, s.rank, s.mods, s.submitted_at,
          s.marvelous, s.perfect, s.great, s.good, s.bad, s.miss,
          s.accuracy_history, s.hit_errors
        FROM scores s
        INNER JOIN users u ON s.user_id = u.id
        WHERE s.beatmap_id = ${params.beatmapId} AND s.user_id = ${user.id}
        ORDER BY s.score DESC, s.submitted_at DESC
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
          accuracyHistory: row.accuracy_history,
          hitErrors: row.hit_errors,
        }));

      return successResponse(sorted);
    },
    { params: t.Object({ beatmapId: t.String({ format: 'uuid' }) }) },
  );
