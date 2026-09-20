import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    type ButtonInteraction,
    type Interaction,
} from "discord.js";
import type { AppConfig } from "./config.ts";
import type { AlarmRuntime } from "./runtime.ts";

const BUTTON_ID = /^alarm:(stop|snooze):([^:]{1,80})$/;

export function playbackButtons(runId: string, allowSnooze: boolean): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`alarm:stop:${runId}`)
            .setLabel("停止して終了")
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`alarm:snooze:${runId}`)
            .setLabel("5分スヌーズ")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!allowSnooze),
    );
}

export function isPlaybackButton(interaction: Interaction): interaction is ButtonInteraction {
    return interaction.isButton() && BUTTON_ID.test(interaction.customId);
}

export async function handlePlaybackButton(
    interaction: ButtonInteraction,
    config: AppConfig,
    runtime: AlarmRuntime,
    getState: () => "ready" | "starting" | "exiting",
): Promise<void> {
    const [, action, runId] = BUTTON_ID.exec(interaction.customId)!;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const state = getState();
    let content: string;
    if (interaction.guildId !== config.guildId) {
        content = "このサーバーのアラームだけ操作できます。";
    } else if (state === "exiting") {
        content = "Botの終了処理中です。";
    } else if (state === "starting" || !runtime.isConnected) {
        content = "Botの接続準備中です。少し待ってから操作してください。";
    } else if (runtime.activeRunId !== runId) {
        content = "このアラームは終了しています。現在の通知を確認してください。";
    } else if (action === "stop") {
        content = await runtime.stop(runId!)
            ? "アラームを停止しました。" : "このアラームは終了しています。";
    } else {
        const result = await runtime.snooze(runId!);
        if (result.kind === "saved") {
            content = "5分後にアラームを再設定しました。";
        } else if (result.kind === "limit") {
            content = "スヌーズの上限に達しました。";
        } else if (result.kind === "stale") {
            content = "このアラームは終了しています。";
        } else {
            content = "スヌーズを保存できませんでした。予約状態を確認してください。";
        }
    }
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
}
