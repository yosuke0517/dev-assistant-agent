# Finegate Stealth Agent - デプロイメント計画（自宅 Mac Mini 運用）

## 1. 概要

自宅 Mac Mini (M4, 24GB/512GB) を常時稼働サーバーとして運用する。
現状の MacBook Pro 構成とほぼ同じ仕組みで、変更点は最小限。

### 構成

```
[Slack /do] → [Cloudflare Tunnel] → [Mac Mini:8787] → [Claude Code CLI] → [GitHub/Backlog]
```

### 採用理由（AWS との比較）

| 項目 | Mac Mini (M4) | AWS EC2 (t3.medium) |
|------|--------------|---------------------|
| 月額コスト | ~¥350-500（電気代のみ） | ~¥10,000 |
| CPU | 10コア（制限なし） | 2 vCPU（バースト制限あり） |
| メモリ | 24GB ユニファイドメモリ | 4GB |
| ストレージ | 512GB NVMe SSD | 50GB EBS gp3 |
| 2年間の総コスト | ~¥167,000 | ~¥240,000 |

> **2年間で約7万円、3年間で約19万円の差額**。個人開発アシスタント用途では Mac Mini が最適。

---

## 2. セットアップ手順

1. Mac Mini を自宅ネットワーク（有線 Ethernet 推奨）に接続
2. macOS 初期設定・自動ログイン設定
3. Homebrew、Node.js、Git、Claude Code CLI をインストール
4. `cloudflared` インストール・既存 Tunnel 設定を移行（または新規作成）
5. SSH リモートアクセス設定（Cloudflare Tunnel 経由、[セクション 4](#4-cloudflare-tunnel--ssh-設定) 参照）
6. アプリケーションを `launchd` でサービス登録（[セクション 3](#3-launchd-サービス登録) 参照）
7. 省エネ設定・macOS サーバー設定（[セクション 5](#5-macos-サーバー設定) 参照）

---

## 3. launchd サービス登録

### Agent サービス

```xml
<!-- ~/Library/LaunchAgents/com.finegate.agent.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.finegate.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/agent/work/dev-assistant-agent/dist/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/agent/work/dev-assistant-agent</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/agent/logs/finegate-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/agent/logs/finegate-agent.error.log</string>
</dict>
</plist>
```

```bash
# サービス登録・起動
launchctl load ~/Library/LaunchAgents/com.finegate.agent.plist
launchctl start com.finegate.agent
```

### cloudflared サービス

```bash
# cloudflared の launchd 登録（公式コマンド）
sudo cloudflared service install
```

---

## 4. Cloudflare Tunnel / SSH 設定

### ドメイン・DNS（設定済み）

| # | 内容 | 状態 |
|---|------|------|
| 1 | ドメイン取得: `finegate.xyz` | 済（お名前.com） |
| 2 | ネームサーバー委譲: Cloudflare NS | 済 |
| 3 | SSL/TLS 証明書有効確認 | 済 |

### Tunnel 設定（Mac Mini 側）

```yaml
# ~/.cloudflared/config.yml
tunnel: <tunnel-id>
credentials-file: /Users/<username>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: agent.finegate.xyz
    service: http://localhost:8787
  - hostname: ssh.finegate.xyz        # SSH 用サブドメイン（外出先からのアクセス用）
    service: ssh://localhost:22
  - service: http_status:404
```

### SSH リモートアクセスの有効化

```bash
# macOS のリモートログインを有効化
sudo systemsetup -setremotelogin on
```

外出先からの接続:
```bash
# cloudflared がインストールされたクライアントから
ssh -o ProxyCommand="cloudflared access ssh --hostname ssh.finegate.xyz" user@ssh.finegate.xyz

# または ~/.ssh/config に設定
# Host mac-mini
#   HostName ssh.finegate.xyz
#   ProxyCommand cloudflared access ssh --hostname %h
#   User <username>
```

---

## 5. macOS サーバー設定

サーバーとして安定稼働させるための設定。**初回セットアップ時に必ず実施する。**

```bash
# 停電復旧後に自動起動（最重要）
sudo pmset -a autorestart 1

# システムフリーズ時の自動再起動
sudo systemsetup -setrestartfreeze on

# スリープ無効化
sudo pmset -a sleep 0
sudo pmset -a disksleep 0
sudo pmset -a displaysleep 0

# Wake on LAN を有効化（同一ネットワーク内からの起動用）
sudo pmset -a wolon 1

# Power Nap を有効化（スリープ中もネットワーク接続を維持）
sudo pmset -a powernap 1
```

---

## 6. Git / SSH 認証

| # | 作業内容 | 状態 | 備考 |
|---|---------|------|------|
| 1 | GitHub SSH 鍵の作成 | 要実施 | Mac Mini 上で `ssh-keygen` → GitHub に登録 |
| 2 | 対象リポジトリへの Deploy Key 登録 | 要実施 | dev-assistant-agent + 各受託案件リポジトリ |
| 3 | SSH config の設定 | 要実施 | `~/.ssh/config` |

---

## 7. Slack App

| # | 作業内容 | 状態 | 備考 |
|---|---------|------|------|
| 1 | Slack App `Finegate-Agent` | 済 | 作成済み |
| 2 | Request URL | - | `https://agent.finegate.xyz/do` のまま変更不要 |
| 3 | Bot Token Scopes | 済 | `chat:write`, `channels:history`, `groups:history`, `commands` |

> Cloudflare Tunnel 経由のため、Slack App 側の設定変更は不要。

---

## 8. Claude Code 認証

| # | 作業内容 | 状態 | 備考 |
|---|---------|------|------|
| 1 | Claude Code のログイン | 要実施 | Mac Mini 上で `claude login`（対話的認証） |
| 2 | API キーの設定（代替） | - | `ANTHROPIC_API_KEY` 環境変数での認証も可 |

---

## 9. 外出先からのリモート復旧

### 障害シナリオ別の対応

| シナリオ | 外出先から復旧可能? | 対応方法 |
|---------|-------------------|---------|
| Agent プロセスがクラッシュ | ◎ 自動復旧 | `launchd` の `KeepAlive` で自動再起動 |
| cloudflared がクラッシュ | ◎ 自動復旧 | `launchd` の `KeepAlive` で自動再起動 |
| Node.js がハングアップ | ○ SSH で対応可 | Cloudflare Tunnel 経由で SSH → `launchctl stop` |
| macOS がフリーズ | ○ スマートプラグで対応 | リモート電源OFF/ON → macOS 自動起動で復旧 |
| カーネルパニック | ○ 自動復旧 | macOS は KP 後に自動再起動（デフォルト動作） |
| 停電（短時間） | ○ UPS で継続 | UPS で数分〜数十分はカバー |
| 停電（長時間） | ○ 自動復旧 | 復電後に macOS 自動起動 + launchd でサービス復旧 |
| 自宅インターネット障害 | × 復旧不可 | 回線復旧を待つしかない |
| ハードウェア故障 | × 復旧不可 | 物理的対応が必要（AWS フェイルオーバーが有効） |

### スマートプラグ（リモート電源制御）

macOS がフリーズして SSH も応答しない場合の最終手段。

| 製品例 | 価格 | 特徴 |
|--------|------|------|
| SwitchBot プラグミニ | ~¥1,500 | スマホアプリ・API 対応 |
| TP-Link Tapo P105 | ~¥1,200 | スマホアプリ対応、入手しやすい |
| Meross スマートプラグ | ~¥1,500 | HomeKit 対応 |

**復旧手順**（macOS フリーズ時）:
1. スマホアプリでスマートプラグの電源を **OFF**
2. 10秒待機
3. スマートプラグの電源を **ON**
4. macOS が `autorestart` 設定により自動起動
5. `launchd` により cloudflared + Agent プロセスが自動起動
6. Cloudflare Tunnel が再接続され、サービス復旧（所要時間: 約2〜3分）

### 復旧フロー

```
障害発生
  ↓
外部ヘルスチェックが検知 → Slack 通知
  ↓
① プロセスクラッシュ?
  → launchd が自動復旧（対応不要）
  ↓
② SSH 接続可能?
  → cloudflared access ssh で接続
  → ログ確認・手動でサービス再起動
  ↓
③ SSH 不通（OS フリーズ等）?
  → スマートプラグでリモート電源OFF/ON
  → macOS 自動起動 → サービス自動復旧
  ↓
④ 上記すべて失敗?
  → ハードウェア障害の可能性
  → AWS Terraform apply でフェイルオーバー（約30分）
```

---

## 10. ヘルスチェック & 自動通知

### 外部監視サービス（推奨）

[UptimeRobot](https://uptimerobot.com/)（無料プラン: 5分間隔）や [Healthchecks.io](https://healthchecks.io/) を使用:
- `https://agent.finegate.xyz/health` エンドポイントを監視（※要実装）
- ダウン検知時に Slack / メール通知

### ローカルヘルスチェック（cron）

```bash
# /usr/local/bin/finegate-healthcheck.sh
#!/bin/bash
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/health 2>/dev/null)
if [ "$RESPONSE" != "200" ]; then
  launchctl stop com.finegate.agent
  sleep 2
  launchctl start com.finegate.agent
fi
```

```bash
# crontab -e
*/5 * * * * /usr/local/bin/finegate-healthcheck.sh
```

---

## 11. 本システム固有の注意点

### node-pty のプラットフォーム対応

現在の `package.json` の postinstall:
```json
"postinstall": "chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper 2>/dev/null || true && lefthook install 2>/dev/null || true"
```

Mac Mini (Apple Silicon) では `darwin-arm64` のプレビルドが使用されるため、現状のままで動作する。

### stealth-run.sh のパス

`WORKSPACE_ROOT` と `AGENT_PROJECT_PATH` が `.env` で設定されるため、パスの変更は `.env` の修正のみで対応可能。

| 環境変数 | MacBook Pro | Mac Mini |
|---------|------------|----------|
| `WORKSPACE_ROOT` | `/Users/takeuchiyosuke/work` | Mac Mini のパスに合わせて設定 |
| `AGENT_PROJECT_PATH` | `/Users/takeuchiyosuke/work/dev-assistant-agent` | Mac Mini のパスに合わせて設定 |

### worktree のストレージ

- worktree は `/tmp/finegate-worktrees/` に作成され、処理完了後に自動クリーンアップ
- Mac Mini の 512GB SSD の `/tmp` を使用するため容量は十分

---

---

## 付録: AWS フェイルオーバー計画（参考）

> **通常運用は Mac Mini を使用する。** 以下は Mac Mini の完全故障・長期不在時に AWS へフェイルオーバーするための参考資料。Terraform 構成はいつでもデプロイ可能な状態で保持しておく（ハイブリッド戦略）。

### AWS 移行後の構成

```
[Slack /do] → [Cloudflare Tunnel] → [EC2:8787] → [Claude Code CLI] → [GitHub/Backlog]
```

### 推奨アーキテクチャ（EC2）

Cloudflare Tunnel を継続利用し、EC2 はプライベートサブネットに配置。

```
[AWS VPC - Private Subnet]
  └── [EC2 Instance (t3.medium または t3.large)]
        ├── cloudflared (tunnel daemon)
        ├── Node.js Server (:8787)
        ├── Claude Code CLI
        └── Git repos + worktrees
```

### 事前準備（AWS フェイルオーバー時）

| # | 作業内容 | 備考 |
|---|---------|------|
| 1 | AWS アカウント・IAM ユーザー作成 | AdministratorAccess またはカスタムポリシー |
| 2 | AWS CLI の設定 | `aws configure` |
| 3 | Terraform インストール | v1.6+ 推奨 |
| 4 | Terraform state 用 S3 バケット手動作成 | `terraform init` 前に必要 |
| 5 | EC2 上で SSH 鍵作成・GitHub Deploy Key 登録 | - |
| 6 | EC2 上で `claude login` 実行 | 対話的認証が必要 |

### Terraform クイックスタート

```bash
# 1. Terraform state 用の S3 バケットを手動作成（初回のみ）
aws s3 mb s3://finegate-terraform-state --region ap-northeast-1

# 2. DynamoDB テーブル作成（state lock 用）
aws dynamodb create-table \
  --table-name finegate-terraform-lock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ap-northeast-1

# 3. Terraform 実行
cd terraform/
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
terraform apply
```

### AWS コスト見積もり（月額概算・東京リージョン）

| リソース | 月額概算 (USD) |
|---------|---------------|
| EC2 (t3.medium) 24/7 | ~$30 |
| EBS (50GB gp3) | ~$4 |
| NAT Gateway | ~$32 + 転送量 |
| CloudWatch Logs | ~$1-5 |
| S3 (tfstate) | ~$0.01 |
| **合計** | **~$67-71/月（約¥10,000）** |

### node-pty の Linux 対応（AWS 移行時）

AWS (Linux x86_64) では `linux-x64` のプレビルドが使用される。移行時に `package.json` の postinstall を修正:

```json
"postinstall": "chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true && lefthook install 2>/dev/null || true"
```

### AWS 移行時の環境変数

| 環境変数 | Mac Mini | AWS (EC2) |
|---------|----------|-----------|
| `WORKSPACE_ROOT` | ローカルパス | `/home/agent/work` |
| `AGENT_PROJECT_PATH` | ローカルパス | `/home/agent/work/dev-assistant-agent` |
