# Finegate Stealth Agent - Local Setup & Operations

## 1. 設定ファイルの配置
### Cloudflare Config (~/.cloudflared/config.yml)
--------------------------------------------------
tunnel: <YOUR_TUNNEL_ID>
credentials-file: /Users/<YOUR_USERNAME>/.cloudflared/<YOUR_TUNNEL_ID>.json

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

## 3. 📝 使い方
Slackで以下のように送信してください。
/do circus_backend PROJ-123
