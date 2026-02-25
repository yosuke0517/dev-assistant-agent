# Finegate Stealth Agent - AWS デプロイメント計画

## 1. 概要

現在ローカルの MacBook Pro で稼働している Finegate Stealth Agent を AWS 上に移行する。
Terraform で再構築が容易なインフラ構成とし、手作業が必要な項目も明確に分離して記載する。

### 現状の構成

```
[Slack /do] → [Cloudflare Tunnel] → [MacBook Pro:8787] → [Claude Code CLI] → [GitHub/Backlog]
```

### 移行後の構成

```
[Slack /do] → [Cloudflare Tunnel] → [EC2:8787] → [Claude Code CLI] → [GitHub/Backlog]
```

## 2. 推奨アーキテクチャ

### 2.1. なぜ EC2 か

| 選択肢 | 評価 | 理由 |
|---------|------|------|
| **EC2（採用）** | ◎ | Claude Code CLI は PTY・フルシェル・Git worktree が必要。ローカル環境と同等の再現が容易 |
| ECS/Fargate | △ | node-pty の PTY 要件、Claude Code CLI のインストール、Git worktree のファイルシステム要件で困難 |
| Lambda | × | 長時間実行（数十分〜数時間）、PTY 要件、ファイルシステム要件で不適合 |

### 2.2. ネットワーク構成

**Cloudflare Tunnel を継続利用する**（推奨）

理由:
- 既存の Slack App 設定（`agent.finegate.xyz`）をそのまま活用可能
- パブリック IP・ALB・ACM 証明書が不要（コスト削減）
- EC2 はプライベートサブネットに配置可能（セキュリティ向上）
- `cloudflared` を EC2 にインストールして systemd サービスとして起動するだけ

```
[Slack] → [Cloudflare Edge] → [Cloudflare Tunnel]
                                       ↓ (Secure Tunnel)
[AWS VPC - Private Subnet]
  └── [EC2 Instance]
        ├── cloudflared (tunnel daemon)
        ├── Node.js Server (:8787)
        ├── Claude Code CLI
        └── Git repos + worktrees
```

### 2.3. 構成図

```
┌─────────────────────────────────────────────────────────┐
│ AWS Account                                             │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ VPC (10.0.0.0/16)                               │    │
│  │                                                  │    │
│  │  ┌───────────────────────────┐                   │    │
│  │  │ Public Subnet (10.0.1.0/24)                   │    │
│  │  │  ┌───────────────┐                            │    │
│  │  │  │ NAT Gateway   │──→ Internet Gateway        │    │
│  │  │  └───────────────┘                            │    │
│  │  └───────────────────────────┘                   │    │
│  │                                                  │    │
│  │  ┌───────────────────────────┐                   │    │
│  │  │ Private Subnet (10.0.2.0/24)                  │    │
│  │  │  ┌─────────────────────────────────────┐      │    │
│  │  │  │ EC2 (t3.medium / t3.large)          │      │    │
│  │  │  │  ├─ cloudflared (tunnel daemon)     │      │    │
│  │  │  │  ├─ Node.js Server (:8787)          │      │    │
│  │  │  │  ├─ Claude Code CLI                 │      │    │
│  │  │  │  └─ Git repos (/home/agent/work)    │      │    │
│  │  │  │                                     │      │    │
│  │  │  │  EBS: 50GB gp3                      │      │    │
│  │  │  └─────────────────────────────────────┘      │    │
│  │  └───────────────────────────┘                   │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌──────────────────┐  ┌────────────────────────┐       │
│  │ SSM Parameter    │  │ CloudWatch Logs         │       │
│  │ Store            │  │  └─ /finegate/agent     │       │
│  │  ├─ SLACK_*      │  └────────────────────────┘       │
│  │  ├─ GIT_*        │                                   │
│  │  └─ CLOUDFLARE_* │  ┌────────────────────────┐       │
│  └──────────────────┘  │ S3 (tfstate)            │       │
│                        │  └─ finegate-terraform   │       │
│                        └────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
```

## 3. Terraform リソース一覧

### 3.1. ディレクトリ構成

```
terraform/
├── main.tf              # プロバイダ設定、terraform backend
├── variables.tf         # 変数定義
├── outputs.tf           # 出力値
├── vpc.tf               # VPC、サブネット、IGW、NAT GW
├── security_group.tf    # セキュリティグループ
├── iam.tf               # IAM ロール、ポリシー
├── ec2.tf               # EC2 インスタンス、EBS
├── ssm.tf               # SSM パラメータストア
├── cloudwatch.tf        # CloudWatch ロググループ
├── s3.tf                # Terraform state バケット（初回のみ）
├── templates/
│   └── user_data.sh.tpl # EC2 初期化スクリプト
└── terraform.tfvars.example  # 変数値のサンプル
```

