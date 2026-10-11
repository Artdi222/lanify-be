/**
 * Dev seed: fake players, scores on ranked beatmaps and friendships, for testing the dashboard, rankings,
 * leaderboards and profiles.
 *
 *   bun scripts/seed-dev.ts            # add seed data (run --reset first to start over)
 *   bun scripts/seed-dev.ts --reset    # delete every seed user (scores/friends cascade), then recompute total pp
 *
 * Seed users are recognised by their email domain; all share the password `password123`.
 * Your own account (the first admin, or SEED_FRIEND_OF=<username>) gets them as friends, some following back.
 */
import bcrypt from 'bcryptjs';
import { eq, like, sql } from 'drizzle-orm';
import { db } from '../src/db';
import { beatmaps, friends, scores, users } from '../src/db/schema';
import { calculateRank } from '../src/types';
import { buildScoreInfo, calculateAccuracyFromJudgements, calculatePp } from '../src/utils/pp-calculator';

const DOMAIN = '@seed.lanify.dev';

// Deterministic RNG so reruns produce the same data.
let seed = 1337;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;

const PLAYERS: [name: string, country: string, skill: number][] = [
  ['TheSnowie', 'US', 0.97], ['GhostNeko', 'CN', 0.95], ['Rembus91', 'KZ', 0.93], ['Noelleyy', 'ID', 0.96],
  ['Hijack3D', 'ID', 0.9], ['Hookseye', 'ID', 0.92], ['PlayerCalledRey', 'ID', 0.88], ['Arrasy', 'ID', 0.86],
  ['HuTao_', 'ID', 0.94], ['rimah2121', 'ID', 0.84], ['Kluxtzy_2003', 'ID', 0.89], ['TORUang31', 'US', 0.91],
  ['bat5231', 'PT', 0.87], ['Myu', 'FI', 0.98], ['suwkuupe', 'HK', 0.92], ['sludgek9unit', 'BR', 0.83],
  ['k2hk2h', 'KR', 0.99], ['sebas8102', 'CA', 0.85], ['waver', 'US', 0.9], ['Jojovin', 'MY', 0.94],
  ['Amasugi', 'VN', 0.88], ['Fazaaaa', 'ID', 0.8], ['akaaaa', 'FR', 0.82], ['collusion', 'RU', 0.86],
];
const ONLINE = new Set(['TheSnowie', 'Myu', 'k2hk2h', 'Jojovin', 'waver']);
const MUTUAL = new Set(['Noelleyy', 'Hookseye', 'TheSnowie', 'TORUang31', 'Rembus91']);

async function reset() {
  // Undo the seed plays' play counts before the scores cascade away.
  await db.execute(sql`
    UPDATE beatmaps b SET play_count = GREATEST(0, b.play_count - c.n)
    FROM (SELECT s.beatmap_id, COUNT(*)::int AS n FROM scores s JOIN users u ON u.id = s.user_id
          WHERE u.email LIKE ${'%' + DOMAIN} GROUP BY s.beatmap_id) c
    WHERE b.id = c.beatmap_id
  `);
  const gone = await db.delete(users).where(like(users.email, `%${DOMAIN}`)).returning({ id: users.id });
  console.log(`Deleted ${gone.length} seed users (scores and friendships cascade).`);
  // Play counts and the real players' totals are untouched; recompute total_pp for everyone left.
  await recomputeTotals();
}

async function recomputeTotals() {
  await db.execute(sql`
    UPDATE users u SET total_pp = COALESCE((
      SELECT SUM(t.pp * POWER(0.95, t.rn - 1)) FROM (
        SELECT s.pp, ROW_NUMBER() OVER (ORDER BY s.pp DESC) AS rn FROM (
          SELECT DISTINCT ON (beatmap_id) pp FROM scores
          INNER JOIN beatmaps b ON scores.beatmap_id = b.id
          WHERE user_id = u.id AND b.ranked_status = 'ranked'
          ORDER BY beatmap_id, pp DESC
        ) s ORDER BY s.pp DESC LIMIT 100
      ) t
    ), 0)
  `);
}

