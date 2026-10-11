import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  real,
  timestamp,
  uniqueIndex,
  index,
  serial,
  boolean,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['user', 'admin']);

export const rankEnum = pgEnum('score_rank', ['SS', 'S', 'A', 'B', 'C', 'D']);

export const rankedStatusEnum = pgEnum('ranked_status', ['ranked', 'loved', 'qualified', 'approved', 'graveyard', 'pending']);

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  username:     varchar('username', { length: 50 }).notNull().unique(),
  email:        varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role:         userRoleEnum('role').notNull().default('user'),
  avatarUrl:    text('avatar_url'),
  bannerUrl:    text('banner_url'),
  country:      varchar('country', { length: 2 }), // ISO 3166-1 alpha-2, optional
  totalPp:      real('total_pp').notNull().default(0),
  lastSeenAt:   timestamp('last_seen_at'),            // updated by POST /users/me/heartbeat; online = within 2 min
  createdAt:    timestamp('created_at').notNull().defaultNow(),
});

// ─── Friends (one-way follow, like osu!; mutual when both rows exist) ─────────

export const friends = pgTable('friends', {
  userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  friendId:  uuid('friend_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  uniqPair: uniqueIndex('friends_user_friend_idx').on(table.userId, table.friendId),
}));

// ─── Notifications (top-bar bell; created by server events such as "added you as a friend") ──
// Created with raw SQL (see notifications endpoints), timestamptz so it reads back as UTC.

export const notifications = pgTable('notifications', {
  id:        serial('id').primaryKey(),
  userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  text:      text('text').notNull(),
  read:      boolean('read').notNull().default(false),
  // Set for direct-message notifications: clicking the entry opens the chat with this user.
  chatUserId: uuid('chat_user_id').references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  byUser: index('notifications_user_idx').on(table.userId),
}));

// ─── Direct messages (chat overlay; polled by the client while open) ──────────

export const messages = pgTable('messages', {
  id:          serial('id').primaryKey(),
  senderId:    uuid('sender_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  recipientId: uuid('recipient_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  text:        text('text').notNull(),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  byPair: index('messages_pair_idx').on(table.senderId, table.recipientId),
  byRecipient: index('messages_recipient_idx').on(table.recipientId),
}));

// ─── Beatmaps ─────────────────────────────────────────────────────────────────

export const beatmaps = pgTable('beatmaps', {
  id:             uuid('id').primaryKey().defaultRandom(),
  title:          varchar('title', { length: 255 }).notNull(),
  artist:         varchar('artist', { length: 255 }).notNull(),
  creator:        varchar('creator', { length: 255 }).notNull(),
  difficultyName: varchar('difficulty_name', { length: 100 }).notNull(),
  mode:           varchar('mode', { length: 20 }).notNull().default('mania'),
  keyCount:       integer('key_count').notNull(),
  starRating:     real('star_rating').notNull(),
  bpm:            real('bpm').notNull(),
  bpmMin:         real('bpm_min').notNull(),
  bpmMax:         real('bpm_max').notNull(),
  lengthSeconds:  integer('length_seconds').notNull(),
  od:             real('od').notNull().default(0),
  hp:             real('hp').notNull().default(0),
  filePath:       text('file_path').notNull(), // Supabase Storage path
  coverUrl:       text('cover_url'),
  rankedStatus:   rankedStatusEnum('ranked_status').notNull().default('ranked'),
  uploadedBy:     uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  noteCount:      integer('note_count').notNull().default(0),
  holdCount:      integer('hold_count').notNull().default(0),
  playCount:      integer('play_count').notNull().default(0),
  favoriteCount:  integer('favorite_count').notNull().default(0),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
});

// ─── Collections (per-player beatmap lists, filter in song select) ───────────

export const collections = pgTable('collections', {
  id:        serial('id').primaryKey(),
  userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name:      varchar('name', { length: 50 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  byUser: index('collections_user_idx').on(table.userId),
}));

export const collectionBeatmaps = pgTable('collection_beatmaps', {
  collectionId: integer('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
  beatmapId:    uuid('beatmap_id').notNull().references(() => beatmaps.id, { onDelete: 'cascade' }),
}, (table) => ({
  uniqPair: uniqueIndex('collection_beatmaps_pair_idx').on(table.collectionId, table.beatmapId),
}));

// ─── Scores ───────────────────────────────────────────────────────────────────

export const scores = pgTable('scores', {
  id:          uuid('id').primaryKey().defaultRandom(),
  userId:      uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  beatmapId:   uuid('beatmap_id').notNull().references(() => beatmaps.id, { onDelete: 'cascade' }),
  score:       integer('score').notNull(),
  accuracy:    real('accuracy').notNull(),  // 0–100
  maxCombo:    integer('max_combo').notNull(),
  marvelous:   integer('marvelous').notNull().default(0),
  perfect:     integer('perfect').notNull().default(0),
  great:       integer('great').notNull().default(0),
  good:        integer('good').notNull().default(0),
  bad:         integer('bad').notNull().default(0),
  miss:        integer('miss').notNull().default(0),
  accuracyHistory: text('accuracy_history'), // JSON string of AccuracyPoint[]
  hitErrors:       text('hit_errors'),       // JSON string of HitError[]
  mods:        text('mods'),                // JSON array string e.g. '["HD","DT"]'
  pp:          real('pp').notNull().default(0),
  rank:        rankEnum('rank').notNull(),
  submittedAt: timestamp('submitted_at').notNull().defaultNow(),
});

// ─── Chart Difficulty Cache ───────────────────────────────────────────────────

export const chartDifficulty = pgTable('chart_difficulty', {
  id:             uuid('id').primaryKey().defaultRandom(),
  beatmapId:      uuid('beatmap_id').notNull().references(() => beatmaps.id, { onDelete: 'cascade' }),
  mods:           varchar('mods', { length: 50 }).notNull().default(''),  // e.g. 'DTHD' or '' for NM
  starRating:     real('star_rating').notNull(),
  greatHitWindow: real('great_hit_window').notNull(),
  maxCombo:       integer('max_combo').notNull(),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  uniqBeatmapMods: uniqueIndex('chart_difficulty_beatmap_mods_idx').on(table.beatmapId, table.mods),
}));

// ─── Relations ────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  scores:   many(scores),
  beatmaps: many(beatmaps),
}));

export const beatmapsRelations = relations(beatmaps, ({ one, many }) => ({
  uploader: one(users, {
    fields:     [beatmaps.uploadedBy],
    references: [users.id],
  }),
  scores: many(scores),
  difficultyCache: many(chartDifficulty),
}));

export const chartDifficultyRelations = relations(chartDifficulty, ({ one }) => ({
  beatmap: one(beatmaps, {
    fields:     [chartDifficulty.beatmapId],
    references: [beatmaps.id],
  }),
}));

export const scoresRelations = relations(scores, ({ one }) => ({
  user: one(users, {
    fields:     [scores.userId],
    references: [users.id],
  }),
  beatmap: one(beatmaps, {
    fields:     [scores.beatmapId],
    references: [beatmaps.id],
  }),
}));

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type User    = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Beatmap    = typeof beatmaps.$inferSelect;
export type NewBeatmap = typeof beatmaps.$inferInsert;

export type Score    = typeof scores.$inferSelect;
export type NewScore = typeof scores.$inferInsert;

export type ChartDifficulty    = typeof chartDifficulty.$inferSelect;
export type NewChartDifficulty = typeof chartDifficulty.$inferInsert;
