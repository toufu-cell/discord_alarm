import { handleRepositoryRequest } from "./repository-api.ts";

export function handleContainerOutbound(
    request: Request,
    database: D1Database,
    containerId: string,
    expectedId: string,
): Promise<Response> | Response {
    if (containerId !== expectedId) return new Response(null, { status: 403 });
    return handleRepositoryRequest(request, database);
}
