# Finegate Stealth Agent - Local Setup & Operations

## 1. 設定ファイルの配置
### Cloudflare Config (~/.cloudflared/config.yml)
--------------------------------------------------
tunnel: f1c9ec3d-8f73-4203-853f-adda0664db34
credentials-file: /Users/takeuchiyosuke/.cloudflared/f1c9ec3d-8f73-4203-853f-adda0664db34.json

ingress:
  - hostname: agent.finegate.xyz
    service: http://127.0.0.1:8787
  - service: http_status:404
--------------------------------------------------

## 2. 🚀 日々の起動手順

### 方法A: 手動起動（ターミナル2つ）
1. トンネル起動 (Terminal 1):
   cloudflared tunnel run agent

2. サーバー起動 (Terminal 2):

   【開発環境】
   cd ~/work/dev-assistant-agent && npm run dev

   【本番環境 (AWS等)】
   cd ~/work/dev-assistant-agent && npm run build && npm start

### 方法B: スリープ抑止付き一括起動（推奨）
   cd ~/work/dev-assistant-agent && ./scripts/start-with-keepalive.sh
   # 開発モード: ./scripts/start-with-keepalive.sh dev

### 方法C: launchdサービス化（蓋閉じ対応・最推奨）
   cd ~/work/dev-assistant-agent && ./scripts/setup-launchd.sh
   # ログイン時に自動起動、異常終了時に自動再起動される
   # 詳細: docs/prevent-sleep-guide.md

## 2.1. 🔋 蓋閉じ時のスリープ防止設定

MacBookの蓋を閉じてもシステムを稼働させるには、以下のpmset設定が必要:

   sudo pmset -a disablesleep 1
   sudo pmset -a sleep 0

詳細な設定ガイド: docs/prevent-sleep-guide.md

## 3. 📝 使い方
Slackで以下のように送信してください。
/do circus_backend PROJ-123