### 3.2. リソース詳細

#### ネットワーク（vpc.tf）

| リソース | 説明 |
|---------|------|
| `aws_vpc` | CIDR: 10.0.0.0/16 |
| `aws_subnet` (public) | 10.0.1.0/24 - NAT Gateway 用 |
| `aws_subnet` (private) | 10.0.2.0/24 - EC2 配置用 |
| `aws_internet_gateway` | パブリックサブネットのインターネットアクセス |
| `aws_nat_gateway` | プライベートサブネットのアウトバウンド通信用 |
| `aws_eip` | NAT Gateway 用の Elastic IP |
| `aws_route_table` × 2 | パブリック / プライベート用 |

#### セキュリティグループ（security_group.tf）

| リソース | ルール |
|---------|--------|
| `aws_security_group` (agent) | インバウンド: なし（Cloudflare Tunnel は EC2 からアウトバウンド接続のため不要） |
| | アウトバウンド: 443/tcp (HTTPS - GitHub, Slack, Cloudflare, npm), 22/tcp (SSH - GitHub) |

> **ポイント**: Cloudflare Tunnel はEC2から Cloudflare へのアウトバウンド接続なので、インバウンドルールは不要。

#### IAM（iam.tf）

| リソース | 説明 |
|---------|------|
| `aws_iam_role` (agent) | EC2 インスタンスプロファイル用 |
| `aws_iam_instance_profile` | EC2 にアタッチ |
| `aws_iam_role_policy` | SSM Parameter Store 読み取り、CloudWatch Logs 書き込み |

#### EC2（ec2.tf）

| リソース | 設定 |
|---------|------|
| `aws_instance` | AMI: Amazon Linux 2023, インスタンスタイプ: t3.medium（初期）|
| | EBS: 50GB gp3（Git リポジトリ + node_modules + worktrees） |
| | IAM Instance Profile: 上記ロール |
| | User Data: 初期セットアップスクリプト |

**インスタンスタイプの選定基準:**

| タイプ | vCPU | メモリ | 推奨ケース |
|--------|------|--------|----------|
| t3.medium | 2 | 4GB | 基本構成。同時実行1タスクで十分な場合 |
| t3.large | 2 | 8GB | Git リポジトリが大きい、Node.js の使用メモリが多い場合 |
| t3.xlarge | 4 | 16GB | 将来的に同時実行数を増やす場合 |

#### SSM パラメータストア（ssm.tf）

| パラメータパス | 説明 | タイプ |
|---------------|------|--------|
| `/finegate/slack/bot-token` | Slack Bot Token (xoxb-...) | SecureString |
| `/finegate/slack/channel` | デフォルト Slack チャンネル ID | String |
| `/finegate/slack/owner-member-id` | オーナーの Slack メンバー ID | String |
| `/finegate/git/user-name` | Git コミット用ユーザー名 | String |
| `/finegate/git/user-email` | Git コミット用メールアドレス | String |
| `/finegate/cloudflare/tunnel-token` | Cloudflare Tunnel トークン | SecureString |

#### CloudWatch（cloudwatch.tf）

| リソース | 説明 |
|---------|------|
| `aws_cloudwatch_log_group` | `/finegate/agent` - アプリケーションログ |
| | 保持期間: 30日 |

#### S3（s3.tf）

| リソース | 説明 |
|---------|------|
| `aws_s3_bucket` | `finegate-terraform-state` - Terraform state 管理 |
| `aws_s3_bucket_versioning` | 有効 |
| `aws_dynamodb_table` | `finegate-terraform-lock` - state ロック |

### 3.3. User Data スクリプト（EC2 初期化）

EC2 起動時に以下を自動セットアップする:

