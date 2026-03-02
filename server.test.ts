import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildDoModalView,
    extractErrorSummary,
    extractLastPrUrl,
    extractRelatedRepos,
    extractResultText,
    FollowUpHandler,
    getRepoConfig,
    InteractiveHandler,
    type ModalValues,
    openModal,
    ProgressTracker,
    parseInput,
    parseModalValues,
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
            userRequest: undefined,
        });
    });

    it('カンマ区切りでパースできる', () => {
        const result = parseInput('circus_backend,PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123',
            baseBranch: undefined,
            userRequest: undefined,
        });
    });

    it('カンマ+スペース区切りでパースできる', () => {
        const result = parseInput('circus_backend, PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123',
            baseBranch: undefined,
            userRequest: undefined,
        });
    });

    it('読点(、)区切りでパースできる', () => {
        const result = parseInput('circus_backend、PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123',
            baseBranch: undefined,
            userRequest: undefined,
        });
    });

    it('複数の区切り文字が連続していても正しくパースできる', () => {
        const result = parseInput('circus_backend,  PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123',
            baseBranch: undefined,
            userRequest: undefined,
        });
    });

    it('空入力の場合、folder が空文字列になる', () => {
        const result = parseInput('');
        expect(result.folder).toBe('');
        expect(result.issueId).toBeUndefined();
        expect(result.userRequest).toBeUndefined();
    });

    it('課題キーなしの場合、issueId が undefined になる', () => {
        const result = parseInput('circus_backend');
        expect(result.folder).toBe('circus_backend');
        expect(result.issueId).toBeUndefined();
        expect(result.userRequest).toBeUndefined();
    });

    it('agentキーワードとGitHub Issue番号をパースできる', () => {
        const result = parseInput('agent 5');
        expect(result).toEqual({
            folder: 'agent',
            issueId: '5',
            baseBranch: undefined,
            userRequest: undefined,
        });
    });

    it('第3引数でベースブランチを指定できる', () => {
        const result = parseInput('circus_backend RA_DEV-81 develop');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'RA_DEV-81',
            baseBranch: 'develop',
            userRequest: undefined,
        });
    });

    it('ベースブランチ未指定の場合はundefinedになる', () => {
        const result = parseInput('circus_backend RA_DEV-81');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'RA_DEV-81',
            baseBranch: undefined,
            userRequest: undefined,
        });
    });

    it('カンマ区切りでもベースブランチを指定できる', () => {
        const result = parseInput('circus_backend,RA_DEV-81,develop');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'RA_DEV-81',
            baseBranch: 'develop',
            userRequest: undefined,
        });
    });

    it('第4引数でユーザー要望を受け取れる', () => {
        const result = parseInput(
            'circus_backend RA_DEV-85 feat/RA_DEV-85 CIでテスト時にエラーが出てるので調査して修正してほしい',
        );
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'RA_DEV-85',
            baseBranch: 'feat/RA_DEV-85',
            userRequest:
                'CIでテスト時にエラーが出てるので調査して修正してほしい',
        });
    });

    it('ユーザー要望にスペースが含まれていても正しくパースできる', () => {
        const result = parseInput(
            'circus_backend RA_DEV-85 feat/RA_DEV-85 CI error fix please',
        );
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'RA_DEV-85',
            baseBranch: 'feat/RA_DEV-85',
            userRequest: 'CI error fix please',
        });
    });

    it('第3引数が文字列 "undefined" の場合、baseBranch は undefined になる', () => {
        const result = parseInput('circus_backend RA_DEV-91 undefined');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'RA_DEV-91',
            baseBranch: undefined,
            userRequest: undefined,
        });
    });

    it('第3引数が "undefined" でも第4引数のユーザー要望は正しくパースできる', () => {
        const result = parseInput(
            'circus_agent_ecosystem RA_DEV-91 undefined レポートを作成してpushして欲しい',
        );
        expect(result).toEqual({
            folder: 'circus_agent_ecosystem',
            issueId: 'RA_DEV-91',
            baseBranch: undefined,
            userRequest: 'レポートを作成してpushして欲しい',
        });
    });

    it('agentキーワードでもユーザー要望を受け取れる', () => {
        const result = parseInput(
            'agent 46 feat/issue-46 テストを追加してほしい',
        );
        expect(result).toEqual({
            folder: 'agent',
            issueId: '46',
            baseBranch: 'feat/issue-46',
            userRequest: 'テストを追加してほしい',
        });
    });
});

