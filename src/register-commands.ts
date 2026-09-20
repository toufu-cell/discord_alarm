import { REST, Routes } from "discord.js";
import { alarmCommand } from "./commands.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const rest = new REST({ version: "10" }).setToken(config.discordToken);
await rest.put(
    Routes.applicationGuildCommands(config.applicationId, config.guildId),
    { body: [alarmCommand.toJSON()] },
);
console.log("指定したサーバーへコマンドを登録しました。");

