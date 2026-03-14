#!/bin/bash
# レビューモード: 既存PRをIssue仕様と比較してレビュー
# 必要な変数: GITHUB_REPO, ISSUE_ID, BASE_BRANCH
# 出力: PROMPT 変数を設定

PROMPTS_DIR="${PROMPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}"
source "$PROMPTS_DIR/_common.sh"

USER_REQUEST_SECTION=""
if [ -n "$USER_REQUEST" ]; then
    USER_REQUEST_SECTION="
【ユーザーからの補足指示】
${USER_REQUEST}

上記の補足指示も考慮してレビューを行ってください。
"
fi

if [ -n "$GITHUB_REPO" ]; then
    echo "Claude Code starting PR review for GitHub Issue: #${ISSUE_ID} (${GITHUB_REPO})..."
    REVIEW_RESULT=$(echo "$REVIEW_RESULT_FORMAT" | sed "s/REVIEW_TARGET_PLACEHOLDER/Issue #${ISSUE_ID}/")
    PROMPT="あなたはコードレビューアーです。以下の手順でPRをレビューしてください。

【リポジトリ】${GITHUB_REPO}
【課題ID】GitHub Issue #${ISSUE_ID}
${USER_REQUEST_SECTION}
## 手順

STEP1: 以下のghコマンドで ${GITHUB_REPO} リポジトリの Issue #${ISSUE_ID} の内容を取得してください。これがレビューの基準となる「仕様」です。
\`\`\`
gh issue view ${ISSUE_ID} --repo ${GITHUB_REPO}
\`\`\`

STEP2: Issue #${ISSUE_ID} に関連するPRを見つけてください。以下のghコマンドで探してください：
\`\`\`
gh pr list --repo ${GITHUB_REPO} --state open --search \"issue-${ISSUE_ID}\" --json number,title,headRefName,body
\`\`\`
上記で見つからない場合は、feat/issue-${ISSUE_ID} または fix/issue-${ISSUE_ID} ブランチ名でも検索してください。
PRが見つからない場合は、その旨を報告して終了してください。

STEP3: 見つけたPRの変更内容（diff）を取得してください。以下のghコマンドを使用してください：
\`\`\`
gh pr diff <PR番号> --repo ${GITHUB_REPO}
\`\`\`
※ GitHub MCPの get_pull_request_files ではなく、gh pr diff を使用してください。ghコマンドの方が差分を全量取得できます。

STEP4: Issue仕様とPRの変更内容を比較し、以下の観点でレビューしてください：

${REVIEW_CRITERIA}

${REVIEW_RESULT}

STEP6: レビュー結果をPRにコメントとして投稿してください。以下のghコマンドを使用し、PR番号を指定してください：
\`\`\`
gh pr comment <PR番号> --repo ${GITHUB_REPO} --body \"<レビュー結果>\"
\`\`\`

STEP7: ${REVIEW_SLACK_REPORT}

【重要】コードの修正は行わないでください。レビューと報告のみを行ってください。
${ASK_HUMAN_INSTRUCTIONS_REVIEW}"
else
    echo "Claude Code starting PR review for Backlog Issue: ${ISSUE_ID}..."
    REVIEW_RESULT=$(echo "$REVIEW_RESULT_FORMAT" | sed "s/REVIEW_TARGET_PLACEHOLDER/${ISSUE_ID}/")
    PROMPT="あなたはコードレビューアーです。以下の手順でPRをレビューしてください。

【課題ID】${ISSUE_ID}
${USER_REQUEST_SECTION}
## 手順

STEP1: Backlog MCPを使用して課題 ${ISSUE_ID} の内容を取得してください。これがレビューの基準となる「仕様」です。

STEP2: 課題 ${ISSUE_ID} に関連するPRを見つけてください。feat/${ISSUE_ID} ブランチのPRを探してください。
PRが見つからない場合は、その旨を報告して終了してください。

STEP3: PRの変更内容（diff）を確認してください。git diff ${BASE_BRANCH}...HEAD を使用してください。

STEP4: 課題仕様とPRの変更内容を比較し、以下の観点でレビューしてください：

${REVIEW_CRITERIA_BACKLOG}

${REVIEW_RESULT}

STEP6: ${REVIEW_SLACK_REPORT}

【重要】コードの修正は行わないでください。レビューと報告のみを行ってください。
${ASK_HUMAN_INSTRUCTIONS_REVIEW}"
fi