describe('getRepoConfig', () => {
    it('agentの場合、dev-assistant-agentを返しisGitHubがtrue', () => {
        const config = getRepoConfig('agent');
        expect(config).toEqual({
            displayName: 'dev-assistant-agent',
            isGitHub: true,
        });
    });

    it('jjpの場合、jjp-loadsheet-uiを返しisGitHubがtrue', () => {
        const config = getRepoConfig('jjp');
        expect(config).toEqual({
            displayName: 'jjp-loadsheet-ui',
            isGitHub: true,
        });
    });

    it('その他のリポジトリはフォルダ名をそのまま返しisGitHubがfalse', () => {
        const config = getRepoConfig('circus_backend');
        expect(config).toEqual({
            displayName: 'circus_backend',
            isGitHub: false,
        });
    });

    it('未知のリポジトリ名でもフォルダ名をそのまま返す', () => {
        const config = getRepoConfig('some_new_repo');
        expect(config).toEqual({
            displayName: 'some_new_repo',
            isGitHub: false,
        });
    });
});

describe('extractRelatedRepos', () => {
    it('--related repo:branch を正しく抽出する', () => {
        const result = extractRelatedRepos(
            'circus_agent_ecosystem RA_DEV-81 develop --related circus_backend:develop',
        );
        expect(result.relatedRepos).toEqual([
            { name: 'circus_backend', branch: 'develop' },
        ]);
        expect(result.cleanedText).toBe(
            'circus_agent_ecosystem RA_DEV-81 develop',
        );
    });

    it('--related repo（ブランチ省略）を正しく抽出する', () => {
        const result = extractRelatedRepos(
            'circus_agent_ecosystem RA_DEV-81 develop --related circus_backend',
        );
        expect(result.relatedRepos).toEqual([{ name: 'circus_backend' }]);
        expect(result.cleanedText).toBe(
            'circus_agent_ecosystem RA_DEV-81 develop',
        );
    });

    it('複数の --related を正しく抽出する', () => {
        const result = extractRelatedRepos(
            'circus_agent_ecosystem RA_DEV-81 develop --related circus_backend:develop --related circus_backend_v2:main',
        );
        expect(result.relatedRepos).toEqual([
            { name: 'circus_backend', branch: 'develop' },
            { name: 'circus_backend_v2', branch: 'main' },
        ]);
        expect(result.cleanedText).toBe(
            'circus_agent_ecosystem RA_DEV-81 develop',
        );
    });

    it('--related なしの場合は空配列を返す', () => {
        const result = extractRelatedRepos(
            'circus_agent_ecosystem RA_DEV-81 develop',
        );
        expect(result.relatedRepos).toEqual([]);
        expect(result.cleanedText).toBe(
            'circus_agent_ecosystem RA_DEV-81 develop',
        );
    });

    it('userRequest と --related が混在するケースを正しく処理する', () => {
        const result = extractRelatedRepos(
            'circus_agent_ecosystem RA_DEV-81 develop --related circus_backend:develop テストを追加してほしい',
        );
        expect(result.relatedRepos).toEqual([
            { name: 'circus_backend', branch: 'develop' },
        ]);
        expect(result.cleanedText).toBe(
            'circus_agent_ecosystem RA_DEV-81 develop テストを追加してほしい',
        );
    });

    it('空文字列の場合は空配列と空文字列を返す', () => {
        const result = extractRelatedRepos('');
        expect(result.relatedRepos).toEqual([]);
        expect(result.cleanedText).toBe('');
    });

    it('抽出後に連続スペースがクリーンアップされる', () => {
        const result = extractRelatedRepos(
            'circus_agent_ecosystem  --related circus_backend:develop  RA_DEV-81',
        );
        expect(result.relatedRepos).toEqual([
            { name: 'circus_backend', branch: 'develop' },
        ]);
        expect(result.cleanedText).toBe('circus_agent_ecosystem RA_DEV-81');
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

    it('originalCommand設定時にエラーメッセージに実行コマンドが含まれる', async () => {
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
            originalCommand: 'circus_backend RA_DEV-85 develop',
        });

        await handler.askUser('test error');

        const sentText = mockPost.mock.calls[0][1];
        expect(sentText).toContain('実行コマンド');
        expect(sentText).toContain('`/do circus_backend RA_DEV-85 develop`');

        consoleSpy.mockRestore();
    });

    it('originalCommand未設定時はエラーメッセージに実行コマンドが含まれない', async () => {
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
        expect(sentText).not.toContain('実行コマンド');
        expect(sentText).not.toContain('/do');

        consoleSpy.mockRestore();
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

describe('extractResultText', () => {
    it('成功時のresultイベントからテキストを抽出できる', () => {
        const output = [
            '{"type":"system","session_id":"abc123"}',
            '{"type":"assistant","message":{"content":[{"type":"text","text":"調査を開始します"}]}}',
            '{"type":"result","subtype":"success","result":"調査が完了しました。原因はXXXです。","cost_usd":0.05,"num_turns":5,"duration_ms":30000}',
        ].join('\n');
        const result = extractResultText(output);
        expect(result).toBe('調査が完了しました。原因はXXXです。');
    });

    it('resultイベントが存在しない場合はnullを返す', () => {
        const output = [
            '{"type":"system","session_id":"abc123"}',
            '{"type":"assistant","message":{"content":[{"type":"text","text":"作業中"}]}}',
        ].join('\n');
        const result = extractResultText(output);
        expect(result).toBeNull();
    });

    it('エラー終了のresultイベントではnullを返す', () => {
        const output =
            '{"type":"result","subtype":"error_max_turns","result":"最大ターン数に到達","cost_usd":0.1,"num_turns":50}';
        const result = extractResultText(output);
        expect(result).toBeNull();
    });

    it('ANSIエスケープシーケンスが含まれていても抽出できる', () => {
        const output =
            '\x1b[32m{"type":"result","subtype":"success","result":"レポート完了","cost_usd":0.03}\x1b[0m';
        const result = extractResultText(output);
        expect(result).toBe('レポート完了');
    });

    it('resultフィールドが空文字の場合はnullを返す', () => {
        const output =
            '{"type":"result","subtype":"success","result":"","cost_usd":0.01}';
        const result = extractResultText(output);
        expect(result).toBeNull();
    });

    it('JSON以外の行が混在していても正しく抽出できる', () => {
        const output = [
            'Creating worktree at: /tmp/test',
            '{"type":"system","session_id":"abc123"}',
            'Directory changed to: /tmp/test',
            '{"type":"result","subtype":"success","result":"Issue #66にコメントを追加しました。","cost_usd":0.04}',
            'Task completed at Mon Jan 1 00:00:00 UTC 2025',
        ].join('\n');
        const result = extractResultText(output);
        expect(result).toBe('Issue #66にコメントを追加しました。');
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

describe('buildDoModalView', () => {
    it('正しいcallback_idとtitleを持つモーダルを生成する', () => {
        const view = buildDoModalView('C123456');
        expect(view.type).toBe('modal');
        expect(view.callback_id).toBe('do_modal');
        expect(view.title).toEqual({
            type: 'plain_text',
            text: 'エージェントに指示',
        });
        expect(view.submit).toEqual({ type: 'plain_text', text: '実行' });
        expect(view.close).toEqual({
            type: 'plain_text',
            text: 'キャンセル',
        });
    });

    it('private_metadataにchannel_idが含まれる', () => {
        const view = buildDoModalView('C999888');
        const metadata = JSON.parse(view.private_metadata as string);
        expect(metadata.channel_id).toBe('C999888');
    });

    it('5つの入力ブロックを持つ', () => {
        const view = buildDoModalView('C123456');
        const blocks = view.blocks as Array<{ block_id: string }>;
        expect(blocks).toHaveLength(5);
        expect(blocks[0].block_id).toBe('repository');
        expect(blocks[1].block_id).toBe('branch');
        expect(blocks[2].block_id).toBe('pbi');
        expect(blocks[3].block_id).toBe('base_branch');
        expect(blocks[4].block_id).toBe('fix_description');
    });

    it('repositoryブロックに6つのオプションがある', () => {
        const view = buildDoModalView('C123456');
        const blocks = view.blocks as Array<{
            block_id: string;
            element: { options: unknown[] };
        }>;
        const repoBlock = blocks[0];
        expect(repoBlock.element.options).toHaveLength(6);
    });

    it('base_branchとfix_descriptionはoptionalフラグを持つ', () => {
        const view = buildDoModalView('C123456');
        const blocks = view.blocks as Array<{
            block_id: string;
            optional?: boolean;
        }>;
        expect(blocks[3].optional).toBe(true); // base_branch
        expect(blocks[4].optional).toBe(true); // fix_description
    });
});

describe('openModal', () => {
    it('SLACK_BOT_TOKEN未設定の場合はfalseを返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        delete process.env.SLACK_BOT_TOKEN;
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        const result = await openModal('trigger123', 'C123456');

        expect(result).toBe(false);
        expect(consoleSpy).toHaveBeenCalledWith('SLACK_BOT_TOKEN 未設定');

        consoleSpy.mockRestore();
        if (originalToken !== undefined) {
            process.env.SLACK_BOT_TOKEN = originalToken;
        }
    });

    it('views.open API成功時はtrueを返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

        const mockFetch = vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({ ok: true }),
        });

        const result = await openModal('trigger123', 'C123456', mockFetch);

        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        const callArgs = mockFetch.mock.calls[0];
        expect(callArgs[0]).toBe('https://slack.com/api/views.open');

        const body = JSON.parse(callArgs[1].body as string);
        expect(body.trigger_id).toBe('trigger123');
        expect(body.view.callback_id).toBe('do_modal');

        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('views.open APIエラー時はfalseを返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        const mockFetch = vi.fn().mockResolvedValue({
            json: vi
                .fn()
                .mockResolvedValue({ ok: false, error: 'invalid_trigger_id' }),
        });

        const result = await openModal('bad_trigger', 'C123456', mockFetch);

        expect(result).toBe(false);
        expect(consoleSpy).toHaveBeenCalledWith(
            'views.open API エラー:',
            'invalid_trigger_id',
        );

        consoleSpy.mockRestore();
        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('ネットワークエラー時はfalseを返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

        const result = await openModal('trigger123', 'C123456', mockFetch);

        expect(result).toBe(false);
        expect(consoleSpy).toHaveBeenCalledWith(
            'views.open 送信エラー:',
            'Network error',
        );

        consoleSpy.mockRestore();
        process.env.SLACK_BOT_TOKEN = originalToken;
    });
});

describe('parseModalValues', () => {
    it('全フィールドが入力された場合に正しくパースする', () => {
        const stateValues = {
            repository: {
                value: {
                    type: 'static_select',
                    selected_option: { value: 'circus_backend' },
                },
            },
            branch: {
                value: { type: 'plain_text_input', value: 'feat/RA_DEV-85' },
            },
            pbi: {
                value: { type: 'plain_text_input', value: 'RA_DEV-85' },
            },
            base_branch: {
                value: { type: 'plain_text_input', value: 'develop' },
            },
            fix_description: {
                value: {
                    type: 'plain_text_input',
                    value: 'バグを修正してください',
                },
            },
        };

        const result: ModalValues = parseModalValues(stateValues);

        expect(result).toEqual({
            folder: 'circus_backend',
            branchName: 'feat/RA_DEV-85',
            issueId: 'RA_DEV-85',
            baseBranch: 'develop',
            userRequest: 'バグを修正してください',
        });
    });

    it('オプションフィールドが空の場合はundefinedになる', () => {
        const stateValues = {
            repository: {
                value: {
                    type: 'static_select',
                    selected_option: { value: 'agent' },
                },
            },
            branch: {
                value: { type: 'plain_text_input', value: 'feat/issue-42' },
            },
            pbi: {
                value: { type: 'plain_text_input', value: '42' },
            },
            base_branch: {
                value: { type: 'plain_text_input', value: null },
            },
            fix_description: {
                value: { type: 'plain_text_input', value: null },
            },
        };

        const result: ModalValues = parseModalValues(stateValues);

        expect(result).toEqual({
            folder: 'agent',
            branchName: 'feat/issue-42',
            issueId: '42',
            baseBranch: undefined,
            userRequest: undefined,
        });
    });

    it('空のstateValuesでもクラッシュしない', () => {
        const result: ModalValues = parseModalValues({});

        expect(result).toEqual({
            folder: '',
            branchName: '',
            issueId: '',
            baseBranch: undefined,
            userRequest: undefined,
        });
    });

    it('selected_optionがnullの場合は空文字を返す', () => {
        const stateValues = {
            repository: {
                value: {
                    type: 'static_select',
                    selected_option: null,
                },
            },
            branch: {
                value: { type: 'plain_text_input', value: 'test' },
            },
            pbi: {
                value: { type: 'plain_text_input', value: '1' },
            },
            base_branch: {
                value: { type: 'plain_text_input', value: null },
            },
            fix_description: {
                value: { type: 'plain_text_input', value: null },
            },
        };

        const result: ModalValues = parseModalValues(stateValues);
        expect(result.folder).toBe('');
    });
});
