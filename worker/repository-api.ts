import { randomUUID } from "node:crypto";
import { mapAlarm, type ActiveSnapshot, type AlarmRecord, type AlarmRow, type NewAlarm } from "../src/domain.ts";
import { INTERNAL_API_VERSION } from "../src/remote-repository.ts";

type Database = D1Database | D1DatabaseSession;

function value(args: unknown[], index: number): unknown {
    if (index >= args.length) throw new Error("Invalid arguments");
    return args[index];
}

function str(args: unknown[], index: number, maximum = 300): string {
    const input = value(args, index);
    if (typeof input !== "string" || input.length === 0 || input.length > maximum) throw new Error("Invalid string");
    return input;
}

function integer(args: unknown[], index: number, maximum = Number.MAX_SAFE_INTEGER): number {
    const input = value(args, index);
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0 || input > maximum) {
        throw new Error("Invalid integer");
    }
    return input;
}

function newAlarm(input: unknown): NewAlarm {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid alarm");
    const item = input as Record<string, unknown>;
    const required = ["id", "timeZone", "videoId", "videoUrl", "videoTitle", "notificationChannelId"];
    for (const key of required) {
        if (typeof item[key] !== "string" || item[key].length === 0 || item[key].length > 300) {
            throw new Error("Invalid alarm");
        }
    }
    for (const key of ["scheduledAtMs", "createdAtMs"]) {
        if (typeof item[key] !== "number" || !Number.isSafeInteger(item[key]) || item[key] < 0) {
            throw new Error("Invalid alarm");
        }
    }
    if (item.snoozeCount !== undefined && (!Number.isSafeInteger(item.snoozeCount) || (item.snoozeCount as number) < 0)) {
        throw new Error("Invalid alarm");
    }
    if (item.snoozeParentId !== undefined && item.snoozeParentId !== null
        && (typeof item.snoozeParentId !== "string" || item.snoozeParentId.length > 300)) {
        throw new Error("Invalid alarm");
    }
    return item as unknown as NewAlarm;
}

function snapshot(input: unknown): ActiveSnapshot | null {
    if (input === null) return null;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid snapshot");
    const item = input as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 300
        || !Number.isSafeInteger(item.version) || (item.version as number) < 1) throw new Error("Invalid snapshot");
    return item as unknown as ActiveSnapshot;
}

async function alarmById(db: Database, id: string): Promise<AlarmRecord | null> {
    const row = await db.prepare("SELECT * FROM alarms WHERE id = ?").bind(id).first<AlarmRow>();
    return row ? mapAlarm(row) : null;
}

async function active(db: Database): Promise<AlarmRecord | null> {
    const row = await db.prepare("SELECT * FROM alarms WHERE status IN ('WAITING', 'STARTING', 'PLAYING') LIMIT 1")
        .first<AlarmRow>();
    return row ? mapAlarm(row) : null;
}

function insert(db: Database, alarm: NewAlarm): D1PreparedStatement {
    return db.prepare(`INSERT INTO alarms (
        id, scheduled_at_ms, time_zone, video_id, video_url, video_title,
        notification_channel_id, status, snooze_count, snooze_parent_id, created_at_ms
    ) SELECT ?, ?, ?, ?, ?, ?, ?, 'WAITING', ?, ?, ? WHERE (SELECT changes()) = 1`).bind(
        alarm.id, alarm.scheduledAtMs, alarm.timeZone, alarm.videoId, alarm.videoUrl, alarm.videoTitle,
        alarm.notificationChannelId, alarm.snoozeCount ?? 0, alarm.snoozeParentId ?? null, alarm.createdAtMs,
    );
}

