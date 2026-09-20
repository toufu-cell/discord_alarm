import { Client, Events, GatewayIntentBits } from "discord.js";
import { createServer, type Server } from "node:http";
import { type Server as SocketServer } from "node:net";
import { loadConfig } from "./config.ts";
import { AlarmRepository } from "./database.ts";
import type { AlarmStore } from "./repository.ts";
import { RemoteMutationUncertainError, RemoteRepository } from "./remote-repository.ts";
import { AlarmInteractionHandler } from "./interaction-handler.ts";
import { FfmpegMediaFactory } from "./media.ts";
import { PlaybackController } from "./playback.ts";
import { ProcessLock } from "./process-lock.ts";
import { AlarmRuntime } from "./runtime.ts";
import { DiscordVoiceConnector } from "./voice.ts";
import { YtDlpClient } from "./youtube.ts";
import { controlPath, removeControl, startControl, type ControlRequest, type ControlResponse } from "./local-control.ts";

const config = loadConfig();
const processLock = ProcessLock.acquire(config.lockPath);
let repository: AlarmStore | null = null;
let runtime: AlarmRuntime | null = null;
let client: Client | null = null;
let healthServer: Server | null = null;
let controlServer: SocketServer | null = null;
const localControlPath = controlPath(config.databasePath);
let controlSessions = 0;
let discordOperations = 0;
let confirmationsAwaitingReply = 0;
let idleTimer: NodeJS.Timeout | null = null;
let idleDueAt = Infinity;
let preReadyRetryAt = 0;
let clientReady = false;
let controlReady = false;
let receivedControl = !process.argv.includes("--await-confirm");
const awaitConfirmDeadline = Date.now() + (process.env.NODE_ENV === "test"
    ? Number(process.env.ALARM_TEST_CONFIRM_DEADLINE_MS ?? "20000") : 20_000);
let exitRequested = false;
let shuttingDown = false;
let remoteUncertain = false;

function failClosed(): void {
    if (remoteUncertain) return;
    remoteUncertain = true;
    void runtime?.shutdown();
    const timer = setTimeout(() => void shutdown(1), 3_000);
    timer.unref();
}

async function shutdown(exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) clearTimeout(idleTimer);
    try {
        await runtime?.shutdown();
    } finally {
        try {
            healthServer?.close();
            if (controlServer) {
                controlServer.close();
                removeControl(localControlPath);
            }
            client?.destroy();
        } finally {
            try {
                await repository?.close();
            } finally {
                processLock.release();
                process.exitCode = exitCode;
            }
        }
    }
}

function scheduleIdle(): void {
    if (process.env.ALARM_REMOTE_D1 === "1" || shuttingDown
        || (clientReady && !controlReady && !exitRequested)) return;
    const idleAt = receivedControl || exitRequested ? Date.now() + 300 : awaitConfirmDeadline;
    const dueAt = controlReady ? idleAt : Math.max(idleAt, preReadyRetryAt);
    if (idleTimer && idleDueAt <= dueAt) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleDueAt = dueAt;
    idleTimer = setTimeout(() => void checkIdle(), Math.max(0, dueAt - Date.now()));
}

async function checkIdle(): Promise<void> {
    idleTimer = null;
    idleDueAt = Infinity;
    if (shuttingDown) return;
    if (exitRequested && controlSessions === 0 && discordOperations === 0) {
        await shutdown(0);
        return;
    }
    if (exitRequested) {
        scheduleIdle();
        return;
    }
    if (!controlReady) {
        if (!receivedControl && Date.now() < awaitConfirmDeadline) {
            scheduleIdle();
            return;
        }
        if (controlSessions > 0 || discordOperations > 0) {
            preReadyRetryAt = Date.now() + 300;
            scheduleIdle();
            return;
        }
        try {
            const active = await repository?.getActive();
            if (clientReady || shuttingDown) return;
            if (!active) await shutdown(0);
            else {
                preReadyRetryAt = Date.now() + 5_000;
                scheduleIdle();
            }
        } catch {
            console.error("接続待ちの予約確認に失敗しました。");
            await shutdown(1);
        }
        return;
    }
    if (!receivedControl && Date.now() >= awaitConfirmDeadline) receivedControl = true;
    if (!receivedControl || controlSessions > 0 || discordOperations > 0 || !runtime?.isIdle) {
        scheduleIdle();
        return;
    }
    try {
        const active = await repository?.getActive();
        if (active || controlSessions > 0 || discordOperations > 0 || !runtime?.isIdle) return;
        await shutdown(0);
    } catch {
        console.error("自動終了の判定に失敗しました。");
        scheduleIdle();
    }
}