```bash
#!/bin/bash
set -e

# 1. システムパッケージ
yum update -y
yum install -y git jq

# 2. Node.js 20.x インストール
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs

# 3. Claude Code CLI インストール
npm install -g @anthropic-ai/claude-code

# 4. cloudflared インストール
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# 5. agent ユーザー作成
useradd -m -s /bin/bash agent

# 6. SSH 鍵の配置（SSM Parameter Store から取得）
# → 手動セットアップまたは別途自動化

# 7. アプリケーションデプロイ
su - agent -c '
  mkdir -p ~/work
  cd ~/work
  git clone git@github.com:yosuke0517/dev-assistant-agent.git
  cd dev-assistant-agent
  npm ci
  npm run build
'

# 8. SSM Parameter Store から .env を生成
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)
cat > /home/agent/work/dev-assistant-agent/.env << 'ENVEOF'
WORKSPACE_ROOT=/home/agent/work
AGENT_PROJECT_PATH=/home/agent/work/dev-assistant-agent
ENVEOF

# SSM から秘密情報を取得して .env に追記
for param in slack/bot-token slack/channel slack/owner-member-id git/user-name git/user-email; do
  KEY=$(echo "$param" | tr '/' '_' | tr '[:lower:]' '[:upper:]' | sed 's/BOT_TOKEN/BOT_TOKEN/' | sed 's/-/_/g')
  VALUE=$(aws ssm get-parameter --name "/finegate/$param" --with-decryption --query 'Parameter.Value' --output text --region "$REGION")
  echo "${KEY}=${VALUE}" >> /home/agent/work/dev-assistant-agent/.env
done

chown agent:agent /home/agent/work/dev-assistant-agent/.env
chmod 600 /home/agent/work/dev-assistant-agent/.env

# 9. systemd サービス登録（cloudflared）
cat > /etc/systemd/system/cloudflared.service << 'EOF'
[Unit]
Description=Cloudflare Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token TUNNEL_TOKEN_PLACEHOLDER
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Tunnel トークンを挿入
TUNNEL_TOKEN=$(aws ssm get-parameter --name "/finegate/cloudflare/tunnel-token" --with-decryption --query 'Parameter.Value' --output text --region "$REGION")
sed -i "s|TUNNEL_TOKEN_PLACEHOLDER|${TUNNEL_TOKEN}|" /etc/systemd/system/cloudflared.service

# 10. systemd サービス登録（finegate-agent）
cat > /etc/systemd/system/finegate-agent.service << 'EOF'
[Unit]
Description=Finegate Stealth Agent
After=network-online.target cloudflared.service
Wants=network-online.target

[Service]
Type=simple
User=agent
WorkingDirectory=/home/agent/work/dev-assistant-agent
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
EnvironmentFile=/home/agent/work/dev-assistant-agent/.env

[Install]
WantedBy=multi-user.target
EOF

# 11. サービス起動
systemctl daemon-reload
systemctl enable cloudflared finegate-agent
systemctl start cloudflared finegate-agent
```

## 4. 手作業で必要な準備（人間が実施）

以下はTerraformで自動化できない、または手動で実施すべき項目。

### 4.1. 事前準備（初回のみ）

| # | 作業内容 | 状態 | 備考 |
|---|---------|------|------|
| 1 | **AWS アカウント作成** | - | 請求アラート設定も忘れずに |
| 2 | **IAM ユーザー作成**（Terraform 実行用） | - | AdministratorAccess またはカスタムポリシー |
| 3 | **AWS CLI の設定** | - | `aws configure` でクレデンシャル設定 |
| 4 | **Terraform インストール** | - | v1.6+ 推奨 |
| 5 | **S3 バケット作成**（Terraform state 用） | - | `terraform init` 前に手動作成が必要（bootstrap） |

### 4.2. ドメイン・DNS（GLOBAL_SETUP.md 記載の内容）

| # | 作業内容 | 状態 | 備考 |
|---|---------|------|------|
| 1 | **ドメイン取得**: `finegate.xyz` | 済 | お名前.com で確保済み |
| 2 | **ネームサーバー委譲**: Cloudflare NS に設定 | 済 | 既に移譲済み |
| 3 | **Cloudflare サイトアクティベート確認** | 済 | SSL/TLS 証明書有効確認済み |

### 4.3. Cloudflare Tunnel

| # | 作業内容 | 状態 | 備考 |
|---|---------|------|------|
| 1 | **Cloudflare Tunnel の再作成またはトークン取得** | 要実施 | 既存トンネル（ローカル用）とは別にAWS用のトンネルを作成するか、既存トンネルのトークンを取得。Cloudflare Dashboard → Zero Trust → Tunnels で管理 |
| 2 | **Tunnel のルーティング設定** | 要確認 | `agent.finegate.xyz` → `http://localhost:8787` の設定を確認/更新 |

> **注意**: ローカルとAWSの並行運用期間は、Cloudflare の DNS でトラフィックの向き先を切り替えることで制御可能。

### 4.4. Slack App

