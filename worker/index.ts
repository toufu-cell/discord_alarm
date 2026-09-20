import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";
import { handleContainerOutbound } from "./internal-route.ts";
import { handleManagementRequest } from "./management.ts";

export interface Env {
    ALARM_CONTAINER: DurableObjectNamespace<AlarmContainer>;
    ALARM_DB: D1Database;
    ALARM_ADMIN_TOKEN: string;
    DISCORD_TOKEN: string;
    DISCORD_APPLICATION_ID: string;
    DISCORD_GUILD_ID: string;
    DISCORD_OWNER_ID: string;
    ALARM_TIME_ZONE?: string;
    ALARM_VOLUME_PERCENT?: string;
    ALARM_SNOOZE_LIMIT?: string;
    ALARM_PREVIEW_SECONDS?: string;
}

const INSTANCE_NAME = "discord-alarm";

export class AlarmContainer extends Container<Env> {
    private lifecycleTail: Promise<void> = Promise.resolve();
    defaultPort = 8080;
    pingEndpoint = "localhost/health";
    sleepAfter = "2m";
    enableInternet = true;
    envVars = {
        ALARM_REMOTE_D1: "1",
        YTDLP_PATH: "/opt/discord-alarm/.venv/bin/yt-dlp",
        DISCORD_TOKEN: this.env.DISCORD_TOKEN,
        DISCORD_APPLICATION_ID: this.env.DISCORD_APPLICATION_ID,
        DISCORD_GUILD_ID: this.env.DISCORD_GUILD_ID,
        DISCORD_OWNER_ID: this.env.DISCORD_OWNER_ID,
        ALARM_TIME_ZONE: this.env.ALARM_TIME_ZONE ?? "Asia/Tokyo",
        ALARM_VOLUME_PERCENT: this.env.ALARM_VOLUME_PERCENT ?? "35",
        ALARM_SNOOZE_LIMIT: this.env.ALARM_SNOOZE_LIMIT ?? "3",
        ALARM_PREVIEW_SECONDS: this.env.ALARM_PREVIEW_SECONDS ?? "30",
    };

    public override async fetch(): Promise<Response> {
        return new Response(null, { status: 404 });
    }

    private async scheduleWatchdog(): Promise<void> {
        if (await this.ctx.storage.get<boolean>("watchdogScheduled")) return;
        await this.ctx.storage.put("watchdogScheduled", true);
        try {
            await this.schedule(60, "watchdog");
        } catch (error) {
            await this.ctx.storage.put("watchdogScheduled", false);
            throw error;
        }
    }

    private async withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.lifecycleTail;
        let release!: () => void;
        this.lifecycleTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    public async startService(): Promise<{ enabled: boolean; status: string }> {
        return this.withLifecycle(async () => {
            await this.ctx.storage.put("enabled", true);
            await this.scheduleWatchdog();
            await this.startAndWaitForPorts();
            return this.statusService();
        });
    }

    public async stopService(): Promise<{ enabled: boolean; status: string }> {
        return this.withLifecycle(async () => {
            await this.ctx.storage.put("enabled", false);
            await this.stop();
            return this.statusService();
        });
    }

    public async statusService(): Promise<{ enabled: boolean; status: string }> {
        const enabled = (await this.ctx.storage.get<boolean>("enabled")) === true;
        const state = await this.getState();
        return { enabled, status: state.status };
    }

    public async watchdog(): Promise<void> {
        await this.withLifecycle(async () => {
            await this.ctx.storage.put("watchdogScheduled", false);
            if ((await this.ctx.storage.get<boolean>("enabled")) !== true) return;
            try {
                const state = await this.getState();
                if (state.status === "stopped" || state.status === "stopped_with_code") {
                    await this.startAndWaitForPorts();
                } else if (state.status === "healthy") {
                    this.renewActivityTimeout();
                }
            } finally {
                if ((await this.ctx.storage.get<boolean>("enabled")) === true) await this.scheduleWatchdog();
            }
        });
    }

    public override async onActivityExpired(): Promise<void> {
        if ((await this.ctx.storage.get<boolean>("enabled")) === true) {
            this.renewActivityTimeout();
            return;
        }
        await super.onActivityExpired();
    }
}

AlarmContainer.outboundByHost = {
    "alarm-d1.internal": (request: Request, env: Env, ctx: { containerId: string }) => {
        return handleContainerOutbound(request, env.ALARM_DB,
            ctx.containerId, env.ALARM_CONTAINER.idFromName(INSTANCE_NAME).toString());
    },
};

export { ContainerProxy };

export default {
    fetch(request: Request, env: Env): Promise<Response> {
        return handleManagementRequest(request, env.ALARM_ADMIN_TOKEN,
            () => getContainer(env.ALARM_CONTAINER, INSTANCE_NAME));
    },
} satisfies ExportedHandler<Env>;
