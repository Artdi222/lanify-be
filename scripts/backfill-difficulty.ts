import { db } from '../src/db';
import { beatmaps, chartDifficulty } from '../src/db/schema';
import { getFileStream } from '../src/storage/b2';
import { BeatmapParser } from '../src/utils/beatmap-parser';

async function backfill() {
  console.log('Fetching all beatmaps...');
  const allBeatmaps = await db.select().from(beatmaps);

  console.log(`Found ${allBeatmaps.length} beatmaps. Grouping by file path...`);

  const byFile = new Map<string, typeof allBeatmaps>();
  for (const b of allBeatmaps) {
    if (!byFile.has(b.filePath)) byFile.set(b.filePath, []);
    byFile.get(b.filePath)!.push(b);
  }

  for (const [filePath, fileBeatmaps] of byFile.entries()) {
    console.log(`Processing ${filePath} (${fileBeatmaps.length} difficulties)...`);
    try {
      const file = await getFileStream(filePath);
      const buffer = Buffer.from(await (file.Body as any).transformToByteArray());
      
      const allDiffs = await BeatmapParser.calculateAllDifficultiesFromOsz(buffer);
      
      const cacheInserts = [];
      for (const nb of fileBeatmaps) {
        const matches = allDiffs.filter(d => d.difficultyName === nb.difficultyName);
        for (const m of matches) {
          cacheInserts.push({
            beatmapId: nb.id,
            mods: m.mods,
            starRating: m.starRating,
            greatHitWindow: m.greatHitWindow,
            maxCombo: m.maxCombo,
          });
        }
      }
      if (cacheInserts.length > 0) {
        await db.insert(chartDifficulty).values(cacheInserts).onConflictDoNothing();
        console.log(`Inserted ${cacheInserts.length} cache entries for ${filePath}.`);
      } else {
        console.log(`No cache entries generated for ${filePath}.`);
      }
    } catch (err) {
      console.error(`Failed to process ${filePath}:`, err);
    }
  }

  console.log('Backfill complete.');
  process.exit(0);
}

backfill();