| # | 作業内容 | 状態 | 備考 |
|---|---------|------|------|
| 1 | **Slack App の確認** | 済 | `Finegate-Agent` 作成済み |
| 2 | **Request URL の確認** | - | `https://agent.finegate.xyz/do` のまま変更不要 |
| 3 | **Bot Token Scopes の確認** | 済 | `chat:write`, `channels:history`, `groups:history`, `commands` |

> Cloudflare Tunnel 経由のため、Slack App 側の設定変更は不要。

### 4.5. Git / SSH 認証

| # | 作業内容 | 状態 | 備考 |
|---|---------|------|------|
| 1 | **GitHub SSH Deploy Key の作成** | 要実施 | EC2 上で `ssh-keygen` → GitHub リポジトリに Deploy Key として登録 |
| 2 | **対象リポジトリへの Deploy Key 登録** | 要実施 | dev-assistant-agent + 各受託案件リポジトリ |
| 3 | **SSH config の設定** | 要実施 | EC2 上の `/home/agent/.ssh/config` |

### 4.6. Claude Code 認証

| # | 作業内容 | 状態 | 備考 |
|---|---------|------|------|
| 1 | **Claude Code のログイン** | 要実施 | EC2 上で `claude login` を実行（対話的認証が必要） |
| 2 | **API キーの設定**（代替） | 要実施 | `ANTHROPIC_API_KEY` 環境変数での認証も選択可能 |

### 4.7. 対象リポジトリのクローン

| # | 作業内容 | 状態 | 備考 |
|---|---------|------|------|
| 1 | **`dev-assistant-agent` のクローン** | 要実施 | User Data で自動化予定 |
| 2 | **受託案件リポジトリのクローン** | 要実施 | `WORKSPACE_ROOT` 配下に手動クローン（リポジトリ追加時も同様） |

## 5. 移行手順

### Phase 1: インフラ構築

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
# terraform.tfvars を編集（各パラメータを設定）

terraform init
terraform plan
terraform apply
```

### Phase 2: EC2 セットアップ（手動作業）

```bash
# 1. EC2 に SSH 接続（SSM Session Manager 経由を推奨）
aws ssm start-session --target <instance-id>

# 2. agent ユーザーに切り替え
sudo su - agent

# 3. SSH 鍵の設定
ssh-keygen -t ed25519 -C "finegate-agent@aws" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
# → GitHub に Deploy Key として登録

# 4. Git リポジトリのクローン
mkdir -p ~/work
cd ~/work
git clone git@github.com:yosuke0517/dev-assistant-agent.git
# 受託案件のリポジトリもクローン
# git clone git@github.com:xxx/circus_backend.git
# git clone git@github.com:xxx/circus_agent_ecosystem.git

# 5. アプリケーションビルド
cd ~/work/dev-assistant-agent
npm ci
npm run build

# 6. Claude Code ログイン
claude login
# もしくは .env に ANTHROPIC_API_KEY を設定

# 7. 動作確認
npm start
# 別ターミナルで: curl -X POST http://localhost:8787/do -d "text=test"
```

### Phase 3: 切り替え

```bash
# 1. Cloudflare Tunnel が EC2 から接続していることを確認
systemctl status cloudflared

# 2. ローカル Mac の cloudflared を停止
# （Mac 上で実行）
# launchctl unload ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
# または: cloudflared tunnel stop agent

# 3. Slack から /do コマンドで動作確認
# → EC2 上のサービスが応答することを確認

