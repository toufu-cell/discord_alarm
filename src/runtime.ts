import { randomUUID } from "node:crypto";
import {
    ChannelType,
    PermissionFlagsBits,
    type ActionRowBuilder,
    type BaseGuildVoiceChannel,
    type ButtonBuilder,
    type Client,
} from "discord.js";
import type { AppConfig } from "./config.ts";
import { playbackButtons } from "./commands.ts";
import type { AlarmRecord, VideoChoice } from "./domain.ts";
import type { AlarmStore } from "./repository.ts";
import type { SnoozeResult } from "./database.ts";
import { RemoteMutationUncertainError } from "./remote-repository.ts";
import type { AlarmOperations } from "./interaction-handler.ts";
import type { PlaybackController } from "./playback.ts";

interface PendingAlarm {
    id: string;
    stopReason: string | null;
    stopRequested: boolean;
    abortController: AbortController;
    snoozeTask: Promise<SnoozeResult> | null;
}

interface PendingClaim {
    stoppedIds: Set<string>;
    voiceStopReason: string | null;
    claimedId: string | null;
    cancelled: boolean;
    failure: unknown;
    settled: Promise<void>;
    resolveSettled: () => void;
}

interface PendingPreview {
    abortController: AbortController;
}

type PreviewStartResult = { kind: "started" | "no-voice" | "busy" | "failed" };

export class AlarmRuntime implements AlarmOperations {
    private scheduler: NodeJS.Timeout | null = null;
    private connected = false;
    private shuttingDown = false;
    private ticking = false;
    private claiming: PendingClaim | null = null;
    private starting: PendingAlarm | null = null;
    private startingTask: Promise<void> | null = null;
    private previewLookup: PendingPreview | null = null;
    private previewTask: Promise<PreviewStartResult> | null = null;
    private activeVoiceChannelId: string | null = null;
    private readonly completions = new Set<Promise<unknown>>();
    private readonly notifications = new Set<Promise<void>>();
    private readonly onSettled: () => void;
    private readonly client: Client;
    private readonly config: AppConfig;
    private readonly repository: AlarmStore;
    private readonly playback: PlaybackController<BaseGuildVoiceChannel>;
    private readonly now: () => number;

    public constructor(
        client: Client,
        config: AppConfig,
        repository: AlarmStore,
        playback: PlaybackController<BaseGuildVoiceChannel>,
        now: () => number = Date.now,
        onSettled: () => void = () => undefined,
    ) {
        this.client = client;
        this.config = config;
        this.repository = repository;
        this.playback = playback;
        this.now = now;
        this.onSettled = onSettled;
    }

    public get activeAudioMode(): "alarm" | "preview" | null {
        if (this.starting) return "alarm";
        return this.previewLookup ? "preview" : this.playback.activeMode;
    }

    public get activeRunId(): string | null {
        return this.starting?.id ?? this.playback.activeRunId;
    }

    public get isIdle(): boolean {
        return !this.ticking && !this.claiming && !this.starting && !this.previewLookup
            && !this.previewTask && !this.playback.activeRunId && this.completions.size === 0
            && this.notifications.size === 0;
    }

    public get isConnected(): boolean {
        return this.connected && this.client.isReady();
    }

    public async start(recovered: AlarmRecord[]): Promise<void> {
        if (this.shuttingDown) return;
        this.connected = this.client.isReady();
        await this.tick();
        if (this.shuttingDown) return;
        this.scheduler = setInterval(() => void this.tick(), 1_000);
        this.scheduler.unref();
        for (const alarm of recovered) {
            void this.notify(alarm, "前回の準備中または再生中にBotが終了したため、中断として記録しました。");
        }
    }

    public setConnected(connected: boolean): void {
        this.connected = connected && !this.shuttingDown;
        if (this.connected) void this.tick();
    }

