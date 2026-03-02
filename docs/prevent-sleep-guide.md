# MacBook蓋閉じ時のシステム停止問題 - 調査レポートと対策

## 問題の概要

MacBook Proの蓋を閉じると、Finegate Stealth Agent（Node.jsサーバー + Cloudflare Tunnel）が停止する。
Amphetamineでスリープ防止設定をしているが、蓋を閉じるとシステムが停止し、開くと再開する。

## 根本原因

macOSは蓋を閉じると**クラムシェルスリープ**に入る。この動作はOSレベルで制御されており、
以下の条件が**すべて**揃わない限り、サードパーティアプリ（Amphetamine含む）では完全には防げない：

1. 外部ディスプレイが接続されている
2. 電源アダプタが接続されている
3. 外部キーボード/マウスが接続されている

上記が揃う場合はmacOS標準の「クラムシェルモード」で動作し、蓋を閉じても稼働し続ける。
しかし、外部ディスプレイなしの場合は別の対策が必要。

## 解決策

### 対策1: pmset によるスリープ完全無効化（推奨・最も確実）

```bash
# 現在の電源管理設定を確認
pmset -g

# スリープを完全に無効化（AC電源時）
sudo pmset -a disablesleep 1

# スリープタイマーを無効化
sudo pmset -a sleep 0

# ディスプレイスリープのみ許可（省電力のため）
sudo pmset -a displaysleep 5
```

**確認方法:**
```bash
pmset -g | grep disablesleep
# disablesleep   1 が表示されればOK
```

**元に戻す場合:**
```bash
sudo pmset -a disablesleep 0
```

> **注意**: `disablesleep 1` は蓋を閉じてもスリープしなくなる最も確実な方法。
> バッテリー消費が増えるため、AC電源接続を推奨。

### 対策2: Amphetamine の Closed-Display Mode 設定

Amphetamineには蓋閉じ時にもスリープを防ぐ機能がある：

1. Amphetamine の設定を開く
2. **Triggers** タブへ移動
3. 新しいトリガーを作成、または既存セッションの設定で「**Allow Closed-Display Mode**」を有効化
4. **AC電源接続が必須**（バッテリーのみでは動作しない）

> **注意**: macOS Ventura以降では、Amphetamineの蓋閉じ防止が制限される場合がある。
> `pmset disablesleep` との併用を推奨。

### 対策3: launchd によるサービス化（スリープ復帰後の自動再起動）

スリープを完全に防げない場合でも、スリープ復帰後にサービスが自動再起動されるようにする。

#### セットアップ手順

```bash
# 本リポジトリの scripts/setup-launchd.sh を実行
cd ~/work/dev-assistant-agent
./scripts/setup-launchd.sh
```

これにより以下の2つのサービスが登録される：
- `com.finegate.agent-server`: Node.jsサーバー（caffeinate付き）
- `com.finegate.cloudflared`: Cloudflare Tunnel（caffeinate付き）

#### 手動管理

```bash
# サービスの状態確認
launchctl list | grep finegate

# サービス停止
launchctl unload ~/Library/LaunchAgents/com.finegate.agent-server.plist
launchctl unload ~/Library/LaunchAgents/com.finegate.cloudflared.plist

# サービス開始
launchctl load ~/Library/LaunchAgents/com.finegate.agent-server.plist
launchctl load ~/Library/LaunchAgents/com.finegate.cloudflared.plist
```

### 対策4: caffeinate コマンドによるスリープ抑止（手動起動時）

launchdを使わず手動で起動する場合は、`caffeinate`でプロセスをラップする：

```bash
# サーバー起動（スリープ抑止付き）
caffeinate -s npm start

# または本リポジトリのスクリプトを使用
./scripts/start-with-keepalive.sh
```

`caffeinate -s` はAC電源接続時にシステムスリープを抑止する。
ただし、蓋を閉じた場合の効果は `pmset disablesleep` に劣る。

## 推奨セットアップ（組み合わせ）

最も確実な構成は以下の組み合わせ：

1. **pmset** でスリープ無効化（蓋閉じ対策の根本解決）
2. **launchd** でサービス化（万が一のスリープ復帰時の自動再起動）
3. **AC電源に常時接続**

```bash
# 1. スリープ無効化
sudo pmset -a disablesleep 1
sudo pmset -a sleep 0

# 2. launchdサービスのセットアップ
cd ~/work/dev-assistant-agent
./scripts/setup-launchd.sh

# 3. 動作確認
launchctl list | grep finegate
curl http://127.0.0.1:8787/health  # サーバー応答確認
```

## ネットワーク（テザリング）に関する補足

蓋を閉じた状態でテザリング（iPhone等）でネットワーク接続を維持するには：

- **Wi-Fiテザリング**: スリープ無効化されていればWi-Fi接続は維持される
- **USBテザリング**: USB接続のiPhoneテザリングはより安定
- **Bluetooth**: スリープ無効化されていれば維持されるが、Wi-Fi/USBより不安定

`pmset disablesleep 1` が設定されていれば、蓋を閉じてもネットワーク接続は維持される。
