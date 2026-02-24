# クロスリポジトリ開発機能 設計書

## 背景・課題

フロントエンド（circus_agent_ecosystem）とバックエンド（circus_backend / circus_backend_v2）を跨いだ開発において、以下のようなケースが発生する:

1. フロントエンドの update 処理が失敗している
2. サーバアクションにログを入れて調査
3. バックエンド API の改修が必要であることが判明
4. バックエンドリポジトリに移動して修正が必要

現状のエージェントは1リポジトリ単位でしかタスクを実行できないため、このようなクロスリポジトリの作業を1セッションで完結できない。

## 設計方針

**アプローチ A: マルチリポジトリコマンド方式** を採用する。

Slack コマンドで関連リポジトリを `--related` オプションで指定し、1つの Claude Code セッションで複数リポジトリを操作可能にする。

## コマンドフォーマット

```
/do <primary_repo> <issue_id> <base_branch> --related <repo>:<branch> [--related <repo>:<branch> ...]
```

### 使用例

```bash
# フロントエンドの課題に対応しつつ、バックエンドも修正
/do circus_agent_ecosystem RA_DEV-81 develop --related circus_backend:develop

# 複数の関連リポジトリを指定
/do circus_agent_ecosystem RA_DEV-81 develop --related circus_backend:develop --related circus_backend_v2:main

# ブランチ省略（自動検出）
/do circus_agent_ecosystem RA_DEV-81 develop --related circus_backend
```

## アーキテクチャ

### 処理フロー

```
[Slack コマンド受信]
    ↓
[server.ts] extractRelatedRepos() で --related を抽出
    ↓
[server.ts] parseInput() で通常のパラメータをパース
    ↓
[server.ts] spawnWorker() に relatedRepos を渡す
    ↓
[stealth-run.sh] 環境変数 RELATED_REPOS を受け取り
    ↓
[stealth-run.sh] プライマリ + 関連リポジトリの worktree を作成
    ↓
[stealth-run.sh] 全リポジトリの MCP 設定をマージ
    ↓
[stealth-run.sh] クロスリポジトリ対応のプロンプトを生成
    ↓
[Claude Code] 両リポジトリで実装・コミット・push・PR作成
    ↓
[stealth-run.sh] 全 worktree をクリーンアップ
```

## 変更対象ファイル

### 1. server.ts

#### extractRelatedRepos 関数（新規）

`--related` オプションを入力テキストから抽出する。

```typescript
interface RelatedRepo {
    name: string;
    branch?: string;
}

interface ExtractResult {
    cleanedText: string;
    relatedRepos: RelatedRepo[];
}

function extractRelatedRepos(text: string): ExtractResult
```

- `--related repo:branch` を全て抽出
- 抽出後のクリーンなテキストを返す（parseInput に渡すため）
- ブランチは省略可能（省略時は stealth-run.sh で自動検出）

#### parseInput の変更

parseInput 自体は変更しない。extractRelatedRepos で前処理したテキストを渡す。

#### spawnWorker の変更

- `relatedRepos` パラメータを追加
- 環境変数 `RELATED_REPOS` として `name:branch,name:branch,...` 形式で渡す

#### POST /do ハンドラーの変更

- extractRelatedRepos でテキストを前処理
- spawnWorker に relatedRepos を渡す
- フォローアップワーカーにも relatedRepos を渡す

### 2. stealth-run.sh

#### 関連リポジトリの worktree 作成

```bash
RELATED_REPOS="${RELATED_REPOS:-}"  # 環境変数から取得

if [ -n "$RELATED_REPOS" ]; then
    # カンマ区切りで分割して各リポジトリを処理
    IFS=',' read -ra REPO_SPECS <<< "$RELATED_REPOS"
    for repo_spec in "${REPO_SPECS[@]}"; do
        # name:branch を分割
        # worktree を作成
        # git config を設定
        # MCP 設定をマージ対象に追加
    done
fi
```

#### MCP 設定マージの拡張

現状の3層マージ（グローバル → プロジェクト → セッション）に、関連リポジトリの MCP 設定を追加:

1. グローバル MCP（最低優先度）
2. **関連リポジトリの MCP**（低〜中優先度）
3. プライマリリポジトリの MCP（中優先度）
4. セッション MCP（最高優先度）

#### プロンプトの拡張

通常モード・フォローアップモード・ユーザー要望モード全てで、関連リポジトリ情報をプロンプトに追加:

```
【クロスリポジトリ対応】
以下の関連リポジトリにもアクセス可能です。必要に応じて変更を加えてください。

- リポジトリ: circus_backend
  パス: /tmp/finegate-worktrees/circus_backend-xxxxx
  ベースブランチ: develop

各関連リポジトリでの作業手順:
1. 関連リポジトリのディレクトリに移動してコードを確認・修正
2. ブランチを作成（feat/${ISSUE_ID}）してチェックアウト
3. 変更をコミットしてpush
4. PRを作成（draft、ベースブランチ指定）

プライマリリポジトリと関連リポジトリの両方でPRを作成してください。
```

#### クリーンアップの拡張

trap の cleanup 関数で、関連リポジトリの worktree も削除する。一時ファイルに関連 worktree のパスを記録し、cleanup 時に読み取って削除。

### 3. テスト

#### server.test.ts

- extractRelatedRepos のテスト:
  - `--related repo:branch` を正しく抽出
  - `--related repo`（ブランチ省略）の抽出
  - 複数の `--related` の抽出
  - `--related` なしの場合は空配列
  - 抽出後のテキストが正しくクリーンアップされている
  - userRequest と --related が混在するケース

#### stealth-run.test.ts

- RELATED_REPOS パース関連のテスト
- クロスリポジトリプロンプトの存在確認

## 制約事項

- 関連リポジトリは `WORKSPACE_ROOT` 配下に存在する必要がある
- 各リポジトリは独立した git リポジトリであること
- 関連リポジトリの PR はそれぞれのリポジトリで個別に作成される
- agent（本プロジェクト自身）を関連リポジトリとして指定することも可能
