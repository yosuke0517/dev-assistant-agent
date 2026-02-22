import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { postToSlack, waitForSlackReply } from '../../lib/slack.js';
import { fileURLToPath } from 'url';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30分

/**
 * ask_human ツールのハンドラー
 * Slack経由でユーザーに質問し、回答を待つ
 */
export async function handleAskHuman(question, context, options = {}) {
    const channel = options.channel ?? process.env.SLACK_CHANNEL;
    const threadTs = options.threadTs ?? process.env.SLACK_THREAD_TS;
    const postFn = options.postFn ?? postToSlack;
    const waitReplyFn = options.waitReplyFn ?? waitForSlackReply;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // 質問が空の場合はエラーを返す
    if (!question || (typeof question === 'string' && question.trim() === '')) {
        return {
            content: [{ type: 'text', text: '質問内容が空です。質問を指定してください。' }],
            isError: true,
        };
    }

    if (!channel || !threadTs) {
        return {
            content: [{ type: 'text', text: 'Slack未設定エラー: SLACK_CHANNEL または SLACK_THREAD_TS が設定されていないため、ユーザーへの質問ができません。' }],
            isError: true,
        };
    }

    // 質問メッセージを組み立て
    let message = `❓ *Claude Codeからの質問*\n\n${question}`;
    if (context) {
        message += `\n\n📋 *背景・補足*\n${context}`;
    }
    message += `\n\n_回答をこのスレッドに返信してください（${Math.floor(timeoutMs / 60_000)}分以内）_`;

    // Slackに質問を投稿
    let questionTs;
    try {
        questionTs = await postFn(channel, message, threadTs);
    } catch (err) {
        console.error('Slack投稿中に例外が発生:', err.message);
        return {
            content: [{ type: 'text', text: `Slack送信エラー: 質問の送信中に例外が発生しました: ${err.message}` }],
            isError: true,
        };
    }
    if (!questionTs) {
        return {
            content: [{ type: 'text', text: 'Slack送信失敗: 質問の送信に失敗しました（投稿結果が取得できませんでした）。' }],
            isError: true,
        };
    }

    // ユーザーの返信を待機
    let reply;
    try {
        reply = await waitReplyFn(channel, threadTs, questionTs, { timeoutMs });
    } catch (err) {
        console.error('Slack返信待機中に例外が発生:', err.message);
        return {
            content: [{ type: 'text', text: `Slack待機エラー: 返信の待機中に例外が発生しました: ${err.message}` }],
            isError: true,
        };
    }

    if (!reply) {
        return {
            content: [{ type: 'text', text: `タイムアウト: 質問はSlackに送信済みですが、${Math.floor(timeoutMs / 60_000)}分以内に返信がありませんでした。` }]
        };
    }

    return {
        content: [{ type: 'text', text: reply.text }]
    };
}

/**
 * MCP Server を作成して返す（テスト用にファクトリ関数として公開）
 */
export function createServer(deps = {}) {
    const server = new Server(
        { name: 'slack-human-interaction', version: '1.0.0' },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{
            name: 'ask_human',
            description: 'Slack経由でユーザーに質問し、回答を待つ。仕様の確認、設計判断、曖昧な要件の明確化などに使用。',
            inputSchema: {
                type: 'object',
                properties: {
                    question: {
                        type: 'string',
                        description: '質問内容',
                    },
                    context: {
                        type: 'string',
                        description: '質問の背景・選択肢など（任意）',
                    },
                },
                required: ['question'],
            },
        }],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name === 'ask_human') {
            const { question, context } = request.params.arguments;
            return await handleAskHuman(question, context, deps);
        }

        return {
            content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
            isError: true,
        };
    });

    return server;
}

// メインエントリーポイント（直接実行時のみ起動）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
