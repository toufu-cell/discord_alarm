import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { ChildProcessRegistry } from "./processes.ts";

export interface MediaSource {
    kind: "youtube" | "fallback";
    stream: Readable;
    done: Promise<void>;
    stop(): Promise<void>;
}

export interface MediaFactory {
    createYouTube(url: string, signal: AbortSignal): MediaSource;
    createFallback(signal: AbortSignal): MediaSource;
}

function waitForSuccessfulExit(
    child: ChildProcessWithoutNullStreams,
    label: string,
    registry: ChildProcessRegistry,
    maximumStderrBytes = 64 * 1024,
): Promise<void> {
    let stderrBytes = 0;
    let overflow = false;
    child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > maximumStderrBytes && !overflow) {
            overflow = true;
            void registry.terminateAll();
        }
    });
    return new Promise<void>((resolve, reject) => {
        child.once("error", () => reject(new Error(`${label}を起動できませんでした。`)));
        child.once("close", (code, signal) => {
            registry.delete(child);
            if (overflow) {
                reject(new Error(`${label}の診断出力が上限を超えました。`));
            } else if (code === 0) {
                resolve();
            } else if (signal) {
                reject(new DOMException(`${label}を中止しました。`, "AbortError"));
            } else {
                reject(new Error(`${label}が途中で終了しました。`));
            }
        });
    });
}

function bindAbort(signal: AbortSignal, stop: () => Promise<void>): () => void {
    const abort = () => void stop();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return () => signal.removeEventListener("abort", abort);
}

export class FfmpegMediaFactory implements MediaFactory {
    private readonly ytDlpPath: string;
    private readonly ffmpegPath: string;
    private readonly volumePercent: number;
    private readonly timeoutMs: number;

    public constructor(ytDlpPath: string, ffmpegPath: string, volumePercent: number, timeoutMs = 15_000) {
        this.ytDlpPath = ytDlpPath;
        this.ffmpegPath = ffmpegPath;
        this.volumePercent = volumePercent;
        this.timeoutMs = timeoutMs;
    }

    private outputArguments(inputArguments: string[]): string[] {
        return [
            "-hide_banner",
            "-loglevel",
            "error",
            ...inputArguments,
            "-vn",
            "-filter:a",
            `volume=${this.volumePercent / 100}`,
            "-c:a",
            "libopus",
            "-b:a",
            "96k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-f",
            "ogg",
            "pipe:1",
        ];
    }

    public createYouTube(url: string, signal: AbortSignal): MediaSource {
        if (signal.aborted) throw new DOMException("音源の準備を中止しました。", "AbortError");
        const registry = new ChildProcessRegistry();
        const ytDlp = spawn(this.ytDlpPath, [
            "--ignore-config",
            "--no-cache-dir",
            "--no-playlist",
            "--no-warnings",
            "--no-progress",
            "--js-runtimes",
            "deno",
            "-f",
            "bestaudio/best",
            "-o",
            "-",
            url,
        ], { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
        ytDlp.stdin.end();
        const ffmpeg = spawn(this.ffmpegPath, this.outputArguments(["-i", "pipe:0"]), {
            stdio: ["pipe", "pipe", "pipe"],
        });
        registry.add(ytDlp, process.platform !== "win32");
        registry.add(ffmpeg);
        ytDlp.stdout.pipe(ffmpeg.stdin);
        ytDlp.stdout.on("error", () => void registry.terminateAll());
        ffmpeg.stdin.on("error", () => void registry.terminateAll());
        ffmpeg.stdout.on("error", () => void registry.terminateAll());
        const startupTimeout = setTimeout(() => void registry.terminateAll(), this.timeoutMs);
        startupTimeout.unref();
        ffmpeg.stdout.once("data", () => clearTimeout(startupTimeout));

        let stopPromise: Promise<void> | null = null;
        const stop = (): Promise<void> => {
            if (!stopPromise) {
                clearTimeout(startupTimeout);
                ytDlp.stdout.unpipe(ffmpeg.stdin);
                stopPromise = registry.terminateAll();
            }
            return stopPromise;
        };
        const unbind = bindAbort(signal, stop);
        const done = Promise.all([
            waitForSuccessfulExit(ytDlp, "yt-dlp", registry),
            waitForSuccessfulExit(ffmpeg, "FFmpeg", registry),
        ]).then(() => undefined).catch(async (error: unknown) => {
            await registry.terminateAll();
            throw error;
        }).finally(() => {
            clearTimeout(startupTimeout);
            unbind();
        });
        return { kind: "youtube", stream: ffmpeg.stdout, done, stop };
    }

    public createFallback(signal: AbortSignal): MediaSource {
        if (signal.aborted) throw new DOMException("音源の準備を中止しました。", "AbortError");
        const registry = new ChildProcessRegistry();
        const ffmpeg = spawn(this.ffmpegPath, this.outputArguments([
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=2",
        ]), { stdio: ["pipe", "pipe", "pipe"] });
        ffmpeg.stdin.end();
        registry.add(ffmpeg);
        ffmpeg.stdout.on("error", () => void registry.terminateAll());
        const startupTimeout = setTimeout(() => void registry.terminateAll(), this.timeoutMs);
        startupTimeout.unref();
        ffmpeg.stdout.once("data", () => clearTimeout(startupTimeout));
        let stopPromise: Promise<void> | null = null;
        const stop = (): Promise<void> => {
            if (!stopPromise) {
                clearTimeout(startupTimeout);
                stopPromise = registry.terminateAll();
            }
            return stopPromise;
        };
        const unbind = bindAbort(signal, stop);
        const done = waitForSuccessfulExit(ffmpeg, "FFmpeg", registry).finally(() => {
            clearTimeout(startupTimeout);
            unbind();
        });
        return { kind: "fallback", stream: ffmpeg.stdout, done, stop };
    }
}
