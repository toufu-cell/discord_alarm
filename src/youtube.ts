import type { VideoChoice } from "./domain.ts";
import { runBoundedProcess } from "./processes.ts";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const FULL_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

export function normalizeYouTubeUrl(input: string): { videoId: string; canonicalUrl: string } {
    let parsed: URL;
    try {
        parsed = new URL(input);
    } catch {
        throw new Error("YouTube動画のURLを指定してください。");
    }
    if (parsed.protocol !== "https:") {
        throw new Error("YouTube URLにはhttpsを使用してください。");
    }
    if (parsed.searchParams.has("list")) {
        throw new Error("プレイリストを含むURLは指定できません。");
    }

    let videoId: string | null = null;
    if (parsed.hostname === "youtu.be") {
        const pathParts = parsed.pathname.split("/").filter(Boolean);
        if (pathParts.length === 1) videoId = pathParts[0] ?? null;
    } else if (FULL_HOSTS.has(parsed.hostname) && parsed.pathname === "/watch") {
        videoId = parsed.searchParams.get("v");
    }
    if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) {
        throw new Error("通常のYouTube動画URLだけを指定できます。");
    }
    return {
        videoId,
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
}

export class YtDlpClient {
    private readonly executablePath: string;
    private readonly timeoutMs: number;

    public constructor(executablePath: string, timeoutMs: number) {
        this.executablePath = executablePath;
        this.timeoutMs = timeoutMs;
    }

    public async probe(input: string, signal?: AbortSignal): Promise<VideoChoice> {
        const normalized = normalizeYouTubeUrl(input);
        const result = await runBoundedProcess(
            this.executablePath,
            [
                "--ignore-config",
                "--no-cache-dir",
                "--no-playlist",
                "--no-warnings",
                "--js-runtimes",
                "deno",
                "--print",
                '{"id":%(id)j,"title":%(title)j,"live_status":%(live_status)j,"age_limit":%(age_limit)j}',
                "--skip-download",
                normalized.canonicalUrl,
            ],
            {
                timeoutMs: this.timeoutMs,
                maxStdoutBytes: 16 * 1024,
                maxStderrBytes: 64 * 1024,
                signal,
                processGroup: true,
            },
        );
        if (result.exitCode !== 0) {
            if (result.signal) throw new Error("YouTube動画の取得が時間切れになりました。");
            if (/unavailable/i.test(result.stderr)) throw new Error("YouTube動画は利用できません。");
            if (/sign in|age.restrict/i.test(result.stderr)) throw new Error("ログインが必要な動画は指定できません。");
            throw new Error("YouTubeへの接続または動画情報の取得に失敗しました。");
        }
        let metadata: { id?: unknown; title?: unknown; live_status?: unknown; age_limit?: unknown };
        try {
            metadata = JSON.parse(result.stdout) as typeof metadata;
        } catch {
            throw new Error("YouTube動画の応答を確認できませんでした。");
        }
        if (metadata.id !== normalized.videoId || typeof metadata.title !== "string") {
            throw new Error("YouTube動画の情報がURLと一致しませんでした。");
        }
        if (metadata.live_status !== "not_live") {
            throw new Error("ライブや配信予定の動画は指定できません。");
        }
        if (typeof metadata.age_limit !== "number" || metadata.age_limit >= 18) {
            throw new Error("年齢制限付き動画は指定できません。");
        }
        return {
            videoId: normalized.videoId,
            videoUrl: normalized.canonicalUrl,
            videoTitle: metadata.title.replace(/[\r\n\t]+/g, " ").trim().slice(0, 160) || "YouTube動画",
        };
    }
}
