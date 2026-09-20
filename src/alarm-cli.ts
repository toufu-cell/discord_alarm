import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DiscordConfigurationError, discordConfigurationIssues, loadConfig, type AppConfig } from "./config.ts";
import { AlarmRepository } from "./database.ts";
import { ControlUnavailableError, ControlUnknownError, controlPath, sendControl,
    type ControlRequest, type ControlResponse } from "./local-control.ts";
import { prepareReservation } from "./reservation.ts";
import { YtDlpClient } from "./youtube.ts";
import { launchDetached as launchDetachedProcess } from "./launcher.ts";
import { ProcessLock } from "./process-lock.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let config: AppConfig;
let socketPath: string;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function output(value: unknown, exitCode = 0): void {
    process.stdout.write(JSON.stringify(value) + "\n");
    process.exitCode = exitCode;
}

function parseOptions(args: string[], allowed: string[]): Record<string, string> {
    const options: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index];
        const value = args[index + 1];
        if (!name?.startsWith("--") || !allowed.includes(name) || !value || value.startsWith("--")
            || name in options) throw new Error("引数を確認してください。");
        options[name] = value;
    }
    return options;
}

function openRepository(): AlarmRepository {
    return new AlarmRepository(config.databasePath);
}

async function maybeRunning(request: ControlRequest): Promise<ControlResponse | null> {
    try {
        return await sendControl(socketPath, request);
    } catch (error) {
        if (error instanceof ControlUnavailableError) return null;
        throw error;
    }
}

function launchBot(): number {
    const logPath = join(dirname(config.databasePath), "bot.log");
    return launchDetachedProcess(join(root, "src/index.ts"), logPath, root, ["--await-confirm"]);
}

