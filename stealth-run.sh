#!/bin/bash
set -e

# .env読み込み
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

# 引数の受け取り
FOLDER_NAME=$1    # 例: circus_backend または agent
ISSUE_ID=$2       # 例: PROJ-123 または GitHub Issue番号
BASE_BRANCH_ARG=$3 # オプション: ベースブランチ指定（例: develop）
EXTRA_PROMPT=$4    # オプション: ユーザーからの追加指示（リトライ時に使用）

# 環境変数チェック
if [ -z "$WORKSPACE_ROOT" ] || [ -z "$AGENT_PROJECT_PATH" ]; then
    echo "Error: WORKSPACE_ROOT and AGENT_PROJECT_PATH must be set in .env"
    exit 1
fi

# ルーティング: agentキーワードの場合は本プロジェクトを対象にする
if [ "$FOLDER_NAME" = "agent" ]; then
    TARGET_PATH="$AGENT_PROJECT_PATH"
    IS_SELF_PROJECT=true
else
    TARGET_PATH="$WORKSPACE_ROOT/$FOLDER_NAME"
    IS_SELF_PROJECT=false
fi

# 1. 指定されたフォルダの存在チェック
if [ ! -d "$TARGET_PATH" ]; then
    echo "Error: Directory $TARGET_PATH does not exist."
    exit 1
fi

# 2. ベースブランチを決定（引数指定 or 自動検出）
if [ -n "$BASE_BRANCH_ARG" ]; then
    # 引数でベースブランチが指定された場合、リモートに存在するか検証
    git -C "$TARGET_PATH" fetch origin "$BASE_BRANCH_ARG" 2>/dev/null
    if ! git -C "$TARGET_PATH" rev-parse --verify "origin/$BASE_BRANCH_ARG" >/dev/null 2>&1; then
        echo "Error: Branch '$BASE_BRANCH_ARG' does not exist on remote."
        exit 1
    fi
    BASE_BRANCH="$BASE_BRANCH_ARG"
    echo "Base branch (specified): $BASE_BRANCH"
