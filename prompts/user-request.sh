#!/bin/bash
# ユーザー要望モード: ユーザーの補足指示付きで課題を実装
# サブモード:
#   - USER_REQUEST_NEW_ISSUE=true: 新規ブランチ作成して実装
#   - それ以外: 既存ブランチで要望を実装
# 必要な変数: GITHUB_REPO, ISSUE_ID, BASE_BRANCH, USER_REQUEST, WORK_BRANCH, BRANCH_NAME
# 出力: PROMPT 変数を設定

PROMPTS_DIR="${PROMPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}"
source "$PROMPTS_DIR/_common.sh"

if [ "$USER_REQUEST_NEW_ISSUE" = "true" ]; then
    # --- 新規課題モード ---
    if [ -n "$GITHUB_REPO" ]; then
        if [ -n "$BRANCH_NAME" ]; then
            NEW_ISSUE_BRANCH_INSTRUCTION="ブランチ ${BRANCH_NAME} を作成してください。"
        else
            NEW_ISSUE_BRANCH_INSTRUCTION="Issue内容に基づいたブランチを作成してください。フォーマットは feat/issue-${ISSUE_ID} または fix/issue-${ISSUE_ID}（内容に応じて選択）。"
        fi
        echo "Claude Code starting new issue with user request for GitHub Issue: #${ISSUE_ID} (${GITHUB_REPO})..."
        PROMPT="以下のSTEPに従って作業してください。

【ユーザーからの補足指示】
${USER_REQUEST}

STEP1: GitHub MCPを使用して ${GITHUB_REPO} リポジトリの Issue #${ISSUE_ID} の内容を確認してください。
${NEW_ISSUE_BRANCH_INSTRUCTION}
ブランチ作成後、必ずそのブランチに切り替えてください。

STEP2: Issue内容とユーザーからの補足指示に基づいてコードを実装し、テストをパスさせてください。
適切な粒度でコミットしてください。

STEP3: すべての作業が完了したら、作業ブランチをリモートにpushし、GitHub MCPを使用してPRを作成してください。
PRのタイトルはIssue内容に基づいて簡潔に記述し、bodyには実施内容のサマリーを記載してください。
PRは必ずdraft状態で作成してください（--draft フラグを使用）。
PRのマージ先（ベースブランチ）は ${BASE_BRANCH} を指定してください（--base ${BASE_BRANCH}）。

${PR_BODY_FORMAT_GITHUB}

【重要】絶対に ${BASE_BRANCH} ブランチへ直接 push しないでください。

${ASK_HUMAN_INSTRUCTIONS}"
    else
        if [ -n "$BRANCH_NAME" ]; then
            NEW_ISSUE_BACKLOG_BRANCH_INSTRUCTION="ブランチ ${BRANCH_NAME} を作成してください。ブランチ作成後、必ずそのブランチに切り替えてください。"
        else
            NEW_ISSUE_BACKLOG_BRANCH_INSTRUCTION="課題IDに基づいたブランチを作成してください。フォーマットは feat/${ISSUE_ID} 。例: feat/RA_DEV-1234 。ブランチ作成後、必ずそのブランチに切り替えてください。"
        fi
        echo "Claude Code starting new issue with user request for Backlog Issue: ${ISSUE_ID}..."
        PROMPT="以下のSTEPに従って作業してください。

【ユーザーからの補足指示】
${USER_REQUEST}

STEP1: Backlog MCPを使用して課題 ${ISSUE_ID} の内容を確認し、${NEW_ISSUE_BACKLOG_BRANCH_INSTRUCTION}\

STEP2: 課題内容とユーザーからの補足指示に基づいてコードを実装し、テストをパスさせてください。\
デザインが必要な場合は、まず figma-desktop MCP を試してアプリからデータを取得し、\
接続できない場合は figma MCP (HTTP版) を使用して API 経由でデータを読み取ってください。\
.claude/commands/commit-dry.md を参考に適切な粒度でコミットしてください。

STEP3: すべての作業が完了したら、作業ブランチをリモートにpushし、PRを作成してください。\
PRのタイトルは課題内容に基づいて簡潔に記述し、bodyには実施内容のサマリーを記載してください。\
PRは必ずdraft状態で作成してください（--draft フラグを使用）。\
PRのマージ先（ベースブランチ）は ${BASE_BRANCH} を指定してください（--base ${BASE_BRANCH}）。

${PR_BODY_FORMAT_BACKLOG}

【重要】絶対に ${BASE_BRANCH} ブランチへ直接 push しないでください。

${ASK_HUMAN_INSTRUCTIONS}"
    fi
else
    # --- 既存ブランチモード ---
    if [ -n "$GITHUB_REPO" ]; then
        echo "Claude Code starting user request for GitHub Issue: #${ISSUE_ID} on branch ${WORK_BRANCH} (${GITHUB_REPO})..."
        PROMPT="以下の作業を実行してください。

【リポジトリ】${GITHUB_REPO}
【対象ブランチ】${WORK_BRANCH}（既存ブランチ）
【課題ID】GitHub Issue #${ISSUE_ID}
【ユーザーの要望】
${USER_REQUEST}

以下の手順で作業してください：
1. git fetch origin を実行してリモートの最新状態を取得してください
2. ブランチ ${WORK_BRANCH} をチェックアウトしてください
3. ユーザーの要望を実装してください
4. テストをパスさせてください
5. 変更をコミットしてpushしてください（既存のPRに自動反映されます）

【重要】新しいPRは作成しないでください。既存のブランチへのpushで自動的にPRが更新されます。
【重要】絶対に main ブランチへ直接 push しないでください。

${ASK_HUMAN_INSTRUCTIONS}"
    else
        echo "Claude Code starting user request for Backlog Issue: ${ISSUE_ID} on branch ${WORK_BRANCH}..."
        PROMPT="以下の作業を実行してください。

【対象ブランチ】${WORK_BRANCH}（既存ブランチ）
【課題ID】${ISSUE_ID}
【ユーザーの要望】
${USER_REQUEST}

以下の手順で作業してください：
1. git fetch origin を実行してリモートの最新状態を取得してください
2. ブランチ ${WORK_BRANCH} をチェックアウトしてください
3. ユーザーの要望を実装してください
4. テストをパスさせてください
5. 変更をコミットしてpushしてください（既存のPRに自動反映されます）

【重要】新しいPRは作成しないでください。pushで既存のPRが自動更新されます。
【重要】絶対に main ブランチへ直接 push しないでください。

${ASK_HUMAN_INSTRUCTIONS}"
    fi
fi
