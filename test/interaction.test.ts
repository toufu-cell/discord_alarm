import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Interaction } from "discord.js";
import { loadConfig } from "../src/config.ts";
import { AlarmRepository } from "../src/database.ts";
import { AlarmInteractionHandler, type AlarmOperations } from "../src/interaction-handler.ts";
import type { VideoChoice } from "../src/domain.ts";
import type { AlarmStore } from "../src/repository.ts";

const guildId = "111111111111111111";
const ownerId = "222222222222222222";
const channelId = "333333333333333333";
const video: VideoChoice = {
    videoId: "BaW_jenozKc",
    videoUrl: "https://www.youtube.com/watch?v=BaW_jenozKc",
    videoTitle: "公開テスト動画",
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => { resolve = complete; });
    return { promise, resolve };
}

function withStoreMethods(repository: AlarmRepository, overrides: Partial<AlarmStore>): AlarmStore {
    return new Proxy(repository, {
        get(target, property) {
            if (property in overrides) return Reflect.get(overrides, property);
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

function command(options: {
    guild?: string;
    user?: string;
    subcommand?: string;
    time?: string;
    url?: string | null;
} = {}) {
    const responses: Array<{ content: string; components?: Array<{ components: Array<{ data: { custom_id: string } }> }> }> = [];
    let deferred = false;
    let replied = false;
    const interaction = {
        guildId: options.guild ?? guildId,
        user: { id: options.user ?? ownerId },
        commandName: "alarm",
        channelId,
        get deferred() { return deferred; },
        get replied() { return replied; },
        isChatInputCommand: () => true,
        isButton: () => false,
        options: {
            getSubcommand: () => options.subcommand ?? "set",
            getString: (name: string) => name === "time"
                ? options.time ?? "07:30"
                : options.url ?? null,
        },
        deferReply: async () => { deferred = true; },
        editReply: async (payload: { content: string; components?: unknown[] }) => {
            responses.push(payload as typeof responses[number]);
            replied = true;
        },
        reply: async (payload: { content: string }) => { responses.push(payload); replied = true; },
        followUp: async (payload: { content: string }) => { responses.push(payload); },
    };
    return { interaction: interaction as unknown as Interaction, responses, get deferred() { return deferred; } };
}

function button(customId: string, options: { guild?: string; user?: string } = {}) {
    const responses: Array<{ content: string }> = [];
    let deferredReply = false;
    let replied = false;
    const interaction = {
        guildId: options.guild ?? guildId,
        user: { id: options.user ?? ownerId },
        customId,
        get deferred() { return deferredReply; },
        get replied() { return replied; },
        isChatInputCommand: () => false,
        isButton: () => true,
        deferReply: async () => { deferredReply = true; },
        editReply: async (payload: { content: string }) => { responses.push(payload); replied = true; },
        reply: async (payload: { content: string }) => { responses.push(payload); replied = true; },
    };
    return { interaction: interaction as unknown as Interaction, responses, get deferred() { return deferredReply; } };
}

function makeHandler(
    now: () => number,
    probe: () => Promise<VideoChoice>,
    operations: AlarmOperations,
    store: (repository: AlarmRepository) => AlarmStore = (repository) => repository,
) {
    const path = join(mkdtempSync(join(tmpdir(), "alarm-handler-")), "alarm.sqlite");
    const repository = new AlarmRepository(path);
    const config = loadConfig({
        DISCORD_TOKEN: "unused",
        DISCORD_APPLICATION_ID: "444444444444444444",
        DISCORD_GUILD_ID: guildId,
        DISCORD_OWNER_ID: ownerId,
    });
    const handler = new AlarmInteractionHandler(config, store(repository), { probe }, operations, now);
    return { handler, repository };
}

const idleOperations: AlarmOperations = {
    activeAudioMode: null,
    activeRunId: null,
    startPreview: async () => ({ kind: "no-voice" }),
    stop: async () => false,
    snooze: async () => ({ kind: "stale" }),
};

test("ハンドラーが他人と別サーバーのコマンド・ボタンを作用前に拒否する", async () => {
    let probes = 0;
    let stops = 0;
    const { handler, repository } = makeHandler(
        () => Date.parse("2026-09-19T14:00:00Z"),
        async () => { probes += 1; return video; },
        { ...idleOperations, stop: async () => { stops += 1; return true; } },
    );
    for (const interaction of [
        command({ user: "999999999999999999", url: video.videoUrl }),
        command({ guild: "999999999999999999", url: video.videoUrl }),
        button("alarm:stop:example", { user: "999999999999999999" }),
        button("alarm:stop:example", { guild: "999999999999999999" }),
    ]) {
        await handler.handle(interaction.interaction);
        assert.match(interaction.responses[0]?.content ?? "", /本人とサーバー/);
    }
    assert.equal(probes, 0);
    assert.equal(stops, 0);
    assert.equal(repository.getActive(), null);
    repository.close();
});

test("確認後に登録し、古い確認ボタンと元予約の変更を拒否する", async () => {
    let clock = Date.parse("2026-09-19T14:00:00Z");
    const { handler, repository } = makeHandler(() => clock, async () => video, idleOperations);
    const first = command({ url: video.videoUrl });
    const other = command({ url: video.videoUrl });
    await handler.handle(first.interaction);
    await handler.handle(other.interaction);
    const firstToken = first.responses[0]?.components?.[0]?.components?.[0]?.data.custom_id;
    const otherToken = other.responses[0]?.components?.[0]?.components?.[0]?.data.custom_id;
    assert.ok(firstToken);
    assert.ok(otherToken);
    await handler.handle(button(firstToken).interaction);
    const saved = repository.getActive();
    assert.ok(saved);
    const stale = button(otherToken);
    await handler.handle(stale.interaction);
    assert.match(stale.responses[0]?.content ?? "", /別の操作で変更/);
    assert.equal(repository.getActive()?.id, saved.id);
    const expired = command({ url: video.videoUrl });
    await handler.handle(expired.interaction);
    const expiredId = expired.responses[0]?.components?.[0]?.components?.[0]?.data.custom_id;
    assert.ok(expiredId);
    clock += 121_000;
    const expiredButton = button(expiredId);
    await handler.handle(expiredButton.interaction);
    assert.match(expiredButton.responses[0]?.content ?? "", /期限切れ/);
    repository.close();
});

test("登録コマンドと確認ボタンはDB応答待ちの前に受付を返す", async () => {
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    const replaceStarted = deferred<void>();
    const releaseReplace = deferred<void>();
    const { handler, repository } = makeHandler(
        () => Date.parse("2026-09-19T14:00:00Z"), async () => video, idleOperations,
        (original) => withStoreMethods(original, {
            getActive: async () => {
                readStarted.resolve();
                await releaseRead.promise;
                return original.getActive();
            },
            replaceWaiting: async (input, expected) => {
                replaceStarted.resolve();
                await releaseReplace.promise;
                return original.replaceWaiting(input, expected);
            },
        }),
    );
    const set = command({ url: video.videoUrl });
    const setting = handler.handle(set.interaction);
    await readStarted.promise;
    assert.equal(set.deferred, true);
    assert.equal(set.responses.length, 0);
    releaseRead.resolve();
    await setting;
    const buttonId = set.responses[0]?.components?.[0]?.components?.[0]?.data.custom_id;
    assert.ok(buttonId);

    const confirm = button(buttonId);
    const confirming = handler.handle(confirm.interaction);
    await replaceStarted.promise;
    assert.equal(confirm.deferred, true);
    assert.equal(confirm.responses.length, 0);
    releaseReplace.resolve();
    await confirming;
    assert.match(confirm.responses[0]?.content ?? "", /予約しました/);
    assert.equal(repository.getActive()?.status, "WAITING");
    repository.close();
});

test("確認中に予定時刻を過ぎると次回日時を提示して再確認する", async () => {
    let clock = Date.parse("2026-09-18T22:29:30Z");
    const { handler, repository } = makeHandler(() => clock, async () => video, idleOperations);
    const pending = command({ url: video.videoUrl });
    await handler.handle(pending.interaction);
    const firstId = pending.responses[0]?.components?.[0]?.components?.[0]?.data.custom_id;
    assert.ok(firstId);
    clock += 60_000;
    const reschedule = button(firstId);
    await handler.handle(reschedule.interaction);
    assert.match(reschedule.responses[0]?.content ?? "", /次の日時/);
    assert.equal(repository.getActive(), null);
    const replacement = reschedule.responses[0] as { components?: Array<{
        components: Array<{ data: { custom_id: string } }>;
    }> };
    const nextId = replacement.components?.[0]?.components?.[0]?.data.custom_id;
    assert.ok(nextId);
    await handler.handle(button(nextId).interaction);
    assert.ok(repository.getActive()!.scheduledAtMs > clock);
    repository.close();
});

test("待機中の予約があっても試聴は停止コマンドで終了する", async () => {
    let stoppedRunId: string | null = null;
    const { handler, repository } = makeHandler(
        () => 1_000,
        async () => video,
        {
            ...idleOperations,
            activeAudioMode: "preview",
            stop: async (runId) => { stoppedRunId = runId; return true; },
        },
    );
    repository.replaceWaiting({
        ...video,
        id: "waiting-1",
        scheduledAtMs: 50_000,
        timeZone: "Asia/Tokyo",
        notificationChannelId: channelId,
        createdAtMs: 1_000,
    }, null);
    const interaction = command({ subcommand: "stop" });
    await handler.handle(interaction.interaction);
    assert.equal(stoppedRunId, "preview");
    assert.match(interaction.responses[0]?.content ?? "", /停止を受け付け/);
    repository.close();
});
