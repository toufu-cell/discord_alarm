---
type: "constraint"
status: "accepted"
status_reason: "利用者がカード登録なしの環境だけを探すよう明示した。"
scope: "hosting"
created_at: "2026-09-19"
last_reviewed: "2026-09-19"
review_after: ""
verification: "user-confirmed"
evidence: ["user-confirmed:2026-09-19", "docs/plan.md"]
supersedes: []
superseded_by: ""
---

# カード登録が不要な無料リモート環境を選ぶ

## Context

Discord目覚ましBotには就寝中も動く実行環境が必要である。既存のサーバーや常時起動できるPCはなく、Cloudflareの有料契約は見送られた。
Oracle Cloudの無料枠を提案したところ、利用者はカード登録なしの環境だけを探すよう指定した。

## Decision

常時稼働先はカード登録が不要な無料リモート環境から選ぶ。本人確認だけにカードを使う無料枠も候補から外す。

## Rationale

無料であることだけでは、利用者が示した登録条件を満たさない。カード登録不要を選定条件として保持し、同じ確認を繰り返さない。
個別サービスの採用と音声再生の動作確認は、この条件とは別に判断する。

## Revisit when

利用者が費用やカード登録の条件を明示的に変更したときに見直す。
