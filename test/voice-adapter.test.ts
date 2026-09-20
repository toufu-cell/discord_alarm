import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    VoiceConnectionStatus,
    createAudioPlayer,
    type VoiceConnection,
} from "@discordjs/voice";
import { FfmpegMediaFactory, type MediaFactory } from "../src/media.ts";
import { PlaybackController } from "../src/playback.ts";
import { DiscordVoiceOutput, type VoiceConnector } from "../src/voice.ts";

function connection(): VoiceConnection {
    const emitter = new EventEmitter() as EventEmitter & {
        state: { status: VoiceConnectionStatus };
        destroy(): void;
    };
    emitter.state = { status: VoiceConnectionStatus.Ready };
    emitter.destroy = () => {
        emitter.state = { status: VoiceConnectionStatus.Destroyed };
        emitter.emit(VoiceConnectionStatus.Destroyed);
    };
    return emitter as unknown as VoiceConnection;
}

function actualVoice() {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const connector: VoiceConnector<string> = {
        connect: async () => new DiscordVoiceOutput(connection(), player),
    };
    return { player, connector };
}

function waitFor<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("音声アダプターの状態変更が時間切れになりました。")), 5_000);
        }),
    ]).finally(() => clearTimeout(timer));
}

test("音源取得が先に終わっても実音声の残りを再生する", async () => {
    const ffmpeg = new FfmpegMediaFactory("unused", "ffmpeg", 35);
    const voice = actualVoice();
    let sourceDone: Promise<void> | null = null;
    const sourceReady = Promise.withResolvers<void>();
    let fallbackCount = 0;
    const media: MediaFactory = {
        createYouTube: (_url, signal) => {
            const source = ffmpeg.createFallback(signal);
            sourceDone = source.done;
            sourceReady.resolve();
            return { ...source, kind: "youtube" };
        },
        createFallback: () => {
            fallbackCount += 1;
            throw new Error("正常な音声を内蔵音へ切り替えました。");
        },
    };
    const controller = new PlaybackController(media, voice.connector);
    const completion = controller.start({
        runId: "buffered-audio", mode: "alarm", channel: "voice", videoUrl: "video",
        durationMs: 5_000, mediaTimeoutMs: 100,
    });
    try {
        await waitFor(sourceReady.promise);
        assert.ok(sourceDone);
        await waitFor(sourceDone);
        assert.equal(voice.player.state.status, AudioPlayerStatus.Playing);
        await waitFor(new Promise<void>((resolve) => voice.player.once(AudioPlayerStatus.Idle, () => resolve())));
        assert.equal(fallbackCount, 0);
        assert.equal(controller.requestStop("buffered-audio", "USER_STOPPED"), true);
        const result = await completion;
        assert.equal(result.usedFallback, false);
        assert.equal(result.reason, "USER_STOPPED");
    } finally {
        controller.requestStop("buffered-audio", "USER_STOPPED");
        await completion;
    }
});

test("実音声と内蔵音が途中で止まった場合は失敗として終了する", async () => {
    const ffmpeg = new FfmpegMediaFactory("unused", "ffmpeg", 35);
    const reference = ffmpeg.createFallback(new AbortController().signal);
    const chunks: Buffer[] = [];
    for await (const chunk of reference.stream) chunks.push(chunk as Buffer);
    await reference.done;
    await reference.stop();
    const audio = Buffer.concat(chunks);
    const voice = actualVoice();
    let fallbackStarted!: () => void;
    const fallback = new Promise<void>((resolve) => { fallbackStarted = resolve; });
    const stalledSource = (kind: "youtube" | "fallback") => {
        const stream = new PassThrough();
        let resolveSource!: () => void;
        const sourceDone = new Promise<void>((resolve) => { resolveSource = resolve; });
        queueMicrotask(() => stream.write(audio));
        return {
            kind, stream, done: sourceDone,
            stop: async () => { stream.destroy(); resolveSource(); },
        };
    };
    const media: MediaFactory = {
        createYouTube: () => stalledSource("youtube"),
        createFallback: () => {
            fallbackStarted();
            return stalledSource("fallback");
        },
    };
    const controller = new PlaybackController(media, voice.connector);
    const completion = controller.start({
        runId: "stalled-audio", mode: "alarm", channel: "voice", videoUrl: "video",
        durationMs: 10_000, mediaTimeoutMs: 100,
    });
    try {
        await waitFor(fallback);
        const result = await waitFor(completion);
        assert.equal(result.status, "FAILED");
        assert.equal(result.usedFallback, true);
        assert.match(result.lastError ?? "", /内蔵音/);
    } finally {
        controller.requestStop("stalled-audio", "USER_STOPPED");
        await completion;
    }
});

test("実プレーヤーで音源エラーが起きても内蔵音を再生できる", async () => {
    const ffmpeg = new FfmpegMediaFactory("unused", "ffmpeg", 35);
    const reference = ffmpeg.createFallback(new AbortController().signal);
    const chunks: Buffer[] = [];
    for await (const chunk of reference.stream) chunks.push(chunk as Buffer);
    await reference.done;
    await reference.stop();

    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const output = new DiscordVoiceOutput(connection(), player);
    const broken = new PassThrough();
    let fallback: ReturnType<FfmpegMediaFactory["createFallback"]> | null = null;
    try {
        const first = output.play(broken, new AbortController().signal);
        broken.write(Buffer.concat(chunks));
        await waitFor(first.started);
        const failed = assert.rejects(first.done, /Discordへの音声送信中にエラー/);
        broken.destroy(new Error("音源の読み込みに失敗しました。"));
        await waitFor(failed);

        fallback = ffmpeg.createFallback(new AbortController().signal);
        void fallback.done.catch(() => undefined);
        const next = output.play(fallback.stream, new AbortController().signal);
        await waitFor(next.started);
        assert.equal(player.state.status, AudioPlayerStatus.Playing);
        await waitFor(next.done);
        await waitFor(fallback.done);
    } finally {
        broken.destroy();
        output.stop();
        await output.close();
        if (fallback) await fallback.stop();
    }
});
