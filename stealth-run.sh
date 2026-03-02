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

# モーダルから渡されるブランチ名（環境変数経由）
BRANCH_NAME=${BRANCH_NAME:-}

# "undefined" 文字列はフロントエンド等で値未設定時に渡されることがあるため除外
if [ "$BASE_BRANCH_ARG" = "undefined" ]; then
    BASE_BRANCH_ARG=""
fi

# 環境変数チェック
if [ -z "$WORKSPACE_ROOT" ] || [ -z "$AGENT_PROJECT_PATH" ]; then
    echo "Error: WORKSPACE_ROOT and AGENT_PROJECT_PATH must be set in .env"
    exit 1
fi

# ルーティング: エイリアスに応じたパス解決とタスク管理システム選択
# GITHUB_REPO: 設定時はGitHub Issuesを使用、空の場合はBacklogを使用
if [ "$FOLDER_NAME" = "agent" ]; then
    TARGET_PATH="$AGENT_PROJECT_PATH"
    GITHUB_REPO="yosuke0517/dev-assistant-agent"
elif [ "$FOLDER_NAME" = "jjp" ]; then
    TARGET_PATH="$WORKSPACE_ROOT/jjp-loadsheet-ui"
    GITHUB_REPO="Route-sec/jjp-loadsheet-ui"
else
    TARGET_PATH="$WORKSPACE_ROOT/$FOLDER_NAME"
    GITHUB_REPO=""
fi

# 1. 指定されたフォルダの存在チェック
if [ ! -d "$TARGET_PATH" ]; then
    echo "Error: Directory $TARGET_PATH does not exist."
    exit 1
fi

# 2. ベースブランチを決定（引数指定 or 自動検出）
# 指定されたブランチがリモートに存在しない場合は自動検出にフォールバック
if [ -n "$BASE_BRANCH_ARG" ]; then
    # 引数でベースブランチが指定された場合、リモートに存在するか検証
    git -C "$TARGET_PATH" fetch origin "$BASE_BRANCH_ARG" 2>/dev/null
    if git -C "$TARGET_PATH" rev-parse --verify "origin/$BASE_BRANCH_ARG" >/dev/null 2>&1; then
        BASE_BRANCH="$BASE_BRANCH_ARG"
        echo "Base branch (specified): $BASE_BRANCH"
    else
        echo "Warning: Branch '$BASE_BRANCH_ARG' does not exist on remote. Falling back to auto-detection."
        BASE_BRANCH_ARG=""
    fi
fi

if [ -z "$BASE_BRANCH" ]; then
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

# 3.5. stale worktree 参照のクリーンアップ
git -C "$TARGET_PATH" worktree prune 2>/dev/null || true

# 3.6. USER_REQUEST/FOLLOW_UP モードで対象ブランチの競合を検出・解消
TARGET_BRANCH=""
WORK_BRANCH=""
if [ -n "$USER_REQUEST" ]; then
    if [ -n "$BASE_BRANCH_ARG" ]; then
        # 明示的にブランチが指定された場合はそのまま使用
        TARGET_BRANCH="$BASE_BRANCH"
        WORK_BRANCH="$BASE_BRANCH"
    else
        # ブランチ未指定: 課題IDから既存のフィーチャーブランチを自動検出
        if [ -n "$GITHUB_REPO" ]; then
            for prefix in "feat" "fix"; do
                git -C "$TARGET_PATH" fetch origin "${prefix}/issue-${ISSUE_ID}" 2>/dev/null || true
                if git -C "$TARGET_PATH" rev-parse --verify "origin/${prefix}/issue-${ISSUE_ID}" >/dev/null 2>&1; then
                    TARGET_BRANCH="${prefix}/issue-${ISSUE_ID}"
                    WORK_BRANCH="${prefix}/issue-${ISSUE_ID}"
                    break
                fi
            done
        else
            git -C "$TARGET_PATH" fetch origin "feat/${ISSUE_ID}" 2>/dev/null || true
            if git -C "$TARGET_PATH" rev-parse --verify "origin/feat/${ISSUE_ID}" >/dev/null 2>&1; then
                TARGET_BRANCH="feat/${ISSUE_ID}"
                WORK_BRANCH="feat/${ISSUE_ID}"
            fi
        fi

        if [ -z "$WORK_BRANCH" ]; then
            echo "Error: Could not find existing feature branch for issue ${ISSUE_ID}. Please specify branch explicitly as 3rd argument."
            exit 1
        fi
        echo "Work branch (auto-detected): $WORK_BRANCH"
    fi
