import { randomUUID } from "node:crypto";
import {
    MessageFlags,
    type ButtonInteraction,
    type ChatInputCommandInteraction,
    type Interaction,
    type InteractionEditReplyOptions,
    type InteractionReplyOptions,
} from "discord.js";
import type { AppConfig } from "./config.ts";
import { confirmationButtons } from "./commands.ts";
import type { ActiveSnapshot, VideoChoice } from "./domain.ts";
import type { AlarmStore } from "./repository.ts";
import { formatAlarmDate, nextOccurrence } from "./time.ts";
import { prepareReservation, saveReservation } from "./reservation.ts";

interface VideoProbe {
    probe(url: string, signal?: AbortSignal): Promise<VideoChoice>;
}

export interface AlarmOperations {
    readonly activeAudioMode: "alarm" | "preview" | null;
    readonly activeRunId: string | null;
    startPreview(video: VideoChoice, notificationChannelId: string): Promise<
        { kind: "started" | "no-voice" | "busy" | "failed" }
    >;
    stop(runId: string): Promise<boolean>;
    snooze(runId: string): Promise<
        | { kind: "saved"; scheduledAtMs: number }
        | { kind: "stale" }
        | { kind: "limit"; count: number }
        | { kind: "failed" }
    >;
}

interface PendingConfirmation {
    token: string;
    expiresAtMs: number;
    timeInput: string;
    scheduledAtMs: number;
    channelId: string;
    video: VideoChoice;
    expected: ActiveSnapshot | null;
    previousDescription: string;
}

type SupportedInteraction = ChatInputCommandInteraction | ButtonInteraction;

export class AlarmInteractionHandler {
    private readonly confirmations = new Map<string, PendingConfirmation>();
    private readonly config: AppConfig;
    private readonly repository: AlarmStore;
    private readonly videoProbe: VideoProbe;
    private readonly operations: AlarmOperations;
    private readonly now: () => number;

    public constructor(
        config: AppConfig,
        repository: AlarmStore,
        videoProbe: VideoProbe,
        operations: AlarmOperations,
        now: () => number = Date.now,
    ) {
        this.config = config;
        this.repository = repository;
        this.videoProbe = videoProbe;
        this.operations = operations;
        this.now = now;
    }

