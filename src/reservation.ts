import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.ts";
import type { ActiveSnapshot, AlarmRecord, NewAlarm, VideoChoice } from "./domain.ts";
import type { AlarmStore } from "./repository.ts";
import { explicitOccurrence, nextOccurrence } from "./time.ts";

interface VideoProbe {
    probe(url: string, signal?: AbortSignal): Promise<VideoChoice>;
}

export interface ReservationInput {
    at?: string;
    time?: string;
    url?: string;
    channelId: string;
}

export interface PreparedReservation {
    alarm: NewAlarm;
    expected: ActiveSnapshot | null;
    previous: AlarmRecord | null;
}

export async function prepareReservation(
    input: ReservationInput,
    config: AppConfig,
    repository: AlarmStore,
    probe: VideoProbe,
    nowMs: number,
): Promise<PreparedReservation> {
    if (Boolean(input.at) === Boolean(input.time)) {
        throw new Error("--atまたは--timeを1つ指定してください。");
    }
    if (!/^\d{17,20}$/.test(input.channelId)) {
        throw new Error("通知先チャンネルIDはDiscordのID形式で指定してください。");
    }
    const scheduledAtMs = input.at
        ? explicitOccurrence(input.at, config.timeZone, nowMs)
        : nextOccurrence(input.time!, config.timeZone, nowMs);
    const video = input.url ? await probe.probe(input.url) : await repository.getLastVideo();
    if (!video) throw new Error("初回の登録ではYouTube動画のURLを指定してください。");
    const previous = await repository.getActive();
    if (previous?.status === "STARTING" || previous?.status === "PLAYING") {
        throw new Error("音声処理が進行中です。停止後に予約してください。");
    }
    return {
        alarm: {
            id: randomUUID(), scheduledAtMs, timeZone: config.timeZone,
            notificationChannelId: input.channelId, ...video, createdAtMs: nowMs,
        },
        expected: previous ? { id: previous.id, version: previous.version } : null,
        previous,
    };
}
