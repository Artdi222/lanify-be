import { Elysia, t } from 'elysia';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../../db';
import { scores, beatmaps, users } from '../../db/schema';
import { successResponse, errorResponse, calculateRank } from '../../types';
import { authMiddleware } from '../../middleware/auth';

export const scoreModule = new Elysia({ prefix: '/scores' })

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
      // Verify beatmap exists
      const [beatmap] = await db
        .select({ id: beatmaps.id })
        .from(beatmaps)
        .where(eq(beatmaps.id, body.beatmapId))
        .limit(1);

      if (!beatmap) {
        set.status = 404;
        return errorResponse('Beatmap not found');
      }

      // Auto-calculate rank from accuracy
      const rank = calculateRank(body.accuracy);

      const [newScore] = await db
        .insert(scores)
        .values({
          userId:    user.id,
          beatmapId: body.beatmapId,
          score:     body.score,
          accuracy:  body.accuracy,
          maxCombo:  body.maxCombo,
          marvelous: body.marvelous ?? 0,
          perfect:   body.perfect   ?? 0,
          great:     body.great     ?? 0,
          good:      body.good      ?? 0,
          bad:       body.bad       ?? 0,
          miss:      body.miss      ?? 0,
          accuracyHistory: body.accuracyHistory ?? null,
          hitErrors:       body.hitErrors       ?? null,
          mods:      body.mods      ?? null,
          rank,
        })
        .returning();
      
      // Increment play count on beatmap
      await db
        .update(beatmaps)
        .set({ playCount: sql`${beatmaps.playCount} + 1` })
        .where(eq(beatmaps.id, body.beatmapId));

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
