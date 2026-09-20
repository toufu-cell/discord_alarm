import { resolve } from "node:path";

export interface AppConfig {
    discordToken: string;
    applicationId: string;
    guildId: string;
    ownerId: string;
    notificationChannelId: string;
    timeZone: string;
    volumePercent: number;
    snoozeLimit: number;
    previewSeconds: number;
    databasePath: string;
    lockPath: string;
    ffmpegPath: string;
    ytDlpPath: string;
    lateToleranceMs: number;
    alarmDurationMs: number;
    confirmationTtlMs: number;
    mediaTimeoutMs: number;
}

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const DISCORD_ID_NAMES = ["DISCORD_APPLICATION_ID", "DISCORD_GUILD_ID", "DISCORD_OWNER_ID"] as const;

export class DiscordConfigurationError extends Error {
    public readonly missingVariables: string[];
    public readonly invalidVariables: string[];

    public constructor(missingVariables: string[], invalidVariables: string[]) {
        super("Discord接続情報を確認してください。");
        this.missingVariables = missingVariables;
        this.invalidVariables = invalidVariables;
    }
}

export function discordConfigurationIssues(env: NodeJS.ProcessEnv = process.env, requireNotification = false): {
    missingVariables: string[]; invalidVariables: string[]
} {
    const missingVariables = missingDiscordVariables(env);
    if (requireNotification && !env.ALARM_NOTIFICATION_CHANNEL_ID?.trim()) {
        missingVariables.push("ALARM_NOTIFICATION_CHANNEL_ID");
    }
    const invalidVariables: string[] = DISCORD_ID_NAMES.filter((name) => {
        const value = env[name]?.trim();
        return Boolean(value && !SNOWFLAKE_PATTERN.test(value));
    });
    if (requireNotification && env.ALARM_NOTIFICATION_CHANNEL_ID?.trim()
        && !SNOWFLAKE_PATTERN.test(env.ALARM_NOTIFICATION_CHANNEL_ID.trim())) {
        invalidVariables.push("ALARM_NOTIFICATION_CHANNEL_ID");
    }
    return { missingVariables, invalidVariables };
}

function parseInteger(
    value: string | undefined,
    fallback: number,
    name: string,
    minimum: number,
    maximum: number,
): number {
    const parsed = value === undefined || value === "" ? fallback : Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${name}は${minimum}から${maximum}までの整数で指定してください。`);
    }
    return parsed;
}

export function validateTimeZone(timeZone: string): string {
    try {
        new Intl.DateTimeFormat("ja-JP", { timeZone }).format(0);
    } catch {
        throw new Error("ALARM_TIME_ZONEにはIANAタイムゾーン名を指定してください。");
    }
    return timeZone;
}

export function missingDiscordVariables(env: NodeJS.ProcessEnv = process.env): string[] {
    return [
        "DISCORD_TOKEN",
        "DISCORD_APPLICATION_ID",
        "DISCORD_GUILD_ID",
        "DISCORD_OWNER_ID",
    ].filter((name) => !(env[name]?.trim()));
}

export function loadConfig(
    env: NodeJS.ProcessEnv = process.env,
    options: { requireDiscord?: boolean; cwd?: string } = {},
): AppConfig {
    const cwd = options.cwd ?? process.cwd();
    const requireDiscord = options.requireDiscord ?? true;
    if (requireDiscord) {
        const issues = discordConfigurationIssues(env);
        if (issues.missingVariables.length || issues.invalidVariables.length) {
            throw new DiscordConfigurationError(issues.missingVariables, issues.invalidVariables);
        }
    }
    const discordToken = requireDiscord ? env.DISCORD_TOKEN!.trim() : "";
    const applicationId = requireDiscord ? env.DISCORD_APPLICATION_ID!.trim() : "";
    const guildId = requireDiscord ? env.DISCORD_GUILD_ID!.trim() : "";
    const ownerId = requireDiscord ? env.DISCORD_OWNER_ID!.trim() : "";
    const notificationChannelId = env.ALARM_NOTIFICATION_CHANNEL_ID?.trim() || "";
    const timeZone = validateTimeZone(env.ALARM_TIME_ZONE?.trim() || "Asia/Tokyo");
    const volumePercent = parseInteger(env.ALARM_VOLUME_PERCENT, 35, "ALARM_VOLUME_PERCENT", 1, 100);
    const snoozeLimit = parseInteger(env.ALARM_SNOOZE_LIMIT, 3, "ALARM_SNOOZE_LIMIT", 0, 10);
    const previewSeconds = parseInteger(env.ALARM_PREVIEW_SECONDS, 30, "ALARM_PREVIEW_SECONDS", 1, 120);
    const databasePath = resolve(cwd, env.ALARM_DATABASE_PATH?.trim() || "./data/alarm.sqlite");

    return {
        discordToken,
        applicationId,
        guildId,
        ownerId,
        notificationChannelId,
        timeZone,
        volumePercent,
        snoozeLimit,
        previewSeconds,
        databasePath,
        lockPath: env.ALARM_REMOTE_D1 === "1" ? "/tmp/discord-alarm.process-lock" : `${databasePath}.process-lock`,
        ffmpegPath: env.FFMPEG_PATH?.trim() || "ffmpeg",
        ytDlpPath: resolve(cwd, env.YTDLP_PATH?.trim() || "./.venv/bin/yt-dlp"),
        lateToleranceMs: 180_000,
        alarmDurationMs: 15 * 60_000,
        confirmationTtlMs: 2 * 60_000,
        mediaTimeoutMs: 15_000,
    };
}
