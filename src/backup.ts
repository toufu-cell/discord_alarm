import { constants, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

function assertHealthyDatabase(path: string): void {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
        const result = database.prepare("PRAGMA quick_check").get() as { quick_check: string };
        if (result.quick_check !== "ok") throw new Error("SQLiteの整合性確認に失敗しました。");
    } finally {
        database.close();
    }
}

export async function createBackup(sourcePath: string, destinationPath: string): Promise<number> {
    const source = resolve(sourcePath);
    const destination = resolve(destinationPath);
    if (!existsSync(source)) throw new Error("バックアップ元のDBが見つかりません。");
    if (existsSync(destination)) throw new Error("バックアップ先には新しいパスを指定してください。");
    mkdirSync(dirname(destination), { recursive: true });
    const temporaryDirectory = mkdtempSync(join(dirname(destination), ".alarm-backup-"));
    const temporaryPath = join(temporaryDirectory, "backup.sqlite");
    let database: DatabaseSync | null = null;
    try {
        database = new DatabaseSync(source, { readOnly: true });
        const pages = await backup(database, temporaryPath);
        assertHealthyDatabase(temporaryPath);
        linkSync(temporaryPath, destination);
        return pages;
    } finally {
        try {
            database?.close();
        } finally {
            rmSync(temporaryDirectory, { recursive: true, force: true });
        }
    }
}

export function restoreBackup(sourcePath: string, destinationPath: string): void {
    const source = resolve(sourcePath);
    const destination = resolve(destinationPath);
    if (!existsSync(source)) throw new Error("復元元のDBが見つかりません。");
    if (existsSync(destination)) throw new Error("復元先には新しいパスを指定してください。");
    assertHealthyDatabase(source);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    assertHealthyDatabase(destination);
}
