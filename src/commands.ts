import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    SlashCommandBuilder,
} from "discord.js";

export const alarmCommand = new SlashCommandBuilder()
    .setName("alarm")
    .setDescription("目覚ましを設定・操作します")
    .addSubcommand((command) => command
        .setName("set")
        .setDescription("次の目覚ましを設定します")
        .addStringOption((option) => option
            .setName("time")
            .setDescription("時刻（HH:mm）")
            .setRequired(true))
        .addStringOption((option) => option
            .setName("url")
            .setDescription("YouTube動画のURL")))
    .addSubcommand((command) => command.setName("show").setDescription("予約と直近の結果を表示します"))
    .addSubcommand((command) => command.setName("cancel").setDescription("待機中の予約を取り消します"))
    .addSubcommand((command) => command.setName("test").setDescription("前回の曲を設定した時間まで試聴します"))
    .addSubcommand((command) => command.setName("stop").setDescription("準備中・再生中の音声を停止します"))
    .addSubcommand((command) => command.setName("snooze").setDescription("5分後に再度鳴らします"));

export function confirmationButtons(token: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`alarm:confirm:${token}`)
            .setLabel("この内容で登録")
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`alarm:dismiss:${token}`)
            .setLabel("取り消す")
            .setStyle(ButtonStyle.Secondary),
    );
}

export function playbackButtons(runId: string, allowSnooze: boolean): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`alarm:stop:${runId}`)
            .setLabel("停止")
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`alarm:snooze:${runId}`)
            .setLabel("5分スヌーズ")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!allowSnooze),
    );
}
