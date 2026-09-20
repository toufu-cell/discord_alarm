import { appendFileSync } from "node:fs";
import type { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ChannelType, Events, type BaseGuildVoiceChannel, type Client, type Interaction } from "discord.js";
import { PlaybackController } from "../src/playback.ts";
import type { MediaFactory, MediaSource } from "../src/media.ts";
import type { VoiceConnector, VoiceOutput } from "../src/voice.ts";

function fakeSource(signal: AbortSignal): MediaSource {
    return {
        kind: "youtube",
        stream: new PassThrough(),
        done: new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
        async stop() { return; },
    };
}

const mediaFactory: MediaFactory = {
    createYouTube: (_url, signal) => fakeSource(signal),
    createFallback: (signal) => fakeSource(signal),
};

const voiceConnector: VoiceConnector<BaseGuildVoiceChannel> = {
    async connect(): Promise<VoiceOutput> {
        return {
            play(_stream, signal) {
                const done = new Promise<void>((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
                });
                return { started: Promise.resolve(), done };
            },
            stop() { return; },
            async close() { return; },
        };
    },
};

export function attachFakeDiscord(client: Client): PlaybackController<BaseGuildVoiceChannel> {
    Object.assign(client, { isReady: () => true });
    const pendingNotifications: Array<() => void> = [];
    if (process.send) {
        process.on("message", (message: unknown) => {
            if (!message || typeof message !== "object") return;
            const request = message as { alarmTestEvent?: string; requestId?: string };
            if (typeof request.requestId !== "string") return;
            if (request.alarmTestEvent === "ClientReady") {
                client.emit(Events.ClientReady, { user: { id: "test" } } as Client<true>);
            } else if (request.alarmTestEvent === "ShardReady") {
                (client as unknown as EventEmitter).emit(Events.ShardReady, 0);
            } else if (request.alarmTestEvent === "ShardResume") {
                client.emit(Events.ShardResume, 0, 0);
            } else if (request.alarmTestEvent === "NotificationRelease") {
                for (const release of pendingNotifications.splice(0)) release();
            } else return;
            setImmediate(() => process.send?.({ alarmTestEventDone: request.requestId }));
        });
    }
    const mode = process.env.ALARM_TEST_VOICE ?? "none";
    const me = { id: "test-bot" };
    const channel = {
        id: "test-voice", type: mode === "invalid" ? ChannelType.GuildStageVoice : ChannelType.GuildVoice,
        guild: { members: { me } },
        permissionsFor: () => ({ has: () => true }),
        userLimit: 0, members: new Map(),
    } as unknown as BaseGuildVoiceChannel;
    Object.assign(client.guilds, {
        fetch: async () => ({ members: { fetch: async () => ({ voice: {
            channel: mode === "none" ? null : channel,
        } }) } }),
    });
    Object.assign(client.channels, {
        fetch: async (channelId: string) => ({
            isSendable: () => true,
            send: async (message: { content: string; allowedMentions: { parse: string[] } }) => {
                if (process.env.ALARM_TEST_NOTIFICATION_HOLD === "1" && process.send) {
                    await new Promise<void>((resolve) => {
                        pendingNotifications.push(resolve);
                        process.send?.({ alarmTestNotificationPending: true });
                    });
                }
                const delay = Number(process.env.ALARM_TEST_NOTIFICATION_DELAY_MS ?? "0");
                if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
                if (process.env.ALARM_TEST_NOTIFICATION_FAIL === "1") {
                    throw new Error("fake notification failure");
                }
                const path = process.env.ALARM_TEST_NOTIFICATION_FILE;
                if (path) appendFileSync(path, JSON.stringify({ channelId, content: message.content,
                    allowedMentions: message.allowedMentions }) + "\n");
            },
        }),
    });
    const replyFile = process.env.ALARM_TEST_INTERACTION_FILE;
    if (replyFile) {
        const interaction = {
            guildId: process.env.DISCORD_GUILD_ID,
            user: { id: process.env.DISCORD_OWNER_ID },
            commandName: "alarm",
            options: { getSubcommand: () => "show" },
            deferred: false,
            replied: false,
            isChatInputCommand: () => true,
            isButton: () => false,
            isRepliable: () => true,
            async deferReply() { this.deferred = true; },
            async editReply(message: { content: string }) {
                const delay = Number(process.env.ALARM_TEST_INTERACTION_DELAY_MS ?? "0");
                if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
                appendFileSync(replyFile, message.content + "\n");
                this.replied = true;
            },
        };
        const timer = setTimeout(() => client.emit(Events.InteractionCreate,
            interaction as unknown as Interaction), 100);
        timer.unref();
    }
    return new PlaybackController(mediaFactory, voiceConnector);
}
