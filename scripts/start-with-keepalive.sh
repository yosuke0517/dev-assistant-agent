#!/bin/bash
# Finegate Stealth Agent - スリープ抑止付き起動スクリプト
#
# caffeinate -s でシステムスリープを抑止しつつ、
# Node.jsサーバーとCloudflare Tunnelの両方を起動する。
#
# 使い方:
#   ./scripts/start-with-keepalive.sh        # 本番モード
#   ./scripts/start-with-keepalive.sh dev     # 開発モード（tsx使用）
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

MODE="${1:-prod}"

cleanup() {
    echo "[keepalive] Shutting down..."
    # バックグラウンドプロセスを終了
    if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
        kill "$TUNNEL_PID"
        wait "$TUNNEL_PID" 2>/dev/null || true
    fi
    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID"
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    echo "[keepalive] All processes stopped."
}
trap cleanup EXIT INT TERM

# Cloudflare Tunnel をバックグラウンドで起動
echo "[keepalive] Starting Cloudflare Tunnel..."
caffeinate -s cloudflared tunnel run agent &
TUNNEL_PID=$!

# サーバー起動（caffeinate付き）
if [ "$MODE" = "dev" ]; then
    echo "[keepalive] Starting server in dev mode..."
    caffeinate -s npx tsx server.ts &
else
    echo "[keepalive] Starting server in production mode..."
    npm run build
    caffeinate -s node dist/server.js &
fi
SERVER_PID=$!

echo "[keepalive] All services started."
echo "[keepalive]   Tunnel PID: $TUNNEL_PID"
echo "[keepalive]   Server PID: $SERVER_PID"
echo "[keepalive] Press Ctrl+C to stop all services."

# どちらかのプロセスが終了するまで待機
wait -n "$TUNNEL_PID" "$SERVER_PID" 2>/dev/null || true
echo "[keepalive] A process exited. Shutting down..."
