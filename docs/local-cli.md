# ローカル目覚ましCLI

`/Users/k23062kk/git/discord_alarm/bin/alarm`を絶対パスで呼びます。この実行ファイルはリポジトリの`.env`とNode.js 24を読み、実行時の作業ディレクトリと呼出元の`PATH`に依存しません。通知先は`ALARM_NOTIFICATION_CHANNEL_ID`または`prepare --channel`で指定します。予約案に通知先を保存するため、明示指定した案の`confirm`と保存済み予約の`resume`に通知先の環境変数は必要ありません。

## 操作

| コマンド | 引数 | 結果 |
| --- | --- | --- |
| `prepare` | `--at YYYY-MM-DDTHH:mm`または`--time HH:mm`、任意で`--url URL`、`--channel ID` | 予約案をSQLiteへ保存し、`proposalId`と期限を返す |
| `confirm` | `proposalId` | Botを必要に応じて独立起動し、Bot側で予約を確定する |
| `status` | なし | 稼働状態、Discord接続、現在の予約、音声ID、直近の結果、変更操作用のUUIDを返す |
| `stop` | `--operation-id UUID --target-id ID` | 指定した予約または試聴の音声を止める |
| `cancel` | `--operation-id UUID --target-id ID` | 指定した待機予約を取り消す |
| `snooze` | `--operation-id UUID --target-id ID` | 指定した進行中のアラームを5分後に移す |
| `exit` | `--operation-id UUID` | Botを終了し、待機中の予約を保持する |
| `result` | `operationId` | 変更操作の保存済み結果を取得する |
| `resume` | なし | 待機中の予約を処理するBotを起動する |
| `diagnose` | なし | 設定名と依存関係の診断結果を返す |

`--at`は`ALARM_TIME_ZONE`の現地日時です。日付の省略やUTCオフセットは受け付けません。`--time`は次に来る時刻を選びます。「明日」のように日付が指定された依頼には`--at`を使います。`--url`の省略時は最後に確定した曲を使います。初回はYouTube動画のURLが必要です。

```sh
/Users/k23062kk/git/discord_alarm/bin/alarm prepare --at 2026-09-21T07:00 --url 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
/Users/k23062kk/git/discord_alarm/bin/alarm confirm <proposalId>
/Users/k23062kk/git/discord_alarm/bin/alarm status
```

`prepare`の結果を利用者へ示し、確定指示の後に同じ`proposalId`で`confirm`します。案の有効期間は2分です。日時が過ぎた場合や元の予約が変わった場合は、新しい案を作って再確認します。確定済みの`proposalId`を再送しても、元の予約IDを返します。

変更操作の前に`status`を実行し、返された`operationId`を`--operation-id`へ渡します。`cancel`の対象は同じ結果の`active.id`です。`snooze`の対象は`audio.runId`です。`stop`は再生中なら`audio.runId`を使います。試聴の準備中で`runId`がまだない場合だけ、`--target-id preview`を使います。`exit`も`status.operationId`を使います。結果不明時の`result`と再送には、最初の操作IDと対象IDをそのまま使います。対象IDを固定した操作結果はSQLiteへ保存されます。別の対象へ同じ操作IDを使うと`operation_conflict`を返します。

## JSONと終了コード

標準出力は1行のJSONです。`ok`は今回の操作が成立したか、`code`は機械判定用の結果です。`running`はBotプロセス、`connected`はDiscord接続、`saved`は予約確定の結果を表します。`accepted`は変更操作をBotが受理したかを表します。`paused:true`は待機予約を保持したままBotが停止する状態です。停止中の予約は`resume`まで鳴りません。`status`の`active`は現在の予約、`latest`は直近の終了結果です。`audio`には音声の`mode`と`runId`が入ります。Bot停止中もSQLiteから`active`と`latest`を読みます。予約時刻と期限はUnix時刻のミリ秒です。

