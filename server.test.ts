import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    extractErrorSummary,
    extractLastPrUrl,
    FollowUpHandler,
    InteractiveHandler,
    ProgressTracker,
    parseInput,
    postToSlack,
    processStreamEvent,
    waitForSlackReply,
} from './server.js';

describe('parseInput', () => {
    it('スペース区切りでパースできる', () => {
        const result = parseInput('circus_backend PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123',
            baseBranch: undefined,
        });
    });

    it('カンマ区切りでパースできる', () => {
        const result = parseInput('circus_backend,PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123',
            baseBranch: undefined,
        });
    });

    it('カンマ+スペース区切りでパースできる', () => {
        const result = parseInput('circus_backend, PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123',
            baseBranch: undefined,
        });
    });

    it('読点(、)区切りでパースできる', () => {
        const result = parseInput('circus_backend、PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123',
            baseBranch: undefined,
        });
    });

    it('複数の区切り文字が連続していても正しくパースできる', () => {
        const result = parseInput('circus_backend,  PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123',
            baseBranch: undefined,
        });
    });

    it('空入力の場合、folder が空文字列になる', () => {
        const result = parseInput('');
        expect(result.folder).toBe('');
        expect(result.issueId).toBeUndefined();
    });

    it('課題キーなしの場合、issueId が undefined になる', () => {
        const result = parseInput('circus_backend');
        expect(result.folder).toBe('circus_backend');
        expect(result.issueId).toBeUndefined();
    });

    it('agentキーワードとGitHub Issue番号をパースできる', () => {
        const result = parseInput('agent 5');
        expect(result).toEqual({
            folder: 'agent',
            issueId: '5',
            baseBranch: undefined,
        });
    });

    it('第3引数でベースブランチを指定できる', () => {
        const result = parseInput('circus_backend RA_DEV-81 develop');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'RA_DEV-81',
            baseBranch: 'develop',
        });
    });

    it('ベースブランチ未指定の場合はundefinedになる', () => {
        const result = parseInput('circus_backend RA_DEV-81');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'RA_DEV-81',
            baseBranch: undefined,
        });
    });

    it('カンマ区切りでもベースブランチを指定できる', () => {
        const result = parseInput('circus_backend,RA_DEV-81,develop');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'RA_DEV-81',
            baseBranch: 'develop',
        });
    });
});

describe('processStreamEvent', () => {
    it('systemイベントをパースできる', () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const line = JSON.stringify({
            type: 'system',
            subtype: 'init',
            session_id: 'test-session',
            tools: ['Bash', 'Read', 'Edit'],
        });

        const result = processStreamEvent(line);

        expect(result.type).toBe('system');
        expect(result.session_id).toBe('test-session');
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('セッション開始'),
        );
        consoleSpy.mockRestore();
    });

    it('assistantのテキストイベントをパースできる', () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const line = JSON.stringify({
            type: 'assistant',
            message: {
                content: [{ type: 'text', text: 'コードを分析します' }],
            },
        });

        const result = processStreamEvent(line);

        expect(result.type).toBe('assistant');
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('コードを分析します'),
        );
        consoleSpy.mockRestore();
    });

    it('assistantのツール使用イベントをパースできる', () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const line = JSON.stringify({
            type: 'assistant',
            message: {
                content: [
                    {
                        type: 'tool_use',
                        name: 'Bash',
                        input: { command: 'npm test' },
                    },
                ],
            },
        });

        const result = processStreamEvent(line);

        expect(result.type).toBe('assistant');
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('Bash'),
        );
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('npm test'),
        );
        consoleSpy.mockRestore();
    });

    it('resultイベントをパースできる', () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const line = JSON.stringify({
            type: 'result',
            subtype: 'success',
            cost_usd: 0.0542,
            num_turns: 3,
            duration_ms: 12345,
            result: 'PRを作成しました',
        });

        const result = processStreamEvent(line);

        expect(result.type).toBe('result');
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('$0.0542'),
        );
        consoleSpy.mockRestore();
    });

    it('JSON以外の行はそのまま出力する', () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const line = 'Claude Code starting for Backlog Issue: RA_DEV-81...';

        const result = processStreamEvent(line);

        expect(result.type).toBe('raw');
        expect(consoleSpy).toHaveBeenCalledWith(line);
        consoleSpy.mockRestore();
    });

    it('空行は無視する', () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const result = processStreamEvent('   ');

        expect(result.type).toBe('raw');
        expect(consoleSpy).not.toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it('ツール結果のエラーを正しく表示する', () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const line = JSON.stringify({
            type: 'user',
            message: {
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_123',
                        content: 'Error: file not found',
                        is_error: true,
                    },
                ],
            },
        });

        const result = processStreamEvent(line);

        expect(result.type).toBe('user');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('❌'));
        consoleSpy.mockRestore();
    });

    it('trackerにアクティビティが記録される', () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const tracker = new ProgressTracker(null, 'TEST-1', null);

        processStreamEvent(
            JSON.stringify({
                type: 'assistant',
                message: {
                    content: [{ type: 'text', text: 'ファイルを確認します' }],
                },
            }),
            tracker,
        );

        processStreamEvent(
            JSON.stringify({
                type: 'assistant',
                message: {
                    content: [
                        {
                            type: 'tool_use',
                            name: 'Bash',
                            input: { command: 'ls' },
                        },
                    ],
                },
            }),
            tracker,
        );

        expect(tracker.activities).toHaveLength(2);
        expect(tracker.activities[0]).toContain('ファイルを確認します');
        expect(tracker.activities[1]).toContain('Bash');
        consoleSpy.mockRestore();
    });
});

