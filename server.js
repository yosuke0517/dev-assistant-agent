import 'dotenv/config';
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

/**
 * Slack chat.postMessage でメッセージ送信
 * @returns {Promise<string|null>} メッセージの ts (スレッドID) or null
 */
export async function postToSlack(channel, text, threadTs = null, fetchFn = fetch) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) { console.error('SLACK_BOT_TOKEN 未設定'); return null; }
    try {
        const body = { channel, text, ...(threadTs && { thread_ts: threadTs }) };
        const res = await fetchFn('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!data.ok) { console.error('Slack API エラー:', data.error); return null; }
        return data.ts;
    } catch (err) {
        console.error('Slack 送信エラー:', err.message);
        return null;
    }
}

function timestamp() {
    return `[${new Date().toLocaleString()}]`;
}

/**
 * stream-json形式のイベントをパースしてログ出力する
 */
export function processStreamEvent(line, tracker = null) {
    let event;
    try {
        event = JSON.parse(line);
    } catch {
        // stealth-run.shのechoなどJSON以外の行はそのまま出力
        if (line.trim()) console.log(line);
        return { type: 'raw', text: line };
    }

    switch (event.type) {
        case 'system':
            console.log(`${timestamp()} 📡 セッション開始 (session: ${event.session_id})`);
            if (event.tools) {
                console.log(`  利用可能ツール: ${event.tools.join(', ')}`);
            }
            tracker?.addActivity('📡 セッション開始');
            break;

        case 'assistant': {
            const blocks = event.message?.content || [];
            for (const block of blocks) {
                if (block.type === 'text' && block.text) {
                    const preview = block.text.substring(0, 300) + (block.text.length > 300 ? '...' : '');
                    console.log(`${timestamp()} 💬 Claude: ${preview}`);
                    tracker?.addActivity(`💬 ${block.text.substring(0, 100)}${block.text.length > 100 ? '...' : ''}`);
                } else if (block.type === 'tool_use') {
                    const inputSummary = summarizeToolInput(block.name, block.input);
                    console.log(`${timestamp()} 🔧 ツール実行: ${block.name} ${inputSummary}`);
                    tracker?.addActivity(`🔧 ${block.name} ${inputSummary}`.substring(0, 120));
                }
            }
            break;
        }

        case 'user': {
            const results = event.message?.content || [];
            for (const block of results) {
                if (block.type === 'tool_result') {
                    const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                    const preview = content?.substring(0, 200) || '';
                    const isError = block.is_error;
                    console.log(`${timestamp()} ${isError ? '❌' : '📋'} ツール結果: ${preview}${content?.length > 200 ? '...' : ''}`);
                    if (isError) tracker?.addActivity(`❌ エラー: ${content?.substring(0, 80)}`);
                }
            }
            break;
        }

        case 'result':
            console.log(`${timestamp()} ✅ 完了 (コスト: $${event.cost_usd?.toFixed(4) || '?'}, ターン数: ${event.num_turns || '?'}, 所要時間: ${((event.duration_ms || 0) / 1000).toFixed(1)}s)`);
            if (event.result) {
                console.log(`${timestamp()} 📝 最終結果: ${event.result.substring(0, 500)}${event.result.length > 500 ? '...' : ''}`);
            }
            break;

        default:
            break;
    }

    return event;
}

/**
 * Slack進捗通知用のトラッカー
 * processStreamEventから呼ばれ、直近のアクティビティを蓄積する
 * 1分ごとのタイマーでSlackに送信し、バッファをリセット
 */
export class ProgressTracker {
    constructor(channel, issueId, threadTs, intervalMs = 60_000, postFn = postToSlack) {
        this.channel = channel;
        this.issueId = issueId;
        this.threadTs = threadTs;
        this.intervalMs = intervalMs;
        this.activities = [];
        this.timer = null;
        this._post = postFn;
    }

