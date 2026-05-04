import { Elysia } from 'elysia';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { users, beatmaps, scores } from '../../db/schema';
import { successResponse, errorResponse } from '../../types';
import { authMiddleware } from '../../middleware/auth';

export const adminModule = new Elysia({ prefix: '/admin' })
  .use(authMiddleware)
  .get(
    '/stats',
    async ({ user, set }) => {
      if (user.role !== 'admin') {
        set.status = 403;
        return errorResponse("Forbidden — requires 'admin' role");
      }

      const [userCount, beatmapCount, scoreCount, activeCount] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(users),
        db.select({ count: sql<number>`count(*)::int` }).from(beatmaps),
        db.select({ count: sql<number>`count(*)::int` }).from(scores),
        db.select({ count: sql<number>`count(DISTINCT ${scores.userId})::int` })
          .from(scores)
          .where(sql`${scores.submittedAt} >= NOW() - INTERVAL '24 hours'`)
      ]);

      return successResponse({
        totalUsers: Number(userCount[0]?.count ?? 0),
        totalBeatmaps: Number(beatmapCount[0]?.count ?? 0),
        totalScores: Number(scoreCount[0]?.count ?? 0),
        dailyActive: Number(activeCount[0]?.count ?? 0)
      });
    }
  );