describe('ProgressTracker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('channelがない場合タイマーは開始しない', () => {
        const tracker = new ProgressTracker(null, 'TEST-1', null);
        tracker.start();
        expect(tracker.timer).toBeNull();
        tracker.stop();
    });

    it('アクティビティが蓄積される', () => {
        const tracker = new ProgressTracker('C123456', 'TEST-1', '1234.5678');
        tracker.addActivity('💬 テスト1');
        tracker.addActivity('🔧 テスト2');
        expect(tracker.activities).toHaveLength(2);
        tracker.stop();
    });

    it('flushでアクティビティがリセットされる', async () => {
        const mockPostFn = vi.fn().mockResolvedValue('mock-ts');

        const tracker = new ProgressTracker(
            'C123456',
            'TEST-1',
            '1234.5678',
            60_000,
            mockPostFn,
        );
        tracker.addActivity('💬 テスト');
        await tracker._flush();

        expect(tracker.activities).toHaveLength(0);
        expect(mockPostFn).toHaveBeenCalledTimes(1);

        // 送信内容を確認
        const [channel, text, threadTs] = mockPostFn.mock.calls[0];
        expect(channel).toBe('C123456');
        expect(text).toContain('TEST-1');
        expect(text).toContain('テスト');
        expect(threadTs).toBe('1234.5678');

        tracker.stop();
    });

    it('アクティビティが空の場合flushしない', async () => {
        const mockPostFn = vi.fn().mockResolvedValue('mock-ts');

        const tracker = new ProgressTracker(
            'C123456',
            'TEST-1',
            '1234.5678',
            60_000,
            mockPostFn,
        );
        await tracker._flush();

        expect(mockPostFn).not.toHaveBeenCalled();
        tracker.stop();
    });

    it('最大10件に制限される', async () => {
        const mockPostFn = vi.fn().mockResolvedValue('mock-ts');

        const tracker = new ProgressTracker(
            'C123456',
            'TEST-1',
            '1234.5678',
            60_000,
            mockPostFn,
        );
        for (let i = 0; i < 15; i++) {
            tracker.addActivity(`アクティビティ ${i}`);
        }
        await tracker._flush();

        const [_channel, text, _threadTs] = mockPostFn.mock.calls[0];
        // 直近10件のみ（5〜14）
        expect(text).toContain('アクティビティ 5');
        expect(text).toContain('アクティビティ 14');
        expect(text).not.toContain('アクティビティ 4');

        tracker.stop();
    });

    it('post失敗でもクラッシュしない', async () => {
        const mockPostFn = vi
            .fn()
            .mockRejectedValue(new Error('network error'));
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        const tracker = new ProgressTracker(
            'C123456',
            'TEST-1',
            '1234.5678',
            60_000,
            mockPostFn,
        );
        tracker.addActivity('テスト');
        await expect(tracker._flush()).resolves.toBeUndefined();

        consoleSpy.mockRestore();
        tracker.stop();
    });
});

