# 個人用Discord目覚ましBot

指定した時刻に、本人が参加しているボイスチャンネルでYouTube動画の音声を流すBotです。曲は最大15分間繰り返します。YouTubeを再生できない回はFFmpegで生成した内蔵音へ切り替えます。通知先は予約したテキストチャンネルです。

現在はMac上のSQLiteと[ローカルCLI](docs/local-cli.md)を利用します。予約確定時にBotを起動し、最後の予約と音声処理が完了すると自動終了します。呼出元の終了後もBotは稼働します。専用DBでDiscord接続、VC再生、スヌーズ、取消、明示終了を実機確認しました。本番DBの予約は変更していません。スキルは別作業で新規作成します。

```sh
/Users/k23062kk/git/discord_alarm/bin/alarm prepare --at 2026-09-21T07:00 --url 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
/Users/k23062kk/git/discord_alarm/bin/alarm confirm <proposalId>
/Users/k23062kk/git/discord_alarm/bin/alarm status
```

`prepare`の予約案を確認してから`confirm`へ案のIDを渡します。初回の設定では`.env`にDiscord接続情報を指定します。通知先は`ALARM_NOTIFICATION_CHANNEL_ID`または`prepare --channel`で指定します。コマンドの全引数、JSON、終了コードは[ローカルCLI仕様](docs/local-cli.md)を参照してください。`npm test`、`npm run diagnose`、`npm run verify:youtube`はDiscordへ接続しません。

## 過去のCloudflare計画と検証記録

Cloudflare Workersが管理APIと単一のContainerを制御し、予約と曲をD1へ保存します。ContainerはNode.js 24でDiscord Gatewayへ接続します。Durable Objectは固定名`discord-alarm`の1つだけを使用し、`max_instances`を1に設定しています。内部D1 APIはContainerから仮想ホスト`alarm-d1.internal`へ送る要求だけを受け付けます。公開Workerには`start`、`status`、`stop`以外の管理操作を設けていません。

