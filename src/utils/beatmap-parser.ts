import JSZip from 'jszip';
import { BeatmapDecoder } from 'osu-parsers';
import { ManiaRuleset } from 'osu-mania-stable';

export interface StarRatingResult {
  difficultyName: string;
  starRating: number;
}

export interface CachedDifficulty {
  difficultyName: string;
  mods: string;
  starRating: number;
  greatHitWindow: number;
  maxCombo: number;
}

export class BeatmapParser {
  /**
   * Reads an .osz file (Buffer) and calculates star ratings for all mania difficulties.
   */
  static async calculateStarsFromOsz(buffer: Buffer): Promise<StarRatingResult[]> {
    const zip = await JSZip.loadAsync(buffer);
    const results: StarRatingResult[] = [];

    const osuFiles = Object.keys(zip.files).filter((name) => name.endsWith('.osu'));
    const decoder = new BeatmapDecoder();

    for (const filename of osuFiles) {
      const content = await zip.files[filename].async('string');
      try {
        const parsedBeatmap = decoder.decodeFromString(content);
        
        // Only process mania difficulties (Mode 3)
        if (parsedBeatmap.mode !== 3) {
           continue;
        }

        const ruleset = new ManiaRuleset();
        const difficultyCalculator = ruleset.createDifficultyCalculator(parsedBeatmap);
        const difficultyAttributes = difficultyCalculator.calculate();

        const difficultyName = parsedBeatmap.metadata.version;
        // Keep starRating up to 2 decimal places
        const starRating = Math.round(difficultyAttributes.starRating * 100) / 100;

        results.push({
          difficultyName,
          starRating,
        });
      } catch (err) {
        console.error(`Failed to parse ${filename} for star calculation:`, err);
      }
    }

    return results;
  }

  /**
   * Reads an .osz file and calculates full difficulty attributes for caching.
   * Includes combinations for NM, DT, HT, HD, HDDT, HDHT.
   */
  static async calculateAllDifficultiesFromOsz(buffer: Buffer): Promise<CachedDifficulty[]> {
    const zip = await JSZip.loadAsync(buffer);
    const results: CachedDifficulty[] = [];

    const osuFiles = Object.keys(zip.files).filter((name) => name.endsWith('.osu'));
    const decoder = new BeatmapDecoder();

    // Mod combinations to cache
    const modVariants = ['NM', 'DT', 'HT', 'HD', 'DTHD', 'HTHD'];

    for (const filename of osuFiles) {
      const content = await zip.files[filename].async('string');
      try {
        const parsedBeatmap = decoder.decodeFromString(content);
        if (parsedBeatmap.mode !== 3) continue;

        const ruleset = new ManiaRuleset();
        const difficultyName = parsedBeatmap.metadata.version;
        const difficultyCalculator = ruleset.createDifficultyCalculator(parsedBeatmap);

        for (const modStr of modVariants) {
          const mods = ruleset.createModCombination(modStr);
          // calculateWithMods returns ManiaDifficultyAttributes
          const attrs = difficultyCalculator.calculateWithMods(mods) as any;

          results.push({
            difficultyName,
            mods: modStr,
            starRating: attrs.starRating,
            greatHitWindow: attrs.greatHitWindow,
            maxCombo: attrs.maxCombo,
          });
        }
      } catch (err) {
        console.error(`Failed to parse ${filename} for difficulty caching:`, err);
      }
    }

    return results;
  }
}
