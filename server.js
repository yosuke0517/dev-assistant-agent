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

/**
 * Slackスレッドへのユーザー返信をポーリングで待機する
 * botメッセージ送信後のユーザー返信のみ取得する
 * @param {string} channel - チャンネルID
 * @param {string} threadTs - スレッドのts
 * @param {string} afterTs - この時刻以降のメッセージのみ取得
 * @param {object} options - ポーリング設定
 * @param {number} options.intervalMs - ポーリング間隔(ms) default: 5000
 * @param {number} options.timeoutMs - タイムアウト(ms) default: 300000 (5分)
 * @param {Function} options.fetchFn - fetch関数（テスト用DI）
 * @returns {Promise<{text: string, user: string}|null>} ユーザー返信 or null (タイムアウト)
 */
export async function waitForSlackReply(channel, threadTs, afterTs, options = {}) {
    const {
        intervalMs = 5_000,
        timeoutMs = 300_000,
        fetchFn = fetch,
    } = options;
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) { console.error('SLACK_BOT_TOKEN 未設定'); return null; }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const params = new URLSearchParams({
                channel,
                ts: threadTs,
                oldest: afterTs,
                limit: '10',
            });
            const res = await fetchFn(`https://slack.com/api/conversations.replies?${params}`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` },
            });
            const data = await res.json();
            if (data.ok && data.messages) {
                // bot自身のメッセージを除外し、afterTs以降のユーザーメッセージを探す
                const userReply = data.messages.find(
                    m => !m.bot_id && !m.app_id && m.ts > afterTs
                );
                if (userReply) {
                    return { text: userReply.text, user: userReply.user };
                }
            }
        } catch (err) {
            console.error('Slack返信取得エラー:', err.message);
        }

        // 次のポーリングまで待機
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    console.log('Slack返信待ちタイムアウト');
    return null;
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

/**
 * エラー発生時にSlackでユーザーに確認し、リトライ判定を行うハンドラー
 * processStreamEventと連携してエラーを自動検知する
 */
export class InteractiveHandler {
    constructor(channel, threadTs, options = {}) {
        this.channel = channel;
        this.threadTs = threadTs;
        this._post = options.postFn || postToSlack;
        this._waitReply = options.waitReplyFn || waitForSlackReply;
        this.timeoutMs = options.timeoutMs || 300_000;
    }

    /**
     * エラー発生時にSlackでユーザーに確認を送り、返信を待つ
     * @param {string} errorSummary - エラー内容のサマリー
     * @returns {Promise<{action: 'retry'|'abort', message: string}>}
     */
    async askUser(errorSummary) {
        if (!this.channel || !this.threadTs) {
            return { action: 'abort', message: 'Slackチャンネル/スレッド未設定' };
        }

        const question = [
            `⚠️ *エラーが発生しました*`,
            '```',
            errorSummary.substring(0, 500),
            '```',
            '',
            '続行方法を返信してください:',
            '• `retry` または `再実行` → 同じタスクを再実行',
            '• `abort` または `中断` → タスクを中断',
            '• その他のメッセージ → 指示内容をプロンプトに追加して再実行',
            '',
            `_${Math.floor(this.timeoutMs / 60_000)}分以内に返信がない場合は自動で中断します_`,
        ].join('\n');

        const questionTs = await this._post(this.channel, question, this.threadTs);
        if (!questionTs) {
            return { action: 'abort', message: 'Slack送信失敗' };
        }

        console.log(`${timestamp()} 🔄 Slackでユーザーの返信を待機中...`);

        const reply = await this._waitReply(this.channel, this.threadTs, questionTs, {
            timeoutMs: this.timeoutMs,
        });

        if (!reply) {
            return { action: 'abort', message: 'タイムアウト（返信なし）' };
        }

        const normalized = reply.text.trim().toLowerCase();
        if (normalized === 'abort' || normalized === '中断') {
            return { action: 'abort', message: reply.text };
        }
        // 'retry', '再実行', またはその他のメッセージは全てretryとして扱う
        return { action: 'retry', message: reply.text };
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

/**
 * Claude Codeワーカープロセスを起動し、完了を待つ
 * @returns {Promise<{exitCode: number, output: string}>}
 */
