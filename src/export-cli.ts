import { exportSqliteForD1 } from "./export-sqlite.ts";

const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error("使用方法: npm run export:sqlite -- SOURCE OUTPUT");
const count = exportSqliteForD1(source, output);
console.log(`SQLを作成しました。予約履歴: ${count.alarms}件、設定: ${count.settings}件。`);