else
    # 自動検出
    BASE_BRANCH=$(git -C "$TARGET_PATH" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
    if [ -z "$BASE_BRANCH" ]; then
        if git -C "$TARGET_PATH" show-ref --verify --quiet refs/heads/main; then
            BASE_BRANCH="main"
        elif git -C "$TARGET_PATH" show-ref --verify --quiet refs/heads/master; then
            BASE_BRANCH="master"
        else
            echo "Error: Could not detect base branch."
            exit 1
        fi
    fi
    echo "Base branch (auto-detected): $BASE_BRANCH"
fi

# 3. 最新を取得（メインの作業ディレクトリには影響しない）
git -C "$TARGET_PATH" fetch origin "$BASE_BRANCH"

# 4. git worktree で一時作業ディレクトリを作成
REPO_NAME=$(basename "$TARGET_PATH")
if [ -z "$WORKTREE_PATH" ]; then
    WORKTREE_PATH="/tmp/finegate-worktrees/${REPO_NAME}-$(date +%s)"
fi
mkdir -p "$(dirname "$WORKTREE_PATH")"
echo "Creating worktree at: $WORKTREE_PATH"
git -C "$TARGET_PATH" worktree add --detach "$WORKTREE_PATH" "origin/$BASE_BRANCH"

# 5. MCP設定ファイルを動的に生成（ask_human ツール用）
MCP_CONFIG="/tmp/finegate-mcp-config-$$.json"
cat > "$MCP_CONFIG" << MCPEOF
{
  "mcpServers": {
    "slack-human": {
      "command": "node",
      "args": ["$SCRIPT_DIR/dist/mcp-servers/slack-human-interaction/index.js"],
      "env": {
        "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}",
        "SLACK_CHANNEL": "${SLACK_CHANNEL}",
        "SLACK_THREAD_TS": "${SLACK_THREAD_TS}",
        "OWNER_SLACK_MEMBER_ID": "${OWNER_SLACK_MEMBER_ID}"
      }
    }
  }
}
MCPEOF

# 6. MCP設定の検証と依存関係の自動修復
echo "MCP config: $MCP_CONFIG"
cat "$MCP_CONFIG"

# 環境変数の存在チェック（警告のみ）
if [ -z "$SLACK_BOT_TOKEN" ]; then
    echo "Warning: SLACK_BOT_TOKEN is not set. ask_human tool will not work."
fi
if [ -z "$SLACK_CHANNEL" ]; then
    echo "Warning: SLACK_CHANNEL is not set. ask_human tool will not work."
fi
if [ -z "$SLACK_THREAD_TS" ]; then
    echo "Warning: SLACK_THREAD_TS is not set. ask_human tool will not work."
fi

# node_modules の存在チェック → なければ npm install
if [ ! -d "$SCRIPT_DIR/node_modules/@modelcontextprotocol" ]; then
    echo "node_modules/@modelcontextprotocol not found. Running npm install..."
    (cd "$SCRIPT_DIR" && npm install)
fi

# ビルド済みファイルの存在チェック → なければ npm run build
if [ ! -f "$SCRIPT_DIR/dist/mcp-servers/slack-human-interaction/index.js" ]; then
    echo "Built files not found. Running npm run build..."
    (cd "$SCRIPT_DIR" && npm run build)
fi

# MCP Serverスクリプトのimportチェック → 失敗時は npm install + build で修復
if ! node --input-type=module <<< "import '$SCRIPT_DIR/dist/mcp-servers/slack-human-interaction/index.js'" 2>/dev/null; then
    echo "MCP Server import failed. Running npm install and build to repair..."
    (cd "$SCRIPT_DIR" && npm install && npm run build)
fi

# 6. エラー時・終了時に worktree と MCP設定をクリーンアップする trap
cleanup() {
    rm -f "$MCP_CONFIG"
    echo "Cleaning up worktree: $WORKTREE_PATH"
    git -C "$TARGET_PATH" worktree remove --force "$WORKTREE_PATH" 2>/dev/null || rm -rf "$WORKTREE_PATH"
}
trap cleanup EXIT

# 7. worktree ディレクトリへ移動
cd "$WORKTREE_PATH"
echo "Directory changed to: $(pwd)"

# 8. ステルス設定 (環境変数から読み取り)
if [ -z "$GIT_USER_NAME" ] || [ -z "$GIT_USER_EMAIL" ]; then
    echo "Error: GIT_USER_NAME and GIT_USER_EMAIL must be set in .env"
    exit 1
fi
git config user.name "$GIT_USER_NAME"
git config user.email "$GIT_USER_EMAIL"

# 9. エージェントによる実装実行
if [ "$IS_SELF_PROJECT" = true ]; then
    echo "Claude Code starting for GitHub Issue: #${ISSUE_ID}..."
    PROMPT="以下のSTEPに従って作業してください。

STEP1: GitHub MCPを使用して yosuke0517/dev-assistant-agent リポジトリの Issue #${ISSUE_ID} の内容を確認してください。
Issue内容に基づいたブランチを作成してください。フォーマットは feat/issue-${ISSUE_ID} または fix/issue-${ISSUE_ID}（内容に応じて選択）。
ブランチ作成後、必ずそのブランチに切り替えてください。

STEP2: Issue内容に基づいてコードを実装し、テストをパスさせてください。
適切な粒度でコミットしてください。

STEP3: すべての作業が完了したら、作業ブランチをリモートにpushし、GitHub MCPを使用してPRを作成してください。
PRのタイトルはIssue内容に基づいて簡潔に記述し、bodyには実施内容のサマリーを記載してください。

【重要】絶対に ${BASE_BRANCH} ブランチへ直接 push しないでください。

【重要】ask_human MCPツールは --mcp-config で事前設定済みです。MCPの設定ファイルを調査する必要はありません。直接呼び出してください。

【重要】実装中に以下のケースでは、必ず ask_human MCPツールを使用してSlackで確認してください（※ AskUserQuestion は使用禁止。必ず ask_human を使うこと）:
- 仕様の解釈が複数通りある場合
- 課題の記述が曖昧で実装方針が定まらない場合
- 破壊的な変更（既存APIの変更、DB スキーマ変更等）を行う前
- 設計判断で迷った場合（例: このロジックはどこに置くべきか）
勝手に解釈して進めず、必ず確認を取ってから実装してください。"
else
    echo "Claude Code starting for Backlog Issue: $ISSUE_ID..."
    PROMPT="以下のSTEPに従って作業してください。

STEP1: Backlog MCPを使用して課題 ${ISSUE_ID} の内容を確認し、課題IDに基づいたブランチを作成してください。フォーマットは feat/${ISSUE_ID} 。例: feat/RA_DEV-1234 。ブランチ作成後、必ずそのブランチに切り替えてください。\

STEP2: 課題内容に基づいてコードを実装し、テストをパスさせてください。\
デザインが必要な場合は、まず figma-desktop MCP を試してアプリからデータを取得し、\
接続できない場合は figma MCP (HTTP版) を使用して API 経由でデータを読み取ってください。\
.claude/commands/commit-dry.md を参考に適切な粒度でコミットしてください。

STEP3: すべての作業が完了したら、実施内容を報告してください。PRは作成不要です。

【重要】絶対に ${BASE_BRANCH} ブランチへ直接 push しないでください。

【重要】ask_human MCPツールは --mcp-config で事前設定済みです。MCPの設定ファイルを調査する必要はありません。直接呼び出してください。

【重要】実装中に以下のケースでは、必ず ask_human MCPツールを使用してSlackで確認してください（※ AskUserQuestion は使用禁止。必ず ask_human を使うこと）:
- 仕様の解釈が複数通りある場合
- 課題の記述が曖昧で実装方針が定まらない場合
- 破壊的な変更（既存APIの変更、DB スキーマ変更等）を行う前
- 設計判断で迷った場合（例: このロジックはどこに置くべきか）
勝手に解釈して進めず、必ず確認を取ってから実装してください。"
fi

# ユーザーからの追加指示がある場合はプロンプトに付与
if [ -n "$EXTRA_PROMPT" ]; then
    PROMPT="${PROMPT}

【ユーザーからの追加指示】
${EXTRA_PROMPT}"
fi

claude --dangerously-skip-permissions \
  --verbose \
  --model claude-opus-4-6 \
  --output-format stream-json \
  --mcp-config "$MCP_CONFIG" \
  --disallowedTools AskUserQuestion \
  -p "$PROMPT"
echo "Task completed at $(date)"