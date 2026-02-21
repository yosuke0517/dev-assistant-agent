# Finegate Stealth Agent 改善レポート

> Issue #18: このプロジェクトをよくするためのレポート
>
> 対象リポジトリ: yosuke0517/dev-assistant-agent
> 作成日: 2026-02-22

## 概要

本プロジェクト（Finegate Stealth Agent）のコードベースを分析し、改善提案をまとめました。
各提案には **優先度**（High / Medium / Low）と **カテゴリ** を記載しています。

現状のプロジェクトは約1,720行のコードで構成されており、テストも1,075行と充実しています。
Slack経由でClaude Codeをリモート起動するという独自のアーキテクチャは堅実に実装されています。
以下は、さらにプロジェクトを成熟させるための改善案です。

---

## 1. CI/CD パイプライン導入 [High]

**現状**: CI/CDパイプラインが未設定。テストはローカルでのみ実行されている。

**課題**:
- PRのマージ前にテストが自動実行されないため、壊れたコードがmainに入るリスクがある
- コード品質チェックが手動に依存している

**提案**:
GitHub Actionsでテストの自動実行を設定する。

```yaml
# .github/workflows/test.yml の例
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm test
```

**効果**: コードの品質を自動的に担保し、レビュー負荷を軽減する。

---

## 2. リンター・フォーマッター導入 [High]

**現状**: ESLint、Prettier 等のコード品質ツールが未導入。

**課題**:
- コーディングスタイルの一貫性が個人の注意に依存
- 潜在的なバグ（未使用変数、暗黙の型変換等）を検出する仕組みがない

**提案**:
- ESLint + flat config（eslint.config.js）を導入
- Prettierでコードフォーマットを統一

```bash
npm install -D eslint prettier eslint-config-prettier
```

**効果**: コードの一貫性を保ち、レビューでスタイルの指摘に時間を取られなくなる。

---

## 3. テストカバレッジの可視化 [Medium]

**現状**: テストは充実しているが、カバレッジの測定・可視化が未実施。

**課題**:
- テストされていないコードパスが不明
- 特に `spawnWorker()` 関数やExpress ルートハンドラーのテストが薄い

**提案**:
vitest の coverage 機能を有効にする。

```json
// package.json
{
  "scripts": {
    "test": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

```bash
npm install -D @vitest/coverage-v8
```

**効果**: テストの穴を可視化し、重要なコードパスの網羅性を確認できる。

---

## 4. Graceful Shutdown の実装 [Medium]

**現状**: サーバーは `app.listen()` で起動するだけで、シャットダウン処理がない。

**課題**:
- SIGINT/SIGTERM受信時に実行中のワーカープロセスが中途半端に終了する可能性がある
- `ProgressTracker` のタイマーが残る可能性がある

**提案**:
```javascript
const server = app.listen(PORT, () => { ... });

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  server.close(() => {
    // 実行中のワーカーがあればクリーンアップ
    process.exit(0);
  });
});
```

**効果**: プロセス再起動時のリソースリークを防止する。

---

## 5. server.js のモジュール分割 [Medium]

**現状**: `server.js` が435行のモノリシックなファイルで、パース・トラッキング・エラー処理・ルートハンドラーが全て同一ファイルに存在する。

**課題**:
- ファイルが肥大化すると保守性が低下する
- テスト対象を個別にインポートしづらくなる

**提案**:
以下のようにモジュール分割する。

```
lib/
├── slack.js              # (既存) Slack API操作
├── stream-parser.js      # processStreamEvent, summarizeToolInput
├── progress-tracker.js   # ProgressTracker クラス
├── interactive-handler.js # InteractiveHandler クラス
├── worker.js             # spawnWorker, extractErrorSummary
└── parse-input.js        # parseInput
server.js                 # Express ルートのみ（薄いエントリーポイント）
```

**効果**: 各モジュールが単一責任になり、テストとメンテナンスが容易になる。

---

## 6. 環境変数のバリデーション強化 [Medium]

**現状**: 環境変数のチェックは `stealth-run.sh` 内で一部行われているが、`server.js` 起動時のバリデーションがない。

**課題**:
- `SLACK_BOT_TOKEN` が未設定でもサーバーは起動する（Slack通知が全て失敗する）
- 問題の発覚がリクエスト処理時まで遅れる

**提案**:
サーバー起動時に必須環境変数をチェックし、不足時は警告を出す。

```javascript
const REQUIRED_ENV = ['WORKSPACE_ROOT', 'AGENT_PROJECT_PATH'];
const OPTIONAL_ENV = ['SLACK_BOT_TOKEN']; // 無くても動くが警告

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Error: ${key} is required`);
    process.exit(1);
  }
}
for (const key of OPTIONAL_ENV) {
  if (!process.env[key]) {
    console.warn(`Warning: ${key} is not set. Some features will be disabled.`);
  }
}
```

**効果**: 設定ミスに早期に気づけるようになる。

---

