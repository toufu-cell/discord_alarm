import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface ProcessResult {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
}

interface RunOptions {
    timeoutMs: number;
    maxStdoutBytes: number;
    maxStderrBytes: number;
    signal?: AbortSignal;
    processGroup?: boolean;
}

const TERMINATIONS = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
    if (process.platform === "win32" || !child.pid || child.pid <= 0) return false;
    try {
        process.kill(-child.pid, signal);
        return true;
    } catch {
        return false;
    }
}

export function terminateChild(child: ChildProcessWithoutNullStreams, processGroup = false): Promise<void> {
    const existing = TERMINATIONS.get(child);
    if (existing) return existing;
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (!processGroup && exited) return Promise.resolve();
    if (processGroup && exited && child.stdout.destroyed && child.stderr.destroyed) return Promise.resolve();
    const termination = new Promise<void>((resolve) => {
        const kill = (signal: NodeJS.Signals) => {
            if (processGroup && signalProcessGroup(child, signal)) return;
            if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        };
        const escalation = setTimeout(() => kill("SIGKILL"), 1_500);
        escalation.unref();
        if (processGroup && !exited) child.once("exit", () => signalProcessGroup(child, "SIGKILL"));
        child.once("close", () => {
            clearTimeout(escalation);
            resolve();
        });
        kill(exited ? "SIGKILL" : "SIGTERM");
    });
    TERMINATIONS.set(child, termination);
    return termination;
}

export async function runBoundedProcess(
    command: string,
    args: string[],
    options: RunOptions,
): Promise<ProcessResult> {
    if (options.signal?.aborted) throw new DOMException("処理を中止しました。", "AbortError");
    const processGroup = options.processGroup === true && process.platform !== "win32";
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: processGroup });
    child.stdin.end();
    if (processGroup) child.once("exit", () => signalProcessGroup(child, "SIGKILL"));
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let overflow = false;

    const append = (current: Buffer, chunk: Buffer, maximum: number): Buffer => {
        if (current.length + chunk.length > maximum) {
            overflow = true;
            void terminateChild(child, processGroup);
            return current;
        }
        return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk, options.maxStdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk, options.maxStderrBytes);
    });

    const timeout = setTimeout(() => void terminateChild(child, processGroup), options.timeoutMs);
    timeout.unref();
    const abort = () => void terminateChild(child, processGroup);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    try {
        const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
        });
        if (overflow) throw new Error("子プロセスの出力が上限を超えました。");
        if (options.signal?.aborted) throw new DOMException("処理を中止しました。", "AbortError");
        return {
            ...outcome,
            stdout: new TextDecoder().decode(stdout),
            stderr: new TextDecoder().decode(stderr),
        };
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
    }
}

export class ChildProcessRegistry {
    private readonly children = new Map<ChildProcessWithoutNullStreams, boolean>();

    public add(child: ChildProcessWithoutNullStreams, processGroup = false): void {
        this.children.set(child, processGroup);
        if (processGroup) child.once("exit", () => signalProcessGroup(child, "SIGKILL"));
        child.once("close", () => {
            this.children.delete(child);
        });
    }

    public delete(child: ChildProcessWithoutNullStreams): void {
        this.children.delete(child);
    }

    public async terminateAll(): Promise<void> {
        const children = [...this.children];
        await Promise.allSettled(children.map(([child, group]) => terminateChild(child, group)));
        this.children.clear();
    }

    public get size(): number {
        return this.children.size;
    }
}
