# dev-assistant-agent

Slack の `/do` コマンドで Backlog 課題を自動実装するエージェントサーバー。

## 起動手順・設定

→ [LOCAL_SETUP.md](./LOCAL_SETUP.md) を参照

## 使い方

Slack で `/do` を送信するとモーダルが表示されます。モーダルで対象リポジトリ・課題ID・モードなどを選択して実行します。

### モード一覧

| モード | 説明 | 環境変数 |
|--------|------|----------|
| 実装 | Backlog/GitHub課題を自動実装してPRを作成する（デフォルト） | なし |
| PRレビュー | 既存PRのコードレビューを行い、レビューコメントを投稿する | `REVIEW_MODE=true` |
| PRレビューFB対応 | PRレビューで指摘されたフィードバックを自動修正する | `REVIEW_FIX_MODE=true` |
| 調査（リサーチ） | コードベースやIssueを調査し、結果をSlackにレポートする（PRは作成しない） | `RESEARCH_MODE=true` |

各モードの環境変数はSlackモーダルでモードを選択すると自動的に設定されます。手動で `stealth-run.sh` を実行する場合は、上記の環境変数を設定してください。

#### 手動実行例

```bash
# 調査（リサーチ）モードで実行
RESEARCH_MODE=true ./stealth-run.sh circus_backend PROJ-123
```
