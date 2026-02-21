import fetch from 'node-fetch';

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
 * @param {number} options.timeoutMs - タイムアウト(ms) default: 1800000 (30分)
 * @param {Function} options.fetchFn - fetch関数（テスト用DI）
 * @returns {Promise<{text: string, user: string}|null>} ユーザー返信 or null (タイムアウト)
 */
export async function waitForSlackReply(channel, threadTs, afterTs, options = {}) {
    const {
        intervalMs = 5_000,
        timeoutMs = 1_800_000,
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
