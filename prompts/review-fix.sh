#!/bin/bash
# PRレビューFB対応モード: PRのレビュー指摘を修正
# 必要な変数: GITHUB_REPO, ISSUE_ID, BASE_BRANCH, WORK_BRANCH
# 出力: PROMPT 変数を設定

PROMPTS_DIR="${PROMPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}"
source "$PROMPTS_DIR/_common.sh"

if [ -n "$GITHUB_REPO" ]; then
    echo "Claude Code starting review fix for GitHub Issue: #${ISSUE_ID} on branch ${WORK_BRANCH} (${GITHUB_REPO})..."
    PROMPT="あなたはPRレビュー指摘の修正担当です。以下の手順でレビュー指摘を修正してください。

【リポジトリ】${GITHUB_REPO}
【対象ブランチ】${WORK_BRANCH}
【課題ID】GitHub Issue #${ISSUE_ID}

## 手順

STEP1: GitHub MCPを使用して ${GITHUB_REPO} リポジトリの Issue #${ISSUE_ID} の内容を取得してください。これが元の仕様です。

STEP2: Issue #${ISSUE_ID} に関連するPRを見つけてください。以下の方法で探してください：
- GitHub MCPでオープン中のPR一覧を取得し、タイトルやbodyに #${ISSUE_ID} への参照があるものを探す
- feat/issue-${ISSUE_ID} または fix/issue-${ISSUE_ID} ブランチのPRを探す
PRが見つからない場合は、その旨を報告して終了してください。

STEP3: 見つけたPRのレビューコメントを取得してください。GitHub MCPの get_pull_request_reviews および get_pull_request_comments を使用してください。
レビュー指摘がない場合は、その旨を報告して終了してください。

STEP4: git fetch origin を実行し、ブランチ ${WORK_BRANCH} をチェックアウトしてください。

STEP5: レビュー指摘の内容を確認し、各指摘に対して修正を実施してください。
- Critical（マージ前に修正必須）の指摘は必ず対応してください
- Warning（修正推奨）の指摘も可能な限り対応してください
- Info（改善提案）の指摘は対応が明確なものは対応してください
修正は元の仕様（Issue内容）を逸脱しないよう注意してください。
テストをパスさせてください。

STEP6: 変更を適切な粒度でコミットしてpushしてください（既存のPRに自動反映されます）。

STEP7: PRに対応完了のコメントを投稿してください。GitHub MCPの add_issue_comment を使用し、以下の形式でコメントしてください：
---
## レビューFB対応完了

### 対応した指摘
- 指摘1: （対応内容）
- 指摘2: （対応内容）

### 対応しなかった指摘（ある場合）
- 指摘X: （理由）
---

【重要】新しいPRは作成しないでください。既存のブランチへのpushで自動的にPRが更新されます。
【重要】絶対に ${BASE_BRANCH} ブランチへ直接 push しないでください。

${ASK_HUMAN_INSTRUCTIONS}"
else
    echo "Claude Code starting review fix for Backlog Issue: ${ISSUE_ID} on branch ${WORK_BRANCH}..."
    PROMPT="あなたはPRレビュー指摘の修正担当です。以下の手順でレビュー指摘を修正してください。

【対象ブランチ】${WORK_BRANCH}
【課題ID】${ISSUE_ID}

## 手順

STEP1: Backlog MCPを使用して課題 ${ISSUE_ID} の内容を取得してください。これが元の仕様です。

STEP2: 課題 ${ISSUE_ID} に関連するPRを見つけてください。feat/${ISSUE_ID} ブランチのPRを探してください。
PRが見つからない場合は、その旨を報告して終了してください。

STEP3: PRのレビューコメントを確認してください。

STEP4: git fetch origin を実行し、ブランチ ${WORK_BRANCH} をチェックアウトしてください。

STEP5: レビュー指摘の内容を確認し、各指摘に対して修正を実施してください。
- Critical（マージ前に修正必須）の指摘は必ず対応してください
- Warning（修正推奨）の指摘も可能な限り対応してください
- Info（改善提案）の指摘は対応が明確なものは対応してください
修正は元の仕様（課題内容）を逸脱しないよう注意してください。
テストをパスさせてください。

STEP6: 変更を適切な粒度でコミットしてpushしてください（既存のPRに自動反映されます）。

【重要】新しいPRは作成しないでください。pushで既存のPRが自動更新されます。
【重要】絶対に ${BASE_BRANCH} ブランチへ直接 push しないでください。

${ASK_HUMAN_INSTRUCTIONS}"
fi
