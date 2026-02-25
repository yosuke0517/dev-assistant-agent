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

## 9. 自宅 Mac Mini 運用 vs AWS 比較

AWS 月額 ~$67-71（約1万円）に対し、Mac Mini を購入して自宅サーバーとして運用する選択肢を比較する。

### 9.1. コスト比較

#### 初期費用

| 項目 | AWS | 自宅 Mac Mini |
|------|-----|---------------|
| Mac Mini 本体（M4, 24GB/512GB） | 不要 | ¥154,800 |
| UPS（無停電電源装置） | 不要 | ~¥10,000-20,000（推奨） |
| Ethernet ケーブル等 | 不要 | ~¥1,000 |
| **合計** | **¥0** | **~¥166,000-176,000** |

> **購入予定スペック**: M4チップ（10コアCPU、10コアGPU、16コアNeural Engine）、24GBユニファイドメモリ、512GB SSD、Thunderbolt 4 x 3、HDMI、ギガビットEthernet、最大3台の外部ディスプレイ対応

#### ランニングコスト（月額）

| 項目 | AWS | 自宅 Mac Mini |
|------|-----|---------------|
| EC2 (t3.medium) | ~¥4,500 ($30) | ¥0 |
| EBS (50GB gp3) | ~¥600 ($4) | ¥0 |
| NAT Gateway | ~¥4,800 ($32) | ¥0 |
| CloudWatch Logs | ~¥150-750 ($1-5) | ¥0 |
| 電気代（Mac Mini 24/7 稼働、~15W 平均） | ¥0 | ~¥350-500 |
| インターネット回線 | 不要（別途） | 既存回線を利用（追加費用なし） |
| Cloudflare Tunnel | 無料 | 無料（同じ仕組み） |
| **月額合計** | **~¥10,000** | **~¥350-500** |

#### 損益分岐点

月額差額: ~¥10,000 (AWS) - ~¥500 (電気代) = **~¥9,500/月の節約**

| シナリオ | Mac Mini 回収期間 |
|---------|-------------------|
| M4 (¥154,800) + UPS (¥15,000) | ~18ヶ月 |
| M4 (¥154,800) UPS なし | ~16-17ヶ月 |

> **結論: M4 モデルは約16-18ヶ月で元が取れる。24GBメモリ・512GB SSD の高スペックで、2年以上運用するなら自宅 Mac Mini の方が安い。**

### 9.2. 性能比較

| 項目 | AWS EC2 (t3.medium) | Mac Mini (M4, 24GB) |
|------|---------------------|---------------------|
| CPU | 2 vCPU（バースト制限あり） | 10コア（制限なし） |
| メモリ | 4GB | 24GB ユニファイドメモリ |
| ストレージ | 50GB EBS gp3 | 512GB NVMe SSD |
| ネットワーク | 最大5Gbps（バースト） | ギガビットEthernet（自宅回線依存） |
| GPU | なし | 10コア GPU + 16コア Neural Engine |
| AI/ML | なし | Apple Intelligence 対応、将来のローカルLLM実行に有利 |

> **性能面では Mac Mini M4 が圧倒的に優位。** 10コアCPU はバースト制限がないため、Claude Code CLI の長時間実行でも安定する。t3.medium では CPU クレジット枯渇のリスクがあるが、Mac Mini にはその心配がない。24GBメモリにより複数の Git worktree や Node.js プロセスの同時実行も余裕がある。

### 9.3. 運用面の比較

| 項目 | AWS | 自宅 Mac Mini | 備考 |
|------|-----|---------------|------|
| **可用性** | ◎ 高（SLA 99.99%） | △ 自宅回線・電源に依存 | 停電、回線障害時はダウン |
| **リモートアクセス** | ◎ SSM Session Manager | ○ Cloudflare Tunnel + SSH | Mac Mini にも Cloudflare Tunnel で SSH 可能（詳細は 9.7 参照） |
| **バックアップ** | ◎ EBS スナップショット | ○ Time Machine / 手動 | AWS は自動化が容易 |
| **スケーラビリティ** | ◎ インスタンス変更容易 | × 物理ハード依存 | AWS は需要に応じてスケール可能 |
| **メンテナンス** | ◎ OS パッチ自動化可 | ○ macOS 自動アップデート | どちらも自動化可能 |
| **セキュリティ** | ◎ VPC + SG + IAM | ○ Cloudflare Tunnel で保護 | AWS の方がネットワーク分離が強固 |
| **災害復旧** | ◎ 別リージョン復旧可 | × 物理機材の再調達が必要 | AWS は Terraform で再構築容易 |
| **ノイズ・発熱** | 関係なし | ○ Mac Mini はほぼ無音 | 自宅でも気にならない |
| **電源障害対策** | ◎ AWS 側で冗長化済み | △ UPS で短時間カバー可 | 長時間停電には対応困難 |

