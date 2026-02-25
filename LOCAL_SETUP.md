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
1. トンネル起動 (Terminal 1):
   cloudflared tunnel run agent

2. サーバー起動 (Terminal 2):

   【開発環境】
   cd ~/work/dev-assistant-agent && npm run dev

   【本番環境 (AWS等)】
   cd ~/work/dev-assistant-agent && npm run build && npm start

## 3. 🔋 スリープ防止（蓋を閉じても動作させる）

MacBook の蓋を閉じてもシステムを動作させ続けるには、以下のいずれかを使用してください。
詳細は [docs/sleep-prevention-guide.md](docs/sleep-prevention-guide.md) を参照。

### 方法A: start-daemon.sh を使う（簡単）
```bash
# 本番モード
./start-daemon.sh

# 開発モード
./start-daemon.sh --dev
```

### 方法B: launchd でサービス化する（常時稼働向け）
```bash
cp launchd/com.finegate.dev-assistant-agent.plist ~/Library/LaunchAgents/
cp launchd/com.finegate.cloudflared.plist ~/Library/LaunchAgents/
mkdir -p ~/Library/Logs/finegate
launchctl load ~/Library/LaunchAgents/com.finegate.dev-assistant-agent.plist
launchctl load ~/Library/LaunchAgents/com.finegate.cloudflared.plist
```

### 方法C: pmset でシステム設定を変更する（永続的）
```bash
sudo pmset -c sleep 0
sudo pmset -c disablesleep 1
sudo pmset -a tcpkeepalive 1
```

## 4. 📝 使い方
Slackで以下のように送信してください。
/do circus_backend PROJ-123
