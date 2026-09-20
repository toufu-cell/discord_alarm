export interface ServiceControl {
    startService(): Promise<{ enabled: boolean; status: string }>;
    stopService(): Promise<{ enabled: boolean; status: string }>;
    statusService(): Promise<{ enabled: boolean; status: string }>;
}

function tokenMatches(actual: string, expected: string): boolean {
    const maximum = Math.max(actual.length, expected.length);
    let difference = actual.length ^ expected.length;
    for (let index = 0; index < maximum; index += 1) {
        difference |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
    }
    return difference === 0;
}

export async function handleManagementRequest(
    request: Request,
    adminToken: string,
    service: () => ServiceControl,
): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname;
    if (url.search || !["/api/bot/start", "/api/bot/status", "/api/bot/stop"].includes(action)) {
        return new Response(null, { status: 404 });
    }
    if (request.method !== (action === "/api/bot/status" ? "GET" : "POST")) {
        return new Response(null, { status: 405 });
    }
    if (request.headers.has("origin") && request.headers.get("origin") !== url.origin) {
        return new Response(null, { status: 403 });
    }
    if (!adminToken || adminToken.length < 16) {
        return new Response(null, { status: 503 });
    }
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")
        || !tokenMatches(authorization.slice(7), adminToken)) {
        return new Response(null, { status: 401 });
    }
    const container = service();
    try {
        const result = action === "/api/bot/start" ? await container.startService()
            : action === "/api/bot/stop" ? await container.stopService()
                : await container.statusService();
        return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch {
        return Response.json({ error: "Container operation failed" }, { status: 503 });
    }
}
