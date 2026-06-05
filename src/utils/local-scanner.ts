import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { BeatmapDecoder } from 'osu-parsers';
import { ManiaRuleset } from 'osu-mania-stable';
import type { Beatmap } from '../db/schema';

export interface LocalBeatmapInfo {
  beatmap: Beatmap;
  folderName: string;
  osuFileName: string;
  audioFilename: string;
  backgroundFilename: string | null;
}

export class LocalBeatmapScanner {
  private static cache: LocalBeatmapInfo[] = [];
  private static lastScanTime = 0;
  private static CACHE_TTL = 300000; // 5 minutes
  private static CACHE_FILE = path.join(process.cwd(), '.cache', 'local-songs-cache.json');

  private static async loadFileCache(): Promise<Record<string, any>> {
    try {
      const data = await fs.readFile(this.CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      return parsed.entries || {};
    } catch {
      return {};
    }
  }

  private static async saveFileCache(entries: Record<string, any>): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.CACHE_FILE), { recursive: true });
      await fs.writeFile(
        this.CACHE_FILE,
        JSON.stringify({ version: '1', songsPath: this.getSongsPath(), entries }, null, 2),
        'utf-8'
      );
    } catch (err) {
      console.warn('Failed to save local songs cache file:', err);
    }
  }

  /**
   * Get the absolute path to the local osu! Songs directory.
   */
  static getSongsPath(): string {
    if (process.env.LOCAL_OSU_SONGS_PATH) {
      return path.normalize(process.env.LOCAL_OSU_SONGS_PATH);
    }

    // Inside Docker, default to '/app/songs' which is where the host volume will be mounted.
    // Outside Docker, fallback to the standard Windows path.
    const isDocker = process.env.IS_DOCKER === 'true' || process.platform !== 'win32';
    if (isDocker) {
      return '/app/songs';
    }

    return path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'osu!', 'Songs');
  }

  /**
   * Scan the Songs directory and return all parsed mania beatmaps.
   */
  static async scan(force = false): Promise<LocalBeatmapInfo[]> {
    const now = Date.now();
    if (!force && this.cache.length > 0 && now - this.lastScanTime < this.CACHE_TTL) {
      return this.cache;
    }

    const songsPath = this.getSongsPath();
    const results: LocalBeatmapInfo[] = [];

    try {
      // Check if folder exists
      await fs.access(songsPath);
    } catch {
      console.warn(`Local osu! Songs folder not found or inaccessible at: ${songsPath}`);
      return [];
    }

    try {
      const dirs = await fs.readdir(songsPath, { withFileTypes: true });
      const songDirs = dirs.filter((d) => d.isDirectory()).map((d) => d.name);

      const decoder = new BeatmapDecoder();
      const fileCache = await this.loadFileCache();
      let cacheUpdated = false;
      const newFileCache: Record<string, any> = {};

      for (const dirName of songDirs) {
        const dirPath = path.join(songsPath, dirName);
        try {
          const files = await fs.readdir(dirPath);
          const osuFiles = files.filter((f) => f.endsWith('.osu'));

          for (const osuFile of osuFiles) {
            const osuPath = path.join(dirPath, osuFile);
            const cacheKey = `${dirName}/${osuFile}`;
            try {
              const stats = await fs.stat(osuPath);
              const mtimeMs = stats.mtime.getTime();
              const size = stats.size;

              // Check if we have a valid cache entry
              const cachedEntry = fileCache[cacheKey];
              if (cachedEntry && cachedEntry.mtimeMs === mtimeMs && cachedEntry.size === size) {
                // Restore Date object for createdAt
                const info = cachedEntry.info;
                info.beatmap.createdAt = new Date(info.beatmap.createdAt);
                results.push(info);
                newFileCache[cacheKey] = cachedEntry;
                continue;
              }

              // Otherwise parse the file
              const content = await fs.readFile(osuPath, 'utf-8');
              const parsed = decoder.decodeFromString(content);

              // Only mania beatmaps (Mode 3)
              if (parsed.mode !== 3) {
                continue;
              }

              const id = this.generateUuid(dirName, osuFile);

              // Calculate star rating
              let starRating = 1.0;
              try {
                const ruleset = new ManiaRuleset();
                const difficultyCalculator = ruleset.createDifficultyCalculator(parsed);
                const attrs = difficultyCalculator.calculate();
                starRating = Math.round(attrs.starRating * 100) / 100;
              } catch (err) {
                console.warn(`Failed to calculate stars for local map ${dirName}/${osuFile}:`, err);
              }

              // Count notes and hold notes
              let noteCount = 0;
              let holdCount = 0;
              if (parsed.hitObjects) {
                for (const obj of parsed.hitObjects) {
                  const isHold = (obj as any).duration > 0 || (obj as any).endTime > obj.startTime;
                  if (isHold) {
                    holdCount++;
                  } else {
                    noteCount++;
                  }
                }
              }

              // BPM calculation
              let bpm = 120;
              if (parsed.controlPoints?.timingPoints && parsed.controlPoints.timingPoints.length > 0) {
                const beatLength = parsed.controlPoints.timingPoints[0].beatLength;
                if (beatLength > 0) {
                  bpm = Math.round(60000 / beatLength);
                }
              }

              // Song length calculation
              let lengthSeconds = 0;
              if (parsed.hitObjects && parsed.hitObjects.length > 0) {
                const lastObj = parsed.hitObjects[parsed.hitObjects.length - 1];
                lengthSeconds = Math.round(((lastObj as any).endTime || lastObj.startTime) / 1000);
              }

              const audioFilename = parsed.general.audioFilename?.trim() || '';
              const backgroundFilename = parsed.events.backgroundPath?.trim() || null;

              // Build a standardized Beatmap object resembling the Database schema
              const beatmap: Beatmap = {
                id,
                title: parsed.metadata.title || 'Unknown Title',
                artist: parsed.metadata.artist || 'Unknown Artist',
                creator: parsed.metadata.creator || 'Unknown Creator',
                difficultyName: parsed.metadata.version || 'Normal',
                mode: 'mania',
                keyCount: Math.round(parsed.difficulty.circleSize || 4),
                starRating,
                bpm,
                bpmMin: bpm,
                bpmMax: bpm,
                lengthSeconds,
                od: parsed.difficulty.overallDifficulty || 8,
                hp: parsed.difficulty.drainRate || 8,
                filePath: `local://${dirName}/${osuFile}`,
                coverUrl: backgroundFilename
                  ? `http://localhost:3000/beatmaps/local/bg?id=${id}`
                  : null,
                rankedStatus: 'ranked',
                uploadedBy: null,
                noteCount,
                holdCount,
                playCount: 0,
                favoriteCount: 0,
                createdAt: new Date(),
              };

              const info: LocalBeatmapInfo = {
                beatmap,
                folderName: dirName,
                osuFileName: osuFile,
                audioFilename,
                backgroundFilename,
              };

              results.push(info);

              newFileCache[cacheKey] = {
                mtimeMs,
                size,
                info
              };
              cacheUpdated = true;
            } catch (err) {
              console.warn(`Failed to parse file: ${osuPath}`, err);
            }
          }
        } catch (err) {
          console.warn(`Failed to read folder contents of: ${dirPath}`, err);
        }
      }

      // If we scanned new/updated maps, or some were deleted (length mismatch)
      if (cacheUpdated || Object.keys(fileCache).length !== Object.keys(newFileCache).length) {
        await this.saveFileCache(newFileCache);
      }

      this.cache = results;
      this.lastScanTime = now;
      console.log(`Local beatmap scanner successfully indexed ${results.length} difficulties.`);
    } catch (err) {
      console.error('Error during local beatmap folder scanning:', err);
    }

    return results;
  }

  /**
   * Generate a deterministic UUID based on folder and filename.
   */
  private static generateUuid(folder: string, filename: string): string {
    const hash = crypto.createHash('md5').update(`${folder}/${filename}`).digest('hex');
    return hash.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  }

  /**
   * Find a scanned beatmap by ID.
   */
  static async getById(id: string): Promise<LocalBeatmapInfo | null> {
    const list = await this.scan();
    return list.find((item) => item.beatmap.id === id) || null;
  }
}