### 9.4. 自宅 Mac Mini の構成（採用する場合）

現状のローカル MacBook Pro 構成とほぼ同じ。変更点は最小限。

```
[Slack /do] → [Cloudflare Tunnel] → [Mac Mini:8787] → [Claude Code CLI] → [GitHub/Backlog]
```

#### セットアップ手順

1. Mac Mini を自宅ネットワークに接続
2. macOS 初期設定、自動ログイン設定
3. Homebrew、Node.js、Git、Claude Code CLI をインストール
4. `cloudflared` インストール・Tunnel 設定（既存設定を移行）
5. SSH リモートアクセス設定（Cloudflare Tunnel 経由）
6. アプリケーションを `launchd` でサービス登録（自動起動）
7. 省エネ設定: 「電源アダプタ接続時はスリープしない」を有効化

#### macOS のサービス登録（launchd）

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

### 9.5. 推奨判定

| 条件 | 推奨環境 |
|------|---------|
| コスト最優先（個人プロジェクト） | **自宅 Mac Mini** |
| 2年以上の長期運用が確定 | **自宅 Mac Mini** |
| 高可用性が必要（ビジネスクリティカル） | **AWS** |
| 災害復旧・冗長性が重要 | **AWS** |
| 将来的にスケールアウトが必要 | **AWS** |
| 現状の用途（個人開発アシスタント）を継続 | **自宅 Mac Mini** |

### 9.7. 外出先からのリモート復旧

自宅 Mac Mini 運用における最大の懸念は「外出先で障害が発生した場合に復旧できるか」である。
以下にシナリオ別の対応策と、事前に準備すべき設定をまとめる。

#### 障害シナリオ別の対応

| シナリオ | 外出先から復旧可能? | 対応方法 |
|---------|-------------------|---------|
| **Agent プロセスがクラッシュ** | ◎ 自動復旧 | `launchd` の `KeepAlive` 設定で自動再起動される |
| **cloudflared がクラッシュ** | ◎ 自動復旧 | `launchd` の `KeepAlive` 設定で自動再起動される |
| **Node.js がハングアップ** | ○ SSH で対応可 | Cloudflare Tunnel 経由で SSH → `launchctl stop` で再起動 |
| **macOS がフリーズ** | ○ スマートプラグで対応 | スマートプラグでリモート電源OFF/ON → macOS 自動起動設定で復旧 |
| **カーネルパニック** | ○ 自動復旧 | macOS は KP 後に自動再起動する（デフォルト動作） |
| **停電（短時間）** | ○ UPS で継続 | UPS で数分〜数十分はカバー、復電後に継続稼働 |
| **停電（長時間）** | ○ 自動復旧 | 復電後に macOS 自動起動 + launchd でサービス自動復旧 |
| **自宅インターネット障害** | × 復旧不可 | 回線復旧を待つしかない（モバイル回線フェイルオーバーで軽減可） |
| **ハードウェア故障** | × 復旧不可 | 物理的な対応が必要。AWS フェイルオーバーが有効 |

#### 事前準備: macOS 設定

以下の設定を事前に行うことで、大半の障害からの自動復旧が可能になる。

```bash
# 1. 電源復旧後に自動起動（停電対策の最重要設定）
sudo pmset -a autorestart 1

# 2. システムフリーズ時の自動再起動
sudo systemsetup -setrestartfreeze on

# 3. スリープ無効化（サーバー用途）
sudo pmset -a sleep 0
sudo pmset -a disksleep 0
sudo pmset -a displaysleep 0

# 4. Wake on LAN を有効化（同一ネットワーク内からの起動用）
sudo pmset -a wolon 1

# 5. Power Nap を有効化（スリープ中もネットワーク接続を維持）
sudo pmset -a powernap 1
```

#### 事前準備: リモート SSH アクセス（Cloudflare Tunnel 経由）

Mac Mini にも Cloudflare Tunnel 経由で SSH アクセスを設定しておく。

```yaml
# ~/.cloudflared/config.yml（Mac Mini 側）
tunnel: <tunnel-id>
credentials-file: /Users/<username>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: agent.finegate.xyz
    service: http://localhost:8787
  - hostname: ssh.finegate.xyz        # SSH 用のサブドメインを追加
    service: ssh://localhost:22
  - service: http_status:404
```

```bash
# macOS のリモートログイン（SSH）を有効化
sudo systemsetup -setremotelogin on
```

外出先からの SSH 接続:
```bash
# cloudflared がインストールされたクライアントから
ssh -o ProxyCommand="cloudflared access ssh --hostname ssh.finegate.xyz" user@ssh.finegate.xyz

# または ~/.ssh/config に設定
# Host mac-mini
#   HostName ssh.finegate.xyz
#   ProxyCommand cloudflared access ssh --hostname %h
#   User <username>
```

