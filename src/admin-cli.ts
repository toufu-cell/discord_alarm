const action = process.argv[2] ?? "status";
if (!["start", "status", "stop"].includes(action)) {
    throw new Error("使用方法: npm run bot -- start|status|stop");
}
const token = process.env.ALARM_ADMIN_TOKEN;
const baseUrl = process.env.ALARM_WORKER_URL;
if (!token || token.length < 16 || !baseUrl) {
    throw new Error("ALARM_ADMIN_TOKENとALARM_WORKER_URLを設定してください。");
}
const url = new URL(baseUrl);
if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("公開WorkerにはHTTPSを使用してください。");
}
const response = await fetch(new URL(`/api/bot/${action}`, url), {
    method: action === "status" ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`管理操作に失敗しました: HTTP ${response.status}`);
console.log(JSON.stringify(await response.json(), null, 2));
