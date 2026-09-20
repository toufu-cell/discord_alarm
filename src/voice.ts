import type { Readable } from "node:stream";
import {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    entersState,
    joinVoiceChannel,
    type AudioPlayer,
    type VoiceConnection,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";

export interface VoiceOutput {
    play(stream: Readable, signal: AbortSignal): VoicePlayback;
    stop(): void;
    close(): Promise<void>;
}

export interface VoicePlayback {
    started: Promise<void>;
    done: Promise<void>;
}

export interface VoiceConnector<Channel = VoiceBasedChannel> {
    connect(channel: Channel, signal: AbortSignal): Promise<VoiceOutput>;
}

export class DiscordVoiceOutput implements VoiceOutput {
    private readonly connection: VoiceConnection;
    private readonly player: AudioPlayer;
    private connectionFailed = false;
    private readonly guardConnectionError = () => { this.connectionFailed = true; };
    private readonly guardPlayerError = () => undefined;

    public constructor(connection: VoiceConnection, player: AudioPlayer) {
        this.connection = connection;
        this.player = player;
        this.connection.on("error", this.guardConnectionError);
        this.player.on("error", this.guardPlayerError);
    }

    public play(stream: Readable, signal: AbortSignal): VoicePlayback {
        if (signal.aborted) throw new DOMException("音声再生を中止しました。", "AbortError");
        if (this.connectionFailed || this.connection.state.status !== VoiceConnectionStatus.Ready) {
            throw new Error("音声接続が切断されています。");
        }
        const resource = createAudioResource(stream, { inputType: StreamType.OggOpus });
        const started = Promise.withResolvers<void>();
        const done = Promise.withResolvers<void>();
        let playingReached = false;
        let settled = false;
        const cleanup = () => {
            signal.removeEventListener("abort", abort);
            this.player.off(AudioPlayerStatus.Playing, playing);
            this.player.off(AudioPlayerStatus.Idle, idle);
            this.player.off("error", failed);
            this.connection.off(VoiceConnectionStatus.Disconnected, disconnected);
            this.connection.off(VoiceConnectionStatus.Destroyed, disconnected);
            this.connection.off("error", failed);
        };
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (!playingReached) started.reject(error);
            done.reject(error);
        };
        const playing = () => {
            if (settled || playingReached) return;
            playingReached = true;
            started.resolve();
        };
        const idle = () => {
            if (settled) return;
            if (!playingReached) {
                fail(new Error("音声が始まる前に終了しました。"));
                return;
            }
            settled = true;
            cleanup();
            done.resolve();
        };
        const failed = () => fail(new Error("Discordへの音声送信中にエラーが発生しました。"));
        const disconnected = () => fail(new Error("音声接続が切断されました。"));
        const abort = () => {
            fail(new DOMException("音声再生を中止しました。", "AbortError"));
            this.player.stop(true);
        };
        signal.addEventListener("abort", abort, { once: true });
        this.player.on(AudioPlayerStatus.Playing, playing);
        this.player.once(AudioPlayerStatus.Idle, idle);
        this.player.once("error", failed);
        this.connection.once(VoiceConnectionStatus.Disconnected, disconnected);
        this.connection.once(VoiceConnectionStatus.Destroyed, disconnected);
        this.connection.once("error", failed);
        try {
            this.player.play(resource);
        } catch {
            fail(new Error("音声再生を開始できませんでした。"));
        }
        return { started: started.promise, done: done.promise };
    }

    public stop(): void {
        this.player.stop(true);
    }

    public async close(): Promise<void> {
        this.stop();
        try {
            if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
        } finally {
            this.connection.off("error", this.guardConnectionError);
            this.player.off("error", this.guardPlayerError);
        }
    }
}

export class DiscordVoiceConnector implements VoiceConnector {
    public async connect(channel: VoiceBasedChannel, signal: AbortSignal): Promise<VoiceOutput> {
        if (signal.aborted) throw new DOMException("音声接続を中止しました。", "AbortError");
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: false,
        });
        const readiness = new AbortController();
        const failed = () => readiness.abort();
        connection.on("error", failed);
        const abort = () => {
            readiness.abort();
            if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
        };
        signal.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(() => readiness.abort(), 15_000);
        timeout.unref();
        try {
            if (signal.aborted) abort();
            await entersState(connection, VoiceConnectionStatus.Ready, readiness.signal);
            if (signal.aborted) throw new DOMException("音声接続を中止しました。", "AbortError");
            const player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
            });
            connection.subscribe(player);
            return new DiscordVoiceOutput(connection, player);
        } catch (error) {
            abort();
            throw error;
        } finally {
            clearTimeout(timeout);
            signal.removeEventListener("abort", abort);
            connection.off("error", failed);
        }
    }
}
