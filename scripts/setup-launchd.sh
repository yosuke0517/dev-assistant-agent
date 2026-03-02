#!/bin/bash
# Finegate Stealth Agent - launchd サービスセットアップスクリプト
#
# Node.jsサーバーとCloudflare Tunnelをlaunchdサービスとして登録する。
# ログイン時に自動起動し、異常終了時には自動再起動される。
#
# 使い方:
#   ./scripts/setup-launchd.sh          # セットアップ
#   ./scripts/setup-launchd.sh uninstall # アンインストール
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$PROJECT_DIR/logs"

SERVER_PLIST="com.finegate.agent-server.plist"
TUNNEL_PLIST="com.finegate.cloudflared.plist"

uninstall() {
    echo "Uninstalling launchd services..."

    launchctl unload "$LAUNCHD_DIR/$SERVER_PLIST" 2>/dev/null || true
    launchctl unload "$LAUNCHD_DIR/$TUNNEL_PLIST" 2>/dev/null || true

    rm -f "$LAUNCHD_DIR/$SERVER_PLIST"
    rm -f "$LAUNCHD_DIR/$TUNNEL_PLIST"

    echo "Services uninstalled."
}

if [ "$1" = "uninstall" ]; then
    uninstall
    exit 0
fi

# 事前チェック
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
    echo "Error: node not found in PATH."
    exit 1
fi

CLOUDFLARED_PATH=$(which cloudflared)
if [ -z "$CLOUDFLARED_PATH" ]; then
    echo "Error: cloudflared not found in PATH."
    exit 1
fi

if [ ! -f "$PROJECT_DIR/dist/server.js" ]; then
    echo "Built files not found. Running npm run build..."
    (cd "$PROJECT_DIR" && npm run build)
fi

# ログディレクトリ作成
mkdir -p "$LOG_DIR"

# .env の内容を plist に反映するための環境変数読み込み
ENV_VARS=""
if [ -f "$PROJECT_DIR/.env" ]; then
    while IFS='=' read -r key value; do
        # コメント行・空行をスキップ
        [[ "$key" =~ ^#.*$ ]] && continue
        [[ -z "$key" ]] && continue
        # 引用符を除去
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        ENV_VARS="$ENV_VARS        <key>$key</key>\n        <string>$value</string>\n"
    done < "$PROJECT_DIR/.env"
fi

# plistファイルを生成（プレースホルダを置換）
mkdir -p "$LAUNCHD_DIR"

# 既存サービスを停止
launchctl unload "$LAUNCHD_DIR/$SERVER_PLIST" 2>/dev/null || true
launchctl unload "$LAUNCHD_DIR/$TUNNEL_PLIST" 2>/dev/null || true

# サーバー plist
sed -e "s|__NODE_PATH__|$NODE_PATH|g" \
    -e "s|__AGENT_PROJECT_PATH__|$PROJECT_DIR|g" \
    "$SCRIPT_DIR/launchd/$SERVER_PLIST" > "$LAUNCHD_DIR/$SERVER_PLIST"

# .env の環境変数を追加
if [ -n "$ENV_VARS" ]; then
    # EnvironmentVariables dict に .env の値を追加
    ENV_BLOCK=$(printf '%b' "$ENV_VARS")
    # PATH行の後に挿入
    awk -v env="$ENV_BLOCK" '
        /<key>NODE_ENV<\/key>/ { print; getline; print; print env; next }
        { print }
    ' "$LAUNCHD_DIR/$SERVER_PLIST" > "$LAUNCHD_DIR/$SERVER_PLIST.tmp"
    mv "$LAUNCHD_DIR/$SERVER_PLIST.tmp" "$LAUNCHD_DIR/$SERVER_PLIST"
fi

# Tunnel plist
sed -e "s|__CLOUDFLARED_PATH__|$CLOUDFLARED_PATH|g" \
    -e "s|__AGENT_PROJECT_PATH__|$PROJECT_DIR|g" \
    "$SCRIPT_DIR/launchd/$TUNNEL_PLIST" > "$LAUNCHD_DIR/$TUNNEL_PLIST"

# サービス登録
launchctl load "$LAUNCHD_DIR/$SERVER_PLIST"
launchctl load "$LAUNCHD_DIR/$TUNNEL_PLIST"

echo "=== Setup Complete ==="
echo "Services registered:"
echo "  - $SERVER_PLIST (Node.js server with caffeinate)"
echo "  - $TUNNEL_PLIST (Cloudflare Tunnel with caffeinate)"
echo ""
echo "Logs:"
echo "  - $LOG_DIR/server.log"
echo "  - $LOG_DIR/cloudflared.log"
echo ""
echo "Management commands:"
echo "  launchctl list | grep finegate    # ステータス確認"
echo "  launchctl unload ~/Library/LaunchAgents/$SERVER_PLIST   # サーバー停止"
echo "  launchctl unload ~/Library/LaunchAgents/$TUNNEL_PLIST   # トンネル停止"
echo ""
echo "Uninstall:"
echo "  ./scripts/setup-launchd.sh uninstall"