describe('postToSlack', () => {
    it('SLACK_BOT_TOKEN未設定の場合はnullを返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        delete process.env.SLACK_BOT_TOKEN;
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        const result = await postToSlack('C123456', 'テスト');

        expect(result).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith('SLACK_BOT_TOKEN 未設定');

        consoleSpy.mockRestore();
        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('Slack API呼び出しが成功した場合tsを返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

        // node-fetch をモック
        const mockFetch = vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({ ok: true, ts: '1234.5678' }),
        });

        const result = await postToSlack(
            'C123456',
            'テストメッセージ',
            null,
            mockFetch,
        );

        expect(result).toBe('1234.5678');
        expect(mockFetch).toHaveBeenCalledTimes(1);

        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('スレッド返信の場合thread_tsが含まれる', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

        const mockFetch = vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({ ok: true, ts: '1234.5679' }),
        });

        const result = await postToSlack(
            'C123456',
            'スレッド返信',
            '1234.5678',
            mockFetch,
        );

        expect(result).toBe('1234.5679');

        // リクエストボディを確認
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.thread_ts).toBe('1234.5678');

        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('Slack APIエラーの場合nullを返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        const mockFetch = vi.fn().mockResolvedValue({
            json: vi
                .fn()
                .mockResolvedValue({ ok: false, error: 'channel_not_found' }),
        });

        const result = await postToSlack('C123456', 'テスト', null, mockFetch);

        expect(result).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith(
            'Slack API エラー:',
            'channel_not_found',
        );

        consoleSpy.mockRestore();
        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('ネットワークエラーの場合nullを返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

        const result = await postToSlack('C123456', 'テスト', null, mockFetch, {
            maxRetries: 0,
        });

        expect(result).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith(
            'Slack 送信エラー:',
            'Network error',
        );

        consoleSpy.mockRestore();
        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('ネットワークエラー時にリトライして成功する', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        let callCount = 0;
        const mockFetch = vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount <= 2) {
                return Promise.reject(new Error('fetch failed'));
            }
            return Promise.resolve({
                json: () => Promise.resolve({ ok: true, ts: '1234.5678' }),
            });
        });

        const result = await postToSlack('C123456', 'テスト', null, mockFetch, {
            maxRetries: 3,
            sleepFn: async () => {},
        });

        expect(result).toBe('1234.5678');
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(warnSpy).toHaveBeenCalledTimes(2);

        warnSpy.mockRestore();
        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('リトライ上限に達した場合はnullを返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

        const result = await postToSlack('C123456', 'テスト', null, mockFetch, {
            maxRetries: 2,
            sleepFn: async () => {},
        });

        expect(result).toBeNull();
        expect(mockFetch).toHaveBeenCalledTimes(3); // 1回目 + 2回リトライ
        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(consoleSpy).toHaveBeenCalledWith(
            'Slack 送信エラー:',
            'Network error',
        );

        consoleSpy.mockRestore();
        warnSpy.mockRestore();
        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('Slack APIエラーはリトライしない', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        const mockFetch = vi.fn().mockResolvedValue({
            json: vi
                .fn()
                .mockResolvedValue({ ok: false, error: 'channel_not_found' }),
        });

        const result = await postToSlack('C123456', 'テスト', null, mockFetch, {
            maxRetries: 3,
            sleepFn: async () => {},
        });

        expect(result).toBeNull();
        expect(mockFetch).toHaveBeenCalledTimes(1); // リトライなし
        expect(consoleSpy).toHaveBeenCalledWith(
            'Slack API エラー:',
            'channel_not_found',
        );

        consoleSpy.mockRestore();
        process.env.SLACK_BOT_TOKEN = originalToken;
    });
});

