# MacBook スリープ防止ガイド（クラムシェルモード運用）

## 問題

MacBook Pro の蓋を閉じると本システム（Express サーバー + Cloudflare Tunnel）が停止する。蓋を開くと再開する。

### 前提条件
- ローカル MacBook Pro で動作
- Amphetamine でセッション管理中（ディスプレイを閉じたときにスリープしない設定のはず）
- ネットワーク（テザリング等）に接続されている限り動き続けてほしい

## 根本原因

macOS はデフォルトで蓋を閉じると **システムスリープ** に入る。Amphetamine は「アイドルスリープ」を防止できるが、**クラムシェルモード**（蓋を閉じた状態での動作）には以下の条件が必要：

1. **外部ディスプレイ** が接続されている
2. **外部キーボードまたはマウス** が接続されている
3. **電源アダプタ** が接続されている

これらの条件が揃わない場合、Amphetamine だけではスリープを防止できない。

## 解決策

以下の3つのアプローチを推奨する（すべて併用可能）。

---

### 解決策1: `caffeinate` コマンド（推奨・最も簡単）

`caffeinate` は macOS 標準のスリープ防止コマンド。`-s` フラグでシステムスリープを防止する。

#### 使い方

本プロジェクトに追加された `start-daemon.sh` スクリプトを使用する：

```bash
# サーバーを caffeinate 付きで起動（スリープ防止）
./start-daemon.sh
```

または手動で：

```bash
# サーバー起動（caffeinate でスリープ防止）
caffeinate -s npm start

# 開発モード
caffeinate -s npm run dev

# Cloudflare Tunnel も同様
caffeinate -s cloudflared tunnel run agent
```

#### caffeinate のフラグ一覧

| フラグ | 説明 |
|--------|------|
| `-d` | ディスプレイスリープを防止 |
| `-i` | アイドルスリープを防止 |
| `-s` | **システムスリープを防止**（蓋閉じ対策はこれ） |
| `-u` | ユーザーアクティビティを宣言 |
| `-w PID` | 指定PIDが終了するまでスリープ防止 |

**注意**: `caffeinate -s` はプロセスが実行中の間のみ有効。プロセスが終了するとスリープ防止も解除される。

---

### 解決策2: `pmset` によるシステム設定（永続的）

`pmset` で macOS の電源管理を直接設定する。

```bash
# 現在の設定を確認
pmset -g

# AC電源接続時のスリープを無効化
sudo pmset -c sleep 0

# バッテリー時のスリープを無効化（バッテリー消耗に注意）
sudo pmset -b sleep 0

# クラムシェルモード（蓋閉じ）でのスリープを無効化
# ※ macOS Sonoma 以降で利用可能
sudo pmset -a disablesleep 1
```

#### 推奨設定

```bash
# AC電源時のみスリープ無効化（バッテリー時は省電力のためスリープ許可）
sudo pmset -c sleep 0
sudo pmset -c disablesleep 1

# TCP キープアライブを有効化（ネットワーク接続維持）
sudo pmset -a tcpkeepalive 1
```

**設定を元に戻す場合**:
```bash
sudo pmset -c sleep 10  # 10分でスリープ
sudo pmset -c disablesleep 0
```

---

### 解決策3: launchd によるプロセス管理（自動起動・自動再起動）

macOS の `launchd` を使い、サーバーをシステムサービスとして管理する。これにより：
- Mac 起動時に自動でサーバーが起動
- クラッシュ時に自動で再起動
- ログの自動管理

#### セットアップ

```bash
# 1. plist ファイルをコピー
cp launchd/com.finegate.dev-assistant-agent.plist ~/Library/LaunchAgents/
cp launchd/com.finegate.cloudflared.plist ~/Library/LaunchAgents/

# 2. ログディレクトリを作成
mkdir -p ~/Library/Logs/finegate

# 3. サービスを登録・起動
launchctl load ~/Library/LaunchAgents/com.finegate.dev-assistant-agent.plist
launchctl load ~/Library/LaunchAgents/com.finegate.cloudflared.plist

# 4. 状態確認
launchctl list | grep finegate
```

#### サービス管理コマンド

```bash
# 停止
launchctl unload ~/Library/LaunchAgents/com.finegate.dev-assistant-agent.plist

# 再起動
launchctl unload ~/Library/LaunchAgents/com.finegate.dev-assistant-agent.plist
launchctl load ~/Library/LaunchAgents/com.finegate.dev-assistant-agent.plist

# ログ確認
tail -f ~/Library/Logs/finegate/server.stdout.log
tail -f ~/Library/Logs/finegate/server.stderr.log
```

---

### Amphetamine の設定確認

Amphetamine を引き続き使用する場合、以下を確認：

1. **Triggers** タブで「Closed-Display Mode」を有効にする
2. ただし、外部ディスプレイ・電源が接続されていない場合は動作しない
3. `caffeinate` または `pmset` との併用を推奨

---

## 推奨構成

| 環境 | 推奨方法 |
|------|----------|
| 開発時（手動起動） | `caffeinate -s npm run dev` または `./start-daemon.sh` |
| 本番運用（常時稼働） | launchd + pmset |
| 外出時（テザリング） | caffeinate + pmset（バッテリー設定に注意） |

## トラブルシューティング

### caffeinate が効かない場合
```bash
# caffeinate のアサーションを確認
pmset -g assertions
```

### スリープ原因を調査
```bash
# スリープ/ウェイクのログを確認
pmset -g log | grep -E "Sleep|Wake" | tail -20

# システムログでスリープ原因を確認
log show --predicate 'eventMessage contains "Sleep"' --last 1h
```

### ネットワーク接続の確認
```bash
# Power Nap（スリープ中のネットワーク活動）を有効化
sudo pmset -a powernap 1

# TCP キープアライブ
sudo pmset -a tcpkeepalive 1
```
