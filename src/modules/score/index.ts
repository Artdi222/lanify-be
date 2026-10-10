import { Elysia, t } from 'elysia';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../../db';
import { scores, beatmaps, users } from '../../db/schema';
import { successResponse, errorResponse, calculateRank } from '../../types';
import { authMiddleware } from '../../middleware/auth';
import { validateMods } from '../../utils/mod-validator';
import { calculateAccuracyFromJudgements, buildScoreInfo, calculatePp, calculateMaxPp } from '../../utils/pp-calculator';

export const scoreModule = new Elysia({ prefix: '/scores' })

  // ── GET /scores/performance/:beatmapId — NM star rating + max pp (result screen) ──
  .get(
    '/performance/:beatmapId',
    async ({ params, set }) => {
      const perf = await calculateMaxPp(params.beatmapId);
      if (!perf) {
        set.status = 404;
        return errorResponse('No difficulty data for this beatmap');
      }
      return successResponse(perf);
    },
    { params: t.Object({ beatmapId: t.String({ format: 'uuid' }) }) },
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
      // 1. Verify beatmap exists and get note counts
      const [beatmap] = await db
        .select({ 
          id: beatmaps.id,
          noteCount: beatmaps.noteCount,
          holdCount: beatmaps.holdCount,
        })
        .from(beatmaps)
        .where(eq(beatmaps.id, body.beatmapId))
        .limit(1);

      if (!beatmap) {
        set.status = 404;
        return errorResponse('Beatmap not found');
      }

      // 2. Validate mods
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

      // 5. Calculate PP
      const scoreInfo = buildScoreInfo(
        marvelous, perfect, great, good, bad, miss, body.maxCombo, body.score
      );
      
      const pp = await calculatePp(beatmap.id, body.mods || '', scoreInfo);

      let newScore;
      await db.transaction(async (tx) => {
        // Insert score
        const [inserted] = await tx
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
        
        newScore = inserted;
        
        // Increment play count on beatmap
        await tx
          .update(beatmaps)
          .set({ playCount: sql`${beatmaps.playCount} + 1` })
          .where(eq(beatmaps.id, body.beatmapId));
          
        // Recompute user's total PP (weighted top-N)
        // Note: we only count scores set on 'ranked' maps for PP.
        const userTopScores = await tx.execute(sql`
          SELECT s.pp
          FROM (
            SELECT DISTINCT ON (beatmap_id) pp
            FROM scores
            INNER JOIN beatmaps b ON scores.beatmap_id = b.id
            WHERE user_id = ${user.id} AND b.ranked_status = 'ranked'
            ORDER BY beatmap_id, pp DESC
          ) s
          ORDER BY s.pp DESC
          LIMIT 100
        `);

        let totalPp = 0;
        const rows = (userTopScores as any).rows ?? userTopScores;
        rows.forEach((row: any, i: number) => {
          totalPp += row.pp * Math.pow(0.95, i);
        });

        await tx
          .update(users)
          .set({ totalPp })
          .where(eq(users.id, user.id));
      });

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
