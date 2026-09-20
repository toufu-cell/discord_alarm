import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class ProcessLockError extends Error {
    public constructor(message = "Botはすでに起動しています。") {
        super(message);
        this.name = "ProcessLockError";
    }
}

export class ProcessLock {
    private released = false;
    private readonly database: DatabaseSync;

    private constructor(database: DatabaseSync) {
        this.database = database;
    }

    public static acquire(path: string): ProcessLock {
        mkdirSync(dirname(path), { recursive: true });
        const database = new DatabaseSync(path);
        try {
            database.exec("PRAGMA busy_timeout = 100; PRAGMA journal_mode = DELETE;");
            database.exec("CREATE TABLE IF NOT EXISTS process_lock (id INTEGER PRIMARY KEY CHECK (id = 1));");
            database.exec("BEGIN EXCLUSIVE;");
            database.prepare("INSERT OR IGNORE INTO process_lock (id) VALUES (1)").run();
            return new ProcessLock(database);
        } catch {
            database.close();
            throw new ProcessLockError();
        }
    }

    public static isHeld(path: string): boolean {
        try {
            const lock = ProcessLock.acquire(path);
            lock.release();
            return false;
        } catch (error) {
            if (error instanceof ProcessLockError) return true;
            throw error;
        }
    }

    public release(): void {
        if (this.released) return;
        this.released = true;
        try {
            this.database.exec("ROLLBACK;");
        } finally {
            this.database.close();
        }
    }
}
