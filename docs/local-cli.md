# 目覚ましCLI契約

リポジトリの`bin/alarm`を絶対パスで呼びます。実行ファイルは自身の場所から`.env`と実装を特定し、別の作業ディレクトリからも動きます。標準出力は1行のJSONです。予約と操作結果はSQLiteへ保存します。

| コマンド | 引数 | 結果 |
| --- | --- | --- |
| `prepare` | `--at YYYY-MM-DDTHH:mm`または`--time HH:mm`、任意で`--url URL`、`--channel ID` | 予約案を保存し、`proposalId`と期限を返す |
| `confirm` | `proposalId` | Botを独立起動し、予約を確定する |
| `status` | なし | 稼働状態、予約、音声の対象ID、直近の結果、操作用のUUIDを返す |
| `cancel` | `--operation-id UUID --target-id ID` | 指定した待機予約を取り消す |
| `stop` | `--operation-id UUID --target-id ID` | 指定した予約の音声を止める |
| `snooze` | `--operation-id UUID --target-id ID` | 指定したアラームを5分後に移す |
| `exit` | `--operation-id UUID` | 待機予約を保持してBotを終了する |
| `resume` | なし | 待機予約を処理するBotを起動する |
| `result` | `operationId` | 保存済みの操作結果を取得する |
| `diagnose` | なし | 依存と設定項目の診断結果を返す |

通知先は`ALARM_NOTIFICATION_CHANNEL_ID`または`prepare --channel`で指定します。`--at`は`ALARM_TIME_ZONE`の現地日時で、日付と時刻を指定します。`--time`は次に来る時刻を選びます。日付が指定された依頼には`--at`を使います。初回はYouTube動画の`--url`が必要です。以後、省略すると最後に確定した曲を使います。

`prepare`の結果にある日時、曲、通知先が依頼と一致するか確認します。日時と曲が明確な予約依頼には確定の指示も含まれるため、一致していれば同じ`proposalId`で`confirm`します。案だけの依頼や必要事項が曖昧な場合は確認を待ちます。案は2分で失効します。元の予約が変わった場合や予定時刻が過ぎた場合は、新しい案を作ります。同じ`proposalId`を再送した場合は確定済みの予約を返します。

確定時は予約日時、タイムゾーン、曲名、動画URLを通知します。`saved:true`は予約の保存成功を示します。通知に失敗しても予約は残り、`status`の`active.notificationError`へ記録します。

CLIで変更する直前に`status`を実行し、返された`operationId`を`--operation-id`に渡します。`cancel`の対象は`active.id`、`stop`と`snooze`の対象は`audio.runId`です。`exit`も`status.operationId`を使います。結果不明時は最初の操作IDで`result`を呼び、再送する場合も同じ操作IDと対象IDを使います。別の対象へ同じ操作IDを使うと`operation_conflict`を返します。対象IDを指定するため、古い予約への操作は新しい予約へ作用しません。

再生中は通知の「停止して終了」と「5分スヌーズ」でも操作できます。設定サーバーで通知を見られる人なら誰でも押せます。`DISCORD_OWNER_ID`は再生先VCを探す本人のIDであり、ボタンの操作者制限には使いません。ボタンは通知した予約IDに固定され、古い通知から新しい予約へ作用しません。スヌーズ上限に達した通知ではスヌーズボタンが無効になります。応答は押した人だけに表示されます。

## JSONと終了コード

`ok`は操作の成否、`code`は機械判定用の結果です。`running`はBotの稼働、`connected`はDiscord接続、`saved`は予約の保存、`accepted`は変更操作の受理を示します。`active`は現在の予約、`latest`は直近の終了結果です。`audio.runId`は再生中または準備中の予約IDです。`paused:true`は待機予約を保持したままBotが停止した状態です。時刻と期限はUnix時刻のミリ秒です。

| 終了コード | 意味 | 主な`code` |
| --- | --- | --- |
| `0` | 操作成功 | `prepared`、`saved`、`replayed`、`ok`、`running`、`stopped`、`cancelled`、`exiting`、`already_stopped` |
| `2` | 入力または状態による不成立 | `invalid_or_failed`、`missing_configuration`、`invalid_configuration`、`missing`、`expired`、`elapsed`、`stale`、`busy`、`operation_conflict`、`missing_result`、`no_waiting`、`no_audio`、`limit`、`failed`、`no_reservation`、`diagnostic_failed` |
| `3` | Botの起動または受付準備を確認できない | `start_failed`、`starting` |
| `4` | 結果を判断できない | `result_unknown` |

`status`は`active`、`latest`、`audio`、新しい`operationId`を返します。接続や復旧の準備中は`code:"starting"`でも状態取得は成功し、終了コードは`0`です。この間は`cancel`と`exit`を受け付けます。`confirm`、`stop`、`snooze`は`accepted:false`を返します。`exiting:true`は終了処理中です。

`confirm`の起動失敗時は保存結果をSQLiteで再確認します。`saved:true`と`start_failed`の組み合わせは、予約が保存された後にBot起動を確認できない状態です。`saved:false`は保存されていない状態です。結果が不明な場合は`saved`が省略されます。`confirm`の`result_unknown`は同じ`proposalId`で再確認します。

`stop`、`snooze`、`cancel`、`exit`の`result_unknown`は、`result <operationId>`と`status`で確認します。保存中の操作結果がなお不明な場合は、新しい操作IDで再送せず、予約と音声の状態を確認します。`result.current`は現在の稼働状態です。`exit`は応答時点で`running:true`を返すことがあり、終了後の`status`では`running:false`になります。

Botは呼出元から独立したプロセスグループで動きます。予約、再生、通知、ボタンへの応答が完了し、有効な予約がなくなると自動終了します。停止中に別の予約が確定した場合、その予約を保持して稼働を続けます。スヌーズ後も稼働を続けます。異常終了後の待機予約には180秒の遅延規則を適用します。待機中に`exit`した予約は`resume`で再開します。ログはSQLiteと同じディレクトリの`bot.log`に保存します。

確定要求を待つ空のBotは、Discord接続が完了しない場合も起動から20秒で終了します。待機予約があるBotは接続を待ちます。接続前の`exit`は待機予約を保持します。最後の待機予約を`cancel`するとBotは自動終了します。
