import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AlarmRepository } from "../src/database.ts";
import { controlPath, sendControl } from "../src/local-control.ts";
import { ProcessLock } from "../src/process-lock.ts";
import { explicitOccurrence } from "../src/time.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = join(root, "bin/alarm");
const channelId = "333333333333333333";
const video = {
    videoId: "jNQXAC9IVRw", videoUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    videoTitle: "公開テスト動画",
};

function fixture(validIds = false) {
    const directory = mkdtempSync(join(tmpdir(), "alarm-cli-"));
    const databasePath = join(directory, "alarm.sqlite");
    const repository = new AlarmRepository(databasePath);
    const seed = repository.replaceWaiting({
        id: "old", scheduledAtMs: Date.now() + 3_600_000,
        timeZone: "Asia/Tokyo", notificationChannelId: channelId,
        ...video, createdAtMs: Date.now(),
    }, null);
    assert.equal(seed.kind, "saved");
    repository.cancelWaiting(Date.now());
    repository.close();
    const env: NodeJS.ProcessEnv = { ...process.env, ALARM_DATABASE_PATH: databasePath,
        ALARM_NOTIFICATION_CHANNEL_ID: channelId, DISCORD_APPLICATION_ID: "",
        DISCORD_GUILD_ID: "", DISCORD_OWNER_ID: "", DISCORD_TOKEN: "test-token",
        NODE_ENV: "test", ALARM_TEST_GATEWAY: "1", PATH: "/nonexistent" };
    if (validIds) {
        env.DISCORD_APPLICATION_ID = "111111111111111111";
        env.DISCORD_GUILD_ID = "222222222222222222";
        env.DISCORD_OWNER_ID = "444444444444444444";
    }
    const cli = (...args: string[]) => {
        const result = spawnSync(executable, args, { cwd: directory, env, encoding: "utf8" });
        assert.equal(result.error, undefined);
        return { code: result.status, result: JSON.parse(result.stdout) as Record<string, unknown> };
    };
    return { directory, databasePath, env, cli,
        cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("期限内に状態が変わりませんでした。");
}

function proposal(repository: AlarmRepository, at = Date.now() + 86_400_000) {
    const id = randomUUID();
    const alarmId = randomUUID();
    repository.saveProposal({ id, expiresAtMs: Date.now() + 60_000,
        alarm: { id: alarmId, scheduledAtMs: at, timeZone: "Asia/Tokyo",
            notificationChannelId: channelId, ...video, createdAtMs: Date.now() }, expected: null });
    return { id, alarmId };
}

function asynchronousCli(env: NodeJS.ProcessEnv, ...args: string[]): Promise<{ code: number | null; result: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd: root, env });
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.once("error", reject);
        child.once("close", (code) => {
            try { resolve({ code, result: JSON.parse(stdout) as Record<string, unknown> }); }
            catch (error) { reject(error); }
        });
    });
}

async function startBot(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
    const child = spawn(process.execPath, [join(root, "src/index.ts"), "--await-confirm"], {
        cwd: root, env, stdio: "ignore",
    });
    await waitFor(async () => {
        try {
            return (await sendControl(controlPath(env.ALARM_DATABASE_PATH!), { action: "status" })).code === "ok";
        } catch { return false; }
    });
    return child;
}

function rawControl(path: string, payload: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(path);
        let data = "";
        socket.setTimeout(5_000, () => reject(new Error("IPC応答がありません。")));
        socket.once("error", reject);
        socket.once("connect", () => socket.write(payload));
        socket.on("data", (chunk: Buffer) => {
            data += chunk.toString();
            if (data.includes("\n")) {
                socket.destroy();
                resolve(JSON.parse(data.slice(0, data.indexOf("\n"))) as Record<string, unknown>);
            }
        });
    });
}

