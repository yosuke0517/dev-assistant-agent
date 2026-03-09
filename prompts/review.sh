#!/bin/bash
# レビューモード: 既存PRをIssue仕様と比較してレビュー
# 必要な変数: GITHUB_REPO, ISSUE_ID, BASE_BRANCH
# 出力: PROMPT 変数を設定

PROMPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$PROMPTS_DIR/_common.sh"

if [ -n "$GITHUB_REPO" ]; then
    echo "Claude Code starting PR review for GitHub Issue: #${ISSUE_ID} (${GITHUB_REPO})..."
    REVIEW_RESULT=$(echo "$REVIEW_RESULT_FORMAT" | sed "s/REVIEW_TARGET_PLACEHOLDER/Issue #${ISSUE_ID}/")
    PROMPT="あなたはコードレビューアーです。以下の手順でPRをレビューしてください。

【リポジトリ】${GITHUB_REPO}
【課題ID】GitHub Issue #${ISSUE_ID}

## 手順

STEP1: GitHub MCPを使用して ${GITHUB_REPO} リポジトリの Issue #${ISSUE_ID} の内容を取得してください。これがレビューの基準となる「仕様」です。

STEP2: Issue #${ISSUE_ID} に関連するPRを見つけてください。以下の方法で探してください：
- GitHub MCPでオープン中のPR一覧を取得し、タイトルやbodyに #${ISSUE_ID} への参照があるものを探す
- feat/issue-${ISSUE_ID} または fix/issue-${ISSUE_ID} ブランチのPRを探す
PRが見つからない場合は、その旨を報告して終了してください。

STEP3: 見つけたPRの変更内容（diff）を取得してください。GitHub MCPの get_pull_request_files を使用してください。

STEP4: Issue仕様とPRの変更内容を比較し、以下の観点でレビューしてください：

${REVIEW_CRITERIA}

${REVIEW_RESULT}

STEP6: レビュー結果をPRにコメントとして投稿してください。GitHub MCPの add_issue_comment を使用し、PR番号を指定してください。

【重要】コードの修正は行わないでください。レビューと報告のみを行ってください。
${ASK_HUMAN_INSTRUCTIONS_REVIEW}"
else
    echo "Claude Code starting PR review for Backlog Issue: ${ISSUE_ID}..."
    REVIEW_RESULT=$(echo "$REVIEW_RESULT_FORMAT" | sed "s/REVIEW_TARGET_PLACEHOLDER/${ISSUE_ID}/")
    PROMPT="あなたはコードレビューアーです。以下の手順でPRをレビューしてください。

【課題ID】${ISSUE_ID}

## 手順

STEP1: Backlog MCPを使用して課題 ${ISSUE_ID} の内容を取得してください。これがレビューの基準となる「仕様」です。

STEP2: 課題 ${ISSUE_ID} に関連するPRを見つけてください。feat/${ISSUE_ID} ブランチのPRを探してください。
PRが見つからない場合は、その旨を報告して終了してください。

STEP3: PRの変更内容（diff）を確認してください。git diff ${BASE_BRANCH}...HEAD を使用してください。

STEP4: 課題仕様とPRの変更内容を比較し、以下の観点でレビューしてください：

${REVIEW_CRITERIA_BACKLOG}

${REVIEW_RESULT}

【重要】コードの修正は行わないでください。レビューと報告のみを行ってください。
${ASK_HUMAN_INSTRUCTIONS_REVIEW}"
fi
