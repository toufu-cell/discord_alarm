import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Miniflare } from "miniflare";
import { loadConfig } from "../src/config.ts";
import { AlarmRepository } from "../src/database.ts";
import { exportSqliteForD1 } from "../src/export-sqlite.ts";
import { PlaybackController } from "../src/playback.ts";
import { RemoteRepository } from "../src/remote-repository.ts";
import { AlarmRuntime } from "../src/runtime.ts";
import { handleRepositoryRequest } from "../worker/repository-api.ts";
import { handleContainerOutbound } from "../worker/internal-route.ts";
import { handleManagementRequest } from "../worker/management.ts";
import type { Client } from "discord.js";
import type { BaseGuildVoiceChannel } from "discord.js";

function alarm(id: string, scheduledAtMs = 1_000) {
    return {
        id, scheduledAtMs, timeZone: "Asia/Tokyo", videoId: "BaW_jenozKc",
        videoUrl: "https://www.youtube.com/watch?v=BaW_jenozKc", videoTitle: "公開テスト動画",
        notificationChannelId: "333333333333333333", createdAtMs: 500,
    };
}

async function setup() {
    const mf = new Miniflare({
        workers: [{
            config: {
                name: "alarm-test",
                type: "worker",
                compatibilityDate: "2026-09-19",
                manifest: {
                    mainModule: "index.js",
                    modules: {
                        "index.js": { type: "esm", contents: "export default { fetch() { return new Response('ok'); } }" },
                    },
                },
                env: { ALARM_DB: { type: "d1", name: "alarm-test" } },
            },
        }],
    });
    const db = await mf.getD1Database("ALARM_DB", "alarm-test");
    await db.batch(readFileSync("migrations/0001_initial.sql", "utf8")
        .split(";").map((statement) => statement.trim()).filter(Boolean)
        .map((statement) => db.prepare(statement)));
    const call = async (op: string, args: unknown[] = [], version = "1") => {
        const response = await handleRepositoryRequest(new Request("http://alarm-d1.internal/v1/repository", {
            method: "POST", headers: { "x-alarm-api-version": version }, body: JSON.stringify({ op, args }),
        }), db);
        return { status: response.status, body: response.ok ? await response.json() as { result: any } : null };
    };
    return { mf, db, call };
}

test("D1の置換とスヌーズは失敗時に全体を戻し、古い版と二重claimを拒否する", async () => {
    const { mf, db, call } = await setup();
    try {
        const first = alarm("first");
        assert.equal((await call("replaceWaiting", [first, null])).body?.result.kind, "saved");
        const snapshot = { id: first.id, version: 1 };
        await db.prepare("CREATE TRIGGER reject_insert BEFORE INSERT ON alarms BEGIN SELECT RAISE(ABORT, 'blocked'); END").run();
        const second = { ...alarm("second"), videoId: "jNQXAC9IVRw" };
        assert.equal((await call("replaceWaiting", [second, snapshot])).status, 503);
        assert.equal((await call("getActive")).body?.result.id, first.id);
        assert.equal((await call("getLastVideo")).body?.result.videoId, first.videoId);
        await db.prepare("DROP TRIGGER reject_insert").run();
        assert.equal((await call("replaceWaiting", [second, snapshot])).body?.result.kind, "saved");
        assert.equal((await call("getLastVideo")).body?.result.videoId, second.videoId);
        assert.equal((await call("replaceWaiting", [alarm("third"), snapshot])).body?.result.kind, "stale");
        assert.equal((await call("claimDue", [1_000, 180_000])).body?.result.kind, "claimed");
        assert.equal((await call("claimDue", [1_000, 180_000])).body?.result.kind, "none");
        await db.prepare("CREATE TRIGGER reject_insert BEFORE INSERT ON alarms BEGIN SELECT RAISE(ABORT, 'blocked'); END").run();
        assert.equal((await call("snoozeRun", ["second", 301_000, 1_000, 3])).status, 503);
        assert.equal((await call("getActive")).body?.result.id, "second");
        await db.prepare("DROP TRIGGER reject_insert").run();
        assert.equal((await call("snoozeRun", ["second", 301_000, 1_000, 3])).body?.result.kind, "saved");
        assert.equal((await call("getActive")).body?.result.snoozeCount, 1);
        assert.equal((await call("snoozeRun", ["second", 301_000, 1_000, 3])).body?.result.kind, "stale");
    } finally { await mf.dispose(); }
});

