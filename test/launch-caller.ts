import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { controlPath, sendControl } from "../src/local-control.ts";
import { launchDetached } from "../src/launcher.ts";

const [databasePath, markerPath, proposalId] = process.argv.slice(2);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pid = launchDetached(join(root, "src/index.ts"), `${databasePath}.log`, root, ["--await-confirm"]);
const deadline = Date.now() + 5_000;
let status;
while (Date.now() < deadline) {
    try {
        status = await sendControl(controlPath(databasePath!), { action: "status" });
        break;
    } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}
if (!status) throw new Error("制御プロセスへ接続できません。");
const confirmed = await sendControl(controlPath(databasePath!), { action: "confirm", proposalId: proposalId! });
if (!confirmed.ok) throw new Error(`予約確定に失敗しました: ${confirmed.code}`);
writeFileSync(markerPath!, JSON.stringify({ pid, alarm: confirmed.alarm }));
setInterval(() => undefined, 1_000);
