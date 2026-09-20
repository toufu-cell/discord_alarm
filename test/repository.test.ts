import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AlarmRepository } from "../src/database.ts";
import { ProcessLock, ProcessLockError } from "../src/process-lock.ts";

const fixtureDirectory = mkdtempSync(join(tmpdir(), "discord-alarm-test-"));

function alarm(scheduledAtMs: number, id = randomUUID()) {
    return {
        id,
        scheduledAtMs,
        timeZone: "Asia/Tokyo",
        videoId: "BaW_jenozKc",
        videoUrl: "https://www.youtube.com/watch?v=BaW_jenozKc",
        videoTitle: "公開テスト動画",
        notificationChannelId: "123456789012345678",
        createdAtMs: 1_000,
    };
}

function rejectAlarmInserts(path: string): DatabaseSync {
    const database = new DatabaseSync(path);
    database.exec(`
        CREATE TRIGGER reject_alarm_insert BEFORE INSERT ON alarms
        BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END;
    `);
    return database;
}

test("予約置換と前回の曲を保存し、古い確認画面では予約を失わない", () => {
    const path = join(fixtureDirectory, "replace.sqlite");
    const repository = new AlarmRepository(path);
    const first = alarm(20_000);
    assert.equal(repository.replaceWaiting(first, null).kind, "saved");
    const original = repository.getActive()!;
    const replacement = {
        ...alarm(30_000),
        videoId: "jNQXAC9IVRw",
        videoUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        videoTitle: "変更後の動画",
    };
    const injector = rejectAlarmInserts(path);
    assert.throws(
        () => repository.replaceWaiting(replacement, { id: original.id, version: original.version }),
        /injected insert failure/,
    );
    assert.deepEqual(repository.getAlarm(first.id), original);
    assert.equal(repository.getActive()?.id, first.id);
    assert.equal(repository.getLastVideo()?.videoId, first.videoId);
    injector.exec("DROP TRIGGER reject_alarm_insert;");
    injector.close();

    assert.equal(repository.replaceWaiting(replacement, { id: original.id, version: original.version }).kind, "saved");
    assert.equal(repository.replaceWaiting(alarm(40_000), { id: original.id, version: original.version }).kind, "stale");
    assert.equal(repository.getActive()?.id, replacement.id);
    assert.equal(repository.getAlarm(first.id)?.stopReason, "REPLACED");
    assert.equal(repository.cancelWaiting(2_000)?.status, "CANCELLED");
    assert.equal(repository.getLastVideo()?.videoId, replacement.videoId);
    repository.close();
    const reopened = new AlarmRepository(path);
    assert.equal(reopened.getActive(), null);
    assert.equal(reopened.getLastVideo()?.videoTitle, replacement.videoTitle);
    reopened.close();
});

test("遅延180秒の前後と準備中・再生中の中断復旧", () => {
    for (const [delay, expected] of [[179_999, "claimed"], [180_000, "claimed"], [180_001, "skipped"]] as const) {
        const repository = new AlarmRepository(":memory:");
        const item = alarm(100_000);
        repository.replaceWaiting(item, null);
        const outcome = repository.claimDue(100_000 + delay, 180_000);
        assert.equal(outcome.kind, expected);
        if (outcome.kind === "claimed") {
            if (delay === 180_000) repository.markPlaying(item.id, 100_000 + delay);
            assert.deepEqual(repository.recoverInterrupted(400_000).map((record) => record.id), [item.id]);
            assert.equal(repository.getAlarm(item.id)?.status, "INTERRUPTED");
            assert.equal(repository.claimDue(400_001, 180_000).kind, "none");
        } else {
            assert.equal(repository.getAlarm(item.id)?.status, "SKIPPED");
        }
        repository.close();
    }
});

test("スヌーズを同一取引で保存し、回数を復元後も引き継ぐ", () => {
    const path = join(fixtureDirectory, "snooze.sqlite");
    const repository = new AlarmRepository(path);
    const item = alarm(10_000);
    repository.replaceWaiting(item, null);
    repository.claimDue(10_000, 180_000);
    repository.markPlaying(item.id, 10_000);
    const beforeFailure = repository.getAlarm(item.id);
    const injector = rejectAlarmInserts(path);
    assert.throws(() => repository.snoozeRun(item.id, 310_000, 10_000, 3), /injected insert failure/);
    assert.deepEqual(repository.getAlarm(item.id), beforeFailure);
    assert.equal(repository.getActive()?.id, item.id);
    assert.equal(repository.getLastVideo()?.videoId, item.videoId);
    injector.exec("DROP TRIGGER reject_alarm_insert;");
    injector.close();

    const outcome = repository.snoozeRun(item.id, 310_000, 10_000, 3);
    assert.equal(outcome.kind, "saved");
    if (outcome.kind === "saved") {
        assert.equal(outcome.alarm.snoozeCount, 1);
        assert.equal(repository.snoozeRun(item.id, 310_000, 10_000, 3).kind, "stale");
    }
    repository.close();
    const reopened = new AlarmRepository(path);
    assert.equal(reopened.getActive()?.snoozeCount, 1);
    assert.equal(reopened.getAlarm(item.id)?.stopReason, "SNOOZED");
    reopened.close();
});

test("独立プロセスを排他し、強制終了の後にロックを再取得できる", async () => {
    const path = join(fixtureDirectory, "singleton.sqlite");
    const child = spawn(process.execPath, [
        "--disable-warning=ExperimentalWarning",
        "test/lock-holder.ts",
        path,
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", (chunk: Buffer) => {
            assert.match(chunk.toString(), /LOCKED/);
            resolve();
        });
        child.once("exit", () => reject(new Error("ロック保持プロセスが先に終了しました。")));
    });
    assert.throws(() => ProcessLock.acquire(path), ProcessLockError);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    const next = ProcessLock.acquire(path);
    next.release();
    const again = ProcessLock.acquire(path);
    again.release();
});