function fakeGatewayEvent(child: ChildProcess, event: "ClientReady" | "ShardReady" | "ShardResume") {
    return new Promise<void>((resolve, reject) => {
        const requestId = randomUUID();
        const timeout = setTimeout(() => finish(new Error("接続イベントの応答がありません。")), 3_000);
        const onMessage = (message: unknown) => {
            if ((message as { alarmTestEventDone?: string })?.alarmTestEventDone === requestId) finish();
        };
        const onClose = () => finish(new Error("接続イベントの前にBotが終了しました。"));
        const finish = (error?: Error) => {
            clearTimeout(timeout);
            child.off("message", onMessage);
            child.off("close", onClose);
            if (error) reject(error);
            else resolve();
        };
        child.on("message", onMessage);
        child.once("close", onClose);
        child.send({ alarmTestEvent: event, requestId }, (error) => {
            if (error) finish(error);
        });
    });
}

test("明示日付をタイムゾーンで解決し、CLIの確認案を別実行へ保持する", () => {
    const now = Date.now();
    const future = new Date(now + 2 * 86_400_000);
    const at = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(future).replace(" ", "T");
    assert.equal(explicitOccurrence(at, "Asia/Tokyo", now) > now, true);
    const fixtureData = fixture();
    try {
        const prepared = fixtureData.cli("prepare", "--at", at);
        assert.equal(prepared.code, 0);
        assert.equal(prepared.result.code, "prepared");
        const repository = new AlarmRepository(fixtureData.databasePath);
        const proposalId = prepared.result.proposalId as string;
        const missing = fixtureData.cli("confirm", proposalId);
        assert.equal(missing.code, 2);
        assert.equal(missing.result.code, "missing_configuration");
        const saved = repository.confirmProposal(proposalId, Date.now());
        assert.equal(saved.kind, "saved");
        const replay = repository.confirmProposal(proposalId, Date.now());
        assert.equal(replay.kind, "replayed");
        assert.equal("alarm" in saved && "alarm" in replay && saved.alarm.id, replay.alarm.id);
        repository.close();
    } finally {
        fixtureData.cleanup();
    }
});

test("確認中の予約変更と期限切れは古い予約案による置換を防ぐ", () => {
    const fixtureData = fixture();
    try {
        const repository = new AlarmRepository(fixtureData.databasePath);
        const at = Date.now() + 86_400_000;
        const proposal = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", expiresAtMs: Date.now() + 60_000,
            alarm: { id: "prepared", scheduledAtMs: at, timeZone: "Asia/Tokyo",
                notificationChannelId: channelId, ...video, createdAtMs: Date.now() }, expected: null };
        repository.saveProposal(proposal);
        repository.replaceWaiting({ ...proposal.alarm, id: "other" }, null);
        assert.equal(repository.confirmProposal(proposal.id, Date.now()).kind, "stale");
        repository.saveProposal({ ...proposal, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            expiresAtMs: Date.now() - 1 });
        assert.equal(repository.confirmProposal("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", Date.now()).kind,
            "expired");
        repository.saveProposal({ ...proposal, id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
            alarm: { ...proposal.alarm, id: "elapsed", scheduledAtMs: Date.now() - 1 } });
        assert.equal(repository.confirmProposal("dddddddd-dddd-dddd-dddd-dddddddddddd", Date.now()).kind,
            "elapsed");
        assert.equal(repository.getActive()?.id, "other");
        repository.close();
    } finally {
        fixtureData.cleanup();
    }
});

test("不正なDiscord IDと接続待ちを構造化して返す", () => {
    const f = fixture();
    const repository = new AlarmRepository(f.databasePath);
    const item = proposal(repository);
    repository.close();
    try {
        f.env.DISCORD_APPLICATION_ID = "invalid";
        f.env.DISCORD_GUILD_ID = "222222222222222222";
        f.env.DISCORD_OWNER_ID = "444444444444444444";
        const invalid = f.cli("confirm", item.id);
        assert.equal(invalid.result.code, "invalid_configuration");
        assert.deepEqual(invalid.result.invalidVariables, ["DISCORD_APPLICATION_ID"]);
        const lock = ProcessLock.acquire(`${f.databasePath}.process-lock`);
        try {
            const status = f.cli("status");
            assert.equal(status.result.code, "starting");
            assert.equal(status.result.running, true);
            assert.equal(status.result.connected, false);
        } finally { lock.release(); }
        const saved = new AlarmRepository(f.databasePath);
        assert.equal(saved.confirmProposal(item.id, Date.now()).kind, "saved");
        saved.close();
        const replay = f.cli("confirm", item.id);
        assert.equal(replay.result.code, "invalid_configuration");
        assert.equal(replay.result.saved, true);
        assert.deepEqual(replay.result.invalidVariables, ["DISCORD_APPLICATION_ID"]);
    } finally { f.cleanup(); }
});

