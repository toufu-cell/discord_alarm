# Discord目覚ましBot

エージェントが`bin/alarm`のJSON CLIから予約する、macOS用の目覚ましBotです。指定時刻に本人のボイスチャンネルでYouTube音声を流します。取得や再生に失敗した場合は内蔵音へ切り替えます。予約と操作結果はローカルのSQLiteへ保存します。

## Discord Botを用意する

1. [Discord Developer Portal](https://discord.com/developers/applications)でアプリを作成し、BotのTokenを取得します。[公式の作成ガイド](https://docs.discord.com/developers/quick-start/getting-started)に沿って進めてください。
2. InstallationでGuild Installを有効にし、botスコープを選びます。BotにはView Channels、Send Messages、Connect、Speakを付け、使用するサーバーへインストールします。
3. Discordの開発者モードを有効にし、サーバー、本人、通知先テキストチャンネルのIDを取得します。[IDの取得方法](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID)を参照してください。

BotはGatewayのGuildsとGuildVoiceStatesを使用します。予約と起動はCLIで行います。再生中の操作には通知のボタンを使えます。Discordコマンドの登録は必要ありません。

## Macへ依存を導入する

Node.js 24、npm、FFmpeg、Deno、Python 3を用意します。Homebrewを使用する場合の例です。

```sh
brew install node@24 ffmpeg deno python@3.14
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
node --version
npm ci
python3.14 -m venv .venv
.venv/bin/python -m pip install -r requirements-media.txt
```

`node --version`が`v24`で始まることを確認してください。Intel MacではHomebrewの配置に合わせて`PATH`を設定します。`bin/alarm`は自身の場所からリポジトリを特定し、Homebrewと呼出元の`PATH`からNode.jsを探します。

`.env`が存在しない場合だけ、ひな型をコピーします。既存ファイルとシンボリックリンクは保持します。

```sh
if [ ! -e .env ] && [ ! -L .env ]; then
    cp .env.example .env
    chmod 600 .env
fi
```

`.env`に`DISCORD_TOKEN`、`DISCORD_GUILD_ID`、`DISCORD_OWNER_ID`、`ALARM_NOTIFICATION_CHANNEL_ID`を設定します。`DISCORD_OWNER_ID`は再生先のVCを探す本人のIDです。通知先IDは予約時の`--channel`でも指定できます。`.env`はGitの管理対象から除外されています。`ALARM_TIME_ZONE`、`ALARM_VOLUME_PERCENT`、`ALARM_SNOOZE_LIMIT`、`ALARM_DATABASE_PATH`は任意設定です。

依存と設定は`npm run diagnose`で確認できます。コードとFake Discordのテストは`npm run check`で確認できます。

## エージェントから予約する

エージェントには、このリポジトリの`bin/alarm`の絶対パスと[CLI契約](docs/local-cli.md)を渡します。別の作業ディレクトリからも同じパスで実行できます。

1. `bin/alarm prepare --time 07:00 --url 'https://www.youtube.com/watch?v=jNQXAC9IVRw'`で予約案を作ります。日付を指定するときは`--at YYYY-MM-DDTHH:mm`を使います。
2. 返された日時、曲、通知先が依頼と一致することを確認します。日時と曲が明確な予約依頼には確定の指示も含まれます。案だけを求められた場合や必要事項が曖昧な場合は、確定前に確認します。
3. `bin/alarm confirm <proposalId>`で確定します。Botは独立したプロセスとして起動し、呼出元が終了しても予約を処理します。
4. `bin/alarm status`で予約とBotの状態を確認します。CLIで変更する場合は、返された`operationId`と対象IDを使います。

`confirm`は予約日時、タイムゾーン、曲名、動画URLを通知先へ送ります。`saved:true`は予約保存の結果です。通知に失敗した場合は`status`の`active.notificationError`で確認できます。同じ`proposalId`の再送は既存の予約結果を返します。

本人は予定時刻までにボイスチャンネルへ入ってください。本人が移動するとBotは再生を停止します。退出した場合も停止します。再生通知には「停止して終了」と「5分スヌーズ」のボタンが付きます。設定サーバーで通知を見られる人なら誰でも操作できます。スヌーズの上限に達するとボタンは無効になります。

停止後、有効な予約がなく、通知とボタンへの応答が完了するとBotは自動終了します。操作中に新しい予約が確定していれば、その予約を保持して稼働を続けます。スヌーズ後も5分後の予約を保持して稼働を続けます。エージェントはCLIの`stop`と`snooze`も使用できます。

Macがスリープすると時刻どおりに処理できません。就寝中はMacのスリープを防ぎ、ネットワークと音量を確認してください。別のターミナルで`caffeinate -i`を実行すると、終了するまでアイドルスリープを防げます。Macの再起動後に待機予約がある場合は`bin/alarm resume`を実行します。予定時刻から180秒を超えた待機予約は再生せず、準備中または再生中に中断した予約は記録して終了します。
