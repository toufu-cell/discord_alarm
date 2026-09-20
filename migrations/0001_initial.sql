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
    ON alarms ((1)) WHERE status IN ('WAITING', 'STARTING', 'PLAYING');
CREATE INDEX IF NOT EXISTS alarms_schedule ON alarms (status, scheduled_at_ms);
CREATE TABLE IF NOT EXISTS bot_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;