test("D1変更後の応答喪失で再生を止め、復旧後に予約枠を使える", async () => {
    const { mf, call, db } = await setup();
    const nativeFetch = globalThis.fetch;
    try {
        assert.equal((await call("replaceWaiting", [alarm("lost"), null])).status, 200);
        let voiceConnections = 0;
        let runtime: AlarmRuntime;
        let uncertain = false;
        const repository = new RemoteRepository(() => {
            uncertain = true;
            void runtime.shutdown();
        });
        const client = {
            isReady: () => true,
            guilds: { fetch: async () => { throw new Error("Unexpected Discord access"); } },
            channels: { fetch: async () => null },
        } as unknown as Client;
        const config = loadConfig({
            DISCORD_TOKEN: "unused", DISCORD_APPLICATION_ID: "111111111111111111",
            DISCORD_GUILD_ID: "222222222222222222", DISCORD_OWNER_ID: "333333333333333333",
        });
        const playback = new PlaybackController<BaseGuildVoiceChannel>({
            createYouTube: () => { throw new Error("Unexpected media"); },
            createFallback: () => { throw new Error("Unexpected media"); },
        }, { connect: async () => { voiceConnections += 1; throw new Error("Unexpected voice"); } });
        runtime = new AlarmRuntime(client, config, repository, playback, () => 1_000);
        globalThis.fetch = async (input, init) => {
            const body = JSON.parse(String(init?.body)) as { op: string };
            const response = await handleRepositoryRequest(new Request(String(input), init), db);
            if (body.op === "claimDue") throw new Error("HTTP response lost");
            return response;
        };
        await runtime.start([]);
        assert.equal(uncertain, true);
        assert.equal(voiceConnections, 0);
        assert.equal((await call("getActive")).body?.result.status, "STARTING");
        globalThis.fetch = nativeFetch;
        assert.equal((await call("recoverInterrupted", [2_000])).body?.result[0].status, "INTERRUPTED");
        assert.equal((await call("replaceWaiting", [alarm("next", 500_000), null])).body?.result.kind, "saved");
        assert.equal((await call("getActive")).body?.result.id, "next");
    } finally {
        globalThis.fetch = nativeFetch;
        await mf.dispose();
    }
});

test("再生開始のD1応答が失われた場合は音声を止めて復旧する", async () => {
    const { mf, db, call } = await setup();
    const nativeFetch = globalThis.fetch;
    try {
        assert.equal((await call("replaceWaiting", [alarm("before-audio"), null])).status, 200);
        assert.equal((await call("claimDue", [1_000, 180_000])).body?.result.kind, "claimed");
        let played = 0;
        let stopped = false;
        const stream = new PassThrough();
        let finishSource!: () => void;
        const sourceDone = new Promise<void>((resolve) => { finishSource = resolve; });
        let playback!: PlaybackController<null>;
        const repository = new RemoteRepository(() => {
            playback.requestStop("before-audio", "PROCESS_SHUTDOWN");
        });
        playback = new PlaybackController<null>({
            createYouTube: () => ({
                kind: "youtube", stream, done: sourceDone,
                stop: async () => { stream.destroy(); finishSource(); },
            }),
            createFallback: () => { throw new Error("Unexpected fallback"); },
        }, { connect: async () => ({
            play: (_source, signal) => {
                played += 1;
                return {
                    started: Promise.resolve(),
                    done: new Promise<void>((resolve) => {
                        signal.addEventListener("abort", () => resolve(), { once: true });
                    }),
                };
            },
            stop: () => { stopped = true; },
            close: async () => undefined,
        }) });
        globalThis.fetch = async (input, init) => {
            const body = JSON.parse(String(init?.body)) as { op: string };
            const response = await handleRepositoryRequest(new Request(String(input), init), db);
            if (body.op === "markPlaying") throw new Error("HTTP response lost");
            return response;
        };
        await playback.start({
            runId: "before-audio", mode: "alarm", channel: null,
            videoUrl: alarm("before-audio").videoUrl, durationMs: 1_000,
            onStarted: async () => {
                const saved = await repository.markPlaying("before-audio", 1_000);
                assert.ok(saved);
            },
        });
        assert.equal(played, 1);
        assert.equal(stopped, true);
        assert.equal((await call("getActive")).body?.result.status, "PLAYING");
        assert.equal((await call("recoverInterrupted", [2_000])).body?.result[0].status, "INTERRUPTED");
        assert.equal((await call("replaceWaiting", [alarm("next", 500_000), null])).body?.result.kind, "saved");
    } finally {
        globalThis.fetch = nativeFetch;
        await mf.dispose();
    }
});

