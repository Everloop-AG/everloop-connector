// Type definitions for everloop-connector v1.0.0 (schema v1)
// The app's only interface to EverLoop. See everloop-connector.js for behaviour.

export as namespace EverLoop;

/** Status of a single activity, as decided by EverLoop (never by the app). */
export type ActivityStatus = "not_started" | "in_progress" | "completed";

/** One activity's authoritative record, restored on resume and updated on every confirm. */
export interface ActivityRecord {
  activity_id: string;
  status: ActivityStatus;
  score?: number;
  maxScore?: number;
  bestScore?: number;
  attempts?: number;
  progressPct?: number;
  /** Opaque per-activity resume blob the app previously saved (<=16KB). Never read for rewards. */
  saveSlot?: unknown;
  firstCompletedAt?: string;
  lastPlayedAt?: string;
}

export interface AchievementRecord {
  earnedAt: string;
  tier?: string | null;
  title?: string | null;
}

/** The authoritative snapshot passed to onUpdate. Read-only copy; mutating it does nothing. */
export interface EverLoopState {
  student: { displayName: string };
  activities: Record<string, ActivityRecord>;
  achievements: Record<string, AchievementRecord>;
  /** Bucks earned in THIS app (confirmed by the server). The header shows the real total. */
  bucksEarnedHere: number;
}

/** What EverLoop returns for an accepted event. The app renders from this, not from guesses. */
export interface Confirm {
  event_id: string;
  status: "accepted" | "rejected" | "pending";
  record: ActivityRecord;
  achievements_earned: Array<{
    achievement_id: string;
    tier?: string | null;
    title?: string | null;
    earned_at?: string;
  }>;
  /** Amount EverLoop decided to pay for this event. Always from the server, never the app. */
  bucks_paid: number;
  wallet_earned_here?: number;
  reject_reason?: string;
}

export interface ProgressApi {
  /** Send a mid-activity checkpoint. `saveSlot` is an opaque resume blob (<=16KB). */
  (activityId: string, opts?: { saveSlot?: unknown; progressPct?: number }): Promise<Confirm>;
  /** Read a restored activity record, or null if none. */
  get(activityId: string): ActivityRecord | null;
  /** Read every restored activity record. */
  all(): Record<string, ActivityRecord>;
}

export interface EverLoopConnector {
  readonly version: string;
  readonly schemaVersion: number;

  // --- events: each resolves with EverLoop's authoritative confirmation ---
  started(activityId: string): Promise<Confirm>;
  progress: ProgressApi;
  scored(activityId: string, score: number, maxScore: number): Promise<Confirm>;
  completed(activityId: string, opts?: { score?: number; maxScore?: number }): Promise<Confirm>;
  achievement(achievementId: string, tier?: string): Promise<Confirm>;
  /** Request a payout for finishing an activity. EverLoop decides the amount. */
  reward(activityId: string): Promise<Confirm>;

  // --- reads (render only from these) ---
  achievements: { list(): Record<string, AchievementRecord> };
  readonly student: { displayName: string };
  readonly bucksEarnedHere: number;

  // --- subscriptions / status ---
  /** Subscribe to authoritative state. Fires immediately if already ready. Returns an unsubscribe fn. */
  onUpdate(cb: (state: EverLoopState) => void): () => void;
  /** Called once the handshake + resume completes. */
  onReady(cb: () => void): void;
  isReady(): boolean;
  /** True when running outside EverLoop (local preview); nothing is saved or paid. */
  isPreview(): boolean;
}

declare global {
  interface Window {
    EverLoop: EverLoopConnector;
    /** Optional: seed richer local preview state before the connector loads. */
    EVERLOOP_PREVIEW?: Partial<EverLoopState>;
  }
  const EverLoop: EverLoopConnector;
}

declare const EverLoop: EverLoopConnector;
export default EverLoop;
