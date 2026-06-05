import { Elysia, t } from 'elysia';
import { eq, sql, desc, and, ne, or, ilike, inArray } from 'drizzle-orm';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import JSZip from 'jszip';
import { db } from '../../db';
import { beatmaps } from '../../db/schema';
import { successResponse, errorResponse } from '../../types';
import { authMiddleware } from '../../middleware/auth';
import { getSignedUrl, deleteFile, uploadFile } from '../../storage/supabase';
import { BeatmapParser } from '../../utils/beatmap-parser';
import { LocalBeatmapScanner } from '../../utils/local-scanner';

export const beatmapModule = new Elysia()
  .group('/beatmaps', (app) => app
    // ── GET /beatmaps/local/bg — Stream local background image ─────────────
    .get(
      '/local/bg',
      async ({ query, set }) => {
        const id = query.id;
        const localMap = await LocalBeatmapScanner.getById(id);
        if (!localMap || !localMap.backgroundFilename) {
          set.status = 404;
          return errorResponse('Background not found');
        }

        const songsPath = LocalBeatmapScanner.getSongsPath();
        const bgPath = path.join(songsPath, localMap.folderName, localMap.backgroundFilename);

        try {
          const fileBuffer = await fs.readFile(bgPath);
          let mimeType = 'image/jpeg';
          if (localMap.backgroundFilename.toLowerCase().endsWith('.png')) mimeType = 'image/png';
          else if (localMap.backgroundFilename.toLowerCase().endsWith('.webp')) mimeType = 'image/webp';
          else if (localMap.backgroundFilename.toLowerCase().endsWith('.gif')) mimeType = 'image/gif';

          set.headers['Content-Type'] = mimeType;
          return fileBuffer;
        } catch {
          set.status = 404;
          return errorResponse('Background file not found');
        }
      },
      {
        query: t.Object({
          id: t.String({ format: 'uuid' }),
        }),
      }
    )

    // ── GET /beatmaps/local/osz — Stream dynamic OSZ zip file ──────────────
    .get(
      '/local/osz',
      async ({ query, set }) => {
        const id = query.id;
        const localMap = await LocalBeatmapScanner.getById(id);
        if (!localMap) {
          set.status = 404;
          return errorResponse('Local beatmap not found');
        }

        const songsPath = LocalBeatmapScanner.getSongsPath();
        const dirPath = path.join(songsPath, localMap.folderName);

        try {
          const zip = new JSZip();
          const files = await fs.readdir(dirPath);

          // 1. Pack all .osu files in the directory
          for (const file of files) {
            if (file.endsWith('.osu')) {
              const content = await fs.readFile(path.join(dirPath, file));
              zip.file(file, content);
            }
          }

          // 2. Pack the current audio file
          if (localMap.audioFilename) {
            const audioPath = path.join(dirPath, localMap.audioFilename);
            try {
              const content = await fs.readFile(audioPath);
              zip.file(localMap.audioFilename, content);
            } catch (err) {
              console.warn(`Could not add audio file to local zip: ${audioPath}`, err);
            }
          }

          // 3. Pack the background file if present
          if (localMap.backgroundFilename) {
            const bgPath = path.join(dirPath, localMap.backgroundFilename);
            try {
              const content = await fs.readFile(bgPath);
              zip.file(localMap.backgroundFilename, content);
            } catch (err) {
              console.warn(`Could not add background file to local zip: ${bgPath}`, err);
            }
          }

          const buffer = await zip.generateAsync({ type: 'nodebuffer' });
          
          set.headers['Content-Type'] = 'application/x-osu-beatmap-archive';
          set.headers['Content-Disposition'] = `attachment; filename="${localMap.folderName}.osz"`;
          return buffer;
        } catch (err: any) {
          set.status = 500;
          return errorResponse(`Failed to generate local OSZ archive: ${err.message}`);
        }
      },
      {
        query: t.Object({
          id: t.String({ format: 'uuid' }),
        }),
      }
    )

    // ── GET /beatmaps — list all (with pagination, grouped by set) ──────────
    .get(
      '',
      async ({ query }) => {
        const page  = Math.max(1, Number(query.page  ?? 1));
        const limitQuery = query.limit;
        const limit = limitQuery === 'all' || limitQuery === '-1'
          ? 999999
          : Math.min(10000, Math.max(1, Number(limitQuery ?? 10)));
        const offset = (page - 1) * limit;
        const search = query.search;

        // Prioritize local beatmaps if any are found
        const localItems = await LocalBeatmapScanner.scan();
        if (localItems.length > 0) {
          const lowerSearch = search ? search.toLowerCase() : '';
          const filteredLocal = localItems.filter(item => {
            const b = item.beatmap;
            return !search || 
              b.title.toLowerCase().includes(lowerSearch) ||
              b.artist.toLowerCase().includes(lowerSearch) ||
              b.creator.toLowerCase().includes(lowerSearch) ||
              b.difficultyName.toLowerCase().includes(lowerSearch);
          }).map(item => item.beatmap);

          const total = filteredLocal.length;
          const paginated = filteredLocal.slice(offset, offset + limit);

          return successResponse({
            data: paginated,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          });
        }

        let whereClause = undefined;
        if (search) {
          const s = `%${search.toLowerCase()}%`;
          whereClause = or(
            ilike(beatmaps.title, s),
            ilike(beatmaps.artist, s),
            ilike(beatmaps.creator, s),
            ilike(beatmaps.difficultyName, s)
          );
        }

        try {
          const countResult = await db
            .select({ count: sql<number>`count(distinct ${beatmaps.filePath})::int` })
            .from(beatmaps)
            .where(whereClause);
          
          const total = countResult[0]?.count ?? 0;

          const uniquePaths = await db
            .select({ filePath: beatmaps.filePath })
            .from(beatmaps)
            .where(whereClause)
            .groupBy(beatmaps.filePath)
            .orderBy(desc(sql`max(${beatmaps.createdAt})`))
            .limit(limit)
            .offset(offset);

          const pathList = uniquePaths.map(p => p.filePath);

          if (pathList.length === 0) {
            return successResponse({
              data: [],
              total,
              page,
              limit,
              totalPages: Math.ceil(total / limit),
            });
          }

          const items = await db
            .select()
            .from(beatmaps)
            .where(inArray(beatmaps.filePath, pathList))
            .orderBy(desc(beatmaps.createdAt));

          return successResponse({
            data: items,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          });
        } catch (err) {
          console.warn('Supabase DB connection failed, returning empty list:', err);
          return successResponse({
            data: [],
            total: 0,
            page,
            limit,
            totalPages: 0,
          });
        }
      },
      {
        query: t.Object({
          page:   t.Optional(t.String()),
          limit:  t.Optional(t.String()),
          search: t.Optional(t.String()),
        }),
      }
    )
    .get(
      '/',
      async ({ query }) => {
        const page  = Math.max(1, Number(query.page  ?? 1));
        const limitQuery = query.limit;
        const limit = limitQuery === 'all' || limitQuery === '-1'
          ? 999999
          : Math.min(10000, Math.max(1, Number(limitQuery ?? 10)));
        const offset = (page - 1) * limit;
        const search = query.search;

        // Prioritize local beatmaps if any are found
        const localItems = await LocalBeatmapScanner.scan();
        if (localItems.length > 0) {
          const lowerSearch = search ? search.toLowerCase() : '';
          const filteredLocal = localItems.filter(item => {
            const b = item.beatmap;
            return !search || 
              b.title.toLowerCase().includes(lowerSearch) ||
              b.artist.toLowerCase().includes(lowerSearch) ||
              b.creator.toLowerCase().includes(lowerSearch) ||
              b.difficultyName.toLowerCase().includes(lowerSearch);
          }).map(item => item.beatmap);

          const total = filteredLocal.length;
          const paginated = filteredLocal.slice(offset, offset + limit);

          return successResponse({
            data: paginated,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          });
        }

        let whereClause = undefined;
        if (search) {
          const s = `%${search.toLowerCase()}%`;
          whereClause = or(
            ilike(beatmaps.title, s),
            ilike(beatmaps.artist, s),
            ilike(beatmaps.creator, s),
            ilike(beatmaps.difficultyName, s)
          );
        }

        try {
          const countResult = await db
            .select({ count: sql<number>`count(distinct ${beatmaps.filePath})::int` })
            .from(beatmaps)
            .where(whereClause);
          
          const total = countResult[0]?.count ?? 0;

          const uniquePaths = await db
            .select({ filePath: beatmaps.filePath })
            .from(beatmaps)
            .where(whereClause)
            .groupBy(beatmaps.filePath)
            .orderBy(desc(sql`max(${beatmaps.createdAt})`))
            .limit(limit)
            .offset(offset);

          const pathList = uniquePaths.map(p => p.filePath);

          if (pathList.length === 0) {
            return successResponse({
              data: [],
              total,
              page,
              limit,
              totalPages: Math.ceil(total / limit),
            });
          }

          const items = await db
            .select()
            .from(beatmaps)
            .where(inArray(beatmaps.filePath, pathList))
            .orderBy(desc(beatmaps.createdAt));

          return successResponse({
            data: items,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          });
        } catch (err) {
          console.warn('Supabase DB connection failed, returning empty list:', err);
          return successResponse({
            data: [],
            total: 0,
            page,
            limit,
            totalPages: 0,
          });
        }
      },
      {
        query: t.Object({
          page:   t.Optional(t.String()),
          limit:  t.Optional(t.String()),
          search: t.Optional(t.String()),
        }),
      }
    )

    // ── GET /beatmaps/:id — single beatmap detail ──────────────────────────
    .get(
      '/:id',
      async ({ params, set }) => {
        // Check local scanner first
        const localMap = await LocalBeatmapScanner.getById(params.id);
        if (localMap) {
          return successResponse(localMap.beatmap);
        }

        try {
          const [beatmap] = await db
            .select()
            .from(beatmaps)
            .where(eq(beatmaps.id, params.id))
            .limit(1);

          if (!beatmap) {
            set.status = 404;
            return errorResponse('Beatmap not found');
          }

          return successResponse(beatmap);
        } catch (err) {
          set.status = 404;
          return errorResponse('Beatmap not found (Supabase DB offline)');
        }
      },
      {
        params: t.Object({
          id: t.String({ format: 'uuid' }),
        }),
      },
    )

    // ── GET /beatmaps/:id/url — signed download URL ───────────────────────
    .get(
      '/:id/url',
      async ({ params, set }) => {
        // Check local scanner first
        const localMap = await LocalBeatmapScanner.getById(params.id);
        if (localMap) {
          return successResponse({ 
            url: `http://localhost:3000/beatmaps/local/osz?id=${params.id}`, 
            expiresIn: 3600 
          });
        }

        try {
          const [beatmap] = await db
            .select({ filePath: beatmaps.filePath })
            .from(beatmaps)
            .where(eq(beatmaps.id, params.id))
            .limit(1);

          if (!beatmap) {
            set.status = 404;
            return errorResponse('Beatmap not found');
          }

          const signedUrl = await getSignedUrl(beatmap.filePath, 3600);
          return successResponse({ url: signedUrl, expiresIn: 3600 });
        } catch (err: any) {
          set.status = 500;
          return errorResponse(`Failed to generate download URL: ${err.message}`);
        }
      },
      {
        params: t.Object({
          id: t.String({ format: 'uuid' }),
        }),
      },
    )

    // ── Protected + Admin routes ──────────────────────────────────────────
    .use(authMiddleware)
  
    // ── POST /beatmaps/calculate-stars — Calculate star rating (admin only) ─
    .post(
      '/calculate-stars',
      async ({ body, user, set }) => {
        if (user.role !== 'admin') {
          set.status = 403;
          return errorResponse("Forbidden — requires 'admin' role");
        }

        const file = body.file;
        try {
          const buffer = Buffer.from(await file.arrayBuffer());
          const starsResult = await BeatmapParser.calculateStarsFromOsz(buffer);
          return successResponse(starsResult);
        } catch (err: any) {
          set.status = 500;
          return errorResponse(`Failed to calculate stars: ${err.message}`);
        }
      },
      {
        body: t.Object({
          file: t.File(),
        }),
      },
    )

    // ── POST /beatmaps/upload — Proxy upload to Supabase (admin only) ───────
    .post(
      '/upload',
      async ({ body, user, set }) => {
        if (user.role !== 'admin') {
          set.status = 403;
          return errorResponse("Forbidden — requires 'admin' role");
        }

        const file = body.file;
        
        try {
          const buffer = Buffer.from(await file.arrayBuffer());
          const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 12);
          const sanitizedName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const fileName = `${hash}-${sanitizedName}`;
          const path = `uploads/${fileName}`;

          const storagePath = await uploadFile(path, buffer, file.type);
          return successResponse({ filePath: storagePath });
        } catch (err: any) {
          set.status = 500;
          return errorResponse(`Upload failed: ${err.message}`);
        }
      },
      {
        body: t.Object({
          file: t.File(),
        }),
      },
    )

    // ── POST /beatmaps/batch — create multiple beatmaps at once (admin only) ──
    .post(
      '/batch',
      async ({ body, user, set }) => {
        if (user.role !== 'admin') {
          set.status = 403;
          return errorResponse("Forbidden — requires 'admin' role");
        }

        const { filePath, coverUrl, commonMetadata, difficulties: diffs } = body;

        const newBeatmaps = await db.transaction(async (tx) => {
          const results = [];
          for (const diff of diffs) {
            const [inserted] = await tx
              .insert(beatmaps)
              .values({
                title:          commonMetadata.title,
                artist:         commonMetadata.artist,
                creator:        commonMetadata.creator,
                difficultyName: diff.difficultyName,
                mode:           'mania',
                keyCount:       diff.keyCount,
                starRating:     diff.starRating,
                bpm:            diff.bpm,
                bpmMin:         diff.bpm,
                bpmMax:         diff.bpm,
                lengthSeconds:  diff.lengthSeconds,
                od:             diff.od,
                hp:             diff.hp,
                noteCount:      diff.noteCount ?? 0,
                holdCount:      diff.holdCount ?? 0,
                filePath:       filePath,
                coverUrl:       coverUrl ?? null,
                rankedStatus:   (body.rankedStatus as any) ?? 'ranked',
                uploadedBy:     user.id,
              })
              .returning();
            results.push(inserted);
          }
          return results;
        });

        return successResponse(newBeatmaps);
      },
      {
        body: t.Object({
          filePath: t.String({ minLength: 1 }),
          coverUrl: t.Optional(t.String()),
          commonMetadata: t.Object({
            title:   t.String({ minLength: 1 }),
            artist:  t.String({ minLength: 1 }),
            creator: t.String({ minLength: 1 }),
          }),
          difficulties: t.Array(t.Object({
            difficultyName: t.String({ minLength: 1 }),
            keyCount:       t.Integer({ minimum: 1, maximum: 10 }),
            starRating:     t.Number({ minimum: 0 }),
            bpm:            t.Number({ minimum: 0 }),
            lengthSeconds:  t.Integer({ minimum: 0 }),
            od:             t.Number({ minimum: 0 }),
            hp:             t.Number({ minimum: 0 }),
            noteCount:      t.Optional(t.Integer({ minimum: 0 })),
            holdCount:      t.Optional(t.Integer({ minimum: 0 })),
          })),
          rankedStatus: t.Optional(t.String()),
        }),
      },
    )

    // ── POST /beatmaps — create beatmap metadata (admin only) ─────────────
    .post(
      '',
      async ({ body, user, set }) => {
        if (user.role !== 'admin') {
          set.status = 403;
          return errorResponse("Forbidden — requires 'admin' role");
        }

        const [newBeatmap] = await db
          .insert(beatmaps)
          .values({
            title:          body.title,
            artist:         body.artist,
            creator:        body.creator,
            difficultyName: body.difficultyName,
            mode:           'mania',
            keyCount:       body.keyCount,
            starRating:     body.starRating,
            bpm:            body.bpm,
            bpmMin:         body.bpmMin ?? body.bpm,
            bpmMax:         body.bpmMax ?? body.bpm,
            lengthSeconds:  body.lengthSeconds,
            od:             body.od,
            hp:             body.hp,
            noteCount:      body.noteCount ?? 0,
            holdCount:      body.holdCount ?? 0,
            filePath:       body.filePath,
            coverUrl:       body.coverUrl ?? null,
            rankedStatus:   (body.rankedStatus as any) ?? 'ranked',
            uploadedBy:     user.id,
          })
          .returning();

        return successResponse(newBeatmap);
      },
      {
        body: t.Object({
          title:          t.String({ minLength: 1 }),
          artist:         t.String({ minLength: 1 }),
          creator:        t.String({ minLength: 1 }),
          difficultyName: t.String({ minLength: 1 }),
          keyCount:       t.Integer({ minimum: 1, maximum: 10 }),
          starRating:     t.Number({ minimum: 0 }),
          bpm:            t.Number({ minimum: 0 }),
          bpmMin:         t.Optional(t.Number({ minimum: 0 })),
          bpmMax:         t.Optional(t.Number({ minimum: 0 })),
          lengthSeconds:  t.Integer({ minimum: 0 }),
          od:             t.Number({ minimum: 0 }),
          hp:             t.Number({ minimum: 0 }),
          noteCount:      t.Optional(t.Integer({ minimum: 0 })),
          holdCount:      t.Optional(t.Integer({ minimum: 0 })),
          filePath:       t.String({ minLength: 1 }),
          coverUrl:       t.Optional(t.String()),
          rankedStatus:   t.Optional(t.String()),
        }),
      },
    )
    .post(
      '/',
      async ({ body, user, set }) => {
        if (user.role !== 'admin') {
          set.status = 403;
          return errorResponse("Forbidden — requires 'admin' role");
        }

        const [newBeatmap] = await db
          .insert(beatmaps)
          .values({
            title:          body.title,
            artist:         body.artist,
            creator:        body.creator,
            difficultyName: body.difficultyName,
            mode:           'mania',
            keyCount:       body.keyCount,
            starRating:     body.starRating,
            bpm:            body.bpm,
            bpmMin:         body.bpmMin ?? body.bpm,
            bpmMax:         body.bpmMax ?? body.bpm,
            lengthSeconds:  body.lengthSeconds,
            od:             body.od,
            hp:             body.hp,
            noteCount:      body.noteCount ?? 0,
            holdCount:      body.holdCount ?? 0,
            filePath:       body.filePath,
            coverUrl:       body.coverUrl ?? null,
            rankedStatus:   (body.rankedStatus as any) ?? 'ranked',
            uploadedBy:     user.id,
          })
          .returning();

        return successResponse(newBeatmap);
      },
      {
        body: t.Object({
          title:          t.String({ minLength: 1 }),
          artist:         t.String({ minLength: 1 }),
          creator:        t.String({ minLength: 1 }),
          difficultyName: t.String({ minLength: 1 }),
          keyCount:       t.Integer({ minimum: 1, maximum: 10 }),
          starRating:     t.Number({ minimum: 0 }),
          bpm:            t.Number({ minimum: 0 }),
          bpmMin:         t.Optional(t.Number({ minimum: 0 })),
          bpmMax:         t.Optional(t.Number({ minimum: 0 })),
          lengthSeconds:  t.Integer({ minimum: 0 }),
          od:             t.Number({ minimum: 0 }),
          hp:             t.Number({ minimum: 0 }),
          noteCount:      t.Optional(t.Integer({ minimum: 0 })),
          holdCount:      t.Optional(t.Integer({ minimum: 0 })),
          filePath:       t.String({ minLength: 1 }),
          coverUrl:       t.Optional(t.String()),
          rankedStatus:   t.Optional(t.String()),
        }),
      },
    )

    // ── DELETE /beatmaps/:id — delete beatmap (admin only) ─────────────────
    .delete(
      '/:id',
      async ({ params, user, set }) => {
        if (user.role !== 'admin') {
          set.status = 403;
          return errorResponse("Forbidden — requires 'admin' role");
        }

        const [beatmap] = await db
          .select()
          .from(beatmaps)
          .where(eq(beatmaps.id, params.id))
          .limit(1);

        if (!beatmap) {
          set.status = 404;
          return errorResponse('Beatmap not found');
        }

        const [otherFileUsage] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(beatmaps)
          .where(and(eq(beatmaps.filePath, beatmap.filePath), ne(beatmaps.id, params.id)));
          
        const [otherCoverUsage] = beatmap.coverUrl 
          ? await db
              .select({ count: sql<number>`count(*)::int` })
              .from(beatmaps)
              .where(and(eq(beatmaps.coverUrl, beatmap.coverUrl), ne(beatmaps.id, params.id)))
          : [{ count: 1 }];

        await db.delete(beatmaps).where(eq(beatmaps.id, params.id));

        if (otherFileUsage.count === 0) {
          try {
            await deleteFile(beatmap.filePath);
          } catch (err) {
            console.error(`Failed to delete file ${beatmap.filePath}:`, err);
          }
        }

        if (beatmap.coverUrl && otherCoverUsage.count === 0) {
          try {
            const bucketSearch = '/beatmaps/';
            const bucketIdx = beatmap.coverUrl.indexOf(bucketSearch);
            if (bucketIdx !== -1) {
              const storagePath = beatmap.coverUrl.substring(bucketIdx + bucketSearch.length);
              await deleteFile(storagePath);
            }
          } catch (err) {
            console.error(`Failed to delete cover ${beatmap.coverUrl}:`, err);
          }
        }

        return successResponse({ deleted: true, id: params.id });
      },
      {
        params: t.Object({
          id: t.String({ format: 'uuid' }),
        }),
      },
    )
  );