async function execute(db: Database, op: string, args: unknown[]): Promise<unknown> {
    switch (op) {
        case "getActive": return active(db);
        case "getAlarm": return alarmById(db, str(args, 0));
        case "getLatestResult": {
            const row = await db.prepare(`SELECT * FROM alarms
                WHERE status NOT IN ('WAITING', 'STARTING', 'PLAYING')
                ORDER BY COALESCE(finished_at_ms, created_at_ms) DESC LIMIT 1`).first<AlarmRow>();
            return row ? mapAlarm(row) : null;
        }
        case "getLastVideo": {
            const row = await db.prepare("SELECT value FROM bot_settings WHERE key = 'last_video'")
                .first<{ value: string }>();
            if (!row) return null;
            try {
                const parsed: unknown = JSON.parse(row.value);
                if (parsed && typeof parsed === "object" && "videoId" in parsed && "videoUrl" in parsed
                    && "videoTitle" in parsed) return parsed;
            } catch { return null; }
            return null;
        }
        case "replaceWaiting": {
            const alarm = newAlarm(value(args, 0));
            const expected = snapshot(value(args, 1));
            const current = await active(db);
            if (current?.status === "STARTING" || current?.status === "PLAYING") return { kind: "busy", current };
            if ((current === null && expected !== null) || (current !== null
                && (expected === null || current.id !== expected.id || current.version !== expected.version))) {
                return { kind: "stale", current };
            }
            const update = current
                ? db.prepare(`UPDATE alarms SET status = 'CANCELLED', version = version + 1,
                    finished_at_ms = ?, stop_reason = 'REPLACED'
                    WHERE id = ? AND status = 'WAITING' AND version = ?`)
                    .bind(alarm.createdAtMs, current.id, current.version)
                : db.prepare("SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM alarms WHERE status IN ('WAITING', 'STARTING', 'PLAYING'))");
            const insertion = current ? insert(db, alarm) : db.prepare(`INSERT INTO alarms (
                id, scheduled_at_ms, time_zone, video_id, video_url, video_title,
                notification_channel_id, status, snooze_count, snooze_parent_id, created_at_ms
            ) SELECT ?, ?, ?, ?, ?, ?, ?, 'WAITING', ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM alarms WHERE status IN ('WAITING', 'STARTING', 'PLAYING'))`).bind(
                alarm.id, alarm.scheduledAtMs, alarm.timeZone, alarm.videoId, alarm.videoUrl, alarm.videoTitle,
                alarm.notificationChannelId, alarm.snoozeCount ?? 0, alarm.snoozeParentId ?? null, alarm.createdAtMs,
            );
            const video = JSON.stringify({ videoId: alarm.videoId, videoUrl: alarm.videoUrl, videoTitle: alarm.videoTitle });
            const results = await db.batch([
                update,
                insertion,
                db.prepare(`INSERT INTO bot_settings (key, value)
                    SELECT 'last_video', ? WHERE EXISTS (SELECT 1 FROM alarms WHERE id = ? AND status = 'WAITING')
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(video, alarm.id),
            ]);
            if (results[1].meta.changes !== 1) return { kind: "stale", current: await active(db) };
            return { kind: "saved", alarm: await alarmById(db, alarm.id), replaced: current };
        }
        case "cancelWaiting": {
            const now = integer(args, 0);
            const current = await active(db);
            if (current?.status !== "WAITING") return null;
            const result = await db.prepare(`UPDATE alarms SET status = 'CANCELLED', version = version + 1,
                finished_at_ms = ?, stop_reason = 'USER_CANCELLED'
                WHERE id = ? AND status = 'WAITING' AND version = ?`).bind(now, current.id, current.version).run();
            return result.meta.changes === 1 ? alarmById(db, current.id) : null;
        }
        case "claimDue": {
            const now = integer(args, 0);
            const tolerance = integer(args, 1, 180_000);
            const row = await db.prepare(`SELECT * FROM alarms WHERE status = 'WAITING' AND scheduled_at_ms <= ?
                ORDER BY scheduled_at_ms LIMIT 1`).bind(now).first<AlarmRow>();
            if (!row) return { kind: "none" };
            const late = now - row.scheduled_at_ms > tolerance;
            const result = await db.prepare(late
                ? `UPDATE alarms SET status = 'SKIPPED', version = version + 1,
                    finished_at_ms = ?, stop_reason = 'LATE_OVER_LIMIT'
                    WHERE id = ? AND status = 'WAITING' AND version = ?`
                : `UPDATE alarms SET status = 'STARTING', version = version + 1
                    WHERE id = ? AND status = 'WAITING' AND version = ?`)
                .bind(...(late ? [now, row.id, row.version] : [row.id, row.version])).run();
            return result.meta.changes === 1
                ? { kind: late ? "skipped" : "claimed", alarm: await alarmById(db, row.id) }
                : { kind: "none" };
        }
        case "markPlaying": {
            const id = str(args, 0);
            const now = integer(args, 1);
            const result = await db.prepare(`UPDATE alarms SET status = 'PLAYING', version = version + 1,
                started_at_ms = ? WHERE id = ? AND status = 'STARTING'`).bind(now, id).run();
            return result.meta.changes === 1 ? alarmById(db, id) : null;
        }
        case "finishRun": {
            const id = str(args, 0);
            const status = str(args, 1, 20);
            if (!["FINISHED", "FAILED", "SKIPPED"].includes(status)) throw new Error("Invalid status");
            const reason = str(args, 2);
            const now = integer(args, 3);
            const lastError = args[4] === null || args[4] === undefined ? null : str(args, 4);
            const result = await db.prepare(`UPDATE alarms SET status = ?, version = version + 1,
                finished_at_ms = ?, stop_reason = ?, last_error = ?
                WHERE id = ? AND status IN ('STARTING', 'PLAYING')`).bind(status, now, reason, lastError, id).run();
            return result.meta.changes === 1;
        }
        case "snoozeRun": {
            const id = str(args, 0);
            const scheduledAtMs = integer(args, 1);
            const now = integer(args, 2);
            const limit = integer(args, 3, 10);
            const current = await alarmById(db, id);
            if (current?.status !== "STARTING" && current?.status !== "PLAYING") return { kind: "stale" };
            if (current.snoozeCount >= limit) return { kind: "limit", count: current.snoozeCount };
            const alarm: NewAlarm = {
                id: randomUUID(), scheduledAtMs, timeZone: current.timeZone,
                videoId: current.videoId, videoUrl: current.videoUrl, videoTitle: current.videoTitle,
                notificationChannelId: current.notificationChannelId, snoozeCount: current.snoozeCount + 1,
                snoozeParentId: current.snoozeParentId ?? current.id, createdAtMs: now,
            };
            const results = await db.batch([
                db.prepare(`UPDATE alarms SET status = 'FINISHED', version = version + 1,
                    finished_at_ms = ?, stop_reason = 'SNOOZED'
                    WHERE id = ? AND status IN ('STARTING', 'PLAYING') AND version = ?`)
                    .bind(now, id, current.version),
                insert(db, alarm),
            ]);
            return results[1].meta.changes === 1
                ? { kind: "saved", alarm: await alarmById(db, alarm.id) }
                : { kind: "stale" };
        }
        case "recoverInterrupted": {
            const now = integer(args, 0);
            const rows = await db.prepare("SELECT id FROM alarms WHERE status IN ('STARTING', 'PLAYING')")
                .all<{ id: string }>();
            if (rows.results.length === 0) return [];
            await db.prepare(`UPDATE alarms SET status = 'INTERRUPTED', version = version + 1,
                finished_at_ms = ?, stop_reason = 'PROCESS_INTERRUPTED'
                WHERE status IN ('STARTING', 'PLAYING')`).bind(now).run();
            return Promise.all(rows.results.map((row) => alarmById(db, row.id)));
        }
        case "recordNotificationError": {
            const id = str(args, 0);
            const message = str(args, 1);
            await db.prepare("UPDATE alarms SET notification_error = ? WHERE id = ?").bind(message, id).run();
            return null;
        }
        default: throw new Error("Invalid operation");
    }
}

export async function handleRepositoryRequest(request: Request, database: D1Database): Promise<Response> {
    const headers = { "x-alarm-api-version": INTERNAL_API_VERSION, "content-type": "application/json" };
    if (new URL(request.url).hostname !== "alarm-d1.internal"
        || new URL(request.url).pathname !== "/v1/repository" || request.method !== "POST") {
        return new Response(null, { status: 404, headers });
    }
    if (request.headers.get("x-alarm-api-version") !== INTERNAL_API_VERSION) {
        return new Response(null, { status: 409, headers });
    }
    try {
        const text = await request.text();
        if (text.length > 8_192) return new Response(null, { status: 413, headers });
        const body: unknown = JSON.parse(text);
        if (!body || typeof body !== "object" || !("op" in body) || !("args" in body)
            || typeof body.op !== "string" || !Array.isArray(body.args) || body.args.length > 5) {
            return new Response(null, { status: 400, headers });
        }
        const result = await execute(database.withSession("first-primary"), body.op, body.args);
        return new Response(JSON.stringify({ result }), { headers });
    } catch (error) {
        const invalid = error instanceof Error && error.message.startsWith("Invalid");
        return new Response(null, { status: invalid ? 400 : 503, headers });
    }
}
