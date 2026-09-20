import { ProcessLock } from "../src/process-lock.ts";

const lockPath = process.argv[2];
if (!lockPath) throw new Error("ロックファイルのパスが必要です。");
ProcessLock.acquire(lockPath);
console.log("LOCKED");
setInterval(() => undefined, 1_000);

