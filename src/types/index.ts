// ─── Response Shape ───────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export const successResponse = <T>(data: T): ApiResponse<T> => ({
  success: true,
  data,
});

export const errorResponse = (error: string): ApiResponse<never> => ({
  success: false,
  error,
});

// ─── Enums ────────────────────────────────────────────────────────────────────

export type UserRole = 'user' | 'admin';

export type Rank = 'SS' | 'S' | 'A' | 'B' | 'C' | 'D';

export type Mod =
  | 'NM'   // No Mod
  | 'NF'   // No Fail
  | 'EZ'   // Easy
  | 'HT'   // Half Time
  | 'HR'   // Hard Rock
  | 'SD'   // Sudden Death
  | 'DT'   // Double Time
  | 'NC'   // Nightcore
  | 'HD'   // Hidden
  | 'FI'   // Fade In
  | 'FL'   // Flashlight
  | 'MR'   // Mirror
  | 'RN'   // Random
  | 'CN';  // Cinema

// ─── Rank Calculator ─────────────────────────────────────────────────────────

/**
 * Derives a score rank from accuracy (0–100).
 * SS  = 100%
 * S   = ≥ 95%
 * A   = ≥ 90%
 * B   = ≥ 80%
 * C   = ≥ 70%
 * D   = < 70%
 */
export function calculateRank(accuracy: number): Rank {
  if (accuracy === 100) return 'SS';
  if (accuracy >= 95)   return 'S';
  if (accuracy >= 90)   return 'A';
  if (accuracy >= 80)   return 'B';
  if (accuracy >= 70)   return 'C';
  return 'D';
}

// ─── JWT Payload ─────────────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string;       // user.id (UUID)
  username: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

// ─── Authenticated User Context ───────────────────────────────────────────────

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
}

// ─── osu! IBeatmap compatibility types ───────────────────────────────────────
// Mirrors the IBeatmap interface from osu-classes so the beatmap parser
// module can type-check correctly without re-importing the whole library.

export interface BeatmapMetaFromParser {
  title: string;
  artist: string;
  creator: string;
  difficultyName: string;
  keyCount: number;       // difficulty.circleSize
  bpm: number;            // dominant BPM
  bpmMin: number;
  bpmMax: number;
  lengthSeconds: number;  // derived from last hitObject startTime
  starRating: number;     // calculated via ManiaRuleset
}