export function spawnWorker(folder, issueId, tracker, extraPrompt = null) {
    return new Promise((resolve) => {
        // Claude Code内から起動された場合のネスト検出を回避
        const childEnv = { ...process.env };
        delete childEnv.CLAUDECODE;
        delete childEnv.CLAUDE_CODE_SSE_PORT;
        delete childEnv.CLAUDE_CODE_ENTRYPOINT;

        const args = ['./stealth-run.sh', folder, issueId];
        if (extraPrompt) args.push(extraPrompt);

        // PTY経由で起動（バッファリング防止のためTTYが必要）
        const worker = pty.spawn('/bin/zsh', args, {
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

        worker.onExit(({ exitCode }) => {
            // バッファに残った最後の行を処理
            if (lineBuffer.trim()) {
                const cleaned = lineBuffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '').trim();
                if (cleaned) processStreamEvent(cleaned, tracker);
            }

            resolve({ exitCode, output });
        });
    });
}

/** 出力からエラーサマリーを抽出する */
export function extractErrorSummary(output) {
    // ANSIエスケープシーケンスを除去
    const cleaned = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    // stream-jsonからエラーイベントを探す
    const lines = cleaned.split('\n');
    const errors = [];

    for (const line of lines) {
        try {
            const event = JSON.parse(line.trim());
            if (event.type === 'user' && event.message?.content) {
                for (const block of event.message.content) {
                    if (block.is_error && block.content) {
                        errors.push(block.content);
                    }
                }
            }
            // resultイベントのエラーも収集
            if (event.type === 'result' && event.subtype === 'error_max_turns') {
                errors.push('最大ターン数に到達しました');
            }
            if (event.type === 'result' && event.subtype !== 'success' && event.result) {
                errors.push(event.result);
            }
        } catch {
            // JSON以外の行でエラーっぽいものを拾う
            if (/error|Error|エラー|失敗/.test(line) && line.trim().length > 5) {
                errors.push(line.trim());
            }
        }
    }

    if (errors.length > 0) {
        return errors.slice(-5).join('\n');
    }
    return '原因不明のエラーで終了しました（ログを確認してください）';
}

app.post('/do', async (req, res) => {
    const { folder, issueId } = parseInput(req.body.text || "");
    const channelId = req.body.channel_id;

    if (!folder || !issueId) {
        return res.status(400).send('引数不足。例: circus_agent_ecosystem RA_DEV-81');
    }

    const isAgent = folder === 'agent';
    const displayName = isAgent ? 'dev-assistant-agent' : folder;
    const issueLabel = isAgent ? `GitHub Issue #${issueId}` : issueId;

    // 1. 即レス（Slack 3秒ルール）
    res.send(`了解。${displayName} にて ${issueLabel} の対応を開始しました。MBPのターミナルで進捗を確認してください。`);

    console.log(`\n${timestamp()} 🚀 実行開始: ${displayName}, ID: ${issueLabel}`);

    // 2. 親メッセージを chat.postMessage で投稿 → ts (スレッドID) 取得
    const parentTs = await postToSlack(channelId, `🚀 *${displayName}* にて *${issueLabel}* の対応を開始しました。\n進捗はこのスレッドでお知らせします。`);

    // 3. Slack進捗通知トラッカー（1分ごとにスレッドへ進捗を送信）
    const tracker = new ProgressTracker(channelId, issueId, parentTs);
    tracker.start();

    // 4. インタラクティブハンドラー（エラー時にSlackで確認）
    const interactive = new InteractiveHandler(channelId, parentTs);

    const MAX_RETRIES = 3;
    let attempt = 0;
    let lastExitCode = 0;
    let lastOutput = '';
    let extraPrompt = null;

    while (attempt < MAX_RETRIES) {
        attempt++;
        if (attempt > 1) {
            console.log(`\n${timestamp()} 🔄 リトライ実行 (${attempt}/${MAX_RETRIES})`);
            await postToSlack(channelId, `🔄 *${issueLabel}* をリトライ実行します (${attempt}/${MAX_RETRIES})`, parentTs);
        }

        const { exitCode, output } = await spawnWorker(folder, issueId, tracker, extraPrompt);
        lastExitCode = exitCode;
        lastOutput = output;

        if (exitCode !== 0 && output.trim() === '') {
            console.error(`⚠️ プロセスが出力なしで異常終了 (Exit Code: ${exitCode})。環境変数を確認してください。`);
        }
        console.log(`\n${timestamp()} ${exitCode === 0 ? '✅' : '❌'} 実行完了 (Exit Code: ${exitCode})`);

        // 正常終了ならループ終了
        if (exitCode === 0) break;

        // 最大リトライ回数に達した場合はループ終了
        if (attempt >= MAX_RETRIES) {
            console.log(`${timestamp()} ⛔ 最大リトライ回数 (${MAX_RETRIES}) に到達`);
            break;
        }

        // 異常終了: Slackでユーザーに確認
        const errorSummary = extractErrorSummary(output);
        const decision = await interactive.askUser(errorSummary);

        if (decision.action === 'abort') {
            console.log(`${timestamp()} ⛔ ユーザーが中断を選択: ${decision.message}`);
            await postToSlack(channelId, `⛔ ユーザーの指示により中断しました: ${decision.message}`, parentTs);
            break;
        }

        // retry: ユーザーの追加指示があればプロンプトに含める
        const normalized = decision.message.trim().toLowerCase();
        if (normalized !== 'retry' && normalized !== '再実行') {
            extraPrompt = decision.message;
            console.log(`${timestamp()} 💡 ユーザーからの追加指示: ${decision.message}`);
        } else {
            extraPrompt = null;
        }
    }

    // 5. タイマー停止
    tracker.stop();

    // 6. 完了メッセージをスレッドに投稿
    if (channelId && parentTs) {
        const prUrlMatch = lastOutput.match(/https:\/\/github\.com\/[^\s"]+\/pull\/\d+/);
        const prMessage = prUrlMatch
            ? `\nPRが作成されました: ${prUrlMatch[0]}`
            : "\nPRの作成を確認できませんでした。詳細はターミナルのログを確認してください。";

        const retryInfo = attempt > 1 ? ` (試行回数: ${attempt})` : '';

        try {
            await postToSlack(channelId, `${lastExitCode === 0 ? '✅' : '❌'} *${issueLabel}* の対応が${lastExitCode === 0 ? '完了' : '終了'}しました！ (Exit Code: ${lastExitCode})${retryInfo}${prMessage}`, parentTs);
        } catch (err) {
            console.error('Slackへの通知に失敗しました:', err);
        }
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log('----------------------------------------------------');
    console.log(`Finegate Agent Server running on port ${PORT}`);
    console.log('SlackのRequest URLを以下に設定してください:');
    console.log('http://あなたのトンネルURL/do');
    console.log('----------------------------------------------------');
});