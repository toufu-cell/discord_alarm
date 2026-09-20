import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mapAlarm, type ActiveSnapshot, type AlarmRecord, type AlarmRow, type AlarmStatus, type NewAlarm, type VideoChoice } from "./domain.ts";

export type ReplaceResult =
    | { kind: "saved"; alarm: AlarmRecord; replaced: AlarmRecord | null }
    | { kind: "stale"; current: AlarmRecord | null }
    | { kind: "busy"; current: AlarmRecord };

export type ClaimResult =
    | { kind: "none" }
    | { kind: "claimed"; alarm: AlarmRecord }
    | { kind: "skipped"; alarm: AlarmRecord };

export type SnoozeResult =
    | { kind: "saved"; alarm: AlarmRecord }
    | { kind: "stale" }
    | { kind: "limit"; count: number };

export interface ReservationProposal {
    id: string;
    expiresAtMs: number;
    alarm: NewAlarm;
    expected: ActiveSnapshot | null;
}

export type ConfirmResult = ReplaceResult | { kind: "missing" | "expired" | "elapsed" }
    | { kind: "replayed"; alarm: AlarmRecord };

export type OperationState =
    | { kind: "new" | "pending" | "conflict" }
    | { kind: "replayed"; result: unknown };

export class AlarmRepository {
    private readonly database: DatabaseSync;

    public constructor(path: string) {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        this.database = new DatabaseSync(path);
        this.database.exec(`
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS alarms (
                id TEXT PRIMARY KEY,
                version INTEGER NOT NULL DEFAULT 1,
                scheduled_at_ms INTEGER NOT NULL,
                time_zone TEXT NOT NULL,
                video_id TEXT NOT NULL,
                video_url TEXT NOT NULL,
                video_title TEXT NOT NULL,
                notification_channel_id TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN (
                    'WAITING', 'STARTING', 'PLAYING', 'FINISHED',
                    'CANCELLED', 'SKIPPED', 'FAILED', 'INTERRUPTED'
                )),
                snooze_count INTEGER NOT NULL DEFAULT 0 CHECK (snooze_count >= 0),
                snooze_parent_id TEXT,
                created_at_ms INTEGER NOT NULL,
                started_at_ms INTEGER,
                finished_at_ms INTEGER,
                stop_reason TEXT,
                last_error TEXT,
                notification_error TEXT
            ) STRICT;
            CREATE UNIQUE INDEX IF NOT EXISTS alarms_one_active
                ON alarms ((1))
                WHERE status IN ('WAITING', 'STARTING', 'PLAYING');
            CREATE INDEX IF NOT EXISTS alarms_schedule
                ON alarms (status, scheduled_at_ms);
            CREATE TABLE IF NOT EXISTS bot_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS reservation_proposals (
                id TEXT PRIMARY KEY,
                expires_at_ms INTEGER NOT NULL,
                payload TEXT NOT NULL,
                confirmed_alarm_id TEXT
            ) STRICT;
            CREATE TABLE IF NOT EXISTS cli_operations (
                id TEXT PRIMARY KEY,
                action TEXT NOT NULL,
                target_id TEXT NOT NULL,
                result TEXT
            ) STRICT;
        `);
    }

    private transaction<T>(operation: () => T): T {
        this.database.exec("BEGIN IMMEDIATE;");
        try {
            const result = operation();
            this.database.exec("COMMIT;");
            return result;
        } catch (error) {
            try {
                this.database.exec("ROLLBACK;");
            } catch {
                // The original database error is more useful to the caller.
            }
            throw error;
        }
    }

    private findActiveRow(): AlarmRow | undefined {
        return this.database.prepare(`
            SELECT * FROM alarms
            WHERE status IN ('WAITING', 'STARTING', 'PLAYING')
            LIMIT 1
        `).get() as AlarmRow | undefined;
    }

    public getActive(): AlarmRecord | null {
        const row = this.findActiveRow();
        return row ? mapAlarm(row) : null;
    }

