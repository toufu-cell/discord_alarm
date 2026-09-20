import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateDependencyReport } from "@discordjs/voice";
import { discordConfigurationIssues, loadConfig } from "./config.ts";
import { runBoundedProcess } from "./processes.ts";
import { checkStunUdp } from "./udp-check.ts";

interface CheckResult {
    name: string;
    ok: boolean;
    detail: string;
}

async function commandCheck(
    name: string,
    command: string,
    args: string[],
    successDetail: (stdout: string) => string,
): Promise<CheckResult> {
    try {
        const result = await runBoundedProcess(command, args, {
            timeoutMs: 10_000,
            maxStdoutBytes: 128 * 1024,
            maxStderrBytes: 64 * 1024,
        });
        return result.exitCode === 0
            ? { name, ok: true, detail: successDetail(result.stdout) }
            : { name, ok: false, detail: "コマンドがエラーで終了しました。" };
    } catch {
        return { name, ok: false, detail: "コマンドを実行できませんでした。" };
    }
}

const config = loadConfig(process.env, { requireDiscord: false });
const checks: CheckResult[] = [];
checks.push({
    name: "Node.js",
    ok: Number(process.versions.node.split(".")[0]) >= 24,
    detail: process.versions.node,
});
try {
    const database = new DatabaseSync(":memory:");
    const row = database.prepare("SELECT sqlite_version() AS version").get() as { version: string };
    database.close();
    checks.push({ name: "SQLite", ok: true, detail: row.version });
} catch {
    checks.push({ name: "SQLite", ok: false, detail: "node:sqliteを利用できません。" });
}

checks.push(await commandCheck("FFmpeg", config.ffmpegPath, ["-hide_banner", "-encoders"], (stdout) => (
    stdout.includes("libopus") ? "libopusを利用できます。" : "libopusが見つかりません。"
)));
if (checks.at(-1)?.detail.includes("見つかりません")) checks.at(-1)!.ok = false;
checks.push(await commandCheck("yt-dlp", config.ytDlpPath, ["--version"], (stdout) => stdout.trim()));
checks.push(await commandCheck("Deno", "deno", ["--version"], (stdout) => stdout.split("\n")[0] ?? "利用可能"));
checks.push(await commandCheck(
    "yt-dlp-ejs",
    join(dirname(config.ytDlpPath), "python"),
    ["-c", "import yt_dlp_ejs; print('available')"],
    () => "利用できます。",
));
if (process.argv.includes("--udp")) {
    const ok = await checkStunUdp();
    checks.push({
        name: "Cloudflare STUN UDP",
        ok,
        detail: ok ? "固定宛先でUDP応答を確認しました。Discord音声の確認は別途必要です。"
            : "固定宛先のUDP応答を確認できませんでした。",
    });
}
try {
    await import("@snazzah/davey");
    const report = generateDependencyReport();
    checks.push({
        name: "DAVE",
        ok: report.includes("@snazzah/davey"),
        detail: report.includes("@snazzah/davey") ? "@discordjs/voiceから利用できます。" : "依存関係を確認できません。",
    });
} catch {
    checks.push({ name: "DAVE", ok: false, detail: "DAVE依存関係を読み込めません。" });
}

const { missingVariables, invalidVariables } = discordConfigurationIssues(process.env);
if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ checks, missingVariables, invalidVariables }));
} else {
    for (const check of checks) {
        console.log(`${check.ok ? "OK" : "NG"} ${check.name}: ${check.detail}`);
    }
    console.log(missingVariables.length === 0 && invalidVariables.length === 0
        ? "Discord接続情報: 設定済み（値は表示しません）"
        : `Discord接続情報の未設定項目: ${missingVariables.join(", ")}、形式不正: ${invalidVariables.join(", ")}`);
}
if (checks.some((check) => !check.ok) || missingVariables.length || invalidVariables.length) process.exitCode = 1;
