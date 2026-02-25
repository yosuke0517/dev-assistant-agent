#!/bin/bash
# start-daemon.sh - caffeinate 付きでサーバーを起動するスクリプト
# macOS のシステムスリープを防止し、蓋を閉じても動作し続ける
#
# 使い方:
#   ./start-daemon.sh         # 本番モード（ビルド済み）
#   ./start-daemon.sh --dev   # 開発モード（tsx）

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# caffeinate コマンドの存在確認（macOS 標準）
if ! command -v caffeinate >/dev/null 2>&1; then
    echo "Warning: caffeinate command not found (non-macOS environment?)"
    echo "Starting without sleep prevention..."
    if [ "$1" = "--dev" ]; then
        exec npm run dev
    else
        exec npm start
    fi
fi

echo "=== Finegate Dev Assistant Agent ==="
echo "Sleep prevention: enabled (caffeinate -s)"
echo "Mode: $([ "$1" = "--dev" ] && echo "development" || echo "production")"
echo "PID: $$"
echo "===================================="

# caffeinate -s: システムスリープを防止
# caffeinate はラップしたプロセスが終了すると自動解除される
if [ "$1" = "--dev" ]; then
    exec caffeinate -s npm run dev
else
    exec caffeinate -s npm start
fi
