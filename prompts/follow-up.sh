#!/bin/bash
# フォローアップモード: 既存ブランチで追加依頼を処理
# 必要な変数: GITHUB_REPO, ISSUE_ID, BASE_BRANCH, FOLLOW_UP_MESSAGE
# 出力: PROMPT 変数を設定

PROMPTS_DIR="${PROMPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}"
source "$PROMPTS_DIR/_common.sh"

if [ -n "$GITHUB_REPO" ]; then
    echo "Claude Code starting follow-up for GitHub Issue: #${ISSUE_ID} (${GITHUB_REPO})..."
    PROMPT="前回のタスクでGitHub Issue #${ISSUE_ID}（${GITHUB_REPO}）に対する実装を行い、PRを作成しました。
ユーザーからメッセージがあります。

【ユーザーメッセージ】
${FOLLOW_UP_MESSAGE}

まず、上記のメッセージが「質問・確認」なのか「修正・追加の依頼」なのかを判断してください。

■ 質問・確認の場合（例: 「なぜこう実装した？」「〜の設定方法は？」「〜とは何？」）：
- コードやドキュメントを調査し、質問に対する回答をテキストで出力してください
- コードの変更やコミットは不要です

■ 修正・追加の依頼の場合（例: 「〜を修正して」「〜を追加して」「〜を変更して」）：
以下の手順で作業してください：
1. git fetch origin を実行してリモートの最新状態を取得してください
2. 既存の作業ブランチ（feat/issue-${ISSUE_ID} または fix/issue-${ISSUE_ID}）をチェックアウトしてください
3. 追加依頼の内容を実装してください
4. テストをパスさせてください
5. 変更をコミットしてpushしてください（既存のPRに自動反映されます）

【重要】新しいPRは作成しないでください。既存のブランチへのpushで自動的にPRが更新されます。
【重要】絶対に ${BASE_BRANCH} ブランチへ直接 push しないでください。

${ASK_HUMAN_INSTRUCTIONS}"
else
    echo "Claude Code starting follow-up for Backlog Issue: $ISSUE_ID..."
    PROMPT="前回のタスクで課題 ${ISSUE_ID} に対する実装を行い、PRを作成しました。
ユーザーからメッセージがあります。

【ユーザーメッセージ】
${FOLLOW_UP_MESSAGE}

まず、上記のメッセージが「質問・確認」なのか「修正・追加の依頼」なのかを判断してください。

■ 質問・確認の場合（例: 「なぜこう実装した？」「〜の設定方法は？」「〜とは何？」）：
- コードやドキュメントを調査し、質問に対する回答をテキストで出力してください
- コードの変更やコミットは不要です

■ 修正・追加の依頼の場合（例: 「〜を修正して」「〜を追加して」「〜を変更して」）：
以下の手順で作業してください：
1. git fetch origin を実行してリモートの最新状態を取得してください
2. 既存の作業ブランチ（feat/${ISSUE_ID}）をチェックアウトしてください
3. 追加依頼の内容を実装してください
4. テストをパスさせてください
5. 変更をコミットしてpushしてください（既存のPRに自動反映されます）

【重要】新しいPRは作成しないでください。pushで既存のPRが自動更新されます。
【重要】絶対に ${BASE_BRANCH} ブランチへ直接 push しないでください。

${ASK_HUMAN_INSTRUCTIONS}"
fi