async function handleControl(request: ControlRequest): Promise<ControlResponse> {
    if (request.action !== "status" && request.action !== "result"
        && (controlReady || request.action === "cancel" || request.action === "exit")) {
        receivedControl = true;
        if (!controlReady) preReadyRetryAt = 0;
    }
    const store = repository!;
    const running = { running: true, connected: runtime!.isConnected };
    if (shuttingDown) return { ok: false, code: "unavailable", ...running };
    if (request.action === "result") {
        if (!(store instanceof AlarmRepository)) return { ok: false, code: "unsupported", ...running };
        const operation = store.getOperation(request.operationId);
        if (!operation) return { ok: false, code: "missing_result", ...running };
        if (operation.result === null) return { ok: false, code: "result_unknown", ...running,
            operationId: request.operationId };
        return operation.result as ControlResponse;
    }
    switch (request.action) {
        case "status":
            return { ok: true, code: controlReady ? "ok" : "starting", ...running,
                exiting: exitRequested,
                active: await store.getActive(), latest: await store.getLatestResult(),
                audio: { mode: runtime!.activeAudioMode, runId: runtime!.activeRunId } };
        case "confirm": {
            if (exitRequested) return { ok: false, code: "exiting", ...running, accepted: false };
            if (!controlReady) return { ok: false, code: "starting", ...running,
                saved: false, accepted: false };
            if (!(store instanceof AlarmRepository)) return { ok: false, code: "unsupported", ...running };
            confirmationsAwaitingReply += 1;
            let result;
            try {
                result = store.confirmProposal(request.proposalId, Date.now());
            } catch (error) {
                confirmationsAwaitingReply -= 1;
                throw error;
            }
            if (result.kind === "saved" || result.kind === "replayed") {
                if (result.kind === "saved") runtime!.notifyReservation(result.alarm);
                return { ok: true, code: result.kind, ...running, saved: true, accepted: true,
                    alarm: result.alarm };
            }
            confirmationsAwaitingReply -= 1;
            return { ok: false, code: result.kind, ...running, saved: false, accepted: false,
                active: result.kind === "stale" || result.kind === "busy" ? result.current : undefined };
        }
        case "cancel":
        case "stop":
        case "snooze":
        case "exit": {
            if (!(store instanceof AlarmRepository)) return { ok: false, code: "unsupported", ...running };
            const targetId = request.action === "exit" ? "bot" : request.targetId;
            const previous = store.getOperation(request.operationId);
            if (previous) {
                if (previous.action !== request.action || previous.targetId !== targetId) {
                    return { ok: false, code: "operation_conflict", ...running,
                        operationId: request.operationId, accepted: false };
                }
                if (previous.result !== null) return previous.result as ControlResponse;
                return { ok: false, code: "result_unknown", ...running,
                    operationId: request.operationId, accepted: true };
            }
            if (exitRequested) return { ok: false, code: "exiting", ...running, accepted: false };
            if (!controlReady && request.action !== "cancel" && request.action !== "exit") {
                return { ok: false, code: "starting", ...running, accepted: false };
            }
            if (request.action === "exit" && confirmationsAwaitingReply > 0) {
                return { ok: false, code: "busy", ...running, accepted: false };
            }
            const begun = store.beginOperation(request.operationId, request.action, targetId);
            if (begun.kind !== "new") return { ok: false, code: "result_unknown", ...running,
                operationId: request.operationId, accepted: begun.kind !== "conflict" };
            if (request.action === "exit") {
                exitRequested = true;
                runtime!.setConnected(false);
            }
            let response: ControlResponse;
            try {
                if (request.action === "cancel") {
                    const alarm = store.cancelWaitingTarget(targetId, Date.now());
                    response = { ok: Boolean(alarm), code: alarm ? "cancelled" : "no_waiting", ...running, alarm };
                } else if (request.action === "stop") {
                    const stopped = await runtime!.stop(targetId);
                    response = { ok: stopped, code: stopped ? "stopped" : "no_audio", ...running,
                        active: await store.getActive() };
                } else if (request.action === "snooze") {
                    const result = await runtime!.snooze(targetId);
                    response = { ok: result.kind === "saved", code: result.kind, ...running,
                        active: await store.getActive() };
                } else {
                    const active = await store.getActive();
                    response = { ok: true, code: "exiting", ...running,
                        active, paused: active?.status === "WAITING" };
                }
            } catch {
                response = { ok: false, code: "result_unknown", ...running };
            }
            response = { ...response, operationId: request.operationId, accepted: true };
            store.completeOperation(request.operationId, response);
            return response;
        }
        default:
            return { ok: false, code: "invalid_input", ...running };
    }
}

