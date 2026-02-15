#!/bin/bash
set -e

# 引数の受け取り
FOLDER_NAME=$1  # 例: circus_backend
ISSUE_ID=$2    # 例: PROJ-123

# ワークスペースのベースパス
WORKSPACE_ROOT="/Users/takeuchiyosuke/work/circus"

# 1. 指定されたフォルダへ移動
TARGET_PATH="$WORKSPACE_ROOT/$FOLDER_NAME"

if [ -d "$TARGET_PATH" ]; then
    cd "$TARGET_PATH"
    echo "Directory changed to: $(pwd)"
else
    echo "Error: Directory $TARGET_PATH does not exist."
    exit 1
fi

# 2. Git最新化
git checkout main
git pull origin main

# 3. ステルス設定 (Yosuke Takeuchiさん本人のコミットとして記録)
git config user.name yosuke0517
# 受託開発用のメールアドレスに適宜書き換えてください
git config user.email "yosuke.takeuchi@gmail.com" 

# 4. エージェントによる実装実行
# Backlog MCPを使用して課題内容を読み取るよう明示
echo "Claude Code starting for Backlog Issue: $ISSUE_ID..."

# --verbose を追加
# -y を追加して、ツール実行の確認をすべてスキップさせる
#claude --dangerously-skip-permissions --verbose -p "Backlog MCPを使用して、課題 $ISSUE_ID の内容を確認してください。その内容に基づいてコードを実装し、テストをパスさせ（UIのみのタスクについては不要）、プルリクエストを作成してください。デザインが必要な場合はfigma desktop mcpを使用してデータを読み取ってください。完了したらPRのURLを教えてください。【重要】絶対に main ブランチへ直接 push しないでください。"
claude --dangerously-skip-permissions --verbose -p "Backlog MCPを使用して、課題 $ISSUE_ID の内容を確認してください。その内容に基づいてコードを実装し、テストをパスさせ（UIのみのタスクについては不要）、プルリクエストを作成してください。デザインが必要な場合はfigma desktop mcpを使用してデータを読み取ってください。完了したらPRのURLを教えてください。【重要】絶対に main ブランチへ直接 push しないでください。"
echo "Task completed at $(date)"