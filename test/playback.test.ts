import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { AlarmRepository } from "../src/database.ts";
import type { MediaFactory } from "../src/media.ts";
import { PlaybackController } from "../src/playback.ts";
import type { VoiceConnector, VoiceOutput } from "../src/voice.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
    return { promise, resolve, reject };
}

function createMedia(options: { failYoutube?: boolean; hang?: boolean; onFallback?: () => void } = {}) {
    const created: Array<{ kind: string; stopped: boolean }> = [];
    let youtubeCount = 0;
    const factory: MediaFactory = {
        createYouTube: () => {
            youtubeCount += 1;
            const entry = { kind: "youtube", stopped: false };
            created.push(entry);
            const stream = new PassThrough();
            if (!options.hang) queueMicrotask(() => stream.end(Buffer.from("audio")));
            return {
                kind: "youtube",
                stream,
                done: options.failYoutube
                    ? Promise.reject(new Error("音声取得エラー"))
                    : new Promise<void>((resolve) => stream.once("end", resolve)),
                stop: async () => { entry.stopped = true; stream.destroy(); },
            };
        },
        createFallback: () => {
            options.onFallback?.();
            const entry = { kind: "fallback", stopped: false };
            created.push(entry);
            const stream = new PassThrough();
            queueMicrotask(() => stream.end(Buffer.from("tone")));
            return {
                kind: "fallback",
                stream,
                done: new Promise<void>((resolve) => stream.once("end", resolve)),
                stop: async () => { entry.stopped = true; stream.destroy(); },
            };
        },
    };
    return { factory, created, get youtubeCount() { return youtubeCount; } };
}

function createConnector() {
    const outputs: Array<{ stopped: boolean; closed: boolean }> = [];
    const connector: VoiceConnector<string> = {
        connect: async () => {
            const entry = { stopped: false, closed: false };
            outputs.push(entry);
            const output: VoiceOutput = {
                play: (stream, signal) => ({
                    started: Promise.resolve(),
                    done: new Promise<void>((resolve, reject) => {
                        const abort = () => reject(new DOMException("停止", "AbortError"));
                        signal.addEventListener("abort", abort, { once: true });
                        stream.once("end", () => {
                            signal.removeEventListener("abort", abort);
                            resolve();
                        });
                        stream.resume();
                    }),
                }),
                stop: () => { entry.stopped = true; },
                close: async () => { entry.closed = true; },
            };
            return output;
        },
    };
    return { connector, outputs };
}

test("YouTube途中エラー後は同じ回で内蔵音を使い続ける", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const fallbackCreated = deferred<void>();
    const media = createMedia({ failYoutube: true, onFallback: () => fallbackCreated.resolve() });
    const voice = createConnector();
    const controller = new PlaybackController(media.factory, voice.connector);
    const started = deferred<void>();
    const completion = controller.start({
        runId: "fallback",
        mode: "alarm",
        channel: "voice",
        videoUrl: "video",
        durationMs: 40,
        onStarted: () => started.resolve(),
    });
    await started.promise;
    await fallbackCreated.promise;
    context.mock.timers.tick(40);
    const result = await completion;
    assert.equal(result.status, "FINISHED");
    assert.equal(result.usedFallback, true);
    assert.equal(media.youtubeCount, 1);
    assert.equal(media.created.filter((entry) => entry.kind === "fallback").length > 0, true);
    assert.ok(media.created.every((entry) => entry.stopped));
    assert.ok(voice.outputs.every((entry) => entry.closed));
});