    start() {
        if (!this.channel) return;
        this.timer = setInterval(() => this._flush(), this.intervalMs);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** イベントから進捗メッセージを追加 */
    addActivity(message) {
        this.activities.push(message);
    }

    async _flush() {
        if (!this.channel || this.activities.length === 0) return;

        // 直近のアクティビティをまとめて送信（最大10件）
        const recent = this.activities.slice(-10);
        this.activities = [];

        const text = `⏳ *${this.issueId}* 進捗レポート\n${recent.map(a => `• ${a}`).join('\n')}`;

        try {
            await this._post(this.channel, text, this.threadTs);
        } catch (err) {
            console.error('進捗通知の送信に失敗:', err.message);
        }
    }
}

function summarizeToolInput(toolName, input) {
    if (!input) return '';
    switch (toolName) {
        case 'Bash':
            return `> ${input.command || ''}`.substring(0, 150);
        case 'Read':
            return `📄 ${input.file_path || ''}`;
        case 'Edit':
            return `✏️ ${input.file_path || ''}`;
        case 'Write':
            return `📝 ${input.file_path || ''}`;
        case 'Glob':
            return `🔍 ${input.pattern || ''}`;
        case 'Grep':
            return `🔎 "${input.pattern || ''}" in ${input.path || '.'}`;
        case 'Task':
            return `🤖 ${input.description || ''}`;
        default:
            return JSON.stringify(input).substring(0, 100);
    }
}

app.post('/do', async (req, res) => {
    const { folder, issueId } = parseInput(req.body.text || "");
    const channelId = req.body.channel_id;

    if (!folder || !issueId) {
        return res.status(400).send('引数不足。例: circus_agent_ecosystem RA_DEV-81');
    }

    // 1. 即レス（Slack 3秒ルール）
    res.send(`了解。${folder} にて ${issueId} の対応を開始しました。MBPのターミナルで進捗を確認してください。`);

    console.log(`\n${timestamp()} 🚀 実行開始: ${folder}, ID: ${issueId}`);

    // 2. 親メッセージを chat.postMessage で投稿 → ts (スレッドID) 取得
    const parentTs = await postToSlack(channelId, `🚀 *${folder}* にて *${issueId}* の対応を開始しました。\n進捗はこのスレッドでお知らせします。`);

    // 3. Slack進捗通知トラッカー（1分ごとにスレッドへ進捗を送信）
    const tracker = new ProgressTracker(channelId, issueId, parentTs);
    tracker.start();

    // Claude Code内から起動された場合のネスト検出を回避
    const childEnv = { ...process.env };
    delete childEnv.CLAUDECODE;
    delete childEnv.CLAUDE_CODE_SSE_PORT;
    delete childEnv.CLAUDE_CODE_ENTRYPOINT;

    // PTY経由で起動（バッファリング防止のためTTYが必要）
    const worker = pty.spawn('/bin/zsh', ['./stealth-run.sh', folder, issueId], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: process.cwd(),
        env: {
            ...childEnv,
            CI: "true",
            FORCE_COLOR: "1",
            TERM: "xterm-256color"
        }
    });

    let output = '';
    let lineBuffer = '';

    // PTYからのstream-json(NDJSON)をリアルタイムでパース
    worker.onData((data) => {
        output += data;
        lineBuffer += data;

        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop(); // 未完成の行はバッファに残す

        for (const line of lines) {
            // PTYのANSIエスケープシーケンスを除去してからパース
            const cleaned = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '').trim();
            if (!cleaned) continue;
            processStreamEvent(cleaned, tracker);
        }
    });

    worker.onExit(async ({ exitCode }) => {
        // タイマー停止 & 残りのアクティビティをフラッシュ
        tracker.stop();

        // バッファに残った最後の行を処理
        if (lineBuffer.trim()) {
            const cleaned = lineBuffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '').trim();
            if (cleaned) processStreamEvent(cleaned, tracker);
        }

        if (exitCode !== 0 && output.trim() === '') {
            console.error(`⚠️ プロセスが出力なしで異常終了 (Exit Code: ${exitCode})。環境変数を確認してください。`);
        }
        console.log(`\n${timestamp()} ✅ 実行完了 (Exit Code: ${exitCode})`);

        // 4. 完了メッセージをスレッドに投稿
        if (channelId && parentTs) {
            const prUrlMatch = output.match(/https:\/\/github\.com\/[^\s"]+\/pull\/\d+/);
            const prMessage = prUrlMatch
                ? `\nPRが作成されました: ${prUrlMatch[0]}`
                : "\nPRの作成を確認できませんでした。詳細はターミナルのログを確認してください。";

            try {
                await postToSlack(channelId, `✅ 課題 *${issueId}* の対応が完了しました！ (Exit Code: ${exitCode})${prMessage}`, parentTs);
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