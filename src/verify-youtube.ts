import { loadConfig } from "./config.ts";
import { FfmpegMediaFactory } from "./media.ts";
import { YtDlpClient } from "./youtube.ts";

const config = loadConfig(process.env, { requireDiscord: false });
const input = process.argv[2] ?? "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 45_000);
let source: ReturnType<FfmpegMediaFactory["createYouTube"]> | null = null;
try {
    const video = await new YtDlpClient(config.ytDlpPath, 30_000).probe(input, controller.signal);
    source = new FfmpegMediaFactory(
        config.ytDlpPath,
        config.ffmpegPath,
        config.volumePercent,
        config.mediaTimeoutMs,
    ).createYouTube(video.videoUrl, controller.signal);
    void source.done.catch(() => undefined);
    let outputBytes = 0;
    let header = Buffer.alloc(0);
    for await (const chunk of source.stream) {
        const data = chunk as Buffer;
        outputBytes += data.length;
        if (header.length < 256) header = Buffer.concat([header, data]).subarray(0, 256);
    }
    await source.done;
    if (header.subarray(0, 4).toString() !== "OggS" || !header.includes(Buffer.from("OpusHead"))) {
        throw new Error("FFmpegのOgg Opus出力を確認できませんでした。");
    }
    console.log(`YouTube取得とFFmpeg変換に成功しました。動画IDは${video.videoId}です。出力は${outputBytes}バイトです。`);
} catch (error) {
    console.error(error instanceof Error ? error.message : "YouTube音声の技術確認に失敗しました。");
    process.exitCode = 1;
} finally {
    clearTimeout(timeout);
    await source?.stop();
}
