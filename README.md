---
title: Lany API
emoji: 🎵
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 3000
pinned: false
---

# Lany Backend

Lanify Backend is a REST API for a web-based rhythm game. It is built with Bun, Elysia, Drizzle ORM, and PostgreSQL.

## Tech Stack

| Layer      | Technology                        |
| ---------- | --------------------------------- |
| Runtime    | [Bun](https://bun.sh)            |
| Framework  | [ElysiaJS](https://elysiajs.com)  |
| Database   | PostgreSQL (via Supabase)         |
| ORM        | [Drizzle ORM](https://orm.drizzle.team) |
| Storage    | Supabase Storage (beatmap files)  |
| Auth       | JWT (`@elysiajs/jwt` + bcryptjs)  |
| Parsing    | `osu-parsers` + `osu-mania-stable` |

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- PostgreSQL database (Supabase recommended)
- Supabase project with a Storage bucket named `beatmaps`

## Setup

### 1. Clone & Install

```bash
git clone <your-repo-url> lanify
cd lanify
bun install
```

### 2. Configure Environment

Copy the example and fill in your credentials:

```bash
cp .env.example .env
```

```env
DATABASE_URL=postgresql://postgres:[password]@db.[project].supabase.co:5432/postgres
SUPABASE_URL=https://[project].supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_BUCKET_NAME=beatmaps
JWT_SECRET=your-super-secret-jwt-key
PORT=3000
```

### 3. Database Setup

```bash
# Push schema directly to DB (development)
bun run db:push

# Or generate SQL migration files + apply them (production)
bun run db:generate
bun run db:migrate
```

### 4. Run Development Server

```bash
bun run dev
```

The server starts at `http://localhost:3000` with hot-reload.

---

## Deploy (Hugging Face Spaces, free, no card)

The YAML block at the top of this README is the Space config (`sdk: docker`, `app_port: 3000`); the `Dockerfile`
is used as-is.

1. huggingface.co > **New Space** > SDK **Docker** (Blank) > hardware **CPU basic (free)**.
2. Space **Settings > Variables and secrets**: add `DATABASE_URL` (Supabase *pooler* URL; if it cannot connect, use
   port 6543), `JWT_SECRET`, `B2_ENDPOINT`, `B2_APPLICATION_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`,
   `FRONTEND_URL` as **secrets**.
3. Push this repo to the Space: `git remote add space https://huggingface.co/spaces/<user>/<space>` then
   `git push space main` (use a write access token as the password).
4. The API is served at `https://<user>-<space>.hf.space`; set the frontend `NEXT_PUBLIC_API_URL` to it.

A free Space sleeps after 48 hours without traffic and takes a while to wake on the next request.

## Deploy (Render, free plan)

The repo ships a `Dockerfile` (Bun 1.3, installs from `bun.lock`). `render.yaml` describes the same service as a
Blueprint, but Blueprints ask for a card, so the manual route below is the free one.

1. Push this repo to GitHub, then in Render choose **New > Web Service**, pick the repo, runtime **Docker**,
   instance type **Free**, health check path `/`.
2. Add the environment variables (Add from .env works): `DATABASE_URL`, `JWT_SECRET`, `B2_ENDPOINT`, `B2_APPLICATION_KEY_ID`,
   `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`, and `FRONTEND_URL` (the deployed frontend origin, e.g.
   `https://lany.vercel.app`; comma-separate several). Render provides `PORT` itself.
3. In the frontend deployment set `NEXT_PUBLIC_API_URL` to the Render URL (e.g. `https://lany-api.onrender.com`).

Free-plan behaviour: the service sleeps after 15 minutes without requests and takes about a minute to wake.
Player activity ("Choosing a beatmap", ...) is kept in memory and resets when it sleeps; online status itself
comes from `users.last_seen_at`, so it survives.

## API Endpoints

### Health Check

| Method | Path | Description        |
| ------ | ---- | ------------------ |
| GET    | `/`  | Server health info |

### Auth (`/auth`)

| Method | Path             | Auth | Description                  |
| ------ | ---------------- | ---- | ---------------------------- |
| POST   | `/auth/register` | No   | Create a new account         |
| POST   | `/auth/login`    | No   | Login and receive JWT        |
| GET    | `/auth/me`       | Yes  | Get current user profile     |

### Beatmaps (`/beatmaps`)

| Method | Path                 | Auth  | Description                      |
| ------ | -------------------- | ----- | -------------------------------- |
| GET    | `/beatmaps`          | No    | List all beatmaps (paginated)    |
| GET    | `/beatmaps/:id`      | No    | Get beatmap detail               |
| POST   | `/beatmaps`          | Admin | Create beatmap metadata          |
| DELETE | `/beatmaps/:id`      | Admin | Delete beatmap + storage file    |
| GET    | `/beatmaps/:id/url`  | No    | Get signed download URL (1 hour) |
| POST   | `/beatmaps/calculate-stars` | Admin | Calculate star ratings from .osz |

### Scores (`/scores`)

| Method | Path                  | Auth | Description                |
| ------ | --------------------- | ---- | -------------------------- |
| POST   | `/scores`             | Yes  | Submit a score             |
| GET    | `/scores/:beatmapId`  | No   | Get scores for a beatmap   |

### Leaderboard (`/leaderboard`)

| Method | Path                         | Auth | Description                       |
| ------ | ---------------------------- | ---- | --------------------------------- |
| GET    | `/leaderboard/global`        | No   | Top 100 players by total score    |
| GET    | `/leaderboard/:beatmapId`    | No   | Top 50 per beatmap (best/user)    |

### Users (`/users`)

| Method | Path          | Auth | Description              |
| ------ | ------------- | ---- | ------------------------ |
| GET    | `/users/:id`  | No   | Public profile + stats   |
| PUT    | `/users/me`   | Yes  | Update own profile       |

---

## Authentication

All protected routes require a `Bearer` token in the `Authorization` header:

```
Authorization: Bearer <jwt-token>
```

Tokens are returned from `/auth/register` and `/auth/login`.

### User Roles

| Role    | Permissions                           |
| ------- | ------------------------------------- |
| `user`  | Submit scores, update own profile     |
| `admin` | All user perms + manage beatmaps      |

To promote a user to admin:

```sql
UPDATE users SET role = 'admin' WHERE email = 'your@email.com';
```

---

## Response Format

All endpoints return a consistent JSON shape:

```json
// Success
{ "success": true, "data": { ... } }

// Error
{ "success": false, "error": "Error message" }
```

---

## Project Structure

```
src/
├── index.ts                # Elysia app entrypoint
├── db/
│   ├── schema.ts           # Drizzle table/enum definitions
│   └── index.ts            # Drizzle client + pool
├── modules/
│   ├── auth/index.ts       # Register, login, /me
│   ├── beatmap/index.ts    # CRUD + signed URLs
│   ├── score/index.ts      # Score submission/retrieval
│   ├── leaderboard/index.ts # Global + per-beatmap rankings
│   └── user/index.ts       # Profile + stats
├── storage/
│   └── supabase.ts         # Supabase bucket helpers
├── middleware/
│   └── auth.ts             # JWT verify + role guards
└── types/
    └── index.ts            # Shared types, enums, helpers
drizzle.config.ts
.env.example
```

---

## osu! Beatmap Compatibility

This backend supports the standard osu! `.osu` file format via `osu-parsers` and `osu-mania-stable`. The parser extracts:

- **Key count** (from `difficulty.circleSize`)
- **BPM** (min/max from timing points)
- **Length** (from last hit object timestamp)
- **Star rating** (calculated via `ManiaRuleset`)

These fields are stored as beatmap metadata in the database.

## License

MIT
