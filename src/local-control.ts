import { createHash } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type ControlRequest =
    | { action: "confirm"; proposalId: string }
    | { action: "stop" | "snooze" | "cancel"; operationId: string; targetId: string }
    | { action: "exit"; operationId: string }
    | { action: "result"; operationId: string }
    | { action: "status" };

export interface ControlResponse {
    ok: boolean;
    code: string;
    running: boolean;
    connected: boolean;
    paused?: boolean;
    saved?: boolean;
    alarm?: unknown;
    active?: unknown;
    latest?: unknown;
    audio?: unknown;
    detail?: string;
    operationId?: string;
    accepted?: boolean;
    exiting?: boolean;
}

export class ControlUnavailableError extends Error {}
export class ControlUnknownError extends Error {}

export function controlPath(databasePath: string): string {
    const hash = createHash("sha256").update(databasePath).digest("hex").slice(0, 24);
    return join(tmpdir(), `discord-alarm-${process.getuid?.() ?? 0}`, `${hash}.sock`);
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validRequest(value: unknown): value is ControlRequest {
    if (!value || typeof value !== "object") return false;
    const request = value as Record<string, unknown>;
    if (request.action === "status") return true;
    if (request.action === "confirm") return typeof request.proposalId === "string"
        && ID_PATTERN.test(request.proposalId);
    if (request.action === "result" || request.action === "exit") {
        return typeof request.operationId === "string" && ID_PATTERN.test(request.operationId);
    }
    if (request.action === "stop" || request.action === "snooze" || request.action === "cancel") {
        return typeof request.operationId === "string" && ID_PATTERN.test(request.operationId)
            && typeof request.targetId === "string" && request.targetId.length > 0
            && request.targetId.length <= 128;
    }
    return false;
}

export async function sendControl(path: string, request: ControlRequest, timeoutMs = 4_000): Promise<ControlResponse> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(path);
        let connected = false;
        let received = "";
        let settled = false;
        const finish = (error?: Error, response?: ControlResponse) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            if (error) reject(error);
            else resolve(response!);
        };
        socket.setTimeout(timeoutMs, () => finish(new ControlUnknownError("応答期限を超えました。")));
        socket.once("connect", () => {
            connected = true;
            socket.write(JSON.stringify(request) + "\n");
        });
        socket.on("data", (chunk: Buffer) => {
            received += chunk.toString();
            if (received.length > 64 * 1024) {
                finish(new ControlUnknownError("応答が大きすぎます。"));
                return;
            }
            const newline = received.indexOf("\n");
            if (newline < 0) return;
            try {
                finish(undefined, JSON.parse(received.slice(0, newline)) as ControlResponse);
            } catch {
                finish(new ControlUnknownError("応答を読み取れません。"));
            }
        });
        socket.once("error", () => finish(connected
            ? new ControlUnknownError("操作結果を確認できません。")
            : new ControlUnavailableError("Botへ接続できません。")));
        socket.once("close", () => {
            if (!settled) finish(connected
                ? new ControlUnknownError("操作結果を確認できません。")
                : new ControlUnavailableError("Botへ接続できません。"));
        });
    });
}

export async function startControl(
    path: string,
    handle: (request: ControlRequest) => Promise<ControlResponse>,
    settled: (request?: ControlRequest, response?: ControlResponse) => void,
    connectionChange: (delta: number) => void = () => undefined,
): Promise<Server> {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== (process.getuid?.() ?? info.uid)) {
        throw new Error("IPCディレクトリの所有者を確認できません。");
    }
    if ((info.mode & 0o077) !== 0) chmodSync(directory, 0o700);
    try { unlinkSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const server = createServer((socket) => {
        connectionChange(1);
        let acceptedRequest: ControlRequest | undefined;
        let finishedResponse: ControlResponse | undefined;
        let reported = false;
        const report = () => {
            if (reported || !finishedResponse) return;
            reported = true;
            settled(acceptedRequest, finishedResponse);
        };
        socket.once("close", () => {
            connectionChange(-1);
            report();
        });
        socket.on("error", () => undefined);
        socket.setTimeout(4_000, () => {
            if (!handling) {
                handling = true;
                socket.destroy();
            }
        });
        let input = "";
        let handling = false;
        socket.on("data", (chunk: Buffer) => {
            if (handling) return;
            input += chunk.toString();
            if (input.length > 16 * 1024) {
                handling = true;
                finishedResponse = { ok: false, code: "invalid_input", running: true, connected: false };
                socket.end(JSON.stringify(finishedResponse) + "\n", report);
                return;
            }
            if (!input.includes("\n")) return;
            handling = true;
            socket.setTimeout(0);
            void respond();
        });
        async function respond() {
            let response: ControlResponse = { ok: false, code: "invalid_input", running: true, connected: false };
            let request: unknown;
            try {
                request = JSON.parse(input.slice(0, input.indexOf("\n")));
            } catch {}
            if (request !== undefined) {
                try {
                    if (validRequest(request)) {
                        acceptedRequest = request;
                        response = await handle(request);
                    }
                } catch {
                    response = { ok: false, code: "internal_error", running: true, connected: false };
                }
            }
            finishedResponse = response;
            if (!socket.destroyed) socket.end(JSON.stringify(response) + "\n", report);
            else report();
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
    });
    chmodSync(path, 0o600);
    return server;
}

export function removeControl(path: string): void {
    try { unlinkSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}