    public getAlarm(id: string): AlarmRecord | null {
        const row = this.database.prepare("SELECT * FROM alarms WHERE id = ?").get(id) as AlarmRow | undefined;
        return row ? mapAlarm(row) : null;
    }

    public getLatestResult(): AlarmRecord | null {
        const row = this.database.prepare(`
            SELECT * FROM alarms
            WHERE status NOT IN ('WAITING', 'STARTING', 'PLAYING')
            ORDER BY COALESCE(finished_at_ms, created_at_ms) DESC
            LIMIT 1
        `).get() as AlarmRow | undefined;
        return row ? mapAlarm(row) : null;
    }

    public getLastVideo(): VideoChoice | null {
        const row = this.database.prepare("SELECT value FROM bot_settings WHERE key = 'last_video'").get() as
            | { value: string }
            | undefined;
        if (!row) return null;
        try {
            const value = JSON.parse(row.value) as VideoChoice;
            if (value.videoId && value.videoUrl && value.videoTitle) return value;
        } catch {
            return null;
        }
        return null;
    }

    public replaceWaiting(newAlarm: NewAlarm, expected: ActiveSnapshot | null): ReplaceResult {
        return this.transaction(() => this.replaceWaitingInTransaction(newAlarm, expected));
    }

    private replaceWaitingInTransaction(newAlarm: NewAlarm, expected: ActiveSnapshot | null): ReplaceResult {
        const currentRow = this.findActiveRow();
        const current = currentRow ? mapAlarm(currentRow) : null;
        if (current && (current.status === "STARTING" || current.status === "PLAYING")) {
            return { kind: "busy", current };
        }
        const matches = current === null
            ? expected === null
            : expected !== null && current.id === expected.id && current.version === expected.version;
        if (!matches) return { kind: "stale", current };

        if (current) {
            this.database.prepare(`
                UPDATE alarms
                SET status = 'CANCELLED', version = version + 1,
                    finished_at_ms = ?, stop_reason = 'REPLACED'
                WHERE id = ? AND status = 'WAITING' AND version = ?
            `).run(newAlarm.createdAtMs, current.id, current.version);
        }
        this.insertAlarm(newAlarm);
        this.database.prepare(`
            INSERT INTO bot_settings (key, value) VALUES ('last_video', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(JSON.stringify({
            videoId: newAlarm.videoId,
            videoUrl: newAlarm.videoUrl,
            videoTitle: newAlarm.videoTitle,
        }));
        return { kind: "saved", alarm: this.getAlarm(newAlarm.id)!, replaced: current };
    }

    public saveProposal(proposal: ReservationProposal): void {
        this.database.prepare(`
            INSERT INTO reservation_proposals (id, expires_at_ms, payload) VALUES (?, ?, ?)
        `).run(proposal.id, proposal.expiresAtMs, JSON.stringify({
            alarm: proposal.alarm, expected: proposal.expected,
        }));
    }

    public confirmProposal(id: string, nowMs: number): ConfirmResult {
        return this.transaction(() => {
            const row = this.database.prepare(`
                SELECT expires_at_ms, payload, confirmed_alarm_id FROM reservation_proposals WHERE id = ?
            `).get(id) as { expires_at_ms: number; payload: string; confirmed_alarm_id: string | null } | undefined;
            if (!row) return { kind: "missing" };
            if (row.confirmed_alarm_id) {
                const alarm = this.getAlarm(row.confirmed_alarm_id);
                return alarm ? { kind: "replayed", alarm } : { kind: "missing" };
            }
            if (row.expires_at_ms < nowMs) return { kind: "expired" };
            const proposal = JSON.parse(row.payload) as { alarm: NewAlarm; expected: ActiveSnapshot | null };
            if (proposal.alarm.scheduledAtMs <= nowMs) return { kind: "elapsed" };
            const result = this.replaceWaitingInTransaction({ ...proposal.alarm, createdAtMs: nowMs }, proposal.expected);
            if (result.kind === "saved") {
                this.database.prepare(`
                    UPDATE reservation_proposals SET confirmed_alarm_id = ? WHERE id = ?
                `).run(result.alarm.id, id);
            }
            return result;
        });
    }

    public getProposalAlarm(id: string): AlarmRecord | null {
        const row = this.database.prepare(`
            SELECT confirmed_alarm_id FROM reservation_proposals WHERE id = ?
        `).get(id) as { confirmed_alarm_id: string | null } | undefined;
        return row?.confirmed_alarm_id ? this.getAlarm(row.confirmed_alarm_id) : null;
    }

    public getOperation(id: string): { action: string; targetId: string; result: unknown | null } | null {
        const row = this.database.prepare("SELECT action, target_id, result FROM cli_operations WHERE id = ?")
            .get(id) as { action: string; target_id: string; result: string | null } | undefined;
        return row ? { action: row.action, targetId: row.target_id,
            result: row.result === null ? null : JSON.parse(row.result) as unknown } : null;
    }

    public beginOperation(id: string, action: string, targetId: string): OperationState {
        return this.transaction(() => {
            const existing = this.getOperation(id);
            if (existing) {
                if (existing.action !== action || existing.targetId !== targetId) return { kind: "conflict" };
                return existing.result === null ? { kind: "pending" }
                    : { kind: "replayed", result: existing.result };
            }
            this.database.prepare("INSERT INTO cli_operations (id, action, target_id) VALUES (?, ?, ?)")
                .run(id, action, targetId);
            return { kind: "new" };
        });
    }

    public completeOperation(id: string, result: unknown): void {
        this.database.prepare("UPDATE cli_operations SET result = ? WHERE id = ? AND result IS NULL")
            .run(JSON.stringify(result), id);
    }

    private insertAlarm(alarm: NewAlarm): void {
        this.database.prepare(`
            INSERT INTO alarms (
                id, scheduled_at_ms, time_zone, video_id, video_url, video_title,
                notification_channel_id, status, snooze_count, snooze_parent_id,
                created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'WAITING', ?, ?, ?)
        `).run(
            alarm.id,
            alarm.scheduledAtMs,
            alarm.timeZone,
            alarm.videoId,
            alarm.videoUrl,
            alarm.videoTitle,
            alarm.notificationChannelId,
            alarm.snoozeCount ?? 0,
            alarm.snoozeParentId ?? null,
            alarm.createdAtMs,
        );
    }

    public cancelWaiting(nowMs: number): AlarmRecord | null {
        return this.transaction(() => {
            const current = this.getActive();
            if (!current || current.status !== "WAITING") return null;
            this.database.prepare(`
                UPDATE alarms SET status = 'CANCELLED', version = version + 1,
                    finished_at_ms = ?, stop_reason = 'USER_CANCELLED'
                WHERE id = ? AND status = 'WAITING' AND version = ?
            `).run(nowMs, current.id, current.version);
            return this.getAlarm(current.id);
        });
    }

    public cancelWaitingTarget(id: string, nowMs: number): AlarmRecord | null {
        return this.transaction(() => {
            const current = this.getActive();
            if (!current || current.id !== id || current.status !== "WAITING") return null;
            return this.cancelWaitingInTransaction(nowMs, current);
        });
    }

    private cancelWaitingInTransaction(nowMs: number, current: AlarmRecord): AlarmRecord | null {
        this.database.prepare(`
            UPDATE alarms SET status = 'CANCELLED', version = version + 1,
                finished_at_ms = ?, stop_reason = 'USER_CANCELLED'
            WHERE id = ? AND status = 'WAITING' AND version = ?
        `).run(nowMs, current.id, current.version);
        return this.getAlarm(current.id);
    }

    public claimDue(nowMs: number, lateToleranceMs: number): ClaimResult {
        return this.transaction(() => {
            const row = this.database.prepare(`
                SELECT * FROM alarms
                WHERE status = 'WAITING' AND scheduled_at_ms <= ?
                ORDER BY scheduled_at_ms ASC LIMIT 1
            `).get(nowMs) as AlarmRow | undefined;
            if (!row) return { kind: "none" };
            if (nowMs - row.scheduled_at_ms > lateToleranceMs) {
                this.database.prepare(`
                    UPDATE alarms SET status = 'SKIPPED', version = version + 1,
                        finished_at_ms = ?, stop_reason = 'LATE_OVER_LIMIT'
                    WHERE id = ? AND status = 'WAITING' AND version = ?
                `).run(nowMs, row.id, row.version);
                return { kind: "skipped", alarm: this.getAlarm(row.id)! };
            }
            const result = this.database.prepare(`
                UPDATE alarms SET status = 'STARTING', version = version + 1
                WHERE id = ? AND status = 'WAITING' AND version = ?
            `).run(row.id, row.version);
            if (result.changes !== 1) return { kind: "none" };
            return { kind: "claimed", alarm: this.getAlarm(row.id)! };
        });
    }

    public markPlaying(id: string, startedAtMs: number): AlarmRecord | null {
        const result = this.database.prepare(`
            UPDATE alarms SET status = 'PLAYING', version = version + 1,
                started_at_ms = ?
            WHERE id = ? AND status = 'STARTING'
        `).run(startedAtMs, id);
        return result.changes === 1 ? this.getAlarm(id) : null;
    }

    public finishRun(
        id: string,
        status: Extract<AlarmStatus, "FINISHED" | "FAILED" | "SKIPPED">,
        reason: string,
        nowMs: number,
        lastError?: string,
    ): boolean {
        const result = this.database.prepare(`
            UPDATE alarms SET status = ?, version = version + 1,
                finished_at_ms = ?, stop_reason = ?, last_error = ?
            WHERE id = ? AND status IN ('STARTING', 'PLAYING')
        `).run(status, nowMs, reason, lastError ?? null, id);
        return result.changes === 1;
    }

    public snoozeRun(id: string, scheduledAtMs: number, nowMs: number, limit: number): SnoozeResult {
        return this.transaction(() => {
            const current = this.getAlarm(id);
            if (!current || (current.status !== "STARTING" && current.status !== "PLAYING")) {
                return { kind: "stale" };
            }
            if (current.snoozeCount >= limit) return { kind: "limit", count: current.snoozeCount };
            const update = this.database.prepare(`
                UPDATE alarms SET status = 'FINISHED', version = version + 1,
                    finished_at_ms = ?, stop_reason = 'SNOOZED'
                WHERE id = ? AND status IN ('STARTING', 'PLAYING') AND version = ?
            `).run(nowMs, id, current.version);
            if (update.changes !== 1) return { kind: "stale" };

            const alarm: NewAlarm = {
                id: randomUUID(),
                scheduledAtMs,
                timeZone: current.timeZone,
                videoId: current.videoId,
                videoUrl: current.videoUrl,
                videoTitle: current.videoTitle,
                notificationChannelId: current.notificationChannelId,
                snoozeCount: current.snoozeCount + 1,
                snoozeParentId: current.snoozeParentId ?? current.id,
                createdAtMs: nowMs,
            };
            this.insertAlarm(alarm);
            return { kind: "saved", alarm: this.getAlarm(alarm.id)! };
        });
    }

    public recoverInterrupted(nowMs: number): AlarmRecord[] {
        return this.transaction(() => {
            const rows = this.database.prepare(`
                SELECT * FROM alarms WHERE status IN ('STARTING', 'PLAYING')
            `).all() as unknown as AlarmRow[];
            this.database.prepare(`
                UPDATE alarms SET status = 'INTERRUPTED', version = version + 1,
                    finished_at_ms = ?, stop_reason = 'PROCESS_INTERRUPTED'
                WHERE status IN ('STARTING', 'PLAYING')
            `).run(nowMs);
            return rows.map((row) => this.getAlarm(row.id)!);
        });
    }

    public recordNotificationError(id: string, message: string): void {
        this.database.prepare(`
            UPDATE alarms SET notification_error = ? WHERE id = ?
        `).run(message.slice(0, 300), id);
    }

    public close(): void {
        this.database.close();
    }
}