test("停止中の待機予約はexitとstatusで保持と非稼働を示す", () => {
    const fixtureData = fixture();
    try {
        const repository = new AlarmRepository(fixtureData.databasePath);
        repository.replaceWaiting({ id: "paused", scheduledAtMs: Date.now() + 86_400_000,
            timeZone: "Asia/Tokyo", notificationChannelId: channelId,
            ...video, createdAtMs: Date.now() }, null);
        repository.close();
        const exit = fixtureData.cli("exit", "--operation-id", "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
        assert.equal(exit.code, 0);
        assert.equal(exit.result.code, "already_stopped");
        assert.equal(exit.result.paused, true);
        assert.equal((exit.result.active as { id: string }).id, "paused");
        const status = fixtureData.cli("status");
        assert.equal(status.result.running, false);
        assert.equal(status.result.paused, true);
    } finally {
        fixtureData.cleanup();
    }
});

test("保存直後に呼出元のプロセスグループが終了してもBot側プロセスと予約が残る", async () => {
    const fixtureData = fixture(true);
    const marker = join(fixtureData.directory, "confirmed.json");
    const repository = new AlarmRepository(fixtureData.databasePath);
    const proposalId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    repository.saveProposal({ id: proposalId, expiresAtMs: Date.now() + 60_000,
        alarm: { id: "retained", scheduledAtMs: Date.now() + 86_400_000,
            timeZone: "Asia/Tokyo", notificationChannelId: channelId,
            ...video, createdAtMs: Date.now() }, expected: null });
    repository.close();
    const caller = spawn(process.execPath, [join(root, "test/launch-caller.ts"),
        fixtureData.databasePath, marker, proposalId], {
        cwd: root, detached: true, stdio: "ignore", env: fixtureData.env,
    });
    caller.unref();
    let holderPid: number | null = null;
    try {
        const deadline = Date.now() + 5_000;
        while (!existsSync(marker) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(existsSync(marker), true);
        holderPid = (JSON.parse(readFileSync(marker, "utf8")) as { pid: number }).pid;
        process.kill(-caller.pid!, "SIGTERM");
        const replay = fixtureData.cli("confirm", proposalId);
        assert.equal(replay.code, 0);
        assert.equal(replay.result.code, "replayed");
        const response = await sendControl(controlPath(fixtureData.databasePath), { action: "status" });
        assert.equal(response.running, true);
        const inspect = new AlarmRepository(fixtureData.databasePath);
        assert.equal(inspect.getActive()?.id, "retained");
        inspect.close();
    } finally {
        if (holderPid) process.kill(holderPid, "SIGTERM");
        try { process.kill(-caller.pid!, "SIGTERM"); } catch {}
        fixtureData.cleanup();
    }
});

test("並行確定でもBotの起動は一度で、終了中の未受理確定は次のBotへ渡す", async () => {
    const f = fixture(true);
    const repository = new AlarmRepository(f.databasePath);
    const first = proposal(repository);
    repository.close();
    try {
        const results = await Promise.all([
            asynchronousCli(f.env, "confirm", first.id),
            asynchronousCli(f.env, "confirm", first.id),
        ]);
        assert.equal(results.every((item) => item.code === 0 && item.result.saved === true), true);
        const inspect = new AlarmRepository(f.databasePath);
        assert.equal(inspect.getActive()?.id, first.alarmId);
        inspect.close();
        const log = readFileSync(join(f.directory, "bot.log"), "utf8");
        assert.equal((log.match(/Botを起動しました/g) ?? []).length, 1);
        const exit = f.cli("exit", "--operation-id", randomUUID());
        assert.equal(exit.result.code, "exiting");
        await waitFor(() => f.cli("status").result.running === false);
        const repeat = f.cli("confirm", first.id);
        assert.equal(repeat.result.code, "replayed");
        assert.equal(repeat.result.saved, true);
        assert.equal(repeat.result.running, true);
        f.cli("exit", "--operation-id", randomUUID());
        await waitFor(() => f.cli("status").result.running === false);
    } finally { f.cleanup(); }
});

test("取消結果の再送は新しい予約へ作用せず、通知後に自動終了する", async () => {
    const f = fixture(true);
    const repository = new AlarmRepository(f.databasePath);
    repository.replaceWaiting({ id: "first", scheduledAtMs: Date.now() + 86_400_000,
        timeZone: "Asia/Tokyo", notificationChannelId: channelId,
        ...video, createdAtMs: Date.now() }, null);
    repository.close();
    try {
        assert.equal(f.cli("resume").code, 0);
        const status = f.cli("status").result;
        const operationId = status.operationId as string;
        assert.match(operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        assert.equal((status.active as { id: string }).id, "first");
        const cancelled = f.cli("cancel", "--operation-id", operationId, "--target-id", "first");
        assert.equal(cancelled.result.code, "cancelled");
        await waitFor(() => f.cli("status").result.running === false);
        const next = new AlarmRepository(f.databasePath);
        next.replaceWaiting({ id: "second", scheduledAtMs: Date.now() + 86_400_000,
            timeZone: "Asia/Tokyo", notificationChannelId: channelId,
            ...video, createdAtMs: Date.now() }, null);
        next.close();
        const replay = f.cli("cancel", "--operation-id", operationId, "--target-id", "first");
        assert.equal(replay.result.code, "cancelled");
        const fetched = f.cli("result", operationId);
        assert.equal(fetched.result.code, "cancelled");
        assert.deepEqual(fetched.result.current, { running: false, connected: false });
        const inspect = new AlarmRepository(f.databasePath);
        assert.equal(inspect.getActive()?.id, "second");
        inspect.close();
        const conflict = f.cli("cancel", "--operation-id", operationId, "--target-id", "second");
        assert.equal(conflict.result.code, "operation_conflict");
    } finally { f.cleanup(); }
});

test("接続前のBotは空なら期限で終了し、待機予約のexitとcancelを受け付ける", async () => {
    for (const action of ["empty", "exit", "cancel"] as const) {
        const f = fixture(true);
        f.env.ALARM_TEST_NO_READY = "1";
        f.env.ALARM_TEST_CONFIRM_DEADLINE_MS = "3000";
        let proposalId: string | null = null;
        if (action !== "empty") {
            const repository = new AlarmRepository(f.databasePath);
            repository.replaceWaiting({ id: "pending",
                scheduledAtMs: action === "exit" ? Date.now() - 500 : Date.now() + 86_400_000,
                timeZone: "Asia/Tokyo", notificationChannelId: channelId,
                ...video, createdAtMs: Date.now() }, null);
            repository.close();
        } else {
            const repository = new AlarmRepository(f.databasePath);
            proposalId = proposal(repository).id;
            repository.close();
        }
        const child = spawn(process.execPath, [join(root, "src/index.ts"), "--await-confirm"], {
            cwd: root, env: f.env, stdio: action === "exit"
                ? ["ignore", "ignore", "ignore", "ipc"] : "ignore",
        });
        let hold: ReturnType<typeof createConnection> | null = null;
        try {
            await waitFor(async () => {
                try { return (await sendControl(controlPath(f.databasePath), { action: "status" })).code === "starting"; }
                catch { return false; }
            });
            const starting = f.cli("status");
            assert.equal(starting.result.code, "starting");
            assert.equal(starting.result.running, true);
            assert.equal(starting.result.connected, false);
            if (action === "empty") {
                const rejected = await sendControl(controlPath(f.databasePath), {
                    action: "confirm", proposalId: proposalId!,
                });
                assert.equal(rejected.code, "starting");
                assert.equal(rejected.accepted, false);
                const stopped = f.cli("stop", "--operation-id", randomUUID(), "--target-id", "preview");
                assert.equal(stopped.code, 3);
                assert.equal(stopped.result.code, "starting");
                assert.equal(stopped.result.accepted, false);
                await waitFor(() => child.exitCode !== null, 6_000);
                assert.equal(child.exitCode, 0);
                assert.equal(f.cli("status").result.running, false);
            } else if (action === "exit") {
                await new Promise((resolve) => setTimeout(resolve, 3_400));
                assert.equal(child.exitCode, null);
                f.env.ALARM_TEST_READY_DEADLINE_MS = "900";
                const resume = f.cli("resume");
                assert.equal(resume.code, 3);
                assert.equal(resume.result.code, "start_failed");
                assert.equal(resume.result.running, true);
                hold = createConnection(controlPath(f.databasePath));
                await new Promise<void>((resolve, reject) => {
                    hold!.once("connect", resolve);
                    hold!.once("error", reject);
                });
                const exited = f.cli("exit", "--operation-id", randomUUID());
                assert.equal(exited.result.code, "exiting");
                assert.equal(exited.result.paused, true);
                for (const event of ["ShardReady", "ShardResume", "ClientReady"] as const) {
                    await fakeGatewayEvent(child, event);
                    const inspect = new AlarmRepository(f.databasePath);
                    assert.equal(inspect.getActive()?.status, "WAITING");
                    inspect.close();
                    const status = await sendControl(controlPath(f.databasePath), { action: "status" });
                    assert.equal(status.exiting, true);
                    assert.equal(status.connected, false);
                }
                hold.destroy();
                hold = null;
                child.disconnect();
                await waitFor(() => child.exitCode !== null);
                assert.equal(child.exitCode, 0);
            } else {
                const cancelled = f.cli("cancel", "--operation-id", randomUUID(), "--target-id", "pending");
                assert.equal(cancelled.result.code, "cancelled");
                assert.equal(cancelled.result.accepted, true);
                assert.equal(cancelled.result.running, true);
                await waitFor(() => child.exitCode !== null);
                assert.equal(child.exitCode, 0);
            }
        } finally {
            hold?.destroy();
            if (child.connected) child.disconnect();
            if (child.exitCode === null) {
                child.kill();
                await waitFor(() => child.exitCode !== null);
            }
            if (action !== "empty") {
                const repository = new AlarmRepository(f.databasePath);
                assert.equal(repository.getActive()?.id, action === "exit" ? "pending" : undefined);
                repository.close();
            }
            f.cleanup();
        }
    }
});

test("明示した通知先の案は環境変数なしで確定と再開ができる", async () => {
    const f = fixture(true);
    f.env.ALARM_NOTIFICATION_CHANNEL_ID = "";
    try {
        const missing = f.cli("prepare", "--time", "07:30");
        assert.equal(missing.result.code, "missing_configuration");
        const prepared = f.cli("prepare", "--time", "07:30", "--channel", channelId);
        assert.equal(prepared.result.code, "prepared");
        assert.equal((prepared.result.alarm as { notificationChannelId: string }).notificationChannelId, channelId);
        const confirmed = f.cli("confirm", prepared.result.proposalId as string);
        assert.equal(confirmed.result.saved, true);
        assert.equal(confirmed.result.running, true);
        f.cli("exit", "--operation-id", randomUUID());
        await waitFor(() => f.cli("status").result.running === false);
        const resumed = f.cli("resume");
        assert.equal(resumed.result.code, "running");
        assert.equal(resumed.result.running, true);
        f.cli("exit", "--operation-id", randomUUID());
        await waitFor(() => f.cli("status").result.running === false);
    } finally { f.cleanup(); }
});

test("終了中の確定は未受理となり、CLIは終了後に保存して起動する", async () => {
    const f = fixture(true);
    const repository = new AlarmRepository(f.databasePath);
    const item = proposal(repository);
    repository.close();
    const child = await startBot(f.env);
    try {
        const exiting = await sendControl(controlPath(f.databasePath), {
            action: "exit", operationId: randomUUID(),
        });
        assert.equal(exiting.code, "exiting");
        const rejected = await sendControl(controlPath(f.databasePath), {
            action: "confirm", proposalId: item.id,
        });
        assert.equal(rejected.code, "exiting");
        assert.equal(rejected.accepted, false);
        const confirmed = f.cli("confirm", item.id);
        assert.equal(confirmed.result.saved, true);
        assert.equal(confirmed.result.running, true);
        const inspect = new AlarmRepository(f.databasePath);
        assert.equal(inspect.getActive()?.id, item.alarmId);
        inspect.close();
        f.cli("exit", "--operation-id", randomUUID());
        await waitFor(() => f.cli("status").result.running === false);
    } finally {
        if (child.exitCode === null) child.kill();
        f.cleanup();
    }
});

test("終了済みの確定案を再送してもBotとアラームを再起動しない", async () => {
    const f = fixture(true);
    f.env.ALARM_TEST_VOICE = "none";
    const repository = new AlarmRepository(f.databasePath);
    const item = proposal(repository, Date.now() + 4_000);
    repository.close();
    try {
        const confirmed = f.cli("confirm", item.id);
        assert.equal(confirmed.result.saved, true);
        await waitFor(() => f.cli("status").result.running === false, 10_000);
        const before = readFileSync(join(f.directory, "bot.log"), "utf8");
        const replay = f.cli("confirm", item.id);
        assert.equal(replay.result.code, "replayed");
        assert.equal(replay.result.saved, true);
        assert.equal(replay.result.running, false);
        assert.equal(readFileSync(join(f.directory, "bot.log"), "utf8"), before);
    } finally { f.cleanup(); }
});

test("スキップと失敗は最後の通知後に自動終了する", async () => {
    for (const [mode, expectedStatus] of [["none", "SKIPPED"], ["invalid", "FAILED"]] as const) {
        const f = fixture(true);
        f.env.ALARM_TEST_VOICE = mode;
        f.env.ALARM_TEST_CONFIRM_DEADLINE_MS = "500";
        f.env.ALARM_TEST_NOTIFICATION_DELAY_MS = "600";
        f.env.ALARM_TEST_NOTIFICATION_FILE = join(f.directory, "notice.jsonl");
        f.env.ALARM_TEST_INTERACTION_DELAY_MS = "700";
        f.env.ALARM_TEST_INTERACTION_FILE = join(f.directory, "reply.txt");
        const repository = new AlarmRepository(f.databasePath);
        repository.replaceWaiting({ id: randomUUID(), scheduledAtMs: Date.now() - 500,
            timeZone: "Asia/Tokyo", notificationChannelId: channelId,
            ...video, createdAtMs: Date.now() - 1_000 }, null);
        repository.close();
        const child = spawn(process.execPath, [join(root, "src/index.ts"), "--await-confirm"], {
            cwd: root, env: f.env, stdio: "ignore",
        });
        try {
            await waitFor(() => child.exitCode !== null, 5_000);
            assert.equal(child.exitCode, 0);
            const inspect = new AlarmRepository(f.databasePath);
            assert.equal(inspect.getLatestResult()?.status, expectedStatus);
            inspect.close();
            assert.equal(readFileSync(f.env.ALARM_TEST_NOTIFICATION_FILE, "utf8").length > 0, true);
            assert.equal(readFileSync(f.env.ALARM_TEST_INTERACTION_FILE, "utf8")
                .includes("現在の予約はありません"), true);
        } finally {
            if (child.exitCode === null) child.kill();
            f.cleanup();
        }
    }
});

test("スヌーズ後は稼働を続け、停止後は通知を待って終了する", async () => {
    const f = fixture(true);
    f.env.ALARM_TEST_VOICE = "valid";
    f.env.ALARM_TEST_NOTIFICATION_DELAY_MS = "250";
    const noticePath = join(f.directory, "notifications.jsonl");
    f.env.ALARM_TEST_NOTIFICATION_FILE = noticePath;
    const repository = new AlarmRepository(f.databasePath);
    repository.replaceWaiting({ id: "playing-one", scheduledAtMs: Date.now() + 350,
        timeZone: "Asia/Tokyo", notificationChannelId: channelId,
        ...video, createdAtMs: Date.now() }, null);
    repository.close();
    try {
        await startBot(f.env);
        await waitFor(() => f.cli("status").result.audio != null
            && (f.cli("status").result.audio as { runId: string | null }).runId === "playing-one");
        const operationId = randomUUID();
        const snoozed = f.cli("snooze", "--operation-id", operationId, "--target-id", "playing-one");
        assert.equal(snoozed.result.code, "saved");
        const active = f.cli("status").result.active as { id: string; status: string };
        assert.equal(active.status, "WAITING");
        assert.equal(f.cli("status").result.running, true);
        const replay = f.cli("snooze", "--operation-id", operationId, "--target-id", "playing-one");
        assert.equal(replay.result.code, "saved");
        assert.equal((f.cli("status").result.active as { id: string }).id, active.id);
        const cancelled = f.cli("cancel", "--operation-id", randomUUID(), "--target-id", active.id);
        assert.equal(cancelled.result.code, "cancelled");
        await waitFor(() => f.cli("status").result.running === false);
        assert.equal(readFileSync(noticePath, "utf8").includes("アラームを再生しています"), true);
        const next = new AlarmRepository(f.databasePath);
        next.replaceWaiting({ id: "playing-two", scheduledAtMs: Date.now() + 350,
            timeZone: "Asia/Tokyo", notificationChannelId: channelId,
            ...video, createdAtMs: Date.now() }, null);
        next.close();
        await startBot(f.env);
        await waitFor(() => (f.cli("status").result.audio as { runId: string | null })?.runId === "playing-two");
        const stopId = randomUUID();
        const stopped = f.cli("stop", "--operation-id", stopId, "--target-id", "playing-two");
        assert.equal(stopped.result.code, "stopped");
        await waitFor(() => f.cli("status").result.running === false);
        const stopReplay = f.cli("stop", "--operation-id", stopId, "--target-id", "playing-two");
        assert.equal(stopReplay.result.code, "stopped");
        assert.deepEqual(stopReplay.result.current, { running: false, connected: false });
        assert.equal(readFileSync(noticePath, "utf8").split("\n").filter(Boolean).length >= 2, true);
    } finally { f.cleanup(); }
});

test("無送信のIPCは期限で閉じ、異常入力と応答前切断でもBotは正常終了する", async () => {
    const f = fixture(true);
    f.env.ALARM_TEST_CONFIRM_DEADLINE_MS = "500";
    const child = await startBot(f.env);
    const path = controlPath(f.databasePath);
    let silent: ReturnType<typeof createConnection> | null = null;
    try {
        assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
        assert.equal(statSync(path).mode & 0o777, 0o600);
        const socket = createConnection(path);
        silent = socket;
        await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
        });
        assert.equal((await rawControl(path, "{bad}\n")).code, "invalid_input");
        assert.equal((await rawControl(path, '{"action":"unknown"}\n')).code, "invalid_input");
        const repository = new AlarmRepository(f.databasePath);
        const item = proposal(repository);
        repository.close();
        await new Promise<void>((resolve, reject) => {
            const socket = createConnection(path);
            socket.once("error", reject);
            socket.once("connect", () => {
                socket.write(JSON.stringify({ action: "confirm", proposalId: item.id }) + "\n");
                socket.destroy();
                resolve();
            });
        });
        await waitFor(() => {
            const inspect = new AlarmRepository(f.databasePath);
            try { return Boolean(inspect.getProposalAlarm(item.id)); }
            finally { inspect.close(); }
        });
        assert.equal(f.cli("status").result.running, true);
        const cancelled = f.cli("cancel", "--operation-id", randomUUID(), "--target-id", item.alarmId);
        assert.equal(cancelled.result.code, "cancelled");
        await waitFor(() => child.exitCode !== null, 7_000);
        assert.equal(child.exitCode, 0);
    } finally {
        silent?.destroy();
        if (child.exitCode === null) child.kill();
        f.cleanup();
    }
});

test("確定が届かなかった空のBotは受付期限後に終了する", async () => {
    const f = fixture(true);
    f.env.ALARM_TEST_CONFIRM_DEADLINE_MS = "500";
    const child = await startBot(f.env);
    try {
        await waitFor(() => child.exitCode !== null, 5_000);
        assert.equal(child.exitCode, 0);
        assert.equal(f.cli("status").result.running, false);
    } finally {
        if (child.exitCode === null) child.kill();
        f.cleanup();
    }
});