初期サイズは`basic`（1/4 vCPU、1 GiB）です。常時稼働には使用量に応じた料金が発生します。[Containerのサイズ](https://developers.cloudflare.com/containers/platform/limits/)と[料金](https://developers.cloudflare.com/containers/platform/pricing/)を確認してください。

Macでlinux/amd64イメージを変換実行した制限付き試験では、`lite`相当と`basic`相当の両方でメタデータ取得が時間切れになりました。linux/arm64の`native-check`イメージでも制限を変えて試しました。CPU 0.0625、メモリとmemory-swap 256 MiBではFFmpegが途中終了しました。CPU 0.25、メモリとmemory-swap 1 GiBでは`verify-youtube.ts`が成功し、187,956バイトを出力しました。Cloudflare上での成功は未検証です。

事前にWorkers Paidへの加入が必要です。現在のアカウントではContainers APIが未加入を理由に拒否したため、Cloudflare上での起動、Discord音声、DAVE、長時間稼働は未検証です。

### 準備と初回移行

1. Discord Botを作成し、下記の4つのDiscord設定値を用意します。`npm run register`はBot情報をローカルの`.env`へ設定してから一度だけ実行します。
2. `npm ci`の後、`npx wrangler d1 create discord-alarm`で専用D1を作成し、返されたIDを[wrangler.jsonc](wrangler.jsonc)の`database_id`へ設定します。既存の`kotaichi`リソースは使用しません。
3. 管理Tokenを16文字以上で作り、`npx wrangler secret put ALARM_ADMIN_TOKEN`で登録します。管理CLIにも同じ値を環境変数で渡します。
   Discordの4つの設定値も`npx wrangler secret put`で登録します。各変数名は[.env.example](.env.example)で確認できます。TokenをCLI引数やリポジトリへ保存しないでください。
4. ローカルSQLiteから引き継ぐ場合はBotを停止し、元DBをバックアップします。`mkdir -p backups`の後、`npm run export:sqlite -- data/alarm.sqlite backups/alarm-import.sql`でSQLを作成します。元DBは保持します。D1に既存の予約がないことを確認してから、schemaとデータを順に適用します。

[wrangler.jsonc](wrangler.jsonc)の`vars`でタイムゾーン、音量、スヌーズ上限、試聴秒数を設定できます。Workerがこれらの値をContainerへ渡します。変更後は再deployしてください。[Containerの環境変数](https://developers.cloudflare.com/containers/configuration/environment-variables/)を参照してください。

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm ci
npm run check
npx wrangler deploy --dry-run
npx wrangler d1 migrations apply discord-alarm --remote
npx wrangler d1 execute discord-alarm --remote --command "SELECT COUNT(*) AS count FROM alarms;"
npx wrangler d1 execute discord-alarm --remote --file backups/alarm-import.sql
```

旧SQLiteのデータがない場合は最後の`--file`を省きます。移行SQLには予約履歴と前回の曲が含まれるため、ファイルの共有範囲を限定してください。D1への適用後は件数と予約内容を確認し、元DBとバックアップを保持してください。

### 更新と起動

Workerと旧Containerが更新中に混在するため、内部APIの版を`1`に固定しています。版が合わない要求は拒否されます。更新時は次の順序を守ります。`status`はContainerを起動しません。

```sh
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm ci
export ALARM_WORKER_URL="https://<worker-url>"
read -r -s ALARM_ADMIN_TOKEN
export ALARM_ADMIN_TOKEN
npm run bot -- stop
mkdir -p backups
npx wrangler d1 export discord-alarm --remote --output backups/d1-before-update.sql
npx wrangler d1 migrations apply discord-alarm --remote
npx wrangler deploy --dry-run
npx wrangler deploy
npm run bot -- status
npm run bot -- start
npm run bot -- status
```

初回deploy時は旧Containerがないため、`stop`を省けます。`npx wrangler deploy`はCloudflareへWorkerとイメージを公開する操作です。更新後、`status`で`healthy`と`enabled: true`を確認します。起動失敗はwatchdogが約60秒後に再試行します。管理`stop`では有効化フラグを消し、watchdogの再起動を止めます。D1変更の応答が不明になった場合、Botは音声を止めて終了します。再起動時に`STARTING`と`PLAYING`を`INTERRUPTED`へ移し、`WAITING`には180秒の遅延規則を適用します。操作の自動再送はしません。利用者は`/alarm show`で状態を確認してください。

### バックアップと復元

D1は`npx wrangler d1 export discord-alarm --remote --output backups/d1-YYYYMMDD.sql`でSQLを保存します。復元時はBotを`stop`し、新しいD1を作成してエクスポートSQLを`npx wrangler d1 execute <新DB名> --remote --file <SQL>`で適用します。件数を確認し、`wrangler.jsonc`のIDを新DBへ切り替えてdeployし、`status`から`start`へ進みます。[D1のインポートとエクスポート](https://developers.cloudflare.com/d1/best-practices/import-export-data/)も参照してください。

### 準備確認と音声確認

Discord Botの設定前でもLinux/amd64イメージ内で依存とUDPを確認できます。UDP試験の宛先はCloudflare公式の`stun.cloudflare.com:3478`に固定しています。一般のUDP応答とDiscord音声成功は別の確認項目です。

```sh
docker build --platform linux/amd64 -t discord-alarm:check .
docker run --rm --platform linux/amd64 -e YTDLP_PATH=/opt/discord-alarm/.venv/bin/yt-dlp \
    --entrypoint node discord-alarm:check src/diagnose.ts --udp
docker run --rm --platform linux/amd64 -e YTDLP_PATH=/opt/discord-alarm/.venv/bin/yt-dlp \
    --entrypoint node discord-alarm:check src/verify-youtube.ts
```

Discord音声は、Bot作成後にCloudflare上のBotで`/alarm test`と実際の予約を使用して確認します。本人のVCでYouTube音声、内蔵音、停止、移動、スヌーズ、DAVE、長時間稼働を試します。UDP応答やローカルの音源変換だけでは、これらの成功を判断できません。

## 1. DiscordのBotを作成する

1. [Discord Developer Portal](https://discord.com/developers/applications)を開き、`New Application`から自分用のアプリを作ります。`General Information`の`Application ID`を控えます。
2. `Bot`ページでBot Tokenを発行して、安全な場所へ保管します。Tokenは第三者へ渡さず、画面共有やログ、Gitの管理対象へ載せないでください。漏れた場合は同じページで再発行します。
3. `Installation`ページで`Guild Install`を有効にします。Guild用のスコープは`bot`と`applications.commands`を指定します。Botの権限は`View Channels`、`Send Messages`、`Connect`、`Speak`を付けます。対象のテキストチャンネルとボイスチャンネルでも、これらの権限を確認してください。`Administrator`や`Move Members`は必要ありません。
4. `Installation`のリンクから、Botを目覚まし専用のサーバーへ追加します。サーバーの管理権限が必要です。
5. Discordアプリで`Developer Mode`を有効にします。サーバー名を右クリックして`Copy Server ID`、自分のユーザー名を右クリックして`Copy User ID`を選びます。スマートフォンの場合は長押しのメニューからIDをコピーします。

手順の根拠: [DiscordのBot作成ガイド](https://docs.discord.com/developers/quick-start/getting-started)、[DiscordのID確認方法](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID)。公式ガイドにあるHTTP用の`Interactions Endpoint URL`、`Public Key`、ngrokは、このBotでは不要です。BotはGateway接続でコマンドとボタンを受け取ります。`Message Content`などの特権Intentも使用しません。

## 2. Macで準備する

Node.js 24、npm、FFmpeg、Deno、Python 3と`venv`を用意します。Homebrewを使用するMacでは、次のコマンドで導入できます。

```sh
brew install node@24 ffmpeg deno python@3.14
```

確認済みの環境はmacOS arm64、Node.js 24.14.1、npm 11.11.0、FFmpeg 7.1.1、Deno 2.7.4です。Node.jsの標準`node:sqlite`を使用するため、起動時に実験的機能の警告が出ます。

以下の例では、作業するターミナルでNode.js 24を選べるように`PATH`を設定します。

```sh
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
node --version
npm ci
python3.14 -m venv .venv
.venv/bin/python -m pip install -r requirements-media.txt
npm run diagnose
npm run check
```

`node --version`が`v24`で始まることを確認してください。シェルやMacの構成によって、選ばれるNode.jsの場所が異なります。上記の`PATH`はApple SiliconのHomebrewを使用する場合の例です。

`diagnose`は接続情報が空でもFFmpeg、yt-dlp、yt-dlp-ejs、Deno、DAVE、SQLiteを調べます。接続情報は未設定の変数名だけを表示し、値は表示しません。

`.env`がない場合だけ、次のコマンドでひな型をコピーしてください。既存の`.env`や同名のシンボリックリンクは保持します。

```sh
if [ ! -e .env ] && [ ! -L .env ]; then
    cp .env.example .env
    chmod 600 .env
fi
```

作成後は`DISCORD_TOKEN`、`DISCORD_APPLICATION_ID`、`DISCORD_GUILD_ID`、`DISCORD_OWNER_ID`に、前節で取得した値を入力します。`.env`はGitの管理対象から除外しています。

`.env.example`に任意設定を記載しています。初期値は`ALARM_TIME_ZONE=Asia/Tokyo`と`ALARM_VOLUME_PERCENT=35`です。`ALARM_SNOOZE_LIMIT=3`、`ALARM_PREVIEW_SECONDS=30`も初期値です。時刻は設定したタイムゾーンで表示し、DBへはUTCの時刻を数値で保存します。

## 3. ローカル開発でBotを起動する

Discordコマンドの登録は手動実行だけで、起動時には書き換えません。`npm start`は開発時にBotを直接起動する方法です。通常の予約ではローカルCLIを使用します。

```sh
npm run register
npm start
```

登録先は`DISCORD_GUILD_ID`のサーバーだけです。Botを同じDBで二重起動すると後発のプロセスは終了します。設定値を変更したときはBotを停止し、再起動してください。

## 4. 操作する

対象サーバーのテキストチャンネルで本人だけが操作できます。

```text
/alarm set time:07:30 url:https://www.youtube.com/watch?v=jNQXAC9IVRw
/alarm set time:07:30
/alarm show
/alarm cancel
/alarm test
/alarm stop
/alarm snooze
```

`set`は次に来る指定時刻と曲、変更前の予約を確認画面に表示します。2分以内に「この内容で登録」を押してください。初回はURLが必要です。以後は省略すると最後に登録した曲を使います。時刻を過ぎた確認画面は新しい日時を示し、再度確認を求めます。準備中・再生中の登録は、先に`/alarm stop`を実行してください。

予定時刻に本人がVCへ参加していなければ通知だけを送ります。通知が送れなくても音声は続き、`/alarm show`で通知失敗を確認できます。通知のボタンかコマンドで停止・5分スヌーズできます。本人が再生先から移動・退出した場合も停止します。スヌーズの上限は初期値で3回です。

## 5. 就寝前に実際の音声を確認する

この確認は利用者と時機を合わせて行います。接続情報の入力だけではコマンド登録や接続は実行されません。

1. 自分のボイスチャンネルへ入り、Botを起動します。`/alarm set`で数分後の時刻を登録して確定します。
2. `/alarm test`で音量を確認し、`/alarm stop`で終了します。実際に寝る端末の音量とミュート状態でも確認します。
3. 指定時刻にYouTube音声が聞こえるか確認します。曲の繰り返し、停止ボタン、スヌーズ、移動・退出時の停止も試します。
4. 音源を取得できない場合の内蔵音、通知権限がない場合、本人がVCにいない場合も確認します。
5. `/alarm show`で結果を確認し、BotがVCから退出していることを確認します。

ネットワークだけの技術確認には`npm run verify:youtube`を使います。公開動画の取得とFFmpegによるOpus変換を試します。公開動画`jNQXAC9IVRw`では187,976 bytesのOgg Opus出力を確認しました。動画が見られなくなった場合は動画URLを引数に指定してください。この操作はDiscordへ送信しません。

## 6. バックアップと復元

Botを稼働したままDBを保存する場合はSQLiteのバックアップ機能を使います。例のファイル名は毎回変更し、既存ファイルを上書きしません。

```sh
npm run backup -- backups/alarm-20260919.sqlite
npm run restore -- backups/alarm-20260919.sqlite data/restored.sqlite
```

復元先は新しいDBファイルにします。Botを停止し、`ALARM_DATABASE_PATH=./data/restored.sqlite`を設定してから起動します。元のDBは残したまま、`/alarm show`で予約と曲を確認してください。バックアップファイルはTokenと同様に共有範囲を限定してください。予約した動画とサーバーのIDが含まれます。

## 7. Macでの稼働条件

MacがスリープするとBotもアラームを処理できません。必要に応じ、就寝中だけ次のコマンドでシステムのアイドルスリープを防止します。Macの電源、ネットワーク、Discord端末の通知・音量も確認してください。

```sh
caffeinate -i npm start
```

Macの再起動後に待機予約が残る場合は、ローカルCLIの`resume`を実行します。準備中・再生中の予約は中断として記録し、自動で鳴らし直しません。まだ待機中の予約は、予定時刻から180秒以内なら実行し、それより遅れたら通知して終了します。

YouTube側の仕様や利用条件によって、動画を取得できないことがあります。再生の技術的な成功と動画の利用許諾は別です。[YouTube利用規約](https://www.youtube.com/static?template=terms)を確認し、自分が利用できる動画を指定してください。
