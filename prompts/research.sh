#!/bin/bash
# 調査（リサーチ）モード: コード調査・分析を行い、結果をレポートとして出力
# PRは作成せず、コード変更も行わない
# 必要な変数: GITHUB_REPO or Backlog, ISSUE_ID
# 出力: PROMPT 変数を設定

PROMPTS_DIR="${PROMPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}"
source "$PROMPTS_DIR/_common.sh"

USER_REQUEST_SECTION=""
if [ -n "$USER_REQUEST" ]; then
    USER_REQUEST_SECTION="
【ユーザーからの補足指示】
${USER_REQUEST}

上記の補足指示も考慮して調査を行ってください。
"
fi

# Slack用リサーチサマリー出力指示
RESEARCH_SLACK_REPORT='最後のステップとして、以下の形式で調査サマリーをテキスト出力してください。これはSlackに送信されるレポートです。ツール呼び出しではなく、必ずテキストとして出力してください。

---
🔬 *調査レポート*

*調査対象:* （課題ID・調査テーマ）

*調査結果サマリー:*
（調査結果の要点を簡潔に箇条書き）

*詳細:*
（必要に応じて詳細な分析結果、関連ファイル、影響範囲などを記載）

*推奨アクション:*
（調査結果に基づく推奨事項があれば記載。なければ「特になし」）
---

上記のフォーマットを厳密に守り、必ずこのサマリーを最後に出力してください。'

if [ -n "$GITHUB_REPO" ]; then
    echo "Claude Code starting research for GitHub Issue: #${ISSUE_ID} (${GITHUB_REPO})..."
    PROMPT="あなたはコードベースの調査・分析を行うリサーチャーです。以下の手順で調査してください。

【リポジトリ】${GITHUB_REPO}
【課題ID】GitHub Issue #${ISSUE_ID}
${USER_REQUEST_SECTION}
## 手順

STEP1: 以下のghコマンドで ${GITHUB_REPO} リポジトリの Issue #${ISSUE_ID} の内容を確認してください。これが調査の対象となる課題です。
\`\`\`
gh issue view ${ISSUE_ID} --repo ${GITHUB_REPO}
\`\`\`

STEP2: Issue内容に基づいて、コードベースを調査・分析してください。必要に応じて以下を実施してください：
- 関連するソースコードの探索と読み込み
- 既存のアーキテクチャや設計パターンの把握
- 影響範囲の特定
- 実装方針の検討

STEP3: 調査結果をまとめ、必要に応じて以下のアウトプットを行ってください：
- 調査結果のレポート作成
- Issue内容に応じたタスク分解や実装計画の提案
- 必要であればGitHub Issueへのコメント追加（以下のghコマンドを使用）：
\`\`\`
gh issue comment ${ISSUE_ID} --repo ${GITHUB_REPO} --body \"<調査結果>\"
\`\`\`

STEP4: ${RESEARCH_SLACK_REPORT}

【重要】このモードではコードの変更やPRの作成は行わないでください。調査と報告のみを行ってください。
【重要】ブランチの作成やチェックアウトは行わないでください。

${ASK_HUMAN_INSTRUCTIONS}"
else
    echo "Claude Code starting research for Backlog Issue: ${ISSUE_ID}..."
    PROMPT="あなたはコードベースの調査・分析を行うリサーチャーです。以下の手順で調査してください。

【課題ID】${ISSUE_ID}
${USER_REQUEST_SECTION}
## 手順

STEP1: Backlog MCPを使用して課題 ${ISSUE_ID} の内容を確認してください。これが調査の対象となる課題です。

STEP2: 課題内容に基づいて、コードベースを調査・分析してください。必要に応じて以下を実施してください：
- 関連するソースコードの探索と読み込み
- 既存のアーキテクチャや設計パターンの把握
- 影響範囲の特定
- 実装方針の検討

STEP3: 調査結果をまとめ、必要に応じて以下のアウトプットを行ってください：
- 調査結果のレポート作成
- 課題内容に応じたタスク分解や実装計画の提案

STEP4: ${RESEARCH_SLACK_REPORT}

【重要】このモードではコードの変更やPRの作成は行わないでください。調査と報告のみを行ってください。
【重要】ブランチの作成やチェックアウトは行わないでください。

${ASK_HUMAN_INSTRUCTIONS}"
fi