# 4. ローカル Mac のサーバーを停止
```

### Phase 4: 運用開始

- CloudWatch Logs でログ監視
- 新しいリポジトリ追加時は EC2 にSSH して `git clone`
- アプリケーション更新時は `git pull && npm ci && npm run build && sudo systemctl restart finegate-agent`

## 6. セキュリティ考慮事項

| 項目 | 対策 |
|------|------|
| EC2 へのアクセス | SSM Session Manager 経由のみ（SSH ポート不要）|
| シークレット管理 | SSM Parameter Store (SecureString) に保管、IAM で最小権限 |
| ネットワーク | プライベートサブネット配置、インバウンドルールなし |
| Git 認証 | Deploy Key（リポジトリごとの最小権限） |
| Cloudflare Tunnel | トークン認証、TLS 暗号化済み |
| .env ファイル | ファイルパーミッション 600、agent ユーザーのみアクセス可 |
| アプリケーション更新 | `git pull` + `npm ci` + `npm run build` + `systemctl restart` |

## 7. コスト見積もり（月額概算・東京リージョン）

| リソース | スペック | 月額概算 (USD) |
|---------|---------|---------------|
| EC2 (t3.medium) | 2 vCPU, 4GB RAM, 24/7 稼働 | ~$30 |
| EBS (gp3) | 50GB | ~$4 |
| NAT Gateway | データ転送量に依存 | ~$32 + 転送量 |
| SSM Parameter Store | Standard パラメータ | 無料 |
| CloudWatch Logs | ログ量に依存 | ~$1-5 |
| S3 (tfstate) | 微量 | ~$0.01 |
| **合計** | | **~$67-71/月** |

### コスト最適化オプション

| オプション | 節約額 | トレードオフ |
|-----------|--------|------------|
| Reserved Instance (1年) | ~40% 削減 | 長期コミットメント |
| NAT Gateway → NAT Instance (t3.nano) | ~$28/月 削減 | 可用性・帯域が劣る |
| 夜間停止（EventBridge + Lambda） | ~50% 削減 (EC2) | 夜間利用不可 |

## 8. 本システム固有の注意点

### 8.1. node-pty のプラットフォーム対応

現在の `package.json` の postinstall:
```json
"postinstall": "chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper 2>/dev/null || true && lefthook install 2>/dev/null || true"
```

AWS (Linux x86_64) では `darwin-arm64` ではなく `linux-x64` のプレビルドが使用される。
`2>/dev/null || true` によりエラーは無視されるため、**現状のスクリプトのままで動作する**。
ただし、明示的に Linux 対応を追加することを推奨:

```json
"postinstall": "chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true && lefthook install 2>/dev/null || true"
```

### 8.2. stealth-run.sh のパス

`WORKSPACE_ROOT` と `AGENT_PROJECT_PATH` が `.env` で設定されるため、パスの変更は `.env` の修正のみで対応可能。

| 環境変数 | ローカル (Mac) | AWS (EC2) |
|---------|---------------|-----------|
| `WORKSPACE_ROOT` | `/Users/takeuchiyosuke/work` | `/home/agent/work` |
| `AGENT_PROJECT_PATH` | `/Users/takeuchiyosuke/work/dev-assistant-agent` | `/home/agent/work/dev-assistant-agent` |

### 8.3. worktree のストレージ

- worktree は `/tmp/finegate-worktrees/` に作成され、処理完了後に自動クリーンアップ
- EC2 のルートボリューム (EBS) の `/tmp` を使用
- 大規模リポジトリの場合は EBS サイズを調整（50GB → 100GB）

### 8.4. Claude Code CLI の `--dangerously-skip-permissions`

`stealth-run.sh` で使用されている `--dangerously-skip-permissions` フラグはローカル環境と同様に動作する。
EC2 上でも agent ユーザーの権限内で実行されるため、セキュリティリスクは限定的。

## 9. 将来の拡張性

| 拡張案 | 概要 | 実装難度 |
|--------|------|---------|
| Auto Scaling Group | EC2 の自動復旧（min=1, max=1 の ASG） | 低 |
| AMI のカスタムビルド | User Data の実行時間短縮（Packer で事前構築） | 中 |
| EFS マウント | 複数 EC2 間でリポジトリ共有（将来のスケールアウト用） | 中 |
| CodeDeploy 連携 | `git push` → 自動デプロイパイプライン | 中 |
| CloudWatch アラーム | サービス異常時の自動通知（Slack 連携） | 低 |
| 夜間自動停止/起動 | EventBridge + Lambda で EC2 をスケジュール制御 | 低 |

## 10. Terraform 実装時の参考: variables.tf

```hcl
variable "aws_region" {
  description = "AWS リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "instance_type" {
  description = "EC2 インスタンスタイプ"
  type        = string
  default     = "t3.medium"
}

variable "ebs_volume_size" {
  description = "EBS ボリュームサイズ (GB)"
  type        = number
  default     = 50
}

variable "slack_bot_token" {
  description = "Slack Bot Token"
  type        = string
  sensitive   = true
}

variable "slack_channel" {
  description = "Slack チャンネル ID"
  type        = string
}

variable "slack_owner_member_id" {
  description = "Slack オーナーメンバー ID"
  type        = string
}

variable "git_user_name" {
  description = "Git コミット用ユーザー名"
  type        = string
}

variable "git_user_email" {
  description = "Git コミット用メールアドレス"
  type        = string
}

variable "cloudflare_tunnel_token" {
  description = "Cloudflare Tunnel トークン"
  type        = string
  sensitive   = true
}
```
