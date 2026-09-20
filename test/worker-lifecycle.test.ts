import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => { resolve = complete; });
    return { promise, resolve };
}

interface Service {
    startService(): Promise<{ enabled: boolean; status: string }>;
    stopService(): Promise<{ enabled: boolean; status: string }>;
    statusService(): Promise<{ enabled: boolean; status: string }>;
    watchdog(): Promise<void>;
}

function makeService() {
    const operations: string[] = [];
    const startEntered = deferred<void>();
    const releaseStart = deferred<void>();
    const values = new Map<string, unknown>();
    let containerStatus = "stopped";
    class ExternalContainer {
        public readonly ctx: unknown;
        public readonly env: unknown;
        public constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
        public async startAndWaitForPorts(): Promise<void> {
            operations.push("start:begin");
            startEntered.resolve();
            await releaseStart.promise;
            containerStatus = "healthy";
            operations.push("start:end");
        }
        public async stop(): Promise<void> {
            operations.push("stop");
            containerStatus = "stopped";
        }
        public async getState(): Promise<{ status: string }> { return { status: containerStatus }; }
        public async schedule(): Promise<void> { operations.push("schedule"); }
        public renewActivityTimeout(): void { operations.push("renew"); }
    }
    const source = ts.transpileModule(readFileSync("worker/index.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const moduleExports: Record<string, unknown> = {};
    runInNewContext(source, {
        exports: moduleExports,
        require: (name: string) => {
            if (name === "@cloudflare/containers") {
                return { Container: ExternalContainer, ContainerProxy: class {}, getContainer: () => undefined };
            }
            if (name === "./internal-route.ts") return { handleContainerOutbound: () => undefined };
            if (name === "./management.ts") return { handleManagementRequest: () => undefined };
            throw new Error(`Unexpected import: ${name}`);
        },
    });
    const AlarmContainer = moduleExports.AlarmContainer as new (ctx: unknown, env: unknown) => Service;
    const service = new AlarmContainer({
        storage: {
            get: async (key: string) => values.get(key),
            put: async (key: string, value: unknown) => { values.set(key, value); },
        },
    }, {});
    return { service, operations, startEntered, releaseStart, values };
}

test("管理stopは先行startの完了後に停止し、statusとwatchdogは再起動しない", async () => {
    const { service, operations, startEntered, releaseStart } = makeService();
    const initial = await service.statusService();
    assert.equal(initial.enabled, false);
    assert.equal(initial.status, "stopped");
    assert.deepEqual(operations, []);
    const starting = service.startService();
    await startEntered.promise;
    const stopping = service.stopService();
    assert.deepEqual(operations, ["schedule", "start:begin"]);
    releaseStart.resolve();
    await starting;
    const stopped = await stopping;
    assert.equal(stopped.enabled, false);
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(operations, ["schedule", "start:begin", "start:end", "stop"]);
    await service.watchdog();
    assert.deepEqual(operations, ["schedule", "start:begin", "start:end", "stop"]);
});

test("watchdogの開始中にstopしても、停止完了後は古い開始で再起動しない", async () => {
    const { service, operations, startEntered, releaseStart, values } = makeService();
    values.set("enabled", true);
    const watchdog = service.watchdog();
    await startEntered.promise;
    const stopping = service.stopService();
    releaseStart.resolve();
    await watchdog;
    const stopped = await stopping;
    assert.equal(stopped.enabled, false);
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(operations.slice(-2), ["schedule", "stop"]);
    await service.watchdog();
    assert.equal(operations.filter((operation) => operation === "start:begin").length, 1);
});
