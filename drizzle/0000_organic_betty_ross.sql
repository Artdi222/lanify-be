CREATE TYPE "public"."score_rank" AS ENUM('SS', 'S', 'A', 'B', 'C', 'D');--> statement-breakpoint
CREATE TYPE "public"."ranked_status" AS ENUM('ranked', 'loved', 'qualified', 'approved', 'graveyard', 'pending');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "beatmaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(255) NOT NULL,
	"artist" varchar(255) NOT NULL,
	"creator" varchar(255) NOT NULL,
	"difficulty_name" varchar(100) NOT NULL,
	"mode" varchar(20) DEFAULT 'mania' NOT NULL,
	"key_count" integer NOT NULL,
	"star_rating" real NOT NULL,
	"bpm" real NOT NULL,
	"bpm_min" real NOT NULL,
	"bpm_max" real NOT NULL,
	"length_seconds" integer NOT NULL,
	"od" real DEFAULT 0 NOT NULL,
	"hp" real DEFAULT 0 NOT NULL,
	"file_path" text NOT NULL,
	"cover_url" text,
	"ranked_status" "ranked_status" DEFAULT 'ranked' NOT NULL,
	"uploaded_by" uuid,
	"note_count" integer DEFAULT 0 NOT NULL,
	"hold_count" integer DEFAULT 0 NOT NULL,
	"play_count" integer DEFAULT 0 NOT NULL,
	"favorite_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chart_difficulty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"beatmap_id" uuid NOT NULL,
	"mods" varchar(50) DEFAULT '' NOT NULL,
	"star_rating" real NOT NULL,
	"great_hit_window" real NOT NULL,
	"max_combo" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"beatmap_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"accuracy" real NOT NULL,
	"max_combo" integer NOT NULL,
	"marvelous" integer DEFAULT 0 NOT NULL,
	"perfect" integer DEFAULT 0 NOT NULL,
	"great" integer DEFAULT 0 NOT NULL,
	"good" integer DEFAULT 0 NOT NULL,
	"bad" integer DEFAULT 0 NOT NULL,
	"miss" integer DEFAULT 0 NOT NULL,
	"accuracy_history" text,
	"hit_errors" text,
	"mods" text,
	"pp" real DEFAULT 0 NOT NULL,
	"rank" "score_rank" NOT NULL,
	"submitted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(50) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"avatar_url" text,
	"banner_url" text,
	"total_pp" real DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "beatmaps" ADD CONSTRAINT "beatmaps_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_difficulty" ADD CONSTRAINT "chart_difficulty_beatmap_id_beatmaps_id_fk" FOREIGN KEY ("beatmap_id") REFERENCES "public"."beatmaps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_beatmap_id_beatmaps_id_fk" FOREIGN KEY ("beatmap_id") REFERENCES "public"."beatmaps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chart_difficulty_beatmap_mods_idx" ON "chart_difficulty" USING btree ("beatmap_id","mods");