describe('waitForSlackReply', () => {
    it('SLACK_BOT_TOKEN未設定の場合はnullを返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        delete process.env.SLACK_BOT_TOKEN;
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        const result = await waitForSlackReply(
            'C123456',
            '1234.5678',
            '1234.5679',
        );

        expect(result).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith('SLACK_BOT_TOKEN 未設定');

        consoleSpy.mockRestore();
        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('ユーザー返信が見つかったら即座に返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

        const mockFetch = vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({
                ok: true,
                messages: [
                    { ts: '1234.5678', text: 'bot message', bot_id: 'B123' },
                    { ts: '1234.5680', text: 'retry', user: 'U123' },
                ],
            }),
        });

        const result = await waitForSlackReply(
            'C123456',
            '1234.5678',
            '1234.5679',
            {
                fetchFn: mockFetch,
                intervalMs: 10,
                timeoutMs: 1000,
            },
        );

        expect(result).toEqual({ text: 'retry', user: 'U123' });
        expect(mockFetch).toHaveBeenCalledTimes(1);

        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('botメッセージは無視される', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

        let callCount = 0;
        const mockFetch = vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount <= 2) {
                return Promise.resolve({
                    json: () =>
                        Promise.resolve({
                            ok: true,
                            messages: [
                                {
                                    ts: '1234.5680',
                                    text: 'bot reply',
                                    bot_id: 'B123',
                                },
                            ],
                        }),
                });
            }
            return Promise.resolve({
                json: () =>
                    Promise.resolve({
                        ok: true,
                        messages: [
                            {
                                ts: '1234.5680',
                                text: 'bot reply',
                                bot_id: 'B123',
                            },
                            {
                                ts: '1234.5681',
                                text: 'user reply',
                                user: 'U456',
                            },
                        ],
                    }),
            });
        });

        const result = await waitForSlackReply(
            'C123456',
            '1234.5678',
            '1234.5679',
            {
                fetchFn: mockFetch,
                intervalMs: 10,
                timeoutMs: 5000,
            },
        );

        expect(result).toEqual({ text: 'user reply', user: 'U456' });
        expect(callCount).toBeGreaterThanOrEqual(3);

        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('タイムアウト時はnullを返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});

        const mockFetch = vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({
                ok: true,
                messages: [],
            }),
        });

        const result = await waitForSlackReply(
            'C123456',
            '1234.5678',
            '1234.5679',
            {
                fetchFn: mockFetch,
                intervalMs: 10,
                timeoutMs: 50,
            },
        );

        expect(result).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith('Slack返信待ちタイムアウト');

        consoleSpy.mockRestore();
        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('API呼び出しエラーでもクラッシュせずポーリングを継続する', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        let callCount = 0;
        const mockFetch = vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                return Promise.reject(new Error('Network error'));
            }
            return Promise.resolve({
                json: () =>
                    Promise.resolve({
                        ok: true,
                        messages: [
                            { ts: '1234.5680', text: 'retry', user: 'U123' },
                        ],
                    }),
            });
        });

        const result = await waitForSlackReply(
            'C123456',
            '1234.5678',
            '1234.5679',
            {
                fetchFn: mockFetch,
                intervalMs: 10,
                timeoutMs: 5000,
            },
        );

        expect(result).toEqual({ text: 'retry', user: 'U123' });
        expect(consoleSpy).toHaveBeenCalledWith(
            'Slack返信取得エラー:',
            'Network error',
        );

        consoleSpy.mockRestore();
        logSpy.mockRestore();
        process.env.SLACK_BOT_TOKEN = originalToken;
    });
});