try {
    repository = process.env.ALARM_REMOTE_D1 === "1"
        ? new RemoteRepository(failClosed) : new AlarmRepository(config.databasePath);
    // 起動時の中断処理は排他ロックを取得した後にだけ実行する。
    const interrupted = await repository.recoverInterrupted(Date.now());
    client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
        allowedMentions: { parse: [] },
    });
    const fakeGateway = process.env.NODE_ENV === "test" && process.env.ALARM_TEST_GATEWAY === "1";
    const playback = fakeGateway
        ? (await import("../test/fake-discord.ts")).attachFakeDiscord(client)
        : new PlaybackController(new FfmpegMediaFactory(
            config.ytDlpPath, config.ffmpegPath, config.volumePercent, config.mediaTimeoutMs,
        ), new DiscordVoiceConnector());
    runtime = new AlarmRuntime(client, config, repository, playback, Date.now, scheduleIdle);
    const handler = new AlarmInteractionHandler(
        config,
        repository,
        new YtDlpClient(config.ytDlpPath, config.mediaTimeoutMs),
        runtime,
    );

    client.on(Events.InteractionCreate, async (interaction) => {
        discordOperations += 1;
        try {
            if (remoteUncertain) throw new RemoteMutationUncertainError();
            if (exitRequested) throw new Error("Botの終了処理中です。");
            await handler.handle(interaction);
        } catch (error) {
            console.error("Discord操作の処理に失敗しました。");
            if (interaction.isRepliable()) {
                const content = exitRequested ? "Botの終了処理中です。"
                    : error instanceof RemoteMutationUncertainError
                    ? error.message
                    : "操作を完了できませんでした。`/alarm show`で状態を確認してください。";
                const payload = {
                    content,
                    flags: 64,
                    allowedMentions: { parse: [] },
                } as const;
                if (interaction.deferred && !interaction.replied) {
                    await interaction.editReply({ content, allowedMentions: { parse: [] } }).catch(() => undefined);
                } else if (!interaction.replied) {
                    await interaction.reply(payload).catch(() => undefined);
                }
            }
        } finally {
            discordOperations -= 1;
            scheduleIdle();
        }
    });
    client.once(Events.ClientReady, async (readyClient) => {
        if (shuttingDown || exitRequested) return;
        clientReady = true;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        idleDueAt = Infinity;
        console.log(`Botを起動しました: ${readyClient.user.id}`);
        try {
            await runtime!.start(interrupted);
            if (shuttingDown || exitRequested) return;
            controlReady = true;
            scheduleIdle();
            if (process.env.ALARM_REMOTE_D1 === "1") {
                healthServer = createServer((request, response) => {
                    response.writeHead(request.url === "/health" ? 200 : 404);
                    response.end();
                });
                await new Promise<void>((resolve, reject) => {
                    healthServer!.once("error", reject);
                    healthServer!.listen(8080, "0.0.0.0", resolve);
                });
            }
        } catch {
            console.error("起動時に予約を復旧できませんでした。");
            await shutdown(1);
        }
    });
    client.on(Events.ShardDisconnect, () => runtime!.setConnected(false));
    client.on(Events.ShardResume, () => {
        if (!exitRequested && !shuttingDown) runtime!.setConnected(true);
    });
    client.on(Events.ShardReady, () => {
        if (!exitRequested && !shuttingDown) runtime!.setConnected(true);
    });
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
        if (newState.guild.id !== config.guildId || newState.id !== config.ownerId
            || oldState.channelId === newState.channelId) return;
        discordOperations += 1;
        void runtime!.ownerVoiceChanged(newState.channelId).catch(() => {
            console.error("VCの移動による音声停止を完了できませんでした。");
        }).finally(() => {
            discordOperations -= 1;
            scheduleIdle();
        });
    });
    process.once("SIGINT", () => void shutdown(0));
    process.once("SIGTERM", () => void shutdown(0));
    if (process.env.ALARM_REMOTE_D1 !== "1") {
        controlServer = await startControl(localControlPath, handleControl, (request, response) => {
            if (request?.action === "confirm" && response?.ok && response.saved) {
                confirmationsAwaitingReply -= 1;
            }
            scheduleIdle();
        }, (delta) => {
            controlSessions += delta;
            scheduleIdle();
        });
    }
    scheduleIdle();
    if (fakeGateway) {
        if (process.env.ALARM_TEST_NO_READY !== "1") {
            queueMicrotask(() => client!.emit(Events.ClientReady, { user: { id: "test" } } as Client<true>));
        }
    } else {
        await client.login(config.discordToken);
    }
} catch {
    console.error("Botを起動できませんでした。接続情報と診断結果を確認してください。");
    await shutdown(1);
}