## 7. 同時実行制御（ジョブキュー） [Medium]

**現状**: `/do` エンドポイントに同時実行の制御がない。

**課題**:
- 複数の `/do` リクエストが同時に来ると、複数のClaude Codeプロセスが同時起動する
- リソース競合やgit worktreeの衝突が発生する可能性がある

**提案**:
シンプルなインメモリキューで逐次実行を保証する。

```javascript
let currentJob = null;
const jobQueue = [];

async function enqueueJob(jobFn) {
  return new Promise((resolve) => {
    jobQueue.push(async () => {
      const result = await jobFn();
      resolve(result);
      processQueue();
    });
    if (!currentJob) processQueue();
  });
}

function processQueue() {
  currentJob = jobQueue.shift() || null;
  if (currentJob) currentJob();
}
```

**効果**: リソース競合を防ぎ、安定した動作を保証する。

---

## 8. ヘルスチェックエンドポイント [Low]

**現状**: `/do` エンドポイントしか存在しない。

**課題**:
- サーバーが正常に稼働しているか外部から確認する手段がない
- Cloudflare Tunnel経由での疎通確認が困難

**提案**:
```javascript
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    currentJob: currentJob ? 'running' : 'idle',
  });
});
```

**効果**: 外出先からサーバーの状態を確認でき、障害の早期発見に繋がる。

---

## 9. ログの構造化 [Low]

**現状**: `console.log` / `console.error` で自由形式のログを出力している。

**課題**:
- ログの検索・フィルタリングが困難
- タイムスタンプ形式が `toLocaleString()` に依存しており環境によって異なる

**提案**:
シンプルな構造化ログユーティリティを導入する。

```javascript
function log(level, message, meta = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  }));
}
```

外部ライブラリ（pino 等）は依存を増やすため、まずは自前の薄いラッパーで十分。

**効果**: ログの検索性が向上し、障害調査が効率化される。

---

## 10. セキュリティの強化 [Low]

**現状**: Slackからのリクエストの署名検証が実装されていない。

**課題**:
- Cloudflare Tunnelの背後にいるため直接のリスクは低いが、Tunnelの設定ミスでエンドポイントが公開された場合に任意のリクエストを受け付ける
- `/do` エンドポイントでClaude Codeが `--dangerously-skip-permissions` で起動されるため、不正リクエストの影響が大きい

**提案**:
Slackの署名検証を導入する。

```javascript
import crypto from 'crypto';

function verifySlackRequest(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true; // 開発環境ではスキップ

  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  const body = req.rawBody; // express.urlencoded のrawBodyを有効にする必要あり

  const basestring = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', signingSecret).update(basestring).digest('hex');
  const expected = `v0=${hmac}`;

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

**効果**: 不正なリクエストからシステムを保護する。

---

## 改善の優先度マトリックス

| # | 改善項目 | 優先度 | 工数目安 | カテゴリ |
|---|---------|-------|---------|---------|
| 1 | CI/CDパイプライン導入 | High | 小 | インフラ |
| 2 | リンター・フォーマッター導入 | High | 小 | コード品質 |
| 3 | テストカバレッジ可視化 | Medium | 小 | テスト |
| 4 | Graceful Shutdown | Medium | 小 | 信頼性 |
| 5 | server.js モジュール分割 | Medium | 中 | アーキテクチャ |
| 6 | 環境変数バリデーション | Medium | 小 | 信頼性 |
| 7 | 同時実行制御 | Medium | 中 | 信頼性 |
| 8 | ヘルスチェックエンドポイント | Low | 小 | 運用 |
| 9 | ログ構造化 | Low | 小 | 運用 |
| 10 | セキュリティ強化 | Low | 中 | セキュリティ |

## 推奨する実施順序

**Phase 1（すぐに実施）**: #1 CI/CD → #2 リンター
- 工数が小さく、以降の全作業の品質を担保する基盤になる

**Phase 2（短期）**: #3 カバレッジ → #6 環境変数バリデーション → #4 Graceful Shutdown
- テストの信頼性と運用の安定性を向上

**Phase 3（中期）**: #7 同時実行制御 → #5 モジュール分割 → #8 ヘルスチェック
- アーキテクチャの改善とスケーラビリティの確保

**Phase 4（長期）**: #9 ログ構造化 → #10 セキュリティ強化
- 運用成熟度の向上

---

## 現状の良い点

改善提案だけでなく、現状のプロジェクトの強みも記録しておきます。

- **テストの充実度**: 1,075行のテストコードで主要なロジックを網羅している
- **DI（依存性注入）パターン**: `postFn`、`waitReplyFn`、`fetchFn` をテスト用に差し替え可能な設計
- **フォールバック設計**: Slack未設定時やタイムアウト時のフォールバックが適切に実装されている
- **worktreeによる隔離**: メインの作業ディレクトリに影響を与えない安全な設計
- **ドキュメントの充実**: README、OVERVIEW、SETUP系ドキュメントが整備されている
