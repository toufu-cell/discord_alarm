import { spawn } from "node:child_process";
import { chmodSync, closeSync, openSync } from "node:fs";

export function launchDetached(entryPath: string, logPath: string, cwd: string, args: string[] = []): number {
    const log = openSync(logPath, "a", 0o600);
    chmodSync(logPath, 0o600);
    try {
        const child = spawn(process.execPath, [entryPath, ...args], {
            cwd,
            env: process.env,
            detached: true,
            stdio: ["ignore", log, log],
        });
        child.unref();
        return child.pid!;
    } finally {
        closeSync(log);
    }
}