test("内部APIは版・宛先・操作を検証する", async () => {
    const { mf, call, db } = await setup();
    try {
        assert.equal((await call("getActive", [], "2")).status, 409);
        assert.equal((await call("executeSql", ["DELETE FROM alarms"])).status, 400);
        const publicRequest = new Request("https://example.com/v1/repository", { method: "POST" });
        assert.equal((await handleRepositoryRequest(publicRequest, db)).status, 404);
        const internalRequest = new Request("http://alarm-d1.internal/v1/repository", {
            method: "POST", headers: { "x-alarm-api-version": "1" }, body: JSON.stringify({ op: "getActive", args: [] }),
        });
        assert.equal((await handleContainerOutbound(internalRequest, db, "other", "alarm")).status, 403);
        assert.equal((await handleContainerOutbound(internalRequest, db, "alarm", "alarm")).status, 200);
    } finally { await mf.dispose(); }
});

test("公開管理APIは認証と許可した操作だけを受け付け、statusは起動しない", async () => {
    const token = "1234567890abcdef";
    const calls: string[] = [];
    const service = () => ({
        startService: async () => { calls.push("start"); return { enabled: true, status: "healthy" }; },
        stopService: async () => { calls.push("stop"); return { enabled: false, status: "stopped" }; },
        statusService: async () => { calls.push("status"); return { enabled: false, status: "stopped" }; },
    });
    const request = (path: string, method = "GET", authorization = token, origin?: string) => new Request(
        `https://alarm.example${path}`, {
            method,
            headers: { authorization: `Bearer ${authorization}`, ...(origin ? { origin } : {}) },
        },
    );
    assert.equal((await handleManagementRequest(request("/v1/repository"), token, service)).status, 404);
    assert.equal((await handleManagementRequest(request("/api/bot/start", "GET"), token, service)).status, 405);
    assert.equal((await handleManagementRequest(request("/api/bot/start", "POST", "wrong"), token, service)).status, 401);
    assert.equal((await handleManagementRequest(request("/api/bot/start", "POST", token, "https://other.example"), token, service)).status, 403);
    assert.equal((await handleManagementRequest(request("/api/bot/status"), token, service)).status, 200);
    assert.deepEqual(calls, ["status"]);
    assert.equal((await handleManagementRequest(request("/api/bot/stop", "POST"), token, service)).status, 200);
    assert.deepEqual(calls, ["status", "stop"]);
});

test("停止後のSQLiteを書き換えずD1へ予約と曲を移すSQLを作る", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alarm-export-"));
    const source = join(directory, "source.sqlite");
    const output = join(directory, "import.sql");
    const repository = new AlarmRepository(source);
    const item = { ...alarm("old", 500_000), videoTitle: "O'Clock" };
    repository.replaceWaiting(item, null);
    repository.close();
    const before = readFileSync(source);
    assert.deepEqual(exportSqliteForD1(source, output), { alarms: 1, settings: 1 });
    assert.deepEqual(readFileSync(source), before);
    assert.throws(() => exportSqliteForD1(source, output), /EEXIST/);
    const { mf, db, call } = await setup();
    try {
        await db.batch(readFileSync(output, "utf8").split("\n").filter((line) => line.startsWith("INSERT"))
            .map((line) => db.prepare(line)));
        assert.equal((await call("getActive")).body?.result.videoTitle, item.videoTitle);
        assert.equal((await call("getLastVideo")).body?.result.videoTitle, item.videoTitle);
    } finally { await mf.dispose(); }
});