| 終了コード | 意味 | 主な`code` |
| --- | --- | --- |
| `0` | 操作成功 | `prepared`、`saved`、`replayed`、`ok`、`running`、`stopped`、`cancelled`、`exiting`、`already_stopped` |
| `2` | 入力または現在状態により操作不成立 | `invalid_or_failed`、`invalid_input`、`missing_configuration`、`invalid_configuration`、`missing`、`expired`、`elapsed`、`stale`、`busy`、`exiting`、`operation_conflict`、`missing_result`、`no_waiting`、`no_audio`、`limit`、`failed`、`no_reservation`、`diagnostic_failed` |
| `3` | Botの起動、接続、受付待ちを確認できない | `start_failed`、`starting` |
| `4` | 変更結果を判断できない | `result_unknown` |

`status`の`starting`は接続準備中の状態取得に成功した結果として終了コード`0`です。この間も`exit`と`cancel`を受け付けます。`confirm`、`stop`、`snooze`は準備完了まで受け付けず、`accepted:false`を返します。準備が終わらない`confirm`や`resume`は終了コード`3`の`start_failed`になります。

`prepare`は`ok`と`code`、`proposalId`、`expiresAtMs`、`alarm`、`previous`を返します。`alarm`には予約IDと予定時刻、タイムゾーン、曲、通知先が含まれます。`confirm`の成功時は`ok`と`code`、`saved`、`running`、`connected`、`alarm`を返します。

`confirm`の起動失敗時にも提案の保存結果をSQLiteで確認します。`saved:true`と`start_failed`は予約が保存されたもののBot起動を確認できない状態です。`saved:false`は予約が保存されていない状態です。結果が不明な場合は`saved`を省略します。稼働中のBotがDiscordから切断された場合、`saved:true`と`connected:false`を同時に返すことがあります。

`status`は`active`、`latest`、`audio`、新しい`operationId`を返します。`exiting:true`は終了処理中です。接続と復旧の準備中は`running:true`、`code:"starting"`で、`connected`がDiscord接続の状態を示します。`stop`と`snooze`は操作後の`active`を返します。`cancel`は取り消した`alarm`を返します。`exit`は応答時点の`active`を返し、`resume`は起動後の状態を返します。`result`は保存時点の応答を返します。`result.current`には現在の稼働状態を返します。

`diagnose`の`checks`は`name`、`ok`、`detail`を持つ診断結果の配列です。`missingVariables`は未設定のDiscord接続情報、`invalidVariables`は形式不正のDiscord IDを返します。通知先は`prepare`で検証します。操作対象がなければ、`active`や`alarm`は`null`か省略になります。

`confirm`の`result_unknown`では、同じ`proposalId`で再確認します。`stop`、`snooze`、`cancel`、`exit`の`result_unknown`では、`result <operationId>`と`status`で結果と対象予約を確認します。保存中の操作結果がなお不明な場合、別の操作IDで変更を再送せず、予約や音声の状態を確認してください。`exiting`と`accepted:false`は未受理です。`confirm`はBotの終了を待ってから起動し直します。`exit`の応答時点では終了処理中なので、`running:true`を返す場合があります。終了後の`status`では`running:false`となり、残る待機予約は`active`に表示されます。この予約は`resume`まで鳴りません。

Botは独立したプロセスグループで起動します。予約、再生、試聴、通知、操作への応答が終わり、有効な予約がなくなると自動終了します。待機予約やスヌーズが残れば稼働を続けます。異常終了後の待機予約は既存の180秒規則で復旧します。ログはSQLiteと同じディレクトリの`bot.log`へ保存します。

確定要求を待つ空のBotは、Discord接続が完了しない場合も起動から20秒で終了します。待機予約が保存されているBotは接続を待ち、復旧処理を続けます。接続前の`exit`は待機予約を保持し、最後の待機予約を`cancel`するとBotは自動終了します。

ローカルCLIはSQLiteを対象にします。CloudflareのD1運用と管理CLIには既存の操作方法を使います。スキルは別作業で新規作成します。
