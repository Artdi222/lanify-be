import { db } from '../db';
import { chartDifficulty } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { ManiaRuleset, ManiaDifficultyAttributes } from 'osu-mania-stable';
import { ScoreInfo } from 'osu-classes';

/**
 * Derives a score's accuracy using standard osu!mania weighting rules.
 * Marvelous (MAX) and Perfect (300) = 300
 * Great (200) = 200
 * Good (100) = 100
 * Bad (50) = 50
 * Miss (0) = 0
 */
export function calculateAccuracyFromJudgements(
  marvelous: number,
  perfect: number,
  great: number,
  good: number,
  bad: number,
  miss: number
): number {
  const totalHits = marvelous + perfect + great + good + bad + miss;
  if (totalHits === 0) return 0;

  const points = (marvelous + perfect) * 300 + great * 200 + good * 100 + bad * 50;
  const maxPoints = totalHits * 300;
  
  return (points / maxPoints) * 100;
}

/**
 * Translates judgment counts and basic score info into osu-classes `ScoreInfo`.
 */
export function buildScoreInfo(
  marvelous: number,
  perfect: number,
  great: number,
  good: number,
  bad: number,
  miss: number,
  maxCombo: number,
  score: number
): ScoreInfo {
  return new ScoreInfo({
    rulesetId: 3, // osu!mania ruleset ID
    countGeki: marvelous, // MAX / Marvelous
    count300: perfect,    // 300 / Perfect
    countKatu: great,     // 200 / Great
    count100: good,       // 100 / Good
    count50: bad,         // 50 / Bad
    countMiss: miss,      // 0 / Miss
    maxCombo: maxCombo,
    totalScore: score,
  });
}

/**
 * Calculates Performance Points (PP) for a given score.
 * Fetches precomputed difficulty attributes from the database cache.
 */
export async function calculatePp(
  beatmapId: string,
  modsString: string,
  scoreInfo: ScoreInfo
): Promise<number> {
  const ruleset = new ManiaRuleset();
  const mods = ruleset.createModCombination(modsString || '');
  
  // Mod combination acronyms are typically sorted alphabetically internally,
  // but to be safe, we query based on the normalized acronyms joined.
  const normalizedMods = mods.acronyms.join('');

  // Find cached difficulty attributes
  const [cachedAttrs] = await db
    .select()
    .from(chartDifficulty)
    .where(
      and(
        eq(chartDifficulty.beatmapId, beatmapId),
        eq(chartDifficulty.mods, normalizedMods)
      )
    )
    .limit(1);

  if (!cachedAttrs) {
    // Expected to be populated at beatmap upload time. 
    // If missing, we cannot calculate PP.
    console.warn(`[pp-calculator] Missing difficulty cache for beatmap ${beatmapId} with mods '${normalizedMods}'`);
    return 0;
  }

  // Construct difficulty attributes
  const attributes = new ManiaDifficultyAttributes(mods, cachedAttrs.starRating);
  attributes.greatHitWindow = cachedAttrs.greatHitWindow;
  attributes.maxCombo = cachedAttrs.maxCombo;

  // Calculate performance
  const performanceCalculator = ruleset.createPerformanceCalculator(attributes, scoreInfo);
  const performance = performanceCalculator.calculate();
  
  return performance;
}

/**
 * PP of a perfect (all MAX, full combo) play on a beatmap with no mods, plus its NM star rating.
 * Used as the "Maximum" in the result screen's performance breakdown. Null when the cache is missing.
 */
export async function calculateMaxPp(
  beatmapId: string
): Promise<{ starRating: number; maxCombo: number; maxPp: number } | null> {
  const ruleset = new ManiaRuleset();
  const mods = ruleset.createModCombination('');
  // Same key calculatePp uses for no mods (stored as 'NM').
  const [cachedAttrs] = await db
    .select()
    .from(chartDifficulty)
    .where(and(eq(chartDifficulty.beatmapId, beatmapId), eq(chartDifficulty.mods, mods.acronyms.join(''))))
    .limit(1);
  if (!cachedAttrs) return null;

  const attributes = new ManiaDifficultyAttributes(mods, cachedAttrs.starRating);
  attributes.greatHitWindow = cachedAttrs.greatHitWindow;
  attributes.maxCombo = cachedAttrs.maxCombo;

  // ponytail: every judgement counted as MAX; maxCombo stands in for the judgement count.
  const perfect = buildScoreInfo(cachedAttrs.maxCombo, 0, 0, 0, 0, 0, cachedAttrs.maxCombo, 1_000_000);
  const maxPp = ruleset.createPerformanceCalculator(attributes, perfect).calculate();
  return { starRating: cachedAttrs.starRating, maxCombo: cachedAttrs.maxCombo, maxPp };
}