    private async tick(): Promise<void> {
        if (this.ticking || !this.connected || !this.client.isReady() || this.shuttingDown) return;
        this.ticking = true;
        let resolveSettled!: () => void;
        const claiming: PendingClaim = {
            stoppedIds: new Set(), voiceStopReason: null, claimedId: null, cancelled: false,
            failure: null,
            settled: new Promise<void>((resolve) => { resolveSettled = resolve; }),
            resolveSettled: () => resolveSettled(),
        };
        this.claiming = claiming;
        try {
            const result = await this.repository.claimDue(this.now(), this.config.lateToleranceMs);
            if (result.kind === "skipped") {
                void this.notify(result.alarm, "予定から3分を超えたため、この予約は再生しませんでした。");
            } else if (result.kind === "claimed") {
                claiming.claimedId = result.alarm.id;
                const reason = this.shuttingDown ? "PROCESS_SHUTDOWN"
                    : claiming.stoppedIds.has(result.alarm.id) ? "USER_STOPPED" : claiming.voiceStopReason;
                if (reason) {
                    claiming.cancelled = await this.repository.finishRun(result.alarm.id, "FINISHED", reason, this.now());
                } else {
                    const task = this.startAlarm(result.alarm);
                    this.startingTask = task;
                    try {
                        await task;
                    } finally {
                        if (this.startingTask === task) this.startingTask = null;
                    }
                }
            }
        } catch (error) {
            claiming.failure = error;
            console.error("待機中の予約を処理できませんでした。");
        } finally {
            if (this.claiming === claiming) this.claiming = null;
            claiming.resolveSettled();
            this.ticking = false;
            this.onSettled();
        }
    }

    private async ownerVoiceChannel(): Promise<BaseGuildVoiceChannel | null> {
        const guild = await this.client.guilds.fetch(this.config.guildId);
        const member = await guild.members.fetch(this.config.ownerId);
        return member.voice.channel;
    }

    private async lookupVoiceChannel(signal: AbortSignal): Promise<BaseGuildVoiceChannel | null> {
        if (signal.aborted) throw new DOMException("VCの確認を中止しました。", "AbortError");
        let abort: () => void = () => undefined;
        const cancelled = new Promise<never>((_, reject) => {
            abort = () => reject(new DOMException("VCの確認を中止しました。", "AbortError"));
            signal.addEventListener("abort", abort, { once: true });
        });
        try {
            return await Promise.race([this.ownerVoiceChannel(), cancelled]);
        } finally {
            signal.removeEventListener("abort", abort);
        }
    }

