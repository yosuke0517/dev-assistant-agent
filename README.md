# dev-assistant-agent

Slack の `/do` コマンドで Backlog 課題を自動実装するエージェントサーバー。

## 起動手順・設定

→ [LOCAL_SETUP.md](./LOCAL_SETUP.md) を参照

## 使い方

Slack で以下のように送信:
```
/do circus_backend PROJ-123 {基準となるブランチ（option）} {すでにPRが出てる場合、ここに修正指示を書ける}
```