async function ensureRunning(): Promise<ControlResponse> {
    const issues = discordConfigurationIssues(process.env);
    if (issues.missingVariables.length || issues.invalidVariables.length) {
        throw new DiscordConfigurationError(issues.missingVariables, issues.invalidVariables);
    }
    loadConfig(process.env, { cwd: root });
    const existing = await maybeRunning({ action: "status" });
    if (existing?.ok && existing.code === "ok" && !existing.exiting) return existing;
    const deadline = Date.now() + (process.env.NODE_ENV === "test"
        ? Number(process.env.ALARM_TEST_READY_DEADLINE_MS ?? "20000") : 20_000);
    let launchedPid: number | null = null;
    let nextLaunchAt = 0;
    while (Date.now() < deadline) {
        if (!ProcessLock.isHeld(config.lockPath) && Date.now() >= nextLaunchAt
            && (launchedPid === null || !isProcessAlive(launchedPid))) {
            launchedPid = launchBot();
            nextLaunchAt = Date.now() + 1_000;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        const response = await maybeRunning({ action: "status" });
        if (response?.ok && response.code === "ok" && !response.exiting) return response;
    }
    throw new ControlUnavailableError("Botの起動またはDiscord接続を確認できません。");
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function status(): Promise<void> {
    output({ ...await statusSnapshot(), operationId: randomUUID() });
}

async function statusSnapshot(): Promise<ControlResponse> {
    const online = await maybeRunning({ action: "status" });
    if (online) return online;
    const repository = openRepository();
    try {
        const active = repository.getActive();
        const running = ProcessLock.isHeld(config.lockPath);
        return { ok: true, code: running ? "starting" : "ok", running, connected: false,
            paused: active?.status === "WAITING", active, latest: repository.getLatestResult() };
    } finally {
        repository.close();
    }
}

function proposalAlarm(id: string) {
    const repository = openRepository();
    try { return repository.getProposalAlarm(id); } finally { repository.close(); }
}

async function waitForStop(): Promise<boolean> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (!(await statusSnapshot()).running) return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
}

async function main(): Promise<void> {
    const [action, ...args] = process.argv.slice(2);
    if (action === "prepare") {
        const options = parseOptions(args, ["--at", "--time", "--url", "--channel"]);
        const channelId = options["--channel"] ?? config.notificationChannelId;
        if (!channelId) throw new DiscordConfigurationError(["ALARM_NOTIFICATION_CHANNEL_ID"], []);
        if (!options["--channel"] && discordConfigurationIssues(process.env, true).invalidVariables
            .includes("ALARM_NOTIFICATION_CHANNEL_ID")) {
            throw new DiscordConfigurationError([], ["ALARM_NOTIFICATION_CHANNEL_ID"]);
        }
        const repository = openRepository();
        try {
            const prepared = await prepareReservation({
                at: options["--at"], time: options["--time"], url: options["--url"], channelId,
            }, config, repository, new YtDlpClient(config.ytDlpPath, config.mediaTimeoutMs), Date.now());
            const proposalId = randomUUID();
            const expiresAtMs = Date.now() + config.confirmationTtlMs;
            repository.saveProposal({ id: proposalId, expiresAtMs,
                alarm: prepared.alarm, expected: prepared.expected });
            output({ ok: true, code: "prepared", proposalId, expiresAtMs,
                alarm: prepared.alarm, previous: prepared.previous });
        } finally {
            repository.close();
        }
        return;
    }
    if (action === "confirm") {
        if (args.length !== 1 || !ID_PATTERN.test(args[0]!)) throw new Error("proposalIdを指定してください。");
        const proposalId = args[0]!;
        const already = proposalAlarm(proposalId);
        if (already) {
            const active = ["WAITING", "STARTING", "PLAYING"].includes(already.status);
            try {
                if (active) await ensureRunning();
                const state = await statusSnapshot();
                output({ ok: true, code: "replayed", saved: true, alarm: already,
                    running: state.running, connected: state.connected });
                return;
            } catch (error) {
                const state = await statusSnapshot();
                const configuration = error instanceof DiscordConfigurationError ? error : null;
                output({ ok: false, code: configuration
                    ? configuration.missingVariables.length ? "missing_configuration" : "invalid_configuration"
                    : "start_failed", saved: true, alarm: already,
                    running: state.running, connected: state.connected,
                    missingVariables: configuration?.missingVariables,
                    invalidVariables: configuration?.invalidVariables,
                    detail: error instanceof Error ? error.message : "Botを起動できませんでした。" },
                configuration ? 2 : 3);
                return;
            }
        }
        for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
                await ensureRunning();
            } catch (error) {
                const saved = proposalAlarm(proposalId);
                if (error instanceof DiscordConfigurationError) throw error;
                const state = await statusSnapshot();
                output({ ok: false, code: "start_failed", saved: Boolean(saved),
                    alarm: saved ?? undefined, running: state.running,
                    connected: state.connected }, 3);
                return;
            }
            let result: ControlResponse;
            try {
                result = await sendControl(socketPath, { action: "confirm", proposalId });
            } catch (error) {
                if (error instanceof ControlUnavailableError) {
                    if (attempt < 3) continue;
                    const saved = proposalAlarm(proposalId);
                    const state = await statusSnapshot();
                    output({ ok: false, code: "start_failed", saved: Boolean(saved),
                        alarm: saved ?? undefined, running: state.running,
                        connected: state.connected }, 3);
                    return;
                }
                if (error instanceof ControlUnknownError) {
                    const saved = proposalAlarm(proposalId);
                    const state = await statusSnapshot();
                    output({ ok: false, code: "result_unknown", saved: saved ? true : undefined,
                        alarm: saved ?? undefined, running: state.running, connected: state.connected,
                        check: "confirmを同じproposalIdで再実行してください。" }, 4);
                    return;
                }
                throw error;
            }
            if (result.code === "exiting" && result.accepted === false) {
                if (await waitForStop()) continue;
                const saved = proposalAlarm(proposalId);
                const state = await statusSnapshot();
                output({ ok: false, code: "start_failed", saved: Boolean(saved),
                    alarm: saved ?? undefined, running: state.running,
                    connected: state.connected }, 3);
                return;
            }
            if (result.code === "internal_error") {
                const saved = proposalAlarm(proposalId);
                output({ ...result, code: "result_unknown", saved: saved ? true : undefined,
                    alarm: saved ?? undefined }, 4);
                return;
            }
            output(result, result.ok ? 0 : 2);
            return;
        }
        const saved = proposalAlarm(proposalId);
        const state = await statusSnapshot();
        output({ ok: false, code: "start_failed", saved: Boolean(saved), alarm: saved,
            running: state.running, connected: state.connected }, 3);
        return;
    }
    if (action === "status") {
        if (args.length) throw new Error("statusに引数はありません。");
        await status();
        return;
    }
    if (action === "resume") {
        if (args.length) throw new Error("resumeに引数はありません。");
        const repository = openRepository();
        const active = repository.getActive();
        repository.close();
        if (!active) {
            output({ ok: false, code: "no_reservation", running: false, connected: false }, 2);
            return;
        }
        const running = await ensureRunning();
        output({ ...running, code: "running" });
        return;
    }
    if (action === "diagnose") {
        if (args.length) throw new Error("diagnoseに引数はありません。");
        const result = spawnSync(process.execPath, [
            `--env-file-if-exists=${join(root, ".env")}`, join(root, "src/diagnose.ts"), "--json",
        ], { cwd: root, env: process.env, encoding: "utf8", timeout: 30_000 });
        let diagnostic: {
            checks: Array<{ name: string; ok: boolean; detail: string }>;
            missingVariables: string[];
            invalidVariables: string[];
        };
        try {
            diagnostic = JSON.parse(result.stdout) as typeof diagnostic;
        } catch {
            output({ ok: false, code: "diagnostic_failed", detail: "診断結果を読み取れません。" }, 2);
            return;
        }
        const ok = result.status === 0 && diagnostic.missingVariables.length === 0
            && diagnostic.invalidVariables.length === 0;
        output({ ok, code: ok ? "ok" : "diagnostic_failed", ...diagnostic }, ok ? 0 : 2);
        return;
    }
    if (action === "result") {
        if (args.length !== 1 || !ID_PATTERN.test(args[0]!)) {
            throw new Error("operationIdを指定してください。");
        }
        const online = await maybeRunning({ action: "result", operationId: args[0]! });
        if (online) {
            const state = await statusSnapshot();
            output({ ...online, current: { running: state.running, connected: state.connected } },
                online.ok ? 0 : online.code === "result_unknown" ? 4 : 2);
            return;
        }
        const repository = openRepository();
        try {
            const operation = repository.getOperation(args[0]!);
            const state = await statusSnapshot();
            if (!operation) output({ ...state, ok: false, code: "missing_result" }, 2);
            else if (operation.result === null) output({ ok: false, code: "result_unknown",
                operationId: args[0], running: state.running, connected: state.connected }, 4);
            else output({ ...(operation.result as ControlResponse),
                current: { running: state.running, connected: state.connected } },
                (operation.result as ControlResponse).ok ? 0
                    : (operation.result as ControlResponse).code === "result_unknown" ? 4 : 2);
        } finally {
            repository.close();
        }
        return;
    }
    if (["stop", "snooze", "cancel", "exit"].includes(action ?? "")) {
        const command = action as "stop" | "snooze" | "cancel" | "exit";
        const options = parseOptions(args, command === "exit" ? ["--operation-id"]
            : ["--operation-id", "--target-id"]);
        const operationId = options["--operation-id"];
        const targetId = options["--target-id"];
        if (!operationId || !ID_PATTERN.test(operationId)
            || (command !== "exit" && (!targetId || targetId.length > 128))) {
            throw new Error("操作IDと対象IDを指定してください。");
        }
        const request: ControlRequest = command === "exit" ? { action: "exit", operationId }
            : { action: command, operationId, targetId: targetId! };
        const previousRepository = openRepository();
        const previous = previousRepository.getOperation(operationId);
        previousRepository.close();
        if (previous) {
            if (previous.action !== command || previous.targetId !== (targetId ?? "bot")) {
                output({ ok: false, code: "operation_conflict", operationId, accepted: false }, 2);
            } else if (previous.result === null) {
                output({ ok: false, code: "result_unknown", operationId, accepted: true }, 4);
            } else {
                const result = previous.result as ControlResponse;
                const state = await statusSnapshot();
                output({ ...result, replayed: true,
                    current: { running: state.running, connected: state.connected } }, result.ok ? 0
                    : result.code === "result_unknown" ? 4 : 2);
            }
            return;
        }
        let online: ControlResponse | null;
        try {
            online = await maybeRunning(request);
        } catch (error) {
            if (!(error instanceof ControlUnknownError)) throw error;
            output({ ok: false, code: "result_unknown", operationId,
                check: "resultで保存済み結果を確認してください。" }, 4);
            return;
        }
        if (online) {
            output(online, online.ok ? 0 : online.code === "result_unknown" ? 4
                : online.code === "starting" ? 3 : 2);
            return;
        }
        if (ProcessLock.isHeld(config.lockPath)) {
            output({ ok: false, code: "starting", running: true, connected: false,
                operationId, accepted: false }, 3);
            return;
        }
        if (command === "cancel") {
            const repository = openRepository();
            try {
                const operation = repository.beginOperation(operationId, command, targetId!);
                if (operation.kind === "replayed") {
                    const result = operation.result as ControlResponse;
                    output(result, result.ok ? 0 : 2);
                    return;
                }
                if (operation.kind !== "new") {
                    output({ ok: false, code: operation.kind === "conflict" ? "operation_conflict"
                        : "result_unknown", operationId, running: false, connected: false },
                    operation.kind === "conflict" ? 2 : 4);
                    return;
                }
                const alarm = repository.cancelWaitingTarget(targetId!, Date.now());
                const result = { ok: Boolean(alarm), code: alarm ? "cancelled" : "no_waiting",
                    running: false, connected: false, alarm, operationId, accepted: true };
                repository.completeOperation(operationId, result);
                output(result, alarm ? 0 : 2);
            } finally {
                repository.close();
            }
            return;
        }
        if (command === "exit") {
            const repository = openRepository();
            try {
                const active = repository.getActive();
                output({ ok: true, code: "already_stopped", running: false,
                    connected: false, paused: active?.status === "WAITING", active,
                    operationId, accepted: false });
            } finally {
                repository.close();
            }
            return;
        }
        output({ ok: false, code: "no_audio", running: false, connected: false,
            operationId, accepted: false }, 2);
        return;
    }
    throw new Error("操作はprepare、confirm、status、stop、cancel、snooze、exit、result、resume、diagnoseから選んでください。");
}

try {
    config = loadConfig(process.env, { requireDiscord: false, cwd: root });
    socketPath = controlPath(config.databasePath);
    await main();
} catch (error) {
    if (error instanceof DiscordConfigurationError) {
        output({ ok: false, code: error.missingVariables.length ? "missing_configuration" : "invalid_configuration",
            saved: false, running: false, connected: false,
            missingVariables: error.missingVariables, invalidVariables: error.invalidVariables }, 2);
    } else if (error instanceof ControlUnknownError) {
        output({ ok: false, code: "result_unknown", detail: error.message,
            check: "statusで予約とBotの状態を確認してください。" }, 4);
    } else if (error instanceof ControlUnavailableError) {
        const state = await statusSnapshot().catch(() => ({
            running: ProcessLock.isHeld(config.lockPath), connected: false,
        }));
        output({ ok: false, code: "start_failed", saved: false, running: state.running,
            connected: state.connected, detail: error.message }, 3);
    } else {
        output({ ok: false, code: "invalid_or_failed", detail: error instanceof Error ? error.message
            : "操作を完了できませんでした。" }, 2);
    }
}