describe('InteractiveHandler', () => {
    it('channel未設定の場合はabortを返す', async () => {
        const handler = new InteractiveHandler(null, null);
        const result = await handler.askUser('test error');
        expect(result).toEqual({
            action: 'abort',
            message: 'Slackチャンネル/スレッド未設定',
        });
    });

    it('threadTs未設定の場合はabortを返す', async () => {
        const handler = new InteractiveHandler('C123456', null);
        const result = await handler.askUser('test error');
        expect(result).toEqual({
            action: 'abort',
            message: 'Slackチャンネル/スレッド未設定',
        });
    });

    it('Slack送信失敗の場合はabortを返す', async () => {
        const mockPost = vi.fn().mockResolvedValue(null);
        const handler = new InteractiveHandler('C123456', '1234.5678', {
            postFn: mockPost,
        });
        const result = await handler.askUser('test error');
        expect(result).toEqual({ action: 'abort', message: 'Slack送信失敗' });
    });

    it('ユーザーがretryと返信した場合はretryを返す', async () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: 'retry', user: 'U123' });

        const handler = new InteractiveHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        const result = await handler.askUser('MCP connection error');

        expect(result).toEqual({ action: 'retry', message: 'retry' });
        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0][0]).toBe('C123456');
        expect(mockPost.mock.calls[0][1]).toContain('エラーが発生しました');
        expect(mockPost.mock.calls[0][1]).toContain('MCP connection error');
        expect(mockWaitReply).toHaveBeenCalledTimes(1);

        consoleSpy.mockRestore();
    });

    it('ユーザーが再実行と返信した場合はretryを返す', async () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: '再実行', user: 'U123' });

        const handler = new InteractiveHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        const result = await handler.askUser('error');
        expect(result).toEqual({ action: 'retry', message: '再実行' });

        consoleSpy.mockRestore();
    });

    it('ユーザーがabortと返信した場合はabortを返す', async () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: 'abort', user: 'U123' });

        const handler = new InteractiveHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        const result = await handler.askUser('error');
        expect(result).toEqual({ action: 'abort', message: 'abort' });

        consoleSpy.mockRestore();
    });

    it('ユーザーが中断と返信した場合はabortを返す', async () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: '中断', user: 'U123' });

        const handler = new InteractiveHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        const result = await handler.askUser('error');
        expect(result).toEqual({ action: 'abort', message: '中断' });

        consoleSpy.mockRestore();
    });

    it('ユーザーがカスタムメッセージを返信した場合はretryとメッセージを返す', async () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi.fn().mockResolvedValue({
            text: 'MCPの代わりにAPIを直接使って',
            user: 'U123',
        });

        const handler = new InteractiveHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        const result = await handler.askUser('MCP error');
        expect(result).toEqual({
            action: 'retry',
            message: 'MCPの代わりにAPIを直接使って',
        });

        consoleSpy.mockRestore();
    });

    it('タイムアウト時はabortを返す', async () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi.fn().mockResolvedValue(null);

        const handler = new InteractiveHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        const result = await handler.askUser('error');
        expect(result).toEqual({
            action: 'abort',
            message: 'タイムアウト（返信なし）',
        });

        consoleSpy.mockRestore();
    });

    it('OWNER_SLACK_MEMBER_ID設定時にエラーメッセージにメンションが含まれる', async () => {
        const originalOwner = process.env.OWNER_SLACK_MEMBER_ID;
        process.env.OWNER_SLACK_MEMBER_ID = 'U12345678';

        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: 'retry', user: 'U123' });

        const handler = new InteractiveHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        await handler.askUser('test error');

        const sentText = mockPost.mock.calls[0][1];
        expect(sentText).toContain('<@U12345678>');
        expect(sentText).toContain('エラーが発生しました');

        consoleSpy.mockRestore();
        if (originalOwner !== undefined) {
            process.env.OWNER_SLACK_MEMBER_ID = originalOwner;
        } else {
            delete process.env.OWNER_SLACK_MEMBER_ID;
        }
    });

    it('エラーサマリーが500文字を超える場合は切り詰められる', async () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: 'retry', user: 'U123' });

        const handler = new InteractiveHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        const longError = 'A'.repeat(600);
        await handler.askUser(longError);

        const sentText = mockPost.mock.calls[0][1];
        // エラーサマリー部分が500文字に切り詰められていることを確認
        expect(sentText).not.toContain('A'.repeat(600));
        expect(sentText).toContain('A'.repeat(500));

        consoleSpy.mockRestore();
    });
});

