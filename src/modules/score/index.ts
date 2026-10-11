import { Elysia, t } from 'elysia';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../../db';
import { scores, beatmaps, users } from '../../db/schema';
import { successResponse, errorResponse, calculateRank } from '../../types';
import { authMiddleware } from '../../middleware/auth';
import { validateMods } from '../../utils/mod-validator';
import { calculateAccuracyFromJudgements, buildScoreInfo, calculatePp, calculateMaxPp } from '../../utils/pp-calculator';

export const scoreModule = new Elysia({ prefix: '/scores' })

  // ── GET /scores/detail/:scoreId — graph data left out of leaderboard lists ──
  .get(
    '/detail/:scoreId',
    async ({ params, set }) => {
      const [row] = await db
        .select({ accuracyHistory: scores.accuracyHistory, hitErrors: scores.hitErrors })
        .from(scores)
        .where(eq(scores.id, params.scoreId))
        .limit(1);
      if (!row) {
        set.status = 404;
        return errorResponse('Score not found');
      }
      return successResponse(row);
    },
    { params: t.Object({ scoreId: t.String({ format: 'uuid' }) }) },
  )

  // ── GET /scores/performance/:beatmapId?mods&total — star rating + max pp (result screen) ──
  .get(
    '/performance/:beatmapId',
    async ({ params, query, set }) => {
      const perf = await calculateMaxPp(params.beatmapId, query.mods ?? '', query.total);
      if (!perf) {
        set.status = 404;
        return errorResponse('No difficulty data for this beatmap');
      }
      return successResponse(perf);
    },
    {
      params: t.Object({ beatmapId: t.String({ format: 'uuid' }) }),
      query: t.Object({
        mods: t.Optional(t.String({ maxLength: 50 })),
        total: t.Optional(t.Numeric({ minimum: 1 })),
      }),
    },
  )

  // ── GET /scores/:beatmapId — scores for a beatmap ─────────────────────
  .get(
    '/:beatmapId',
    async ({ params, set }) => {
      // Verify beatmap exists
      const [beatmap] = await db
        .select({ id: beatmaps.id })
        .from(beatmaps)
        .where(eq(beatmaps.id, params.beatmapId))
        .limit(1);

      if (!beatmap) {
        set.status = 404;
        return errorResponse('Beatmap not found');
      }

      const results = await db
        .select({
          id:          scores.id,
          userId:      scores.userId,
          username:    users.username,
          avatarUrl:   users.avatarUrl,
          score:       scores.score,
          accuracy:    scores.accuracy,
          maxCombo:    scores.maxCombo,
          marvelous:   scores.marvelous,
          perfect:     scores.perfect,
          great:       scores.great,
          good:        scores.good,
          bad:         scores.bad,
          miss:        scores.miss,
          accuracyHistory: scores.accuracyHistory,
          hitErrors:       scores.hitErrors,
          mods:        scores.mods,
          rank:        scores.rank,
          submittedAt: scores.submittedAt,
        })
        .from(scores)
        .innerJoin(users, eq(scores.userId, users.id))
        .where(eq(scores.beatmapId, params.beatmapId))
        .orderBy(desc(scores.score))
        .limit(100);

      return successResponse(results);
    },
    {
      params: t.Object({
        beatmapId: t.String({ format: 'uuid' }),
      }),
    },
  )

  // ── Protected routes ──────────────────────────────────────────────────
  .use(authMiddleware)

  // ── POST /scores — submit a score (protected) ─────────────────────────
  .post(
    '',
    async ({ body, user, set }) => {
      // 2. Validate mods (before any query)
      const modCheck = validateMods(body.mods || '');
      if (!modCheck.valid) {
        set.status = 400;
        return errorResponse(modCheck.error || 'Invalid mods');
      }

      const marvelous = body.marvelous ?? 0;
      const perfect   = body.perfect ?? 0;
      const great     = body.great ?? 0;
      const good      = body.good ?? 0;
      const bad       = body.bad ?? 0;
      const miss      = body.miss ?? 0;

      // 1 + 5. Beatmap lookup and PP (only needs the beatmap id) in parallel: each DB round trip is ~0.4 s.
      const scoreInfo = buildScoreInfo(
        marvelous, perfect, great, good, bad, miss, body.maxCombo, body.score
      );
      const [[beatmap], pp] = await Promise.all([
        db
          .select({
            id: beatmaps.id,
            noteCount: beatmaps.noteCount,
            holdCount: beatmaps.holdCount,
          })
          .from(beatmaps)
          .where(eq(beatmaps.id, body.beatmapId))
          .limit(1),
        calculatePp(body.beatmapId, body.mods || '', scoreInfo),
      ]);

      if (!beatmap) {
        set.status = 404;
        return errorResponse('Beatmap not found');
      }

      const totalJudgements = marvelous + perfect + great + good + bad + miss;

      // 3. Basic validation against beatmap object count
      // A hold note can have multiple ticks, so total judgements can exceed noteCount + holdCount.
      // But we can apply a generous upper bound to prevent integer overflow abuse.
      const maxPossibleObjects = beatmap.noteCount + beatmap.holdCount * 50; 
      if (totalJudgements > maxPossibleObjects || totalJudgements === 0) {
        set.status = 400;
        return errorResponse('Invalid judgement counts');
      }

      // 4. Server-side accuracy recompute
      const accuracy = calculateAccuracyFromJudgements(
        marvelous, perfect, great, good, bad, miss
      );
      const rank = calculateRank(accuracy);

      // ponytail: no transaction (BEGIN/COMMIT = 2 more round trips). Play count and total PP are derived values;
      // total PP is recomputed from all scores on every submit, so a failed update heals on the next one.
      const [newScore] = await db
          .insert(scores)
          .values({
            userId:    user.id,
            beatmapId: body.beatmapId,
            score:     body.score,
            accuracy:  accuracy, // Store server-computed accuracy
            maxCombo:  body.maxCombo,
            marvelous,
            perfect,
            great,
            good,
            bad,
            miss,
            accuracyHistory: body.accuracyHistory ?? null,
            hitErrors:       body.hitErrors       ?? null,
            mods:      body.mods      ?? null,
            pp, // Store calculated PP
            rank,
          })
          .returning();

      await Promise.all([
        db
          .update(beatmaps)
          .set({ playCount: sql`${beatmaps.playCount} + 1` })
          .where(eq(beatmaps.id, body.beatmapId)),
        // Total PP = weighted top 100 (best per ranked beatmap, 0.95^i), computed in the same statement.
        db.execute(sql`
          UPDATE users SET total_pp = COALESCE((
            SELECT SUM(t.pp * POWER(0.95, t.rn - 1))
            FROM (
              SELECT s.pp, ROW_NUMBER() OVER (ORDER BY s.pp DESC) AS rn
              FROM (
                SELECT DISTINCT ON (beatmap_id) pp
                FROM scores
                INNER JOIN beatmaps b ON scores.beatmap_id = b.id
                WHERE user_id = ${user.id} AND b.ranked_status = 'ranked'
                ORDER BY beatmap_id, pp DESC
              ) s
              ORDER BY s.pp DESC
              LIMIT 100
            ) t
          ), 0)
          WHERE id = ${user.id}
        `),
      ]);

      return successResponse(newScore);
    },
    {
      body: t.Object({
        beatmapId: t.String({ format: 'uuid' }),
        score:     t.Integer({ minimum: 0 }),
        accuracy:  t.Number({ minimum: 0, maximum: 100 }),
        maxCombo:  t.Integer({ minimum: 0 }),
        marvelous: t.Optional(t.Integer({ minimum: 0 })),
        perfect:   t.Optional(t.Integer({ minimum: 0 })),
        great:     t.Optional(t.Integer({ minimum: 0 })),
        good:      t.Optional(t.Integer({ minimum: 0 })),
        bad:       t.Optional(t.Integer({ minimum: 0 })),
        miss:      t.Optional(t.Integer({ minimum: 0 })),
        accuracyHistory: t.Optional(t.String()),
        hitErrors:       t.Optional(t.String()),
        mods:      t.Optional(t.String()),
      }),
    },
  );
