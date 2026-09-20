import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ChannelType, type BaseGuildVoiceChannel, type Client, type Interaction } from "discord.js";
import { loadConfig } from "../src/config.ts";
import { AlarmRepository } from "../src/database.ts";
import type { AlarmStore } from "../src/repository.ts";
import { FfmpegMediaFactory, type MediaFactory } from "../src/media.ts";
import { AlarmInteractionHandler } from "../src/interaction-handler.ts";
import { PlaybackController } from "../src/playback.ts";
import { AlarmRuntime } from "../src/runtime.ts";
import type { VoiceConnector } from "../src/voice.ts";

const guildId = "111111111111111111";
const ownerId = "222222222222222222";
const textChannelId = "333333333333333333";
const video = {
    videoId: "jNQXAC9IVRw",
    videoUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    videoTitle: "公開テスト動画",
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => { resolve = complete; });
    return { promise, resolve };
}

function withStoreMethods(repository: AlarmRepository, overrides: Partial<AlarmStore>): AlarmStore {
    return new Proxy(repository, {
        get(target, property) {
            if (property in overrides) return Reflect.get(overrides, property);
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

function makeHarness(
    lookup: () => Promise<BaseGuildVoiceChannel | null>,
    initiallyReady = true,
    playing: Promise<void> = Promise.resolve(),
    options: {
        media?: MediaFactory;
        sendNotification?: (message: { content: string }) => Promise<void>;
        store?: (repository: AlarmRepository) => AlarmStore;
    } = {},
) {
    let ready = initiallyReady;
    let clock = 1_000_000;
    let connectedCount = 0;
    const notifications: string[] = [];
    const client = {
        isReady: () => ready,
        guilds: { fetch: async () => ({ members: { fetch: async () => ({ voice: { channel: await lookup() } }) } }) },
        channels: { fetch: async () => ({
            isSendable: () => true,
            send: async (message: { content: string }) => {
                notifications.push(message.content);
                await options.sendNotification?.(message);
            },
        }) },
    } as unknown as Client;
    const config = loadConfig({
        DISCORD_TOKEN: "unused",
        DISCORD_APPLICATION_ID: "444444444444444444",
        DISCORD_GUILD_ID: guildId,
        DISCORD_OWNER_ID: ownerId,
    });
    const repository = new AlarmRepository(":memory:");
    const media: MediaFactory = options.media ?? {
        createYouTube: (_url, signal) => makeSource(signal),
        createFallback: (signal) => makeSource(signal),
    };
    const voice: VoiceConnector<BaseGuildVoiceChannel> = {
        connect: async () => {
            connectedCount += 1;
            return {
                play: (_stream, signal) => ({
                    started: playing,
                    done: new Promise<void>((resolve) => {
                        if (signal.aborted) resolve();
                        else signal.addEventListener("abort", () => resolve(), { once: true });
                    }),
                }),
                stop: () => undefined,
                close: async () => undefined,
            };
        },
    };
    const runtime = new AlarmRuntime(client, config, options.store?.(repository) ?? repository,
        new PlaybackController(media, voice), () => clock);
    const channel = {
        id: "555555555555555555",
        type: ChannelType.GuildVoice,
        guild: { members: { me: { id: "666666666666666666" } } },
        permissionsFor: () => ({ has: () => true }),
        userLimit: 0,
        members: new Map(),
    } as unknown as BaseGuildVoiceChannel;
    const reserve = (id: string, scheduledAtMs = clock) => repository.replaceWaiting({
        ...video, id, scheduledAtMs, timeZone: "Asia/Tokyo",
        notificationChannelId: textChannelId, createdAtMs: clock - 1,
    }, null);
    return {
        client, config, repository, runtime, channel, reserve, notifications,
        get connectedCount() { return connectedCount; },
        setReady(value: boolean) { ready = value; runtime.setConnected(value); },
        setClock(value: number) { clock = value; },
        close: async () => { await runtime.shutdown(); repository.close(); },
    };
}

function makeSource(signal: AbortSignal) {
    const stream = new PassThrough();
    const finished = deferred<void>();
    let stopping: Promise<void> | null = null;
    return {
        kind: "youtube" as const,
        stream,
        done: finished.promise,
        stop: () => {
            if (!stopping) {
                stream.destroy();
                finished.resolve();
                stopping = finished.promise;
            }
            return stopping;
        },
    };
}

for (const action of ["stop", "snooze", "shutdown"] as const) {
    test(`VC検索待ち中の${action}で古い音声を開始しない`, async () => {
        const lookup = deferred<BaseGuildVoiceChannel | null>();
        const harness = makeHarness(() => lookup.promise);
        harness.reserve("alarm-1");
        const starting = harness.runtime.start([]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(harness.repository.getAlarm("alarm-1")?.status, "STARTING");
        if (action === "stop") assert.equal(await harness.runtime.stop("alarm-1"), true);
        else if (action === "snooze") assert.equal((await harness.runtime.snooze("alarm-1")).kind, "saved");
        else await harness.runtime.shutdown();
        lookup.resolve(harness.channel);
        await starting;
        assert.equal(harness.connectedCount, 0);
        assert.equal(harness.repository.getAlarm("alarm-1")?.stopReason,
            action === "stop" ? "USER_STOPPED" : action === "snooze" ? "SNOOZED" : "PROCESS_SHUTDOWN");
        await harness.close();
    });
}

for (const action of ["stop", "move"] as const) {
    test(`claim応答待ちの${action}で音声を始めず予約枠を解放する`, async () => {
        const claimed = deferred<void>();
        const release = deferred<void>();
        const harness = makeHarness(async () => { throw new Error("VC検索へ進んではいけません。"); }, true,
            Promise.resolve(), {
                store: (repository) => withStoreMethods(repository, {
                    claimDue: async (now, tolerance) => {
                        const result = repository.claimDue(now, tolerance);
                        claimed.resolve();
                        await release.promise;
                        return result;
                    },
                }),
            });
        harness.reserve("claim-pending");
        const starting = harness.runtime.start([]);
        await claimed.promise;
        assert.equal(harness.repository.getAlarm("claim-pending")?.status, "STARTING");
        const cancellation = action === "stop"
            ? harness.runtime.stop("claim-pending") : harness.runtime.ownerVoiceChanged(null);
        release.resolve();
        if (action === "stop") assert.equal(await cancellation, true);
        else await cancellation;
        await starting;
        assert.equal(harness.connectedCount, 0);
        assert.equal(harness.repository.getAlarm("claim-pending")?.stopReason,
            action === "stop" ? "USER_STOPPED" : "OWNER_LEFT");
        assert.equal(harness.repository.getActive(), null);
        assert.equal(harness.reserve("next").kind, "saved");
        await harness.close();
    });
}

for (const scenario of [
    { name: "saved", outcome: "saved", stopDuringSave: false },
    { name: "failed", outcome: "failed", stopDuringSave: false },
    { name: "failed-stop", outcome: "failed", stopDuringSave: true },
    { name: "saved-stop", outcome: "saved", stopDuringSave: true },
] as const) {
    test(`準備中のスヌーズ保存${scenario.name}まで音声を進めない`, async () => {
        const lookup = deferred<BaseGuildVoiceChannel | null>();
        const mutationStarted = deferred<void>();
        const release = deferred<void>();
        const harness = makeHarness(() => lookup.promise, true, Promise.resolve(), {
            store: (repository) => withStoreMethods(repository, {
                snoozeRun: async (id, scheduledAtMs, nowMs, limit) => {
                    mutationStarted.resolve();
                    await release.promise;
                    if (scenario.outcome === "failed") throw new Error("D1 update failed");
                    return repository.snoozeRun(id, scheduledAtMs, nowMs, limit);
                },
            }),
        });
        harness.reserve("snooze-pending");
        const starting = harness.runtime.start([]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const snoozing = harness.runtime.snooze("snooze-pending");
        await mutationStarted.promise;
        lookup.resolve(harness.channel);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(harness.connectedCount, 0);
        const stopping = scenario.stopDuringSave ? harness.runtime.stop("snooze-pending") : null;
        release.resolve();
        assert.equal((await snoozing).kind, scenario.outcome);
        if (stopping) assert.equal(await stopping, true);
        await starting;
        assert.equal(harness.connectedCount, scenario.outcome === "saved" || scenario.stopDuringSave ? 0 : 1);
        if (scenario.outcome === "saved") {
            assert.equal(harness.repository.getAlarm("snooze-pending")?.stopReason, "SNOOZED");
            const active = harness.repository.getActive();
            assert.equal(active?.status, "WAITING");
            assert.equal(active?.snoozeCount, 1);
            if (scenario.stopDuringSave) {
                assert.equal(await harness.runtime.stop("snooze-pending"), false);
                assert.equal(harness.repository.getActive()?.id, active.id);
            }
        } else if (scenario.stopDuringSave) {
            assert.equal(harness.repository.getAlarm("snooze-pending")?.stopReason, "USER_STOPPED");
            assert.equal(harness.repository.getActive(), null);
        } else {
            assert.equal(await harness.runtime.stop("snooze-pending"), true);
        }
        await harness.close();
    });
}

test("再生中のスヌーズ保存失敗後に保留中の停止要求を実行する", async () => {
    const mutationStarted = deferred<void>();
    const release = deferred<void>();
    let voiceChannel: BaseGuildVoiceChannel;
    const harness = makeHarness(async () => voiceChannel, true, Promise.resolve(), {
        store: (repository) => withStoreMethods(repository, {
            snoozeRun: async () => {
                mutationStarted.resolve();
                await release.promise;
                throw new Error("D1 update failed");
            },
        }),
    });
    voiceChannel = harness.channel;
    harness.reserve("playing-snooze");
    try {
        await harness.runtime.start([]);
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (harness.repository.getAlarm("playing-snooze")?.status === "PLAYING") break;
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.equal(harness.repository.getAlarm("playing-snooze")?.status, "PLAYING");
        const snoozing = harness.runtime.snooze("playing-snooze");
        await mutationStarted.promise;
        const stopping = harness.runtime.stop("playing-snooze");
        release.resolve();
        assert.equal((await snoozing).kind, "failed");
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(harness.repository.getAlarm("playing-snooze")?.stopReason, "USER_STOPPED");
        assert.equal(await stopping, true);
        assert.equal(harness.repository.getActive(), null);
    } finally {
        release.resolve();
        await harness.close();
    }
});

for (const action of ["stop", "move"] as const) {
    test(`試聴のDB読取り待ちで${action}を記録する`, async () => {
        const reading = deferred<void>();
        const release = deferred<void>();
        const harness = makeHarness(async () => { throw new Error("VC検索へ進んではいけません。"); }, true,
            Promise.resolve(), {
                store: (repository) => withStoreMethods(repository, {
                    getActive: async () => {
                        reading.resolve();
                        await release.promise;
                        return repository.getActive();
                    },
                }),
            });
        await harness.runtime.start([]);
        const preview = harness.runtime.startPreview(video, textChannelId);
        await reading.promise;
        const cancellation = action === "stop"
            ? harness.runtime.stop("preview") : harness.runtime.ownerVoiceChanged(null);
        release.resolve();
        if (action === "stop") assert.equal(await cancellation, true);
        else await cancellation;
        assert.equal((await preview).kind, "busy");
        assert.equal(harness.connectedCount, 0);
        await harness.close();
    });
}

test("未接続中は待機を保持し、復旧時の現在時刻で遅延を判定する", async () => {
    const late = makeHarness(async () => null, false);
    late.reserve("late-1", 1_000_000);
    await late.runtime.start([]);
    late.setClock(1_180_001);
    assert.equal(late.repository.getAlarm("late-1")?.status, "WAITING");
    late.setReady(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(late.repository.getAlarm("late-1")?.stopReason, "LATE_OVER_LIMIT");
    await late.close();

    const within = makeHarness(async () => null, false);
    within.reserve("within-1", 1_000_000);
    await within.runtime.start([]);
    within.setClock(1_180_000);
    within.setReady(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(within.repository.getAlarm("within-1")?.stopReason, "OWNER_NOT_IN_VOICE");
    await within.close();
});

test("Botの明示終了では将来の待機予約を保持する", async () => {
    const harness = makeHarness(async () => null);
    harness.reserve("waiting-on-exit", 2_000_000);
    await harness.runtime.start([]);
    await harness.runtime.shutdown();
    assert.equal(harness.repository.getActive()?.id, "waiting-on-exit");
    assert.equal(harness.repository.getActive()?.status, "WAITING");
    await harness.close();
});

test("待機予約のある試聴を実ハンドラーの停止コマンドで終了する", async () => {
    const lookup = deferred<BaseGuildVoiceChannel | null>();
    const lookupStarted = deferred<void>();
    const claimPending = deferred<void>();
    const releaseClaim = deferred<void>();
    let holdClaim = false;
    const harness = makeHarness(() => {
        lookupStarted.resolve();
        return lookup.promise;
    }, true, Promise.resolve(), {
        store: (repository) => withStoreMethods(repository, {
            claimDue: async (now, tolerance) => {
                const result = repository.claimDue(now, tolerance);
                if (holdClaim) {
                    claimPending.resolve();
                    await releaseClaim.promise;
                }
                return result;
            },
        }),
    });
    harness.reserve("waiting-1", 2_000_000);
    await harness.runtime.start([]);
    const preview = harness.runtime.startPreview(video, textChannelId);
    await lookupStarted.promise;
    holdClaim = true;
    harness.setReady(true);
    await claimPending.promise;
    assert.equal(harness.runtime.activeAudioMode, "preview");
    assert.equal(harness.runtime.isIdle, false);
    const responses: string[] = [];
    let deferredReply = false;
    const interaction = {
        guildId, channelId: textChannelId, user: { id: ownerId }, commandName: "alarm",
        isChatInputCommand: () => true, isButton: () => false,
        options: { getSubcommand: () => "stop" },
        get deferred() { return deferredReply; }, replied: false,
        deferReply: async () => { deferredReply = true; },
        editReply: async (message: { content: string }) => { responses.push(message.content); },
    } as unknown as Interaction;
    const handler = new AlarmInteractionHandler(harness.config, harness.repository,
        { probe: async () => video }, harness.runtime, () => 1_000_000);
    const handling = handler.handle(interaction);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseClaim.resolve();
    await handling;
    lookup.resolve(harness.channel);
    assert.equal((await preview).kind, "busy");
    assert.equal(deferredReply, true);
    assert.match(responses[0] ?? "", /停止を受け付け/);
    assert.equal(harness.repository.getAlarm("waiting-1")?.status, "WAITING");
    assert.equal(harness.connectedCount, 0);
    assert.equal(harness.runtime.isIdle, true);
    await harness.close();
});

test("D1読取り失敗でも現在の音声を停止し、古い停止ボタンは作用しない", async () => {
    for (const action of ["command", "button"] as const) {
        let voiceChannel: BaseGuildVoiceChannel;
        const harness = makeHarness(async () => voiceChannel);
        voiceChannel = harness.channel;
        harness.reserve("alarm-playing");
        try {
            await harness.runtime.start([]);
            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (harness.repository.getAlarm("alarm-playing")?.status === "PLAYING") break;
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            assert.equal(harness.repository.getAlarm("alarm-playing")?.status, "PLAYING");
            const unavailable = withStoreMethods(harness.repository, {
                getActive: async () => { throw new Error("D1 read failed"); },
            });
            const handler = new AlarmInteractionHandler(harness.config, unavailable,
                { probe: async () => video }, harness.runtime, () => 1_000_000);
            const stop = async (runId: string) => {
                let deferredReply = false;
                const responses: string[] = [];
                const interaction = {
                    guildId, channelId: textChannelId, user: { id: ownerId }, commandName: "alarm",
                    customId: `alarm:stop:${runId}`,
                    isChatInputCommand: () => action === "command", isButton: () => action === "button",
                    options: { getSubcommand: () => "stop" },
                    get deferred() { return deferredReply; }, replied: false,
                    deferReply: async () => { deferredReply = true; },
                    editReply: async (message: { content: string }) => { responses.push(message.content); },
                } as unknown as Interaction;
                await handler.handle(interaction);
                assert.equal(deferredReply, true);
                return responses[0];
            };
            if (action === "button") {
                assert.match(await stop("older-run") ?? "", /終了しています/);
                assert.equal(harness.repository.getAlarm("alarm-playing")?.status, "PLAYING");
            }
            assert.match(await stop("alarm-playing") ?? "", /停止を受け付け/);
            assert.equal(harness.repository.getAlarm("alarm-playing")?.stopReason, "USER_STOPPED");
            assert.equal(harness.repository.getActive(), null);
        } finally {
            await harness.close();
        }
    }
});

test("試聴検索中の発火は試聴を取消してアラームを優先する", async () => {
    const first = deferred<BaseGuildVoiceChannel | null>();
    const firstLookupStarted = deferred<void>();
    let calls = 0;
    const harness = makeHarness(() => {
        if (++calls === 1) {
            firstLookupStarted.resolve();
            return first.promise;
        }
        return Promise.resolve(null);
    });
    harness.reserve("alarm-2", 1_001_000);
    await harness.runtime.start([]);
    const preview = harness.runtime.startPreview(video, textChannelId);
    await firstLookupStarted.promise;
    harness.setClock(1_001_000);
    harness.setReady(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    first.resolve(harness.channel);
    assert.equal((await preview).kind, "busy");
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (harness.repository.getAlarm("alarm-2")?.stopReason === "OWNER_NOT_IN_VOICE") break;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(harness.repository.getAlarm("alarm-2")?.stopReason, "OWNER_NOT_IN_VOICE");
    assert.equal(harness.connectedCount, 0);
    await harness.close();
});

test("実際のPlaying到達時刻をDBへ保存する", async () => {
    const playing = deferred<void>();
    let voiceChannel: BaseGuildVoiceChannel;
    const harness = makeHarness(async () => voiceChannel, true, playing.promise);
    voiceChannel = harness.channel;
    harness.reserve("alarm-playing");
    await harness.runtime.start([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.repository.getAlarm("alarm-playing")?.status, "STARTING");
    assert.equal(harness.repository.getAlarm("alarm-playing")?.startedAtMs, null);
    harness.setClock(1_005_000);
    playing.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.repository.getAlarm("alarm-playing")?.status, "PLAYING");
    assert.equal(harness.repository.getAlarm("alarm-playing")?.startedAtMs, 1_005_000);
    assert.equal(await harness.runtime.stop("alarm-playing"), true);
    await harness.close();
});

test("停止結果の保存中は音声解放後も終了可能と判定しない", async () => {
    const saving = deferred<void>();
    const release = deferred<void>();
    let voiceChannel: BaseGuildVoiceChannel;
    const harness = makeHarness(async () => voiceChannel, true, Promise.resolve(), {
        store: (repository) => withStoreMethods(repository, {
            finishRun: async (id, status, reason, nowMs, lastError) => {
                saving.resolve();
                await release.promise;
                return repository.finishRun(id, status, reason, nowMs, lastError);
            },
        }),
    });
    voiceChannel = harness.channel;
    harness.reserve("persisting");
    try {
        await harness.runtime.start([]);
        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (harness.repository.getActive()?.status === "PLAYING") break;
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const stopping = harness.runtime.stop("persisting");
        await saving.promise;
        assert.equal(harness.runtime.activeRunId, null);
        assert.equal(harness.runtime.isIdle, false);
        release.resolve();
        await stopping;
        assert.equal(harness.runtime.isIdle, true);
        assert.equal(harness.repository.getActive(), null);
    } finally {
        release.resolve();
        await harness.close();
    }
});

test("通知送信が保留中でも音源失敗を処理し再生時間を守る", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const notificationStarted = deferred<void>();
    const releaseNotification = deferred<void>();
    const fallbackStarted = deferred<void>();
    let notificationFinished = false;
    const realMedia = new FfmpegMediaFactory("__missing_yt_dlp_for_test__", "ffmpeg", 35, 1_000);
    const media: MediaFactory = {
        createYouTube: (url, signal) => realMedia.createYouTube(url, signal),
        createFallback: (signal) => {
            const source = realMedia.createFallback(signal);
            fallbackStarted.resolve();
            return source;
        },
    };
    let voiceChannel: BaseGuildVoiceChannel;
    const harness = makeHarness(async () => voiceChannel, true, Promise.resolve(), {
        media,
        sendNotification: async () => {
            notificationStarted.resolve();
            await releaseNotification.promise;
            notificationFinished = true;
        },
    });
    voiceChannel = harness.channel;
    harness.config.alarmDurationMs = 100;
    harness.config.mediaTimeoutMs = 1_000;
    harness.reserve("notification-delay");
    try {
        await harness.runtime.start([]);
        await notificationStarted.promise;
        await fallbackStarted.promise;
        assert.equal(harness.repository.getAlarm("notification-delay")?.status, "PLAYING");
        context.mock.timers.tick(99);
        assert.equal(harness.repository.getAlarm("notification-delay")?.status, "PLAYING");
        context.mock.timers.tick(1);
        for (let attempt = 0; attempt < 30; attempt += 1) {
            if (harness.repository.getAlarm("notification-delay")?.status === "FINISHED") break;
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const result = harness.repository.getAlarm("notification-delay");
        assert.equal(result?.status, "FINISHED");
        assert.equal(result.stopReason, "TIME_LIMIT");
        assert.match(result.lastError ?? "", /内蔵音へ切り替え/);
        assert.equal(notificationFinished, false);
        assert.equal(harness.runtime.isIdle, false);
    } finally {
        releaseNotification.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(harness.runtime.isIdle, true);
        await harness.close();
    }
});

test("試聴失敗の通知が終わるまで完了待ちを続ける", async () => {
    const notificationStarted = deferred<void>();
    const releaseNotification = deferred<void>();
    let delivered = false;
    const media: MediaFactory = {
        createYouTube: () => { throw new Error("音源を取得できません。"); },
        createFallback: () => { throw new Error("代替音を取得できません。"); },
    };
    let voiceChannel: BaseGuildVoiceChannel;
    const harness = makeHarness(async () => voiceChannel, true, Promise.resolve(), {
        media,
        sendNotification: async () => {
            notificationStarted.resolve();
            await releaseNotification.promise;
            delivered = true;
        },
    });
    voiceChannel = harness.channel;
    try {
        await harness.runtime.start([]);
        assert.equal((await harness.runtime.startPreview(video, textChannelId)).kind, "started");
        await notificationStarted.promise;
        assert.equal(harness.runtime.isIdle, false);
        let shutdownFinished = false;
        const shutdown = harness.runtime.shutdown().then(() => { shutdownFinished = true; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(shutdownFinished, false);
        releaseNotification.resolve();
        await shutdown;
        assert.equal(delivered, true);
        assert.equal(harness.notifications.includes("試聴の音声再生に失敗しました。"), true);
        assert.equal(harness.runtime.isIdle, true);
    } finally {
        releaseNotification.resolve();
        await harness.close();
    }
});
