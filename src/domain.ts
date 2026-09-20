export const ACTIVE_STATUSES = ["WAITING", "STARTING", "PLAYING"] as const;

export type AlarmStatus =
    | "WAITING"
    | "STARTING"
    | "PLAYING"
    | "FINISHED"
    | "CANCELLED"
    | "SKIPPED"
    | "FAILED"
    | "INTERRUPTED";

export interface AlarmRecord {
    id: string;
    version: number;
    scheduledAtMs: number;
    timeZone: string;
    videoId: string;
    videoUrl: string;
    videoTitle: string;
    notificationChannelId: string;
    status: AlarmStatus;
    snoozeCount: number;
    snoozeParentId: string | null;
    createdAtMs: number;
    startedAtMs: number | null;
    finishedAtMs: number | null;
    stopReason: string | null;
    lastError: string | null;
    notificationError: string | null;
}

export interface VideoChoice {
    videoId: string;
    videoUrl: string;
    videoTitle: string;
}

export interface NewAlarm extends VideoChoice {
    id: string;
    scheduledAtMs: number;
    timeZone: string;
    notificationChannelId: string;
    snoozeCount?: number;
    snoozeParentId?: string | null;
    createdAtMs: number;
}

export interface ActiveSnapshot {
    id: string;
    version: number;
}

export interface PlaybackResult {
    status: Extract<AlarmStatus, "FINISHED" | "FAILED">;
    reason: string;
    lastError?: string;
    usedFallback: boolean;
}

export interface AlarmRow {
    id: string;
    version: number;
    scheduled_at_ms: number;
    time_zone: string;
    video_id: string;
    video_url: string;
    video_title: string;
    notification_channel_id: string;
    status: AlarmStatus;
    snooze_count: number;
    snooze_parent_id: string | null;
    created_at_ms: number;
    started_at_ms: number | null;
    finished_at_ms: number | null;
    stop_reason: string | null;
    last_error: string | null;
    notification_error: string | null;
}

export function mapAlarm(row: AlarmRow): AlarmRecord {
    return {
        id: row.id,
        version: row.version,
        scheduledAtMs: row.scheduled_at_ms,
        timeZone: row.time_zone,
        videoId: row.video_id,
        videoUrl: row.video_url,
        videoTitle: row.video_title,
        notificationChannelId: row.notification_channel_id,
        status: row.status,
        snoozeCount: row.snooze_count,
        snoozeParentId: row.snooze_parent_id,
        createdAtMs: row.created_at_ms,
        startedAtMs: row.started_at_ms,
        finishedAtMs: row.finished_at_ms,
        stopReason: row.stop_reason,
        lastError: row.last_error,
        notificationError: row.notification_error,
    };
}
