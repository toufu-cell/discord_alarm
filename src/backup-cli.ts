import { resolve } from "node:path";
import { createBackup } from "./backup.ts";
import { loadConfig } from "./config.ts";

const destination = process.argv[2];
if (!destination) {
    console.error("使い方: npm run backup -- backups/alarm-YYYYMMDD.sqlite");
    process.exitCode = 1;
} else {
    const config = loadConfig(process.env, { requireDiscord: false });
    const pages = await createBackup(config.databasePath, resolve(destination));
    console.log(`バックアップを作成しました。SQLite pages: ${pages}`);
}

