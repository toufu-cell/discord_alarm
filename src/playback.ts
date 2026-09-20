import type { PlaybackResult } from "./domain.ts";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { MediaFactory, MediaSource } from "./media.ts";
import type { VoiceConnector, VoiceOutput } from "./voice.ts";

export interface PlaybackRequest<Channel> {
    runId: string;
    channel: Channel;
    videoUrl: string;
    durationMs: number;
    mediaTimeoutMs?: number;
    beforePlay?: (signal: AbortSignal) => Promise<void>;
    onStarted?: () => Promise<void> | void;
    onFinished?: (result: PlaybackResult, persist: boolean) => Promise<void> | void;
    onPersistenceError?: (error: unknown) => void;
}

interface ActivePlayback<Channel> {
    request: PlaybackRequest<Channel>;
    abortController: AbortController;
    action: "stop" | "snooze" | null;
    requestedReason: string | null;
    queuedStopReason: string | null;
    snoozeCommitted: boolean;
    completion: Promise<PlaybackResult>;
}

export class PlaybackController<Channel> {
    private active: ActivePlayback<Channel> | null = null;
    private readonly mediaFactory: MediaFactory;
    private readonly voiceConnector: VoiceConnector<Channel>;

    public constructor(mediaFactory: MediaFactory, voiceConnector: VoiceConnector<Channel>) {
        this.mediaFactory = mediaFactory;
        this.voiceConnector = voiceConnector;
    }

    public get activeRunId(): string | null {
        return this.active?.request.runId ?? null;
    }

    public start(request: PlaybackRequest<Channel>): Promise<PlaybackResult> {
        if (this.active) throw new Error("別の音声処理が進行中です。");
        const active: ActivePlayback<Channel> = {
            request,
            abortController: new AbortController(),
            action: null,
            requestedReason: null,
            queuedStopReason: null,
            snoozeCommitted: false,
            completion: Promise.resolve({
                status: "FAILED",
                reason: "NOT_STARTED",
                usedFallback: false,
            }),
        };
        this.active = active;
        active.completion = this.run(active);
        return active.completion;
    }

    public requestStop(runId: string, reason: string): boolean {
        const active = this.active;
        if (!active || active.request.runId !== runId) return false;
        if (active.action === "snooze") {
            active.queuedStopReason ??= reason;
            return true;
        }
        if (active.action !== null) return false;
        active.action = "stop";
        active.requestedReason = reason;
        active.abortController.abort();
        return true;
    }

    public forceStop(runId: string, reason: string): boolean {
        const active = this.active;
        if (!active || active.request.runId !== runId) return false;
        active.action = "stop";
        active.requestedReason = reason;
        active.abortController.abort();
        return true;
    }

    public beginSnooze(runId: string): boolean {
        const active = this.active;
        if (!active || active.request.runId !== runId || active.action !== null) return false;
        active.action = "snooze";
        return true;
    }

    public cancelSnooze(runId: string): void {
        const active = this.active;
        if (active?.request.runId === runId && active.action === "snooze" && !active.snoozeCommitted) {
            if (active.queuedStopReason) {
                active.action = "stop";
                active.requestedReason = active.queuedStopReason;
                active.abortController.abort();
            } else {
                active.action = null;
            }
        }
    }

    public commitSnooze(runId: string): boolean {
        const active = this.active;
        if (!active || active.request.runId !== runId || active.action !== "snooze") return false;
        active.snoozeCommitted = true;
        active.requestedReason = "SNOOZED";
        active.abortController.abort();
        return true;
    }

    public completionFor(runId: string): Promise<PlaybackResult> | null {
        return this.active?.request.runId === runId ? this.active.completion : null;
    }