/** One play at roughly `skill` accuracy; returns the scores row. */
function makePlay(userId: string, map: { id: string; noteCount: number; holdCount: number }, skill: number) {
  const total = map.noteCount + map.holdCount * 2; // tap = 1 judgement, hold = head + tail
  const acc = Math.min(0.999, Math.max(0.6, skill - 0.06 + rand() * 0.08));
  const miss = Math.round(total * (1 - acc) * 0.15 * rand());
  const bad = Math.round(total * (1 - acc) * 0.1);
  const good = Math.round(total * (1 - acc) * 0.25);
  const great = Math.round(total * (1 - acc) * 0.8);
  const perfect = Math.round((total - miss - bad - good - great) * (0.25 + rand() * 0.2));
  const marvelous = Math.max(0, total - miss - bad - good - great - perfect);
  const maxCombo = miss === 0 ? total : Math.round(total / (miss + 1 + rand() * 2));
  const score = Math.floor(((marvelous * 320 + perfect * 300 + great * 200 + good * 100 + bad * 50) / (total * 320)) * 1_000_000);
  const accuracy = calculateAccuracyFromJudgements(marvelous, perfect, great, good, bad, miss);
  const daysAgo = rand() * 400;
  return {
    row: {
      userId, beatmapId: map.id, score, accuracy, maxCombo, marvelous, perfect, great, good, bad, miss,
      mods: null, rank: calculateRank(accuracy), submittedAt: new Date(Date.now() - daysAgo * 86_400_000),
    },
    info: buildScoreInfo(marvelous, perfect, great, good, bad, miss, maxCombo, score),
  };
}

async function main() {
  if (process.argv.includes('--reset')) return reset();

  const existing = await db.select({ id: users.id }).from(users).where(like(users.email, `%${DOMAIN}`)).limit(1);
  if (existing.length) {
    console.log('Seed users already exist. Run with --reset first.');
    return;
  }

  const maps = await db
    .select({ id: beatmaps.id, noteCount: beatmaps.noteCount, holdCount: beatmaps.holdCount })
    .from(beatmaps)
    .where(eq(beatmaps.rankedStatus, 'ranked'));
  const playable = maps.filter((m) => m.noteCount > 0);
  if (!playable.length) throw new Error('No ranked beatmaps with note counts to put scores on.');

  const passwordHash = await bcrypt.hash('password123', 10);
  const now = Date.now();
  const created = await db
    .insert(users)
    .values(
      PLAYERS.map(([name, country], i) => ({
        username: name,
        email: `${name.toLowerCase()}${DOMAIN}`,
        passwordHash,
        country,
        // Online players: seen seconds ago. Others: minutes to months ago.
        lastSeenAt: new Date(ONLINE.has(name) ? now - rand() * 60_000 : now - (5 + i ** 2.6 * 40) * 60_000),
      })),
    )
    .returning({ id: users.id, username: users.username });
  console.log(`Created ${created.length} players (password: password123).`);

  const skillOf = new Map(PLAYERS.map(([n, , s]) => [n, s]));
  const plays = created.flatMap((u) => {
    const count = 4 + Math.floor(rand() * Math.min(10, playable.length));
    const chosen = [...playable].sort(() => rand() - 0.5).slice(0, count);
    return chosen.map((m) => makePlay(u.id, m, skillOf.get(u.username)!));
  });

  // PP through the real calculator (one cache lookup each), 10 at a time.
  for (let i = 0; i < plays.length; i += 10) {
    await Promise.all(plays.slice(i, i + 10).map(async (p) => {
      (p.row as any).pp = await calculatePp(p.row.beatmapId, '', p.info);
    }));
  }
  await db.insert(scores).values(plays.map((p) => p.row as any));
  console.log(`Inserted ${plays.length} scores on ${playable.length} ranked beatmaps.`);

  // Friends of your account.
  const ownerName = process.env.SEED_FRIEND_OF;
  const [owner] = ownerName
    ? await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.username, ownerName))
    : await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.role, 'admin')).limit(1);
  if (owner) {
    const followed = created.filter(() => rand() < 0.65);
    for (const n of MUTUAL) {
      const u = created.find((c) => c.username === n);
      if (u && !followed.includes(u)) followed.push(u);
    }
    await db.insert(friends).values(followed.map((u) => ({ userId: owner.id, friendId: u.id }))).onConflictDoNothing();
    const back = followed.filter((u) => MUTUAL.has(u.username));
    await db.insert(friends).values(back.map((u) => ({ userId: u.id, friendId: owner.id }))).onConflictDoNothing();
    console.log(`${owner.username} follows ${followed.length} seed players; ${back.length} follow back.`);
  }

  // Play counts and total pp.
  await db.execute(sql`
    UPDATE beatmaps b SET play_count = b.play_count + c.n
    FROM (SELECT beatmap_id, COUNT(*)::int AS n FROM scores
          WHERE user_id IN (${sql.join(created.map((u) => sql`${u.id}`), sql`, `)}) GROUP BY beatmap_id) c
    WHERE b.id = c.beatmap_id
  `);
  await recomputeTotals();
  console.log('Recomputed play counts and total pp.');
}

await main();
process.exit(0);
