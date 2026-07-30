import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { authModule } from './modules/auth';
import { beatmapModule } from './modules/beatmap';
import { scoreModule } from './modules/score';
import { leaderboardModule } from './modules/leaderboard';
import { userModule } from './modules/user';
import { adminModule } from './modules/admin';

const port = Number(process.env.PORT) || 3000;

const app = new Elysia()
  // ── Global plugins ────────────────────────────────────────────────────
  .use(cors({
    origin: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
      : true
  }))

  // ── Global error handler ──────────────────────────────────────────────
  .onError(({ code, error, set, request }) => {
    console.error(`[${code}] ${request.method} ${request.url}`, error);

    if (code === 'VALIDATION') {
      set.status = 422;
      return {
        success: false,
        error: 'Validation failed',
        details: error.message,
      };
    }

    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { success: false, error: 'Route not found' };
    }

    set.status = 500;
    return { success: false, error: 'Internal server error' };
  })

  // ── Health check ──────────────────────────────────────────────────────
  .get('/', () => ({
    success: true,
    data: {
      name: 'Lanify API',
      version: '1.0.0',
      description: 'osu!mania web rhythm game backend',
    },
  }))

  // ── API modules ───────────────────────────────────────────────────────
  .use(authModule)
  .use(beatmapModule)
  .use(scoreModule)
  .use(leaderboardModule)
  .use(userModule)
  .use(adminModule)

  // ── Start ─────────────────────────────────────────────────────────────
  .listen({
    port,
    hostname: '0.0.0.0'
  });

console.log(`
Port:    ${String(port).padEnd(35)}
URL:     http://localhost:${String(port).padEnd(18)}
`);



export type App = typeof app;
export default app;
