import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { FfmpegMediaFactory } from "../src/media.ts";
import { ChildProcessRegistry, runBoundedProcess, terminateChild } from "../src/processes.ts";

async function assertProcessGone(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            process.kill(pid, 0);
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
        } catch {
            return;
        }
    }
    assert.fail("子孫プロセスが終了しませんでした。");
}

test("FFmpegが生成した内蔵音をOpusへ変換する", async () => {
    const factory = new FfmpegMediaFactory("unused", "ffmpeg", 35);
    const source = factory.createFallback(new AbortController().signal);
    const chunks: Buffer[] = [];
    for await (const chunk of source.stream) chunks.push(chunk as Buffer);
    await source.done;
    assert.equal(Buffer.concat(chunks).subarray(0, 4).toString(), "OggS");
    await source.stop();
});

test("音源の停止を繰り返しても同じ子プロセス終了を待つ", async () => {
    const source = new FfmpegMediaFactory("unused", "ffmpeg", 35).createFallback(new AbortController().signal);
    void source.done.catch(() => undefined);
    const first = source.stop();
    const second = source.stop();
    assert.strictEqual(first, second);
    await first;
});

test("実子プロセスを停止後に残さない", async () => {
    const registry = new ChildProcessRegistry();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["pipe", "pipe", "pipe"],
    });
    registry.add(child);
    await registry.terminateAll();
    assert.equal(registry.size, 0);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("専用プロセスグループの子孫も停止する", { skip: process.platform === "win32" }, async () => {
    const registry = new ChildProcessRegistry();
    const child = spawn(process.execPath, ["test/process-descendant.ts"], {
        detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    registry.add(child, true);
    const pid = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    assert.ok(pid > 0);
    await registry.terminateAll();
    await assertProcessGone(pid);
});

test("メタデータ取得の時間切れでも専用プロセスグループを終了する", {
    skip: process.platform === "win32",
}, async () => {
    const result = await runBoundedProcess(process.execPath, ["test/process-descendant.ts"], {
        timeoutMs: 500,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        processGroup: true,
    });
    const pid = Number(result.stdout.trim());
    assert.ok(pid > 0);
    assert.notEqual(result.exitCode, 0);
    await assertProcessGone(pid);
});

test("親が先に終了しても標準出力を保持する子孫を終了する", {
    skip: process.platform === "win32",
}, async () => {
    const child = spawn(process.execPath, ["test/process-descendant.ts", "exit-parent"], {
        detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const pid = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    assert.ok(pid > 0);
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    assert.equal(child.stdout.destroyed, false);
    await terminateChild(child, true);
    assert.equal(child.stdout.destroyed, true);
    await assertProcessGone(pid);
});

test("メタデータ取得で親が先に終了しても子孫と出力を解放する", {
    skip: process.platform === "win32",
}, async () => {
    const result = await runBoundedProcess(process.execPath, ["test/process-descendant.ts", "exit-parent"], {
        timeoutMs: 2_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        processGroup: true,
    });
    assert.equal(result.exitCode, 0);
    const pid = Number(result.stdout.trim());
    assert.ok(pid > 0);
    await assertProcessGone(pid);
});

test("メタデータ用の子プロセス出力が上限を超えたら中止する", async () => {
    await assert.rejects(
        runBoundedProcess(
            process.execPath,
            ["-e", "process.stdout.write('x'.repeat(4096))"],
            { timeoutMs: 2_000, maxStdoutBytes: 512, maxStderrBytes: 512 },
        ),
        /上限/,
    );
});
