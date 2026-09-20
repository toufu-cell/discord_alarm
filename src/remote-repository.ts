import type { ActiveSnapshot, AlarmRecord, AlarmStatus, NewAlarm, VideoChoice } from "./domain.ts";
import type { ClaimResult, ReplaceResult, SnoozeResult } from "./database.ts";
import type { AlarmStore } from "./repository.ts";

export const INTERNAL_API_VERSION = "1";
export const INTERNAL_API_URL = "http://alarm-d1.internal/v1/repository";

export class RemoteMutationUncertainError extends Error {
    public constructor() {
        super("変更結果を確認できませんでした。Botを再起動しています。`/alarm show`で状態を確認してください。");
    }
}

export class RemoteRepository implements AlarmStore {
    private unavailable = false;
    private readonly onUncertain: () => void;

    public constructor(onUncertain: () => void) {
        this.onUncertain = onUncertain;
    }

    private async call<T>(op: string, args: unknown[], mutation = false): Promise<T> {
        if (this.unavailable) throw new RemoteMutationUncertainError();
        try {
            const response = await fetch(INTERNAL_API_URL, {
                method: "POST",
                headers: { "content-type": "application/json", "x-alarm-api-version": INTERNAL_API_VERSION },
                body: JSON.stringify({ op, args }),
                signal: AbortSignal.timeout(8_000),
            });
            if (!response.ok || response.headers.get("x-alarm-api-version") !== INTERNAL_API_VERSION) {
                throw new Error("内部APIの応答を確認できませんでした。");
            }
            const body: unknown = await response.json();
            if (!body || typeof body !== "object" || !("result" in body)) {
                throw new Error("内部APIの応答形式が不正です。");
            }
            return body.result as T;
        } catch (error) {
            if (mutation) {
                this.unavailable = true;
                this.onUncertain();
                throw new RemoteMutationUncertainError();
            }
            throw error;
        }
    }

    public getActive(): Promise<AlarmRecord | null> { return this.call("getActive", []); }
    public getAlarm(id: string): Promise<AlarmRecord | null> { return this.call("getAlarm", [id]); }
    public getLatestResult(): Promise<AlarmRecord | null> { return this.call("getLatestResult", []); }
    public getLastVideo(): Promise<VideoChoice | null> { return this.call("getLastVideo", []); }
    public replaceWaiting(alarm: NewAlarm, expected: ActiveSnapshot | null): Promise<ReplaceResult> {
        return this.call("replaceWaiting", [alarm, expected], true);
    }
    public cancelWaiting(nowMs: number): Promise<AlarmRecord | null> {
        return this.call("cancelWaiting", [nowMs], true);
    }
    public claimDue(nowMs: number, lateToleranceMs: number): Promise<ClaimResult> {
        return this.call("claimDue", [nowMs, lateToleranceMs], true);
    }
    public markPlaying(id: string, startedAtMs: number): Promise<AlarmRecord | null> {
        return this.call("markPlaying", [id, startedAtMs], true);
    }
    public finishRun(id: string, status: Extract<AlarmStatus, "FINISHED" | "FAILED" | "SKIPPED">,
        reason: string, nowMs: number, lastError?: string): Promise<boolean> {
        return this.call("finishRun", [id, status, reason, nowMs, lastError ?? null], true);
    }
    public snoozeRun(id: string, scheduledAtMs: number, nowMs: number, limit: number): Promise<SnoozeResult> {
        return this.call("snoozeRun", [id, scheduledAtMs, nowMs, limit], true);
    }
    public recoverInterrupted(nowMs: number): Promise<AlarmRecord[]> {
        return this.call("recoverInterrupted", [nowMs], true);
    }
    public recordNotificationError(id: string, message: string): Promise<void> {
        return this.call("recordNotificationError", [id, message], true);
    }
    public close(): void {}
}