elif [ -n "$FOLLOW_UP_MESSAGE" ]; then
    if [ -n "$GITHUB_REPO" ]; then
        for prefix in "feat" "fix"; do
            if git -C "$TARGET_PATH" rev-parse --verify "origin/${prefix}/issue-${ISSUE_ID}" >/dev/null 2>&1; then
                TARGET_BRANCH="${prefix}/issue-${ISSUE_ID}"
                break
            fi
        done
    else
        TARGET_BRANCH="feat/${ISSUE_ID}"
    fi
fi

WORKTREE_BRANCH_CONFLICT=""
if [ -n "$TARGET_BRANCH" ]; then
    # 対象ブランチをfetch
    git -C "$TARGET_PATH" fetch origin "$TARGET_BRANCH" 2>/dev/null || true

    # 対象ブランチが別のworktreeで使用中か確認
    CONFLICT_WT=$(git -C "$TARGET_PATH" worktree list --porcelain | awk -v branch="refs/heads/$TARGET_BRANCH" '
        /^worktree / { wt=substr($0, 10) }
        /^branch / { if ($2 == branch) print wt }
    ')

    if [ -n "$CONFLICT_WT" ]; then
        if echo "$CONFLICT_WT" | grep -q "^/tmp/finegate-worktrees/"; then
            echo "Removing conflicting finegate worktree: $CONFLICT_WT"
            git -C "$TARGET_PATH" worktree remove --force "$CONFLICT_WT" 2>/dev/null || rm -rf "$CONFLICT_WT"
            git -C "$TARGET_PATH" worktree prune 2>/dev/null || true
        else
            echo "Warning: Branch '$TARGET_BRANCH' is already checked out at: $CONFLICT_WT"
            WORKTREE_BRANCH_CONFLICT="$TARGET_BRANCH"
        fi
    fi
fi

# 4. git worktree で一時作業ディレクトリを作成
REPO_NAME=$(basename "$TARGET_PATH")
if [ -z "$WORKTREE_PATH" ]; then
    WORKTREE_PATH="/tmp/finegate-worktrees/${REPO_NAME}-$(date +%s)"
fi
mkdir -p "$(dirname "$WORKTREE_PATH")"

# 対象ブランチが特定できている場合はそのブランチの先端から開始
if [ -n "$TARGET_BRANCH" ] && git -C "$TARGET_PATH" rev-parse --verify "origin/$TARGET_BRANCH" >/dev/null 2>&1; then
    WORKTREE_START="origin/$TARGET_BRANCH"
else
    WORKTREE_START="origin/$BASE_BRANCH"
fi

echo "Creating worktree at: $WORKTREE_PATH"
git -C "$TARGET_PATH" worktree add --detach "$WORKTREE_PATH" "$WORKTREE_START"

# 4.5. 関連リポジトリの worktree を作成
RELATED_WORKTREES_FILE="/tmp/finegate-related-worktrees-$$.txt"
CROSS_REPO_PROMPT=""
RELATED_MCP_PATHS=""

if [ -n "${RELATED_REPOS:-}" ]; then
    echo "Processing related repositories: $RELATED_REPOS"
    IFS=',' read -ra REPO_SPECS <<< "$RELATED_REPOS"
    for repo_spec in "${REPO_SPECS[@]}"; do
        REL_REPO_NAME="${repo_spec%%:*}"
        REL_REPO_BRANCH="${repo_spec#*:}"
        if [ "$REL_REPO_BRANCH" = "$REL_REPO_NAME" ]; then
            REL_REPO_BRANCH=""
        fi

        # 関連リポジトリのパスを解決（エイリアス対応）
        if [ "$REL_REPO_NAME" = "agent" ]; then
            REL_REPO_PATH="$AGENT_PROJECT_PATH"
        elif [ "$REL_REPO_NAME" = "jjp" ]; then
            REL_REPO_PATH="$WORKSPACE_ROOT/jjp-loadsheet-ui"
        else
            REL_REPO_PATH="$WORKSPACE_ROOT/$REL_REPO_NAME"
        fi

        if [ ! -d "$REL_REPO_PATH" ]; then
            echo "Warning: Related repo directory $REL_REPO_PATH does not exist. Skipping."
            continue
        fi

        # ベースブランチ決定
        REL_BASE_BRANCH="$REL_REPO_BRANCH"
        if [ -z "$REL_BASE_BRANCH" ]; then
            REL_BASE_BRANCH=$(git -C "$REL_REPO_PATH" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
            if [ -z "$REL_BASE_BRANCH" ]; then
                if git -C "$REL_REPO_PATH" show-ref --verify --quiet refs/heads/main; then
                    REL_BASE_BRANCH="main"
                elif git -C "$REL_REPO_PATH" show-ref --verify --quiet refs/heads/develop; then
                    REL_BASE_BRANCH="develop"
                elif git -C "$REL_REPO_PATH" show-ref --verify --quiet refs/heads/master; then
                    REL_BASE_BRANCH="master"
                else
                    echo "Warning: Could not detect base branch for $REL_REPO_NAME. Skipping."
                    continue
                fi
            fi
        fi

        # 最新を取得
        git -C "$REL_REPO_PATH" fetch origin "$REL_BASE_BRANCH" 2>/dev/null || true
        git -C "$REL_REPO_PATH" worktree prune 2>/dev/null || true

        # worktree 作成
        REL_WORKTREE="/tmp/finegate-worktrees/${REL_REPO_NAME}-$(date +%s)"
        echo "Creating related worktree at: $REL_WORKTREE (base: $REL_BASE_BRANCH)"
        git -C "$REL_REPO_PATH" worktree add --detach "$REL_WORKTREE" "origin/$REL_BASE_BRANCH"

        # git config 設定
        git -C "$REL_WORKTREE" config user.name "$GIT_USER_NAME"
        git -C "$REL_WORKTREE" config user.email "$GIT_USER_EMAIL"

        # クリーンアップ用に記録
        echo "${REL_REPO_PATH}|${REL_WORKTREE}" >> "$RELATED_WORKTREES_FILE"

        # MCP設定マージ用のパスを記録
        RELATED_MCP_PATHS="${RELATED_MCP_PATHS}${RELATED_MCP_PATHS:+,}${REL_REPO_PATH}"

        # プロンプト用の情報を蓄積
        CROSS_REPO_PROMPT="${CROSS_REPO_PROMPT}
- リポジトリ: ${REL_REPO_NAME}
  パス: ${REL_WORKTREE}
  ベースブランチ: ${REL_BASE_BRANCH}"
    done
fi

# 5. MCP設定ファイルを動的に生成（ask_human + グローバル・プロジェクトMCPをマージ）
MCP_CONFIG="/tmp/finegate-mcp-config-$$.json"
MCP_SCRIPT_DIR="$SCRIPT_DIR" \
MCP_TARGET_PATH="$TARGET_PATH" \
MCP_RELATED_PATHS="$RELATED_MCP_PATHS" \
MCP_OUTPUT="$MCP_CONFIG" \
node -e "
const fs = require('fs');
const path = require('path');

const scriptDir = process.env.MCP_SCRIPT_DIR;
const targetPath = process.env.MCP_TARGET_PATH;
const relatedPaths = process.env.MCP_RELATED_PATHS;
const output = process.env.MCP_OUTPUT;

let mcpServers = {};

// 1. グローバルMCP設定 (~/.claude/.mcp.json) を読み込み（最低優先度）
const globalPath = path.join(process.env.HOME || '', '.claude', '.mcp.json');
try {
    if (fs.existsSync(globalPath)) {
        const g = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
        if (g.mcpServers) Object.assign(mcpServers, g.mcpServers);
    }
} catch (e) {
    console.error('Warning: global MCP config parse error:', e.message);
}

// 1.5. 関連リポジトリのMCP設定を読み込み（低〜中優先度）
if (relatedPaths) {
    for (const rp of relatedPaths.split(',')) {
        const relMcpPath = path.join(rp, '.mcp.json');
        try {
            if (fs.existsSync(relMcpPath)) {
                const r = JSON.parse(fs.readFileSync(relMcpPath, 'utf-8'));
                if (r.mcpServers) Object.assign(mcpServers, r.mcpServers);
            }
        } catch (e) {
            console.error('Warning: related MCP config parse error:', e.message);
        }
    }
}

// 2. プロジェクトレベルMCP設定 (\$TARGET_PATH/.mcp.json) を読み込み（中優先度）
const projectPath = path.join(targetPath, '.mcp.json');
try {
    if (fs.existsSync(projectPath)) {
        const p = JSON.parse(fs.readFileSync(projectPath, 'utf-8'));
        if (p.mcpServers) Object.assign(mcpServers, p.mcpServers);
    }
} catch (e) {
    console.error('Warning: project MCP config parse error:', e.message);
}

// 3. セッション固有のslack-human設定（最高優先度）
mcpServers['slack-human'] = {
    command: 'node',
    args: [path.join(scriptDir, 'dist/mcp-servers/slack-human-interaction/index.js')],
    env: {
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
        SLACK_CHANNEL: process.env.SLACK_CHANNEL || '',
        SLACK_THREAD_TS: process.env.SLACK_THREAD_TS || '',
        OWNER_SLACK_MEMBER_ID: process.env.OWNER_SLACK_MEMBER_ID || ''
    }
};

fs.writeFileSync(output, JSON.stringify({ mcpServers }, null, 2));
"

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
    # 関連リポジトリの worktree もクリーンアップ
    if [ -f "$RELATED_WORKTREES_FILE" ]; then
        while IFS='|' read -r rel_target rel_wt; do
            echo "Cleaning up related worktree: $rel_wt"
            git -C "$rel_target" worktree remove --force "$rel_wt" 2>/dev/null || rm -rf "$rel_wt"
        done < "$RELATED_WORKTREES_FILE"
        rm -f "$RELATED_WORKTREES_FILE"
    fi
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
if [ -n "$FOLLOW_UP_MESSAGE" ]; then
    # フォローアップモード: 既存ブランチで追加依頼を処理
    if [ -n "$GITHUB_REPO" ]; then
        echo "Claude Code starting follow-up for GitHub Issue: #${ISSUE_ID} (${GITHUB_REPO})..."
        PROMPT="前回のタスクでGitHub Issue #${ISSUE_ID}（${GITHUB_REPO}）に対する実装を行い、PRを作成しました。
ユーザーから追加の依頼があります。

【追加依頼】
${FOLLOW_UP_MESSAGE}

以下の手順で作業してください：
1. git fetch origin を実行してリモートの最新状態を取得してください
2. 既存の作業ブランチ（feat/issue-${ISSUE_ID} または fix/issue-${ISSUE_ID}）をチェックアウトしてください
3. 追加依頼の内容を実装してください
4. テストをパスさせてください
5. 変更をコミットしてpushしてください（既存のPRに自動反映されます）

【重要】新しいPRは作成しないでください。既存のブランチへのpushで自動的にPRが更新されます。
【重要】絶対に ${BASE_BRANCH} ブランチへ直接 push しないでください。

【重要】ask_human MCPツールは --mcp-config で事前設定済みです。MCPの設定ファイルを調査する必要はありません。直接呼び出してください。

【重要】実装中に以下のケースでは、必ず ask_human MCPツールを使用してSlackで確認してください（※ AskUserQuestion は使用禁止。必ず ask_human を使うこと）:
- 仕様の解釈が複数通りある場合
- 課題の記述が曖昧で実装方針が定まらない場合
- 破壊的な変更（既存APIの変更、DB スキーマ変更等）を行う前
- 設計判断で迷った場合（例: このロジックはどこに置くべきか）
勝手に解釈して進めず、必ず確認を取ってから実装してください。"
    else
        echo "Claude Code starting follow-up for Backlog Issue: $ISSUE_ID..."
        PROMPT="前回のタスクで課題 ${ISSUE_ID} に対する実装を行い、PRを作成しました。
ユーザーから追加の依頼があります。

【追加依頼】
${FOLLOW_UP_MESSAGE}

以下の手順で作業してください：
1. git fetch origin を実行してリモートの最新状態を取得してください
2. 既存の作業ブランチ（feat/${ISSUE_ID}）をチェックアウトしてください
3. 追加依頼の内容を実装してください
4. テストをパスさせてください
5. 変更をコミットしてpushしてください（既存のPRに自動反映されます）

【重要】新しいPRは作成しないでください。pushで既存のPRが自動更新されます。
【重要】絶対に ${BASE_BRANCH} ブランチへ直接 push しないでください。

【重要】ask_human MCPツールは --mcp-config で事前設定済みです。MCPの設定ファイルを調査する必要はありません。直接呼び出してください。

【重要】実装中に以下のケースでは、必ず ask_human MCPツールを使用してSlackで確認してください（※ AskUserQuestion は使用禁止。必ず ask_human を使うこと）:
- 仕様の解釈が複数通りある場合
- 課題の記述が曖昧で実装方針が定まらない場合
- 破壊的な変更（既存APIの変更、DB スキーマ変更等）を行う前
- 設計判断で迷った場合（例: このロジックはどこに置くべきか）
勝手に解釈して進めず、必ず確認を取ってから実装してください。"
    fi
elif [ -n "$USER_REQUEST" ]; then
    # ユーザー要望モード: 既存ブランチで要望を実装（オープン済みPRの修正等）
    # WORK_BRANCH: 明示指定時は BASE_BRANCH、未指定時は自動検出されたブランチ
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

【重要】ask_human MCPツールは --mcp-config で事前設定済みです。MCPの設定ファイルを調査する必要はありません。直接呼び出してください。

【重要】実装中に以下のケースでは、必ず ask_human MCPツールを使用してSlackで確認してください（※ AskUserQuestion は使用禁止。必ず ask_human を使うこと）:
- 仕様の解釈が複数通りある場合
- 課題の記述が曖昧で実装方針が定まらない場合
- 破壊的な変更（既存APIの変更、DB スキーマ変更等）を行う前
- 設計判断で迷った場合（例: このロジックはどこに置くべきか）
勝手に解釈して進めず、必ず確認を取ってから実装してください。"
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

【重要】ask_human MCPツールは --mcp-config で事前設定済みです。MCPの設定ファイルを調査する必要はありません。直接呼び出してください。

【重要】実装中に以下のケースでは、必ず ask_human MCPツールを使用してSlackで確認してください（※ AskUserQuestion は使用禁止。必ず ask_human を使うこと）:
- 仕様の解釈が複数通りある場合
- 課題の記述が曖昧で実装方針が定まらない場合
- 破壊的な変更（既存APIの変更、DB スキーマ変更等）を行う前
- 設計判断で迷った場合（例: このロジックはどこに置くべきか）
勝手に解釈して進めず、必ず確認を取ってから実装してください。"
    fi
elif [ -n "$GITHUB_REPO" ]; then
    echo "Claude Code starting for GitHub Issue: #${ISSUE_ID} (${GITHUB_REPO})..."
    # BRANCH_NAME が指定されている場合はそのブランチ名を使用、未指定の場合はIssue IDから自動生成
    if [ -n "$BRANCH_NAME" ]; then
        BRANCH_INSTRUCTION="ブランチ ${BRANCH_NAME} を作成してください。"
    else
        BRANCH_INSTRUCTION="Issue内容に基づいたブランチを作成してください。フォーマットは feat/issue-${ISSUE_ID} または fix/issue-${ISSUE_ID}（内容に応じて選択）。"
    fi

    PROMPT="以下のSTEPに従って作業してください。

STEP1: GitHub MCPを使用して ${GITHUB_REPO} リポジトリの Issue #${ISSUE_ID} の内容を確認してください。
${BRANCH_INSTRUCTION}
ブランチ作成後、必ずそのブランチに切り替えてください。

STEP2: Issue内容に基づいてコードを実装し、テストをパスさせてください。
適切な粒度でコミットしてください。

STEP3: すべての作業が完了したら、作業ブランチをリモートにpushし、GitHub MCPを使用してPRを作成してください。
PRのタイトルはIssue内容に基づいて簡潔に記述し、bodyには実施内容のサマリーを記載してください。
PRは必ずdraft状態で作成してください（--draft フラグを使用）。
PRのマージ先（ベースブランチ）は ${BASE_BRANCH} を指定してください（--base ${BASE_BRANCH}）。
ただし、課題の指示が以下に該当する場合はPRを作成せず、実施内容のレポートのみ報告してください:
- 調査・リサーチのみを求める指示の場合（例: 「〜を調べて」「〜の原因を特定して」）
- GitHub Issueへのコメント追加を求める指示の場合（例: 「調査結果をコメントで追加して」）
- レポートやドキュメント作成のみを求める指示の場合
- コード変更を伴わない作業の場合

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
    # BRANCH_NAME が指定されている場合はそのブランチ名を使用
    if [ -n "$BRANCH_NAME" ]; then
        BACKLOG_BRANCH_INSTRUCTION="ブランチ ${BRANCH_NAME} を作成してください。ブランチ作成後、必ずそのブランチに切り替えてください。"
    else
        BACKLOG_BRANCH_INSTRUCTION="課題IDに基づいたブランチを作成してください。フォーマットは feat/${ISSUE_ID} 。例: feat/RA_DEV-1234 。ブランチ作成後、必ずそのブランチに切り替えてください。"
    fi

    PROMPT="以下のSTEPに従って作業してください。

STEP1: Backlog MCPを使用して課題 ${ISSUE_ID} の内容を確認し、${BACKLOG_BRANCH_INSTRUCTION}\

STEP2: 課題内容に基づいてコードを実装し、テストをパスさせてください。\
デザインが必要な場合は、まず figma-desktop MCP を試してアプリからデータを取得し、\
接続できない場合は figma MCP (HTTP版) を使用して API 経由でデータを読み取ってください。\
.claude/commands/commit-dry.md を参考に適切な粒度でコミットしてください。

STEP3: すべての作業が完了したら、作業ブランチをリモートにpushし、PRを作成してください。\
PRのタイトルは課題内容に基づいて簡潔に記述し、bodyには実施内容のサマリーを記載してください。\
PRは必ずdraft状態で作成してください（--draft フラグを使用）。\
PRのマージ先（ベースブランチ）は ${BASE_BRANCH} を指定してください（--base ${BASE_BRANCH}）。\
ただし、課題の指示が以下に該当する場合はPRを作成せず、実施内容のレポートのみ報告してください:\
- レポートやドキュメント作成のみを求める指示の場合\
- Backlogの課題編集やPBI追加など、コード変更を伴わない作業の場合

【重要】絶対に ${BASE_BRANCH} ブランチへ直接 push しないでください。

【重要】ask_human MCPツールは --mcp-config で事前設定済みです。MCPの設定ファイルを調査する必要はありません。直接呼び出してください。

【重要】実装中に以下のケースでは、必ず ask_human MCPツールを使用してSlackで確認してください（※ AskUserQuestion は使用禁止。必ず ask_human を使うこと）:
- 仕様の解釈が複数通りある場合
- 課題の記述が曖昧で実装方針が定まらない場合
- 破壊的な変更（既存APIの変更、DB スキーマ変更等）を行う前
- 設計判断で迷った場合（例: このロジックはどこに置くべきか）
勝手に解釈して進めず、必ず確認を取ってから実装してください。"
fi

# ユーザーからの追加指示がある場合はプロンプトに付与（通常モードのみ）
if [ -z "$FOLLOW_UP_MESSAGE" ] && [ -n "$EXTRA_PROMPT" ]; then
    PROMPT="${PROMPT}

【ユーザーからの追加指示】
${EXTRA_PROMPT}"
fi

# クロスリポジトリ対応の追加指示
if [ -n "$CROSS_REPO_PROMPT" ]; then
    PROMPT="${PROMPT}

【クロスリポジトリ対応】
以下の関連リポジトリにもアクセス可能です。必要に応じて変更を加えてください。
${CROSS_REPO_PROMPT}

各関連リポジトリでの作業手順:
1. 関連リポジトリのディレクトリに移動してコードを確認・修正
2. ブランチを作成（feat/${ISSUE_ID}）してチェックアウト
3. 変更をコミットしてpush
4. PRを作成（draft、各リポジトリのベースブランチをマージ先に指定）

【重要】プライマリリポジトリと関連リポジトリの両方でPRを作成してください。
【重要】関連リポジトリのベースブランチへ直接 push しないでください。"
fi

# worktree ブランチ競合時の追加指示
if [ -n "$WORKTREE_BRANCH_CONFLICT" ]; then
    PROMPT="${PROMPT}

【重要：worktree競合への対応】
ブランチ '${WORKTREE_BRANCH_CONFLICT}' は別のworktreeで使用中のため、git checkout でそのブランチに切り替えることはできません。
以下の方法で対応してください：
- 現在のdetached HEADの状態のまま作業してください（すでにブランチの最新コミットにいます）
- コミットは通常通り行えます
- pushの際は \`git push origin HEAD:${WORKTREE_BRANCH_CONFLICT}\` を使用してください
- \`git checkout ${WORKTREE_BRANCH_CONFLICT}\` は絶対に実行しないでください（エラーになります）"
fi

claude --dangerously-skip-permissions \
  --verbose \
  --model claude-opus-4-6 \
  --output-format stream-json \
  --mcp-config "$MCP_CONFIG" \
  --disallowedTools AskUserQuestion \
  -p "$PROMPT"
echo "Task completed at $(date)"