describe('extractErrorSummary', () => {
    it('ツール結果のエラーを抽出する', () => {
        const output = [
            JSON.stringify({
                type: 'assistant',
                message: { content: [{ type: 'text', text: 'working' }] },
            }),
            JSON.stringify({
                type: 'user',
                message: {
                    content: [
                        {
                            type: 'tool_result',
                            content: 'MCP connection refused',
                            is_error: true,
                        },
                    ],
                },
            }),
        ].join('\n');

        const summary = extractErrorSummary(output);
        expect(summary).toContain('MCP connection refused');
    });

    it('resultイベントのエラーを抽出する', () => {
        const output = JSON.stringify({
            type: 'result',
            subtype: 'error_max_turns',
            result: 'Maximum turns exceeded',
        });

        const summary = extractErrorSummary(output);
        expect(summary).toContain('最大ターン数に到達しました');
    });

    it('非JSONエラー行を抽出する', () => {
        const output =
            'some normal line\nError: Directory /foo does not exist.\nanother line';

        const summary = extractErrorSummary(output);
        expect(summary).toContain('Error: Directory /foo does not exist.');
    });

    it('エラーが見つからない場合はデフォルトメッセージを返す', () => {
        const output = 'normal line 1\nnormal line 2';

        const summary = extractErrorSummary(output);
        expect(summary).toContain('原因不明のエラーで終了しました');
    });

    it('最大5件のエラーに制限される', () => {
        const errors = [];
        for (let i = 0; i < 8; i++) {
            errors.push(`Error: problem ${i}`);
        }
        const output = errors.join('\n');

        const summary = extractErrorSummary(output);
        // 最後の5件のみ（3〜7）
        expect(summary).toContain('Error: problem 3');
        expect(summary).toContain('Error: problem 7');
        expect(summary).not.toContain('Error: problem 2');
    });

    it('ANSIエスケープシーケンスを除去してからパースする', () => {
        const output = '\x1b[31mError: something went wrong\x1b[0m';

        const summary = extractErrorSummary(output);
        expect(summary).toContain('Error: something went wrong');
    });
});

describe('extractLastPrUrl', () => {
    it('GitHub PR URLを検出できる', () => {
        const output =
            'PRが作成されました https://github.com/yosuke0517/dev-assistant-agent/pull/35 完了';
        const result = extractLastPrUrl(output);
        expect(result).toBe(
            'https://github.com/yosuke0517/dev-assistant-agent/pull/35',
        );
    });

    it('Backlog PR URL (.backlog.jp) を検出できる', () => {
        const output =
            'PRを作成しました https://myspace.backlog.jp/git/PROJ/repo/pullRequests/42 end';
        const result = extractLastPrUrl(output);
        expect(result).toBe(
            'https://myspace.backlog.jp/git/PROJ/repo/pullRequests/42',
        );
    });

    it('Backlog PR URL (.backlog.com) を検出できる', () => {
        const output =
            'PR: https://myspace.backlog.com/git/PROJ/repo/pullRequests/123';
        const result = extractLastPrUrl(output);
        expect(result).toBe(
            'https://myspace.backlog.com/git/PROJ/repo/pullRequests/123',
        );
    });

    it('PR URLが含まれない場合はnullを返す', () => {
        const output = 'タスクが完了しました。レポートを送信します。';
        const result = extractLastPrUrl(output);
        expect(result).toBeNull();
    });

    it('複数のPR URLがある場合は最後のURLを返す', () => {
        const output = [
            '前回のPR: https://github.com/yosuke0517/dev-assistant-agent/pull/35',
            'git logを確認...',
            '新しいPRを作成しました: https://github.com/yosuke0517/dev-assistant-agent/pull/36',
        ].join('\n');
        const result = extractLastPrUrl(output);
        expect(result).toBe(
            'https://github.com/yosuke0517/dev-assistant-agent/pull/36',
        );
    });

    it('GitHub PRとBacklog PRが混在する場合は最後のURLを返す', () => {
        const output = [
            '参考: https://github.com/yosuke0517/dev-assistant-agent/pull/10',
            'PRを作成: https://myspace.backlog.jp/git/PROJ/repo/pullRequests/99',
        ].join('\n');
        const result = extractLastPrUrl(output);
        expect(result).toBe(
            'https://myspace.backlog.jp/git/PROJ/repo/pullRequests/99',
        );
    });
});