    public async handle(interaction: Interaction): Promise<void> {
        if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
        if (interaction.guildId !== this.config.guildId || interaction.user.id !== this.config.ownerId) {
            await this.reply(interaction, "この操作は設定済みの本人とサーバーでだけ利用できます。");
            return;
        }
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName !== "alarm") return;
            await this.handleCommand(interaction);
        } else {
            await this.handleButton(interaction);
        }
    }

    private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
        const subcommand = interaction.options.getSubcommand();
        if (!["set", "show", "cancel", "test", "stop", "snooze"].includes(subcommand)) return;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        switch (subcommand) {
            case "set":
                await this.handleSet(interaction);
                break;
            case "show":
                await this.handleShow(interaction);
                break;
            case "cancel":
                await this.handleCancel(interaction);
                break;
            case "test":
                await this.handlePreview(interaction);
                break;
            case "stop":
                await this.handleStop(interaction, null);
                break;
            case "snooze":
                await this.handleSnooze(interaction, null);
                break;
        }
    }

    private async handleSet(interaction: ChatInputCommandInteraction): Promise<void> {
        if (this.operations.activeAudioMode !== null) {
            await this.reply(interaction, "音声処理が進行中です。先に `/alarm stop` を実行してください。");
            return;
        }
        const timeInput = interaction.options.getString("time", true);
        const url = interaction.options.getString("url");
        let prepared;
        try {
            prepared = await prepareReservation({
                time: timeInput, url: url ?? undefined, channelId: interaction.channelId,
            }, this.config, this.repository, this.videoProbe, this.now());
        } catch (error) {
            await this.edit(interaction, error instanceof Error ? error.message : "予約案を確認できませんでした。");
            return;
        }

        const token = randomUUID();
        const previousDescription = prepared.previous
            ? `${formatAlarmDate(prepared.previous.scheduledAtMs, prepared.previous.timeZone)} / ${prepared.previous.videoTitle}`
            : "なし";
        const pending: PendingConfirmation = {
            token,
            expiresAtMs: this.now() + this.config.confirmationTtlMs,
            timeInput,
            scheduledAtMs: prepared.alarm.scheduledAtMs,
            channelId: interaction.channelId,
            video: {
                videoId: prepared.alarm.videoId,
                videoUrl: prepared.alarm.videoUrl,
                videoTitle: prepared.alarm.videoTitle,
            },
            expected: prepared.expected,
            previousDescription,
        };
        this.confirmations.set(token, pending);
        this.expireConfirmation(token, pending.expiresAtMs);
        await this.edit(interaction, this.confirmationMessage(pending), [confirmationButtons(token)]);
    }

    private expireConfirmation(token: string, expiresAtMs: number): void {
        const timer = setTimeout(() => {
            if (this.confirmations.get(token)?.expiresAtMs === expiresAtMs) {
                this.confirmations.delete(token);
            }
        }, Math.max(0, expiresAtMs - this.now()));
        timer.unref();
    }

    private confirmationMessage(pending: PendingConfirmation): string {
        return [
            "次の内容で予約します。2分以内に確認してください。",
            `新しい予約: ${formatAlarmDate(pending.scheduledAtMs, this.config.timeZone)} / ${pending.video.videoTitle}`,
            `タイムゾーン: ${this.config.timeZone}`,
            `通知先チャンネルID: ${pending.channelId}`,
            `変更前: ${pending.previousDescription}`,
        ].join("\n");
    }

    private async handleShow(interaction: ChatInputCommandInteraction): Promise<void> {
        const active = await this.repository.getActive();
        const latest = await this.repository.getLatestResult();
        const lines = [
            active
                ? `現在: ${active.status} / ${formatAlarmDate(active.scheduledAtMs, active.timeZone)} / ${active.videoTitle}`
                : "現在の予約はありません。",
        ];
        if (active?.notificationError) lines.push(`通知: ${active.notificationError}`);
        if (latest) {
            lines.push(`直近: ${latest.status} / 理由: ${latest.stopReason ?? "記録なし"}`);
            if (latest.lastError) lines.push(`音声: ${latest.lastError}`);
            if (latest.notificationError) lines.push(`通知: ${latest.notificationError}`);
        }
        await this.reply(interaction, lines.join("\n"));
    }

    private async handleCancel(interaction: ChatInputCommandInteraction): Promise<void> {
        const active = await this.repository.getActive();
        if (active?.status === "STARTING" || active?.status === "PLAYING") {
            await this.reply(interaction, "準備中または再生中です。`/alarm stop` を実行してください。");
            return;
        }
        const cancelled = await this.repository.cancelWaiting(this.now());
        await this.reply(interaction, cancelled ? "予約を取り消しました。" : "待機中の予約はありません。");
    }

    private async handlePreview(interaction: ChatInputCommandInteraction): Promise<void> {
        const video = await this.repository.getLastVideo();
        if (!video) {
            await this.reply(interaction, "試聴する曲がありません。先に予約を登録してください。");
            return;
        }
        const result = await this.operations.startPreview(video, interaction.channelId);
        const messages = {
            started: `${this.config.previewSeconds}秒を上限に試聴を開始します。停止は \`/alarm stop\` です。`,
            "no-voice": "先にボイスチャンネルへ参加してください。",
            busy: "別の音声処理が進行中です。",
            failed: "試聴を開始できませんでした。",
        } as const;
        await this.reply(interaction, messages[result.kind]);
    }

    private async handleStop(interaction: SupportedInteraction, requestedRunId: string | null): Promise<void> {
        const runId = requestedRunId
            ?? (this.operations.activeAudioMode === "preview" ? "preview"
                : this.operations.activeRunId ?? (await this.repository.getActive())?.id ?? "preview");
        const stopped = await this.operations.stop(runId);
        await this.reply(interaction, stopped ? "停止を受け付けました。" : "対象の音声処理は終了しています。");
    }

    private async handleSnooze(interaction: SupportedInteraction, requestedRunId: string | null): Promise<void> {
        const active = await this.repository.getActive();
        const runId = requestedRunId ?? active?.id;
        if (!runId) {
            await this.reply(interaction, "スヌーズできるアラームはありません。");
            return;
        }
        const result = await this.operations.snooze(runId);
        const message = result.kind === "saved"
            ? `音声を停止し、${formatAlarmDate(result.scheduledAtMs, this.config.timeZone)}にスヌーズしました。`
            : result.kind === "limit"
                ? `スヌーズは${result.count}回で上限です。`
                : result.kind === "failed"
                    ? "スヌーズを保存できませんでした。`/alarm show`で状態を確認してください。"
                    : "この操作画面のアラームは終了しています。";
        await this.reply(interaction, message);
    }

    private async handleButton(interaction: ButtonInteraction): Promise<void> {
        const [namespace, action, token] = interaction.customId.split(":");
        if (namespace !== "alarm" || !action || !token) return;
        if (action === "stop") {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await this.handleStop(interaction, token);
            return;
        }
        if (action === "snooze") {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await this.handleSnooze(interaction, token);
            return;
        }
        const pending = this.confirmations.get(token);
        if (!pending || pending.token !== token || pending.expiresAtMs < this.now()) {
            this.confirmations.delete(token);
            await this.reply(interaction, "この確認画面は期限切れです。もう一度設定してください。");
            return;
        }
        if (action === "dismiss") {
            this.confirmations.delete(token);
            await this.reply(interaction, "登録を取り消しました。既存の予約は変更していません。");
            return;
        }
        if (action !== "confirm") return;
        if (pending.scheduledAtMs <= this.now()) {
            this.confirmations.delete(token);
            const replacement = {
                ...pending,
                token: randomUUID(),
                scheduledAtMs: nextOccurrence(pending.timeInput, this.config.timeZone, this.now()),
                expiresAtMs: this.now() + this.config.confirmationTtlMs,
            };
            this.confirmations.set(replacement.token, replacement);
            this.expireConfirmation(replacement.token, replacement.expiresAtMs);
            await this.reply(
                interaction,
                `予定時刻を過ぎたため、次の日時へ変更しました。\n${this.confirmationMessage(replacement)}`,
                [confirmationButtons(replacement.token)],
            );
            return;
        }

        this.confirmations.delete(token);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await saveReservation(this.repository, { alarm: {
            ...pending.video,
            id: randomUUID(),
            scheduledAtMs: pending.scheduledAtMs,
            timeZone: this.config.timeZone,
            notificationChannelId: pending.channelId,
            createdAtMs: this.now(),
        }, expected: pending.expected });
        if (result.kind === "busy") {
            await this.reply(interaction, "アラームの準備または再生が始まりました。停止後に設定してください。");
        } else if (result.kind === "stale") {
            await this.reply(interaction, "予約が別の操作で変更されました。`/alarm show`で確認してからやり直してください。");
        } else {
            await this.reply(
                interaction,
                `予約しました。ID: ${result.alarm.id}\n${formatAlarmDate(result.alarm.scheduledAtMs, result.alarm.timeZone)} / ${result.alarm.videoTitle}`,
            );
        }
    }

    private async reply(
        interaction: SupportedInteraction,
        content: string,
        components: InteractionReplyOptions["components"] = [],
    ): Promise<void> {
        const payload: InteractionReplyOptions = {
            content,
            components,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        };
        if (interaction.deferred && !interaction.replied) {
            await interaction.editReply({ content, components, allowedMentions: { parse: [] } });
        } else if (interaction.replied) {
            await interaction.followUp(payload);
        } else {
            await interaction.reply(payload);
        }
    }

    private async edit(
        interaction: ChatInputCommandInteraction,
        content: string,
        components: InteractionEditReplyOptions["components"] = [],
    ): Promise<void> {
        await interaction.editReply({ content, components, allowedMentions: { parse: [] } });
    }
}