test("停止後のDB保存失敗でも音声と媒体を解放する", async () => {
    const repository = new AlarmRepository(":memory:");
    repository.close();
    const media = createMedia({ hang: true });
    const voice = createConnector();
    const controller = new PlaybackController(media.factory, voice.connector);
    let started = false;
    let saveFailed = false;
    const completion = controller.start({
        runId: "stop",
        mode: "alarm",
        channel: "voice",
        videoUrl: "video",
        durationMs: 15 * 60_000,
        onStarted: () => { started = true; },
        onFinished: () => { repository.finishRun("stop", "FINISHED", "USER_STOPPED", Date.now()); },
        onPersistenceError: () => { saveFailed = true; },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(started, true);
    assert.equal(controller.requestStop("stop", "USER_STOPPED"), true);
    const result = await completion;
    assert.equal(result.reason, "USER_STOPPED");
    assert.equal(saveFailed, true);
    assert.equal(controller.activeRunId, null);
    assert.ok(media.created.every((entry) => entry.stopped));
    assert.ok(voice.outputs.every((entry) => entry.closed && entry.stopped));
});

test("Playing後のDB応答待ちでも終了タイマーが進み、保存失敗を処理する", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const save = deferred<void>();
    const started = deferred<void>();
    const media = createMedia({ hang: true });
    const voice = createConnector();
    const controller = new PlaybackController(media.factory, voice.connector);
    const completion = controller.start({
        runId: "slow-start-save", mode: "alarm", channel: "voice", videoUrl: "video",
        durationMs: 40,
        onStarted: () => { started.resolve(); return save.promise; },
    });
    await started.promise;
    context.mock.timers.tick(40);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(voice.outputs.every((entry) => entry.stopped && entry.closed));
    save.reject(new Error("D1 response lost"));
    const result = await completion;
    assert.equal(result.status, "FAILED");
    assert.equal(result.reason, "START_PERSISTENCE_FAILED");
    assert.ok(media.created.every((entry) => entry.stopped));
});

test("再生開始が同期的に失敗しても音源の拒否を処理して解放する", async () => {
    let stopped = 0;
    let closed = 0;
    const source = (kind: "youtube" | "fallback") => {
        const stream = new PassThrough();
        const finished = deferred<void>();
        return {
            kind, stream, done: finished.promise,
            stop: async () => {
                stopped += 1;
                finished.reject(new Error("子プロセスを終了しました。"));
                stream.destroy();
            },
        };
    };
    const media: MediaFactory = {
        createYouTube: () => source("youtube"),
        createFallback: () => source("fallback"),
    };
    const voice: VoiceConnector<string> = {
        connect: async () => ({
            play: () => { throw new Error("音声接続が切断されました。"); },
            stop: () => undefined,
            close: async () => { closed += 1; },
        }),
    };
    const controller = new PlaybackController(media, voice);
    const result = await controller.start({
        runId: "sync-play-error", mode: "alarm", channel: "voice", videoUrl: "video",
        durationMs: 1_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result.status, "FAILED");
    assert.equal(result.usedFallback, true);
    assert.equal(stopped, 2);
    assert.equal(closed, 1);
    assert.equal(controller.activeRunId, null);
});

test("スヌーズ保存に失敗したら保留中の停止要求を実行する", async () => {
    const media = createMedia({ hang: true });
    const voice = createConnector();
    const controller = new PlaybackController(media.factory, voice.connector);
    const completion = controller.start({
        runId: "snooze",
        mode: "alarm",
        channel: "voice",
        videoUrl: "video",
        durationMs: 15 * 60_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(controller.beginSnooze("snooze"), true);
    assert.equal(controller.requestStop("snooze", "USER_STOPPED"), true);
    assert.equal(controller.requestStop("older-run", "USER_STOPPED"), false);
    controller.cancelSnooze("snooze");
    const result = await completion;
    assert.equal(result.reason, "USER_STOPPED");
    assert.ok(media.created.every((entry) => entry.stopped));
});

test("DB変更結果が不明なときは保留中のスヌーズも音声を止める", async () => {
    const media = createMedia({ hang: true });
    const voice = createConnector();
    const controller = new PlaybackController(media.factory, voice.connector);
    const completion = controller.start({
        runId: "uncertain-snooze", mode: "alarm", channel: "voice", videoUrl: "video",
        durationMs: 15 * 60_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(controller.beginSnooze("uncertain-snooze"), true);
    assert.equal(controller.forceStop("uncertain-snooze", "PROCESS_SHUTDOWN"), true);
    await completion;
    assert.ok(media.created.every((entry) => entry.stopped));
    assert.ok(voice.outputs.every((entry) => entry.closed && entry.stopped));
});

test("YouTubeと内蔵音がPlayingに到達しなければ時間切れで失敗する", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let created = 0;
    let stopped = 0;
    let played = 0;
    const firstPlay = deferred<void>();
    const secondPlay = deferred<void>();
    const media: MediaFactory = {
        createYouTube: () => source("youtube"),
        createFallback: () => source("fallback"),
    };
    function source(kind: "youtube" | "fallback") {
        created += 1;
        const stream = new PassThrough();
        return {
            kind, stream,
            done: new Promise<void>(() => undefined),
            stop: async () => { stopped += 1; stream.destroy(); },
        };
    }
    const voice: VoiceConnector<string> = {
        connect: async () => ({
            play: () => {
                played += 1;
                if (played === 1) firstPlay.resolve();
                else secondPlay.resolve();
                return { started: new Promise<void>(() => undefined), done: new Promise<void>(() => undefined) };
            },
            stop: () => undefined,
            close: async () => undefined,
        }),
    };
    const controller = new PlaybackController(media, voice);
    const completion = controller.start({
        runId: "media-timeout", mode: "alarm", channel: "voice", videoUrl: "video",
        durationMs: 1_000, mediaTimeoutMs: 20,
    });
    await firstPlay.promise;
    context.mock.timers.tick(20);
    await secondPlay.promise;
    context.mock.timers.tick(20);
    const result = await completion;
    assert.equal(result.status, "FAILED");
    assert.equal(created, 2);
    assert.equal(stopped, 2);
    assert.equal(controller.activeRunId, null);
});

test("再生出力が終了しても取得が終わらない回は内蔵音へ切り替える", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let youtubeCount = 0;
    const outputEnded = deferred<void>();
    const fallbackCreated = deferred<void>();
    const media: MediaFactory = {
        createYouTube: () => {
            youtubeCount += 1;
            const stream = new PassThrough();
            queueMicrotask(() => stream.write(Buffer.from("first")));
            return {
                kind: "youtube", stream, done: new Promise<void>(() => undefined),
                stop: async () => { stream.destroy(); },
            };
        },
        createFallback: () => {
            fallbackCreated.resolve();
            const stream = new PassThrough();
            const done = new Promise<void>((resolve) => stream.once("end", resolve));
            queueMicrotask(() => stream.end(Buffer.from("tone")));
            return { kind: "fallback", stream, done, stop: async () => { stream.destroy(); } };
        },
    };
    const voice: VoiceConnector<string> = {
        connect: async () => ({
            play: (stream, signal) => ({
                started: Promise.resolve(),
                done: new Promise<void>((resolve, reject) => {
                    const abort = () => reject(new DOMException("停止", "AbortError"));
                    signal.addEventListener("abort", abort, { once: true });
                    stream.once("data", () => {
                        signal.removeEventListener("abort", abort);
                        outputEnded.resolve();
                        resolve();
                    });
                    stream.resume();
                }),
            }),
            stop: () => undefined,
            close: async () => undefined,
        }),
    };
    const controller = new PlaybackController(media, voice);
    const completion = controller.start({
        runId: "stalled-data", mode: "alarm", channel: "voice", videoUrl: "video",
        durationMs: 1_000, mediaTimeoutMs: 20,
    });
    await outputEnded.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    context.mock.timers.tick(20);
    await fallbackCreated.promise;
    assert.equal(controller.requestStop("stalled-data", "USER_STOPPED"), true);
    const result = await completion;
    assert.equal(result.status, "FINISHED");
    assert.equal(result.usedFallback, true);
    assert.equal(youtubeCount, 1);
});

test("15分相当の制限は最初のPlayingから計測する", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
    let signalPlaying!: () => void;
    const playing = new Promise<void>((resolve) => { signalPlaying = resolve; });
    const playCalled = deferred<void>();
    const started = deferred<void>();
    const media = createMedia({ hang: true });
    const voice: VoiceConnector<string> = {
        connect: async () => ({
            play: (_stream, signal) => {
                playCalled.resolve();
                return {
                    started: playing,
                    done: new Promise<void>((_, reject) => signal.addEventListener("abort", () =>
                        reject(new DOMException("停止", "AbortError")), { once: true })),
                };
            },
            stop: () => undefined,
            close: async () => undefined,
        }),
    };
    const controller = new PlaybackController(media.factory, voice);
    let starts = 0;
    const completion = controller.start({
        runId: "playing-clock", mode: "alarm", channel: "voice", videoUrl: "video",
        durationMs: 40, mediaTimeoutMs: 200,
        onStarted: () => { starts += 1; started.resolve(); },
    });
    await playCalled.promise;
    context.mock.timers.tick(25);
    assert.equal(starts, 0);
    signalPlaying();
    await started.promise;
    context.mock.timers.tick(39);
    assert.equal(controller.activeRunId, "playing-clock");
    context.mock.timers.tick(1);
    const result = await completion;
    assert.equal(result.reason, "TIME_LIMIT");
    assert.equal(starts, 1);
    assert.equal(Date.now(), 1_065);
});

test("試聴が停止処理中でもアラーム側は解放完了を待つ", async () => {
    const media = createMedia({ hang: true });
    let releaseClose!: () => void;
    const closing = new Promise<void>((resolve) => { releaseClose = resolve; });
    const voice: VoiceConnector<string> = {
        connect: async () => ({
            play: (_stream, signal) => ({
                started: Promise.resolve(),
                done: new Promise<void>((_, reject) => signal.addEventListener("abort", () =>
                    reject(new DOMException("停止", "AbortError")), { once: true })),
            }),
            stop: () => undefined,
            close: async () => closing,
        }),
    };
    const controller = new PlaybackController(media.factory, voice);
    const completion = controller.start({
        runId: "preview-1", mode: "preview", channel: "voice", videoUrl: "video", durationMs: 1_000,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(controller.requestStop("preview-1", "USER_STOPPED"), true);
    let released = false;
    const preemption = controller.stopPreviewForAlarm().then(() => { released = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(released, false);
    releaseClose();
    await preemption;
    await completion;
    assert.equal(released, true);
});