    private async run(active: ActivePlayback<Channel>): Promise<PlaybackResult> {
        const { request, abortController } = active;
        const signal = abortController.signal;
        let output: VoiceOutput | null = null;
        const sourceHolder: { current: MediaSource | null } = { current: null };
        let useFallback = false;
        let started = false;
        let startCallbackFailed = false;
        let startTask: Promise<void> | null = null;
        let lastError: string | undefined;
        let durationTimer: NodeJS.Timeout | null = null;

        let result: PlaybackResult = {
            status: "FINISHED",
            reason: "TIME_LIMIT",
            usedFallback: false,
        };
        try {
            output = await this.voiceConnector.connect(request.channel, signal);
            if (signal.aborted) throw new DOMException("音声再生を中止しました。", "AbortError");
            await request.beforePlay?.(signal);
            if (signal.aborted) throw new DOMException("音声再生を中止しました。", "AbortError");
            while (!signal.aborted) {
                try {
                    const source = useFallback
                        ? this.mediaFactory.createFallback(signal)
                        : this.mediaFactory.createYouTube(request.videoUrl, signal);
                    sourceHolder.current = source;
                    let sourceFinished = false;
                    let sourceWaitTimer: NodeJS.Timeout | null = null;
                    const markSourceFinished = () => {
                        sourceFinished = true;
                        if (sourceWaitTimer) clearTimeout(sourceWaitTimer);
                    };
                    const sourceDone = source.done.then(markSourceFinished, (error: unknown) => {
                        markSourceFinished();
                        throw error;
                    });
                    void sourceDone.catch(() => undefined);
                    const playing = output.play(source.stream, signal);
                    const playbackDone = playing.done.then(async () => {
                        if (sourceFinished) return;
                        try {
                            await Promise.race([
                                sourceDone,
                                new Promise<never>((_, reject) => {
                                    sourceWaitTimer = setTimeout(() => reject(
                                        new Error("音源取得の終了待ちが時間切れになりました。"),
                                    ), request.mediaTimeoutMs ?? 15_000);
                                    sourceWaitTimer.unref();
                                }),
                            ]);
                        } finally {
                            if (sourceWaitTimer) clearTimeout(sourceWaitTimer);
                        }
                    });
                    const cycleDone = Promise.all([playbackDone, sourceDone]);
                    void cycleDone.catch(() => undefined);
                    let mediaTimer: NodeJS.Timeout | null = null;
                    let onAbort: () => void = () => undefined;
                    const aborted = new Promise<never>((_, reject) => {
                        onAbort = () => reject(new DOMException("音声再生を中止しました。", "AbortError"));
                        signal.addEventListener("abort", onAbort, { once: true });
                        if (signal.aborted) onAbort();
                    });
                    const mediaTimeout = new Promise<never>((_, reject) => {
                        mediaTimer = setTimeout(() => reject(new Error("音声の準備が時間切れになりました。")),
                            request.mediaTimeoutMs ?? 15_000);
                        mediaTimer.unref();
                    });
                    try {
                        await Promise.race([
                            playing.started,
                            cycleDone.then(() => { throw new Error("音声が始まる前に終了しました。"); }),
                            mediaTimeout,
                            aborted,
                        ]);
                        if (mediaTimer) clearTimeout(mediaTimer);
                        mediaTimer = null;
                        if (!started) {
                            let startResult: Promise<void> | void;
                            try {
                                startResult = request.onStarted?.();
                            } catch (error) {
                                startCallbackFailed = true;
                                throw error;
                            }
                            started = true;
                            durationTimer = setTimeout(() => {
                                if (!signal.aborted) {
                                    active.requestedReason = "TIME_LIMIT";
                                    abortController.abort();
                                }
                            }, request.durationMs);
                            durationTimer.unref();
                            if (startResult) {
                                startTask = Promise.resolve(startResult);
                                void startTask.catch((error) => {
                                    startCallbackFailed = true;
                                    lastError = error instanceof Error ? error.message : "再生開始を保存できませんでした。";
                                    abortController.abort();
                                });
                            }
                        }
                        await Promise.race([cycleDone, aborted]);
                    } finally {
                        if (mediaTimer) clearTimeout(mediaTimer);
                        signal.removeEventListener("abort", onAbort);
                    }
                    await sourceHolder.current.stop();
                    sourceHolder.current = null;
                    await yieldToEventLoop();
                } catch (error) {
                    try {
                        await sourceHolder.current?.stop();
                    } catch {
                        lastError = "音源の終了処理に失敗しました。";
                    }
                    sourceHolder.current = null;
                    output.stop();
                    if (signal.aborted || startCallbackFailed) throw error;
                    if (!useFallback) {
                        useFallback = true;
                        lastError = "YouTube音声を再生できなかったため、内蔵音へ切り替えました。";
                        continue;
                    }
                    throw new Error("内蔵音を再生できませんでした。", { cause: error });
                }
            }
            result = {
                status: "FINISHED",
                reason: active.requestedReason ?? result.reason,
                lastError,
                usedFallback: useFallback,
            };
        } catch (error) {
            if (signal.aborted) {
                result = {
                    status: "FINISHED",
                    reason: active.requestedReason ?? "STOPPED",
                    lastError,
                    usedFallback: useFallback,
                };
            } else {
                result = {
                    status: "FAILED",
                    reason: "PLAYBACK_ERROR",
                    lastError: error instanceof Error ? error.message : "音声再生に失敗しました。",
                    usedFallback: useFallback,
                };
            }
        } finally {
            if (durationTimer) clearTimeout(durationTimer);
            try {
                await sourceHolder.current?.stop();
            } catch {
                result = { ...result, status: "FAILED", reason: "CLEANUP_ERROR", lastError: "音源を終了できませんでした。" };
            }
            try {
                output?.stop();
            } catch {
                result = { ...result, status: "FAILED", reason: "CLEANUP_ERROR", lastError: "音声を停止できませんでした。" };
            }
            try {
                await output?.close();
            } catch {
                result = { ...result, status: "FAILED", reason: "CLEANUP_ERROR", lastError: "音声接続を終了できませんでした。" };
            }
            if (this.active === active) this.active = null;
        }

        if (startTask) {
            try {
                await startTask;
            } catch {
                result = {
                    ...result, status: "FAILED", reason: "START_PERSISTENCE_FAILED",
                    lastError: lastError ?? "再生開始を保存できませんでした。",
                };
            }
        }

        try {
            await request.onFinished?.(result, !active.snoozeCommitted);
        } catch (error) {
            try {
                request.onPersistenceError?.(error);
            } catch {
                // Playback resources have already been released.
            }
        }
        return result;
    }
}
