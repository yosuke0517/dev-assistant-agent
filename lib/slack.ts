import fetch from 'node-fetch';

export type FetchFn = (
    url: string | URL,
    init?: Record<string, unknown>,
) => Promise<{ json: () => Promise<Record<string, unknown>> }>;

export interface SlackReply {
    text: string;
    user: string;
}

export interface WaitForSlackReplyOptions {
    intervalMs?: number;
    timeoutMs?: number;
    fetchFn?: FetchFn;
}

export interface RetryOptions {
    maxRetries?: number;
    baseDelayMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
}

/**
 * OWNER_SLACK_MEMBER_ID からSlackメンション文字列を生成する
 */
export function formatMention(memberId?: string): string {
    const id = memberId ?? process.env.OWNER_SLACK_MEMBER_ID;
    if (!id) return '';
    return `<@${id}> `;
}

/**
 * Slack chat.postMessage でメッセージ送信
 * ネットワークエラー時は指数バックオフでリトライする
 */
export async function postToSlack(
    channel: string,
    text: string,
    threadTs: string | null = null,
    fetchFn: FetchFn = fetch as unknown as FetchFn,
    retryOptions: RetryOptions = {},
): Promise<string | null> {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
        console.error('SLACK_BOT_TOKEN 未設定');
        return null;
    }

    const {
        maxRetries = 3,
        baseDelayMs = 1_000,
        sleepFn = (ms: number) =>
            new Promise((resolve) => setTimeout(resolve, ms)),
    } = retryOptions;

    const body: Record<string, string> = {
        channel,
        text,
        ...(threadTs && { thread_ts: threadTs }),
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetchFn(
                'https://slack.com/api/chat.postMessage',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify(body),
                },
            );
            const data = await res.json();
            if (!data.ok) {
                // Slack APIエラーはリトライしない（設定/権限の問題）
                console.error('Slack API エラー:', data.error);
                return null;
            }
            return data.ts as string;
        } catch (err: unknown) {
            if (attempt < maxRetries) {
                const delay = baseDelayMs * 2 ** attempt;
                console.warn(
                    `Slack送信リトライ (${attempt + 1}/${maxRetries}): ${(err as Error).message} - ${delay}ms後に再試行`,
                );
                await sleepFn(delay);
            } else {
                console.error('Slack 送信エラー:', (err as Error).message);
                return null;
            }
        }
    }

    return null;
}

/**
 * Slackスレッドへのユーザー返信をポーリングで待機する
 * botメッセージ送信後のユーザー返信のみ取得する
 */
export async function waitForSlackReply(
    channel: string,
    threadTs: string,
    afterTs: string,
    options: WaitForSlackReplyOptions = {},
): Promise<SlackReply | null> {
    const {
        intervalMs = 5_000,
        timeoutMs = 1_800_000,
        fetchFn = fetch as unknown as FetchFn,
    } = options;
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
        console.error('SLACK_BOT_TOKEN 未設定');
        return null;
    }

    const deadline = Date.now() + timeoutMs;
    let apiErrorLogged = false;

    while (Date.now() < deadline) {
        try {
            const params = new URLSearchParams({
                channel,
                ts: threadTs,
                oldest: afterTs,
                limit: '10',
            });
            const res = await fetchFn(
                `https://slack.com/api/conversations.replies?${params}`,
                {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${token}` },
                },
            );
            const data = await res.json();
            if (data.ok && data.messages) {
                const messages = data.messages as Array<Record<string, string>>;
                // bot自身のメッセージを除外し、afterTs以降のユーザーメッセージを探す
                const userReply = messages.find(
                    (m) => !m.bot_id && !m.app_id && m.ts > afterTs,
                );
                if (userReply) {
                    return { text: userReply.text, user: userReply.user };
                }
            } else if (!apiErrorLogged) {
                console.error(
                    'Slack conversations.replies APIエラー:',
                    data.error || 'unknown',
                    '(channel:',
                    channel,
                    'ts:',
                    threadTs,
                    ')',
                );
                apiErrorLogged = true;
            }
        } catch (err: unknown) {
            console.error('Slack返信取得エラー:', (err as Error).message);
        }

        // 次のポーリングまで待機
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    if (apiErrorLogged) {
        console.log(
            'Slack返信待ちタイムアウト（※ APIエラーが発生していたため、返信を取得できなかった可能性があります）',
        );
    } else {
        console.log('Slack返信待ちタイムアウト');
    }
    return null;
}