#### 事前準備: スマートプラグ（リモート電源制御）

macOS がフリーズして SSH も応答しない場合の最終手段として、スマートプラグで電源のON/OFFを行う。

| 製品例 | 価格 | 特徴 |
|--------|------|------|
| SwitchBot プラグミニ | ~¥1,500 | スマホアプリ・API 対応、安価 |
| TP-Link Tapo P105 | ~¥1,200 | スマホアプリ対応、入手しやすい |
| Meross スマートプラグ | ~¥1,500 | HomeKit 対応 |

**復旧手順**（macOS フリーズ時）:
1. スマホアプリでスマートプラグの電源を **OFF**
2. 10秒待機
3. スマートプラグの電源を **ON**
4. macOS が `autorestart` 設定により自動起動
5. `launchd` により cloudflared + Agent プロセスが自動起動
6. Cloudflare Tunnel が再接続され、サービス復旧

> 全体の復旧時間: 約2〜3分（起動 + サービス起動 + Tunnel 再接続）

#### 事前準備: ヘルスチェック & 自動通知

Mac Mini がダウンした際に即座に気づけるよう、外部からのヘルスチェックを設定する。

**方法 1: 外部監視サービス（推奨）**

[UptimeRobot](https://uptimerobot.com/)（無料プラン: 5分間隔）や [Healthchecks.io](https://healthchecks.io/) を使用:
- `https://agent.finegate.xyz/health` エンドポイントを監視（※要実装）
- ダウン検知時に Slack / メール通知

**方法 2: cron + Slack 通知（Mac Mini 側）**

```bash
# /usr/local/bin/finegate-healthcheck.sh
#!/bin/bash
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/health 2>/dev/null)
if [ "$RESPONSE" != "200" ]; then
  # Agent が応答しない場合、launchd で再起動を試みる
  launchctl stop com.finegate.agent
  sleep 2
  launchctl start com.finegate.agent
fi
```

```bash
# crontab -e
*/5 * * * * /usr/local/bin/finegate-healthcheck.sh
```

#### リモート復旧の全体フロー

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

> **まとめ**: 適切な事前準備（macOS 設定 + スマートプラグ + ヘルスチェック）を行えば、**ハードウェア故障とインターネット回線障害を除くほぼすべての障害から、外出先でもリモート復旧が可能**。さらに、AWS の Terraform 構成を常時デプロイ可能な状態に保つことで、Mac Mini の完全故障時にも約30分で AWS へフェイルオーバーできる。

### 9.8. 総合評価

**現在の用途（個人開発アシスタント）であれば、自宅 Mac Mini M4 が最もコストパフォーマンスが高い。**

- AWS 月額 ~¥10,000 × 24ヶ月 = **¥240,000**
- Mac Mini (M4) ¥154,800 + 電気代 ¥500 × 24ヶ月 = **~¥167,000**
- **2年間で約7万円の差額が生まれる**
- **3年運用なら**: AWS ¥360,000 vs Mac Mini ¥173,000 → **約19万円の差額**

M4チップ搭載により、24GBメモリ・512GB SSD・10コアCPU と開発用途には十分すぎるスペックとなり、AWS EC2 (t3.medium) との性能差はさらに広がった。ただし、本プロジェクトが将来的にチーム利用やビジネスクリティカルな用途に拡大する場合は、AWS のスケーラビリティと可用性が重要になる。**AWS デプロイメント計画はそのまま維持し、将来の移行オプションとして残しておく**ことを推奨する。

> **ハイブリッド戦略**: 普段は自宅 Mac Mini で運用し、AWS の Terraform 構成はいつでもデプロイ可能な状態で保持。Mac Mini の故障や長期不在時に AWS へフェイルオーバーできる体制を構築するのが理想的。

## 10. 将来の拡張性（AWS 移行時）

| 拡張案 | 概要 | 実装難度 |
|--------|------|---------|
| Auto Scaling Group | EC2 の自動復旧（min=1, max=1 の ASG） | 低 |
| AMI のカスタムビルド | User Data の実行時間短縮（Packer で事前構築） | 中 |
| EFS マウント | 複数 EC2 間でリポジトリ共有（将来のスケールアウト用） | 中 |
| CodeDeploy 連携 | `git push` → 自動デプロイパイプライン | 中 |
| CloudWatch アラーム | サービス異常時の自動通知（Slack 連携） | 低 |
| 夜間自動停止/起動 | EventBridge + Lambda で EC2 をスケジュール制御 | 低 |

## 11. Terraform 実装時の参考: variables.tf

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