describe('FollowUpHandler', () => {
    it('channel未設定の場合はendを返す', async () => {
        const handler = new FollowUpHandler(null, null);
        const result = await handler.waitForFollowUp('TEST-1');
        expect(result).toEqual({
            action: 'end',
            message: 'Slackチャンネル/スレッド未設定',
        });
    });

    it('threadTs未設定の場合はendを返す', async () => {
        const handler = new FollowUpHandler('C123456', null);
        const result = await handler.waitForFollowUp('TEST-1');
        expect(result).toEqual({
            action: 'end',
            message: 'Slackチャンネル/スレッド未設定',
        });
    });

    it('Slack送信失敗の場合はendを返す', async () => {
        const mockPost = vi.fn().mockResolvedValue(null);
        const handler = new FollowUpHandler('C123456', '1234.5678', {
            postFn: mockPost,
        });
        const result = await handler.waitForFollowUp('TEST-1');
        expect(result).toEqual({ action: 'end', message: 'Slack送信失敗' });
    });

    it('ユーザーが追加依頼を返信した場合はfollow_upを返す', async () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi.fn().mockResolvedValue({
            text: 'テストを追加してください',
            user: 'U123',
        });

        const handler = new FollowUpHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        const result = await handler.waitForFollowUp('Issue #37');

        expect(result).toEqual({
            action: 'follow_up',
            message: 'テストを追加してください',
        });
        expect(mockPost).toHaveBeenCalledTimes(1);
        expect(mockPost.mock.calls[0][1]).toContain('Issue #37');
        expect(mockPost.mock.calls[0][1]).toContain('追加の依頼');
        expect(mockWaitReply).toHaveBeenCalledTimes(1);

        consoleSpy.mockRestore();
    });

    it('ユーザーが終了と返信した場合はendを返す', async () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: '終了', user: 'U123' });

        const handler = new FollowUpHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        const result = await handler.waitForFollowUp('TEST-1');
        expect(result).toEqual({ action: 'end', message: '終了' });

        consoleSpy.mockRestore();
    });

    it('ユーザーがendと返信した場合はendを返す', async () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: 'end', user: 'U123' });

        const handler = new FollowUpHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        const result = await handler.waitForFollowUp('TEST-1');
        expect(result).toEqual({ action: 'end', message: 'end' });

        consoleSpy.mockRestore();
    });

    it('タイムアウト時はendを返す', async () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi.fn().mockResolvedValue(null);

        const handler = new FollowUpHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        const result = await handler.waitForFollowUp('TEST-1');
        expect(result).toEqual({
            action: 'end',
            message: 'タイムアウト（返信なし）',
        });

        consoleSpy.mockRestore();
    });

    it('OWNER_SLACK_MEMBER_ID設定時にメンションが含まれる', async () => {
        const originalOwner = process.env.OWNER_SLACK_MEMBER_ID;
        process.env.OWNER_SLACK_MEMBER_ID = 'U12345678';

        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi.fn().mockResolvedValue({
            text: 'バグを修正して',
            user: 'U123',
        });

        const handler = new FollowUpHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        await handler.waitForFollowUp('TEST-1');

        const sentText = mockPost.mock.calls[0][1];
        expect(sentText).toContain('<@U12345678>');
        expect(sentText).toContain('追加の依頼');

        consoleSpy.mockRestore();
        if (originalOwner !== undefined) {
            process.env.OWNER_SLACK_MEMBER_ID = originalOwner;
        } else {
            delete process.env.OWNER_SLACK_MEMBER_ID;
        }
    });

    it('issueLabel がメッセージに含まれる', async () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: 'end', user: 'U123' });

        const handler = new FollowUpHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        await handler.waitForFollowUp('GitHub Issue #37');

        const sentText = mockPost.mock.calls[0][1];
        expect(sentText).toContain('GitHub Issue #37');

        consoleSpy.mockRestore();
    });

    it('タイムアウト時間がメッセージに含まれる', async () => {
        const consoleSpy = vi
            .spyOn(console, 'log')
            .mockImplementation(() => {});
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: 'end', user: 'U123' });

        const handler = new FollowUpHandler('C123456', '1234.5678', {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
            timeoutMs: 600_000,
        });

        await handler.waitForFollowUp('TEST-1');

        const sentText = mockPost.mock.calls[0][1];
        expect(sentText).toContain('10分以内');

        consoleSpy.mockRestore();
    });
});
