#!/bin/bash
# 通常実装モード: 課題を新規ブランチで実装
# 必要な変数: GITHUB_REPO, ISSUE_ID, BASE_BRANCH, BRANCH_NAME
# 出力: PROMPT 変数を設定

PROMPTS_DIR="${PROMPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}"
source "$PROMPTS_DIR/_common.sh"

USER_REQUEST_SECTION=""
if [ -n "$USER_REQUEST" ]; then
    USER_REQUEST_SECTION="
【ユーザーからの補足指示】
${USER_REQUEST}

上記の補足指示も考慮して実装を行ってください。
"
fi

if [ -n "$GITHUB_REPO" ]; then
    echo "Claude Code starting for GitHub Issue: #${ISSUE_ID} (${GITHUB_REPO})..."
    if [ -n "$BRANCH_NAME" ]; then
        BRANCH_INSTRUCTION="ブランチ ${BRANCH_NAME} を作成してください。"
    else
        BRANCH_INSTRUCTION="Issue内容に基づいたブランチを作成してください。フォーマットは feat/issue-${ISSUE_ID} または fix/issue-${ISSUE_ID}（内容に応じて選択）。"
    fi

    PROMPT="以下のSTEPに従って作業してください。
${USER_REQUEST_SECTION}
STEP1: GitHub MCPを使用して ${GITHUB_REPO} リポジトリの Issue #${ISSUE_ID} の内容を確認してください。
${BRANCH_INSTRUCTION}
ブランチ作成後、必ずそのブランチに切り替えてください。

STEP2: Issue内容に基づいてコードを実装し、テストをパスさせてください。
適切な粒度でコミットしてください。

STEP3: すべての作業が完了したら、作業ブランチをリモートにpushし、GitHub MCPを使用してPRを作成してください。
PRのタイトルはIssue内容に基づいて簡潔に記述し、bodyには実施内容のサマリーを記載してください。
PRは必ずdraft状態で作成してください（--draft フラグを使用）。
PRのマージ先（ベースブランチ）は ${BASE_BRANCH} を指定してください（--base ${BASE_BRANCH}）。

${PR_BODY_FORMAT_GITHUB}

【重要】絶対に ${BASE_BRANCH} ブランチへ直接 push しないでください。

${ASK_HUMAN_INSTRUCTIONS}"
else
    echo "Claude Code starting for Backlog Issue: $ISSUE_ID..."
    if [ -n "$BRANCH_NAME" ]; then
        BACKLOG_BRANCH_INSTRUCTION="ブランチ ${BRANCH_NAME} を作成してください。ブランチ作成後、必ずそのブランチに切り替えてください。"
    else
        BACKLOG_BRANCH_INSTRUCTION="課題IDに基づいたブランチを作成してください。フォーマットは feat/${ISSUE_ID} 。例: feat/RA_DEV-1234 。ブランチ作成後、必ずそのブランチに切り替えてください。"
    fi

    PROMPT="以下のSTEPに従って作業してください。
${USER_REQUEST_SECTION}
STEP1: Backlog MCPを使用して課題 ${ISSUE_ID} の内容を確認し、${BACKLOG_BRANCH_INSTRUCTION}\

STEP2: 課題内容に基づいてコードを実装し、テストをパスさせてください。\
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
