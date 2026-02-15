# Finegate Stealth Agent - Local Setup & Operations

## 1. 設定ファイルの配置
### Cloudflare Config (~/.cloudflared/config.yml)
--------------------------------------------------
tunnel: f1c9ec3d-8f73-4203-853f-adda0664db34
credentials-file: /Users/takeuchiyosuke/.cloudflared/f1c9ec3d-8f73-4203-853f-adda0664db34.json

ingress:
  - hostname: agent.finegate.xyz
    service: http://127.0.0.1:3000
  - service: http_status:404
--------------------------------------------------

## 2. サーバー・スクリプト実装 (Backlog対応版)
~/work/agent ディレクトリに以下の2ファイルを作成してください。

### 【ファイル名: server.js】
--------------------------------------------------
import express from 'express';
import { exec } from 'child_process';
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

export function parseInput(rawText) {
    const parts = rawText.split(/[,、 ]+/);
    return { folder: parts[0], issueId: parts[1] };
}

app.get('/do', (req, res) => res.send('<h1>Finegate Agent is Online!</h1>'));
app.post('/do', (req, res) => {
    const { folder, issueId } = parseInput(req.body.text || "");
    if (!folder || !issueId) return res.status(400).send('引数不足。例: circus_backend PROJ-123');
    console.log(`[${new Date().toLocaleString()}] Start: ${folder}, ID: ${issueId}`);
    
    // バックグラウンドでスクリプト実行
    exec(`./stealth-run.sh "${folder}" "${issueId}"`);
    
    res.send(`了解。${folder} にて ${issueId} の対応を開始しました。`);
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Finegate Agent Server running on port ${PORT}`));
--------------------------------------------------

### 【ファイル名: stealth-run.sh】
--------------------------------------------------
#!/bin/bash
FOLDER_NAME=$1
ISSUE_ID=$2
WORKSPACE_ROOT="/Users/takeuchiyosuke/work/circus"
TARGET_PATH="$WORKSPACE_ROOT/$FOLDER_NAME"

if [ -d "$TARGET_PATH" ]; then
    cd "$TARGET_PATH"
else
    echo "Error: Directory $TARGET_PATH does not exist."
    exit 1
fi

git checkout main && git pull origin main
git config user.name "Yosuke Takeuchi"
git config user.email "yosuke.takeuchi@example.com"

echo "Claude Code starting for Backlog Issue: $ISSUE_ID"
claude -p "Backlog MCPを使用して、課題 $ISSUE_ID の内容を確認してください。その内容に基づいてコードを実装し、テストをパスさせ、プルリクエストを作成してください。完了したらPRのURLを教えてください。"
--------------------------------------------------

## 3. 🚀 日々の起動手順
1. トンネル起動 (Terminal 1): 
   cloudflared tunnel run agent
2. サーバー起動 (Terminal 2): 
   cd ~/work/agent && node server.js

## 4. 📝 使い方
Slackで以下のように送信してください。
/do circus_backend PROJ-123