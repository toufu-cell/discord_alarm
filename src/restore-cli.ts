import { resolve } from "node:path";
import { restoreBackup } from "./backup.ts";

const source = process.argv[2];
const destination = process.argv[3];
if (!source || !destination) {
    console.error("使い方: npm run restore -- backups/alarm.sqlite data/restored.sqlite");
    process.exitCode = 1;
} else {
    restoreBackup(resolve(source), resolve(destination));
    console.log("新しいDBへ復元しました。内容を確認してからALARM_DATABASE_PATHを変更してください。");
}

