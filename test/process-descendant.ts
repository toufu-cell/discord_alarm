import { spawn } from "node:child_process";

const mode = process.argv[2];
if (mode === "hold-output") process.on("SIGTERM", () => undefined);
if (mode !== "descendant" && mode !== "hold-output") {
    const exitParent = mode === "exit-parent";
    const descendant = spawn(process.execPath, [
        "test/process-descendant.ts", exitParent ? "hold-output" : "descendant",
    ], { stdio: exitParent ? ["ignore", "inherit", "inherit"] : "ignore" });
    process.stdout.write(`${descendant.pid}\n`, () => {
        if (exitParent) process.exit(0);
    });
}
setInterval(() => undefined, 1_000);
