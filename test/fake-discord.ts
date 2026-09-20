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
    const pendingButtonReplies: Array<() => void> = [];
    const pendingButtonDefers: Array<() => void> = [];
    if (process.send) {
        process.on("message", (message: unknown) => {
            if (!message || typeof message !== "object") return;
            const request = message as { alarmTestEvent?: string; requestId?: string;
                buttonId?: string; guildId?: string; userId?: string; holdReply?: boolean; holdDefer?: boolean };
            if (typeof request.requestId !== "string") return;
            if (request.alarmTestEvent === "ClientReady") {
                client.emit(Events.ClientReady, { user: { id: "test" } } as Client<true>);
            } else if (request.alarmTestEvent === "ShardReady") {
                (client as unknown as EventEmitter).emit(Events.ShardReady, 0);
            } else if (request.alarmTestEvent === "ShardResume") {
                client.emit(Events.ShardResume, 0, 0);
            } else if (request.alarmTestEvent === "NotificationRelease") {
                for (const release of pendingNotifications.splice(0)) release();
            } else if (request.alarmTestEvent === "ButtonReplyRelease") {
                for (const release of pendingButtonReplies.splice(0)) release();
            } else if (request.alarmTestEvent === "ButtonDeferRelease") {
                for (const release of pendingButtonDefers.splice(0)) release();
            } else if (request.alarmTestEvent === "Button"
                && request.buttonId && request.guildId && request.userId) {
                let deferred = false;
                let replied = false;
                let flags: number | undefined;
                const sendReply = async (payload: { content: string; allowedMentions?: { parse: string[] } }) => {
                    if (request.holdReply) {
                        await new Promise<void>((resolve) => {
                            pendingButtonReplies.push(resolve);
                            process.send?.({ alarmTestButtonReplyPending: request.requestId });
                        });
                    }
                    await new Promise<void>((resolve, reject) => process.send?.({
                        alarmTestButtonResponse: request.requestId, content: payload.content,
                        allowedMentions: payload.allowedMentions, deferred, flags,
                    }, (error) => error ? reject(error) : resolve()));
                    replied = true;
                };
                const interaction = {
                    customId: request.buttonId, guildId: request.guildId, user: { id: request.userId },
                    get deferred() { return deferred; }, get replied() { return replied; },
                    isButton: () => true,
                    deferReply: async (payload: { flags: number }) => {
                        deferred = true;
                        flags = payload.flags;
                        if (request.holdDefer) {
                            await new Promise<void>((resolve) => {
                                pendingButtonDefers.push(resolve);
                                process.send?.({ alarmTestButtonDeferPending: request.requestId });
                            });
                        }
                    },
                    editReply: sendReply, reply: sendReply,
                } as unknown as Interaction;
                client.emit(Events.InteractionCreate, interaction);
                return;
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
            send: async (message: { content: string; allowedMentions: { parse: string[] }; components?: unknown }) => {
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
                    allowedMentions: message.allowedMentions, components: message.components }) + "\n");
            },
        }),
    });
    return new PlaybackController(mediaFactory, voiceConnector);
}
