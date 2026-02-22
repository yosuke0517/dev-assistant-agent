# Finegate Stealth Agent - Global Infrastructure Setup

## 1. ドメイン・DNS設定（管理権の移譲）
1. **ドメイン取得**: お名前.com で `finegate.xyz` を確保。
2. **ネームサーバー移譲 (最重要)**: 
   - **Cloudflareコンソール**で提示された2つのネームサーバーをコピー。
     - (例: `aspen.ns.cloudflare.com` / `dakota.ns.cloudflare.com`)
   - **お名前.com Navi** にログインし、「ネームサーバーの変更」へ進む。
   - 「他のネームサーバーを利用」タブを選択。
   - **Cloudflareからコピーした2つの値**を「ネームサーバー1」「ネームサーバー2」にそれぞれ貼り付け。
   - ※以前の AWS (Route 53) レコードなどは全て削除して上書きする。
3. **アクティベート**: Cloudflare側で「サイトはアクティブです」と表示されるまで待機。
4. **SSL/TLS**: 「エッジ証明書」が「有効」になるまで待機（HTTPS通信に必須）。

## 2. Cloudflare Tunnel 作成
1. **ログイン**: `cloudflared tunnel login`。
2. **作成**: `cloudflared tunnel create agent` (ID: `f1c9ec3d-8f73-4203-853f-adda0664db34`)。
3. **DNS紐付け**: `cloudflared tunnel route dns agent agent.finegate.xyz`。

## 3. Slack App 連携
1. **App作成**: [Slack API](https://api.slack.com/apps) で `Finegate-Agent` を作成。
2. **Slash Command**: `/do` を作成。
3. **エンドポイント**: `Request URL` に `https://agent.finegate.xyz/do` を設定。
4. **Bot Token Scopes** に以下を設定する(OAuth & Permissions):
   - `chat:write` — メッセージ送信（質問投稿・進捗通知）
   - `channels:history` — パブリックチャンネルのメッセージ読み取り（返信受信）
   - `groups:history` — プライベートチャンネルのメッセージ読み取り（返信受信）
   - `commands` — Slash Commandの受信