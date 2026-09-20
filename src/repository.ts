import type { ActiveSnapshot, AlarmRecord, AlarmStatus, NewAlarm, VideoChoice } from "./domain.ts";
import type { ClaimResult, ReplaceResult, SnoozeResult } from "./database.ts";

type Awaitable<T> = T | Promise<T>;

export interface AlarmStore {
    getActive(): Awaitable<AlarmRecord | null>;
    getAlarm(id: string): Awaitable<AlarmRecord | null>;
    getLatestResult(): Awaitable<AlarmRecord | null>;
    getLastVideo(): Awaitable<VideoChoice | null>;
    replaceWaiting(alarm: NewAlarm, expected: ActiveSnapshot | null): Awaitable<ReplaceResult>;
    cancelWaiting(nowMs: number): Awaitable<AlarmRecord | null>;
    claimDue(nowMs: number, lateToleranceMs: number): Awaitable<ClaimResult>;
    markPlaying(id: string, startedAtMs: number): Awaitable<AlarmRecord | null>;
    finishRun(id: string, status: Extract<AlarmStatus, "FINISHED" | "FAILED" | "SKIPPED">,
        reason: string, nowMs: number, lastError?: string): Awaitable<boolean>;
    snoozeRun(id: string, scheduledAtMs: number, nowMs: number, limit: number): Awaitable<SnoozeResult>;
    recoverInterrupted(nowMs: number): Awaitable<AlarmRecord[]>;
    recordNotificationError(id: string, message: string): Awaitable<void>;
    close(): Awaitable<void>;
}