    private validateVoiceChannel(channel: BaseGuildVoiceChannel): boolean {
        if (channel.type !== ChannelType.GuildVoice) return false;
        const me = channel.guild.members.me;
        if (!me) return false;
        const permissions = channel.permissionsFor(me);
        if (!permissions.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
        ])) return false;
        return channel.userLimit === 0 || channel.members.has(me.id) || channel.members.size < channel.userLimit;
    }

    private cancelStarting(pending: PendingAlarm, reason: string): boolean {
        if (this.starting !== pending || pending.stopReason !== null) return false;
        pending.stopReason = reason;
        pending.abortController.abort();
        return true;
    }

    private applyQueuedStop(pending: PendingAlarm): void {
        if (pending.stopRequested && pending.stopReason === null) {
            pending.stopReason = "USER_STOPPED";
            pending.abortController.abort();
        }
    }

    private async finishCancelledStart(pending: PendingAlarm): Promise<boolean> {
        if (pending.snoozeTask) await pending.snoozeTask.catch(() => undefined);
        this.applyQueuedStop(pending);
        if (pending.stopReason === null) return false;
        if (pending.stopReason !== "SNOOZED") {
            await this.repository.finishRun(pending.id, "FINISHED", pending.stopReason, this.now());
        }
        return true;
    }

    private async startAlarm(alarm: AlarmRecord): Promise<void> {
        const pending: PendingAlarm = {
            id: alarm.id, stopReason: null, stopRequested: false,
            abortController: new AbortController(), snoozeTask: null,
        };
        this.starting = pending;
        this.previewLookup?.abortController.abort();
        try {
            await this.playback.stopPreviewForAlarm();
            if (await this.finishCancelledStart(pending)) return;
            const channel = await this.lookupVoiceChannel(pending.abortController.signal);
            if (await this.finishCancelledStart(pending)) return;
            if (!channel) {
                await this.repository.finishRun(alarm.id, "SKIPPED", "OWNER_NOT_IN_VOICE", this.now());
                void this.notify(alarm, "本人がボイスチャンネルにいないため、再生しませんでした。");
                return;
            }
            if (!this.validateVoiceChannel(channel)) {
                await this.repository.finishRun(alarm.id, "FAILED", "VOICE_PERMISSION_OR_CAPACITY", this.now(),
                    "ボイスチャンネルの権限、種類、空きを確認してください。");
                void this.notify(alarm, "ボイスチャンネルの権限、種類、空きが合わず再生できませんでした。");
                return;
            }
            if (await this.finishCancelledStart(pending)) return;
            if (this.shuttingDown || !this.connected) {
                await this.repository.finishRun(alarm.id, "FAILED", "DISCORD_DISCONNECTED", this.now(),
                    "Discord接続が切れたため再生できませんでした。");
                return;
            }
            if (pending.snoozeTask) await pending.snoozeTask.catch(() => undefined);
            this.applyQueuedStop(pending);
            if (pending.stopReason !== null) {
                await this.finishCancelledStart(pending);
                return;
            }
            this.activeVoiceChannelId = channel.id;
            this.starting = null;
            const completion = this.playback.start({
                runId: alarm.id,
                mode: "alarm",
                channel,
                videoUrl: alarm.videoUrl,
                durationMs: this.config.alarmDurationMs,
                mediaTimeoutMs: this.config.mediaTimeoutMs,
                beforePlay: async (signal) => {
                    const current = await this.lookupVoiceChannel(signal);
                    if (this.shuttingDown || !this.connected || current?.id !== channel.id
                        || !this.validateVoiceChannel(channel)) {
                        throw new Error("再生直前に本人のVCを確認できませんでした。");
                    }
                },
                onStarted: async () => {
                    const startedAtMs = this.now();
                    const playing = await this.repository.markPlaying(alarm.id, startedAtMs);
                    if (!playing) throw new Error("予約の再生開始を保存できませんでした。");
                    void this.notify(
                        alarm,
                        "アラームを再生しています: " + alarm.videoTitle,
                        [playbackButtons(alarm.id, alarm.snoozeCount < this.config.snoozeLimit)],
                    );
                },
                onFinished: async (result, persist) => {
                    this.activeVoiceChannelId = null;
                    if (persist) {
                        await this.repository.finishRun(alarm.id, result.status, result.reason, this.now(), result.lastError);
                    }
                    if (result.status === "FAILED") {
                        void this.notify(alarm, "アラームの音声再生に失敗しました。/alarm showで理由を確認してください。");
                    }
                },
                onPersistenceError: () => {
                    console.error("停止結果を保存できませんでした。音声処理は解放済みです。");
                },
            });
            this.completions.add(completion);
            void completion.catch(() => {
                this.activeVoiceChannelId = null;
                console.error("音声処理を完了できませんでした。");
            }).finally(() => {
                this.completions.delete(completion);
                this.onSettled();
            });
        } catch {
            if (this.shuttingDown) {
                if (pending.stopReason === "PROCESS_SHUTDOWN") {
                    try {
                        await this.repository.finishRun(alarm.id, "FINISHED", "PROCESS_SHUTDOWN", this.now());
                    } catch {
                        console.error("終了状態を保存できませんでした。");
                    }
                }
                return;
            }
            if (await this.finishCancelledStart(pending)) return;
            await this.repository.finishRun(alarm.id, "FAILED", "DISCORD_LOOKUP_FAILED", this.now(),
                "Discordの接続先を確認できませんでした。");
            void this.notify(alarm, "Discordの接続先を確認できず、再生を開始できませんでした。");
        } finally {
            if (this.starting === pending) this.starting = null;
            this.onSettled();
        }
    }

    public startPreview(video: VideoChoice, notificationChannelId: string): Promise<PreviewStartResult> {
        if (this.previewTask) return Promise.resolve({ kind: "busy" });
        const task = this.startPreviewInternal(video, notificationChannelId);
        this.previewTask = task;
        void task.finally(() => {
            if (this.previewTask === task) this.previewTask = null;
            this.onSettled();
        }).catch(() => undefined);
        return task;
    }

    private async startPreviewInternal(video: VideoChoice, notificationChannelId: string): Promise<PreviewStartResult> {
        if (this.shuttingDown || !this.connected || !this.client.isReady()
            || this.previewLookup || this.playback.activeRunId || this.starting) return { kind: "busy" };
        const lookup: PendingPreview = { abortController: new AbortController() };
        this.previewLookup = lookup;
        try {
            const active = await this.repository.getActive();
            if (lookup.abortController.signal.aborted || this.shuttingDown || this.starting
                || active?.status === "STARTING" || active?.status === "PLAYING") return { kind: "busy" };
            const channel = await this.lookupVoiceChannel(lookup.abortController.signal);
            if (lookup.abortController.signal.aborted || this.shuttingDown || this.starting
                || this.playback.activeRunId || !this.connected) return { kind: "busy" };
            if (!channel) return { kind: "no-voice" };
            if (!this.validateVoiceChannel(channel)) return { kind: "failed" };
            this.activeVoiceChannelId = channel.id;
            this.previewLookup = null;
            const runId = "preview-" + randomUUID();
            const completion = this.playback.start({
                runId,
                mode: "preview",
                channel,
                videoUrl: video.videoUrl,
                durationMs: this.config.previewSeconds * 1_000,
                mediaTimeoutMs: this.config.mediaTimeoutMs,
                beforePlay: async (signal) => {
                    const current = await this.lookupVoiceChannel(signal);
                    if (this.shuttingDown || !this.connected || current?.id !== channel.id
                        || !this.validateVoiceChannel(channel)) {
                        throw new Error("試聴直前に本人のVCを確認できませんでした。");
                    }
                },
                onFinished: async (result) => {
                    this.activeVoiceChannelId = null;
                    if (result.status === "FAILED") {
                        await this.notifyChannel(notificationChannelId, "試聴の音声再生に失敗しました。");
                    }
                },
            });
            this.completions.add(completion);
            void completion.catch(() => {
                this.activeVoiceChannelId = null;
                console.error("試聴の音声処理を完了できませんでした。");
            }).finally(() => {
                this.completions.delete(completion);
                this.onSettled();
            });
            return { kind: "started" };
        } catch {
            this.activeVoiceChannelId = null;
            return lookup.abortController.signal.aborted ? { kind: "busy" } : { kind: "failed" };
        } finally {
            if (this.previewLookup === lookup) this.previewLookup = null;
        }
    }

    public async stop(runId: string): Promise<boolean> {
        if (runId === "preview" && this.previewLookup) {
            this.previewLookup.abortController.abort();
            await this.previewTask;
            return true;
        }
        const pending = this.starting;
        if (pending?.id === runId) {
            if (pending.snoozeTask) {
                pending.stopRequested = true;
                try {
                    await pending.snoozeTask;
                } catch (error) {
                    if (error instanceof RemoteMutationUncertainError) throw error;
                }
                await this.startingTask;
                return true;
            }
            if (this.cancelStarting(pending, "USER_STOPPED")) {
                await this.startingTask;
                return true;
            }
        }
        const actualRunId = runId === "preview" && this.playback.activeMode === "preview"
            ? this.playback.activeRunId : runId;
        if (actualRunId) {
            const completion = this.playback.completionFor(actualRunId);
            if (completion) {
                if (!this.playback.requestStop(actualRunId, "USER_STOPPED")) return false;
                await completion;
                return true;
            }
        }
        const claiming = this.claiming;
        if (!claiming) return false;
        claiming.stoppedIds.add(runId);
        await claiming.settled;
        if (claiming.failure instanceof RemoteMutationUncertainError) throw claiming.failure;
        return claiming.claimedId === runId && claiming.cancelled;
    }

    public async snooze(runId: string): Promise<
        | { kind: "saved"; scheduledAtMs: number }
        | { kind: "stale" }
        | { kind: "limit"; count: number }
        | { kind: "failed" }
    > {
        const scheduledAtMs = this.now() + 5 * 60_000;
        const pending = this.starting;
        if (pending?.id === runId) {
            if (pending.stopReason !== null || pending.snoozeTask) return { kind: "stale" };
            const mutation = (async () => {
                const saved = await this.repository.snoozeRun(runId, scheduledAtMs, this.now(), this.config.snoozeLimit);
                if (saved.kind === "saved") {
                    pending.stopReason = "SNOOZED";
                    pending.abortController.abort();
                }
                return saved;
            })();
            pending.snoozeTask = mutation;
            try {
                const saved = await mutation;
                if (saved.kind === "saved") {
                    const completion = this.playback.completionFor(runId);
                    if (completion) {
                        this.playback.forceStop(runId, "SNOOZED");
                        await completion;
                    }
                    await this.startingTask;
                    return { kind: "saved", scheduledAtMs };
                }
                return saved;
            } catch (error) {
                if (error instanceof RemoteMutationUncertainError) throw error;
                return { kind: "failed" };
            } finally {
                if (pending.snoozeTask === mutation) pending.snoozeTask = null;
            }
        }
        const completion = this.playback.completionFor(runId);
        if (!completion || !this.playback.beginSnooze(runId)) return { kind: "stale" };
        try {
            const saved = await this.repository.snoozeRun(runId, scheduledAtMs, this.now(), this.config.snoozeLimit);
            if (saved.kind === "saved") {
                this.playback.commitSnooze(runId);
                await completion;
                return { kind: "saved", scheduledAtMs };
            }
            this.playback.cancelSnooze(runId);
            return saved;
        } catch (error) {
            this.playback.cancelSnooze(runId);
            if (error instanceof RemoteMutationUncertainError) throw error;
            return { kind: "failed" };
        }
    }

    public async ownerVoiceChanged(newChannelId: string | null): Promise<void> {
        const reason = newChannelId ? "OWNER_MOVED" : "OWNER_LEFT";
        this.previewLookup?.abortController.abort();
        const claiming = this.claiming;
        if (claiming) claiming.voiceStopReason = reason;
        const pending = this.starting;
        if (pending && this.cancelStarting(pending, reason)) await this.startingTask;
        if (claiming) await claiming.settled;
        const runId = this.playback.activeRunId;
        if (runId && this.activeVoiceChannelId !== newChannelId) {
            const completion = this.playback.completionFor(runId);
            this.playback.requestStop(runId, reason);
            await completion;
        }
    }

    private async notifyChannel(
        channelId: string,
        content: string,
        components: ActionRowBuilder<ButtonBuilder>[] = [],
    ): Promise<boolean> {
        try {
            const channel = await this.client.channels.fetch(channelId);
            if (!channel?.isSendable()) throw new Error("通知先へ送信できません。");
            await channel.send({ content, components, allowedMentions: { parse: [] } });
            return true;
        } catch {
            return false;
        }
    }

    private notify(
        alarm: AlarmRecord,
        content: string,
        components: ActionRowBuilder<ButtonBuilder>[] = [],
    ): Promise<void> {
        const task = (async () => {
            if (await this.notifyChannel(alarm.notificationChannelId, content, components)) return;
            try {
                await this.repository.recordNotificationError(alarm.id, "Discord通知の送信に失敗しました。");
            } catch {
                console.error("通知失敗の記録を保存できませんでした。");
            }
        })();
        this.notifications.add(task);
        void task.finally(() => {
            this.notifications.delete(task);
            this.onSettled();
        });
        return task;
    }

    public async shutdown(): Promise<void> {
        this.shuttingDown = true;
        this.connected = false;
        if (this.scheduler) clearInterval(this.scheduler);
        this.scheduler = null;
        this.previewLookup?.abortController.abort();
        const claiming = this.claiming;
        if (claiming) claiming.voiceStopReason = "PROCESS_SHUTDOWN";
        const pending = this.starting;
        if (pending) this.cancelStarting(pending, "PROCESS_SHUTDOWN");
        await Promise.allSettled([this.previewTask, this.startingTask, claiming?.settled]);
        const runId = this.playback.activeRunId;
        if (runId) {
            const completion = this.playback.completionFor(runId);
            this.playback.forceStop(runId, "PROCESS_SHUTDOWN");
            await completion;
        }
        await Promise.allSettled([...this.completions]);
        await Promise.allSettled([...this.notifications]);
    }
}
