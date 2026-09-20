import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const ALARM_COLUMNS = [
    "id", "version", "scheduled_at_ms", "time_zone", "video_id", "video_url", "video_title",
    "notification_channel_id", "status", "snooze_count", "snooze_parent_id", "created_at_ms",
    "started_at_ms", "finished_at_ms", "stop_reason", "last_error", "notification_error",
] as const;

function sqlValue(value: unknown): string {
    if (value === null) return "NULL";
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
    throw new Error("SQLiteの値をSQLへ変換できませんでした。");
}

export function exportSqliteForD1(sourcePath: string, outputPath: string): { alarms: number; settings: number } {
    const database = new DatabaseSync(sourcePath, { readOnly: true });
    try {
        const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
        if (integrity.integrity_check !== "ok") throw new Error("SQLiteの整合性を確認できませんでした。");
        const alarms = database.prepare(`SELECT ${ALARM_COLUMNS.join(", ")} FROM alarms ORDER BY created_at_ms, id`)
            .all() as Record<string, unknown>[];
        const settings = database.prepare("SELECT key, value FROM bot_settings ORDER BY key")
            .all() as Record<string, unknown>[];
        const lines: string[] = [];
        for (const alarm of alarms) {
            lines.push(`INSERT INTO alarms (${ALARM_COLUMNS.join(", ")}) VALUES (${ALARM_COLUMNS.map(
                (column) => sqlValue(alarm[column]),
            ).join(", ")});`);
        }
        for (const setting of settings) {
            lines.push(`INSERT INTO bot_settings (key, value) VALUES (${sqlValue(setting.key)}, ${sqlValue(setting.value)});`);
        }
        writeFileSync(outputPath, lines.join("\n") + "\n", { flag: "wx", mode: 0o600 });
        return { alarms: alarms.length, settings: settings.length };
    } finally {
        database.close();
    }
}
