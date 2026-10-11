import { Elysia, t } from 'elysia';
import { desc, sql } from 'drizzle-orm';
import { db } from '../../db';
import { scores, users } from '../../db/schema';
import { successResponse } from '../../types';
import { authMiddleware } from '../../middleware/auth';

// `?mods=["DT","HD"]` (JSON, as stored in scores.mods): only scores with exactly that set; "[]" = no mod.
// Two-way containment so order does not matter.
const modsFilter = (mods?: string) => {
  if (mods === undefined) return sql``;
  return sql`AND COALESCE(NULLIF(s.mods, ''), '[]')::jsonb @> ${mods}::jsonb AND ${mods}::jsonb @> COALESCE(NULLIF(s.mods, ''), '[]')::jsonb`;
};
const modsQuery = t.Object({ mods: t.Optional(t.String({ maxLength: 60, pattern: '^\\[("[A-Z]{2}",?)*\\]$' })) });

/** Best score per player on a beatmap; `who` narrows the players (friends). */
const bestPerPlayer = (beatmapId: string, who: ReturnType<typeof sql>, mods?: string) => sql`
  SELECT * FROM (
    SELECT DISTINCT ON (s.user_id)
      s.id, s.user_id, u.username, u.avatar_url,
      s.score, s.pp, s.accuracy, s.max_combo, s.rank, s.mods,
      to_json(s.submitted_at AT TIME ZONE 'UTC')#>>'{}' AS submitted_at,
      s.marvelous, s.perfect, s.great, s.good, s.bad, s.miss
    FROM scores s
    INNER JOIN users u ON s.user_id = u.id
    WHERE s.beatmap_id = ${beatmapId} ${who} ${modsFilter(mods)}
    ORDER BY s.user_id, s.pp DESC
  ) sub
  ORDER BY pp DESC
  LIMIT 50
`;

const toEntries = (results: unknown) =>
  (((results as any).rows ?? results) as any[]).map((row: any, i: number) => ({
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
    async ({ params, query }) => successResponse(toEntries(await db.execute(bestPerPlayer(params.beatmapId, sql``, query.mods)))),
    { params: t.Object({ beatmapId: t.String({ format: 'uuid' }) }), query: modsQuery },
  )
  .use(authMiddleware)
  .get(
    '/:beatmapId/local',
    async ({ params, query, user }) => {
      const results = await db.execute(sql`
        SELECT
          s.id, s.user_id, u.username, u.avatar_url,
          s.score, s.pp, s.accuracy, s.max_combo, s.rank, s.mods,
          to_json(s.submitted_at AT TIME ZONE 'UTC')#>>'{}' AS submitted_at,
          s.marvelous, s.perfect, s.great, s.good, s.bad, s.miss
        FROM scores s
        INNER JOIN users u ON s.user_id = u.id
        WHERE s.beatmap_id = ${params.beatmapId} AND s.user_id = ${user.id} ${modsFilter(query.mods)}
        ORDER BY s.pp DESC, s.submitted_at DESC
        LIMIT 50
      `);
      return successResponse(toEntries(results));
    },
    { params: t.Object({ beatmapId: t.String({ format: 'uuid' }) }), query: modsQuery },
  )
  // Me and everyone I follow.
  .get(
    '/:beatmapId/friends',
    async ({ params, query, user }) => {
      const who = sql`AND (s.user_id = ${user.id} OR s.user_id IN (SELECT friend_id FROM friends WHERE user_id = ${user.id}))`;
      return successResponse(toEntries(await db.execute(bestPerPlayer(params.beatmapId, who, query.mods))));
    },
    { params: t.Object({ beatmapId: t.String({ format: 'uuid' }) }), query: modsQuery },
  );
