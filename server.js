import express from 'express';
import pty from 'node-pty';
import fetch from 'node-fetch'; 

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/**
 * 入力テキストをフォルダ名と課題IDに分割
 * 例: "circus_agent_ecosystem RA_DEV-81" -> { folder, issueId }
 */
export function parseInput(rawText) {
    const parts = rawText.split(/[,、 ]+/);
    return { folder: parts[0], issueId: parts[1] };
}

app.post('/do', async (req, res) => {
    const { folder, issueId } = parseInput(req.body.text || "");
    const responseUrl = req.body.response_url; // Slackからの返信先URL

    if (!folder || !issueId) {
        return res.status(400).send('引数不足。例: circus_agent_ecosystem RA_DEV-81');
    }

    // 1. Slackに受付完了を即レス（3秒ルール回避）
    res.send(`了解。${folder} にて ${issueId} の対応を開始しました。MBPのターミナルで進捗を確認してください。`);

    console.log(`\n[${new Date().toLocaleString()}] 🚀 実行開始: ${folder}, ID: ${issueId}`);

    // 2. Claudeプロセスを起動（node-ptyで疑似端末を提供）
    // PTYを使うことでClaude CLIがTTY環境を認識し、詳細ログを出力します
    // スクリプトを実行するためにzshの絶対パスを指定

    // Claude Code内から起動された場合のネスト検出を回避
    const childEnv = { ...process.env };
    delete childEnv.CLAUDECODE;
    delete childEnv.CLAUDE_CODE_SSE_PORT;
    delete childEnv.CLAUDE_CODE_ENTRYPOINT;

    const worker = pty.spawn('/bin/zsh', ['./stealth-run.sh', folder, issueId], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: process.cwd(),
        env: {
            ...childEnv,
            CI: "true",      // 💡 これを追加！アップデート確認などをスキップさせます
            FORCE_COLOR: "1",
            TERM: "xterm-256color"
        }
    });

    let output = '';

    // 【重要】PTYからの出力をリアルタイムで表示
    // node-ptyはstdout/stderrを統合したストリームを提供します
    // これで「許可待ち」や「思考プロセス」がブラックボックスにならずに済みます
    worker.onData((data) => {
        output += data;
        process.stdout.write(data);
    });

    // 3. 処理完了後の処理
    worker.onExit(async ({ exitCode }) => {
        if (exitCode !== 0 && output.trim() === '') {
            console.error(`⚠️ プロセスが出力なしで異常終了 (Exit Code: ${exitCode})。環境変数を確認してください。`);
        }
        console.log(`\n[${new Date().toLocaleString()}] ✅ 実行完了 (Exit Code: ${exitCode})`);

        // 前回のミス（data.toString()の参照）を削除し、安全に完了通知を送ります
        if (responseUrl) {
            // ログ全体からプルリクエストのURLを探す
            const prUrlMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
            const prMessage = prUrlMatch
                ? `\nPRが作成されました: ${prUrlMatch[0]}`
                : "\nPRの作成を確認できませんでした。詳細はターミナルのログを確認してください。";

            try {
                await fetch(responseUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: `✅ 課題 ${issueId} の対応が完了しました！ (Exit Code: ${exitCode})${prMessage}`,
                        replace_original: false
                    })
                });
            } catch (err) {
                console.error('Slackへの通知に失敗しました:', err);
            }
        }
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log('----------------------------------------------------');
    console.log(`Finegate Agent Server running on port ${PORT}`);
    console.log('SlackのRequest URLを以下に設定してください:');
    console.log('http://あなたのトンネルURL/do');
    console.log('----------------------------------------------------');
});