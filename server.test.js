import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseInput, processStreamEvent, ProgressTracker, postToSlack } from './server.js';

describe('parseInput', () => {
    it('スペース区切りでパースできる', () => {
        const result = parseInput('circus_backend PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123'
        });
    });

    it('カンマ区切りでパースできる', () => {
        const result = parseInput('circus_backend,PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123'
        });
    });

    it('カンマ+スペース区切りでパースできる', () => {
        const result = parseInput('circus_backend, PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123'
        });
    });

    it('読点(、)区切りでパースできる', () => {
        const result = parseInput('circus_backend、PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123'
        });
    });

    it('複数の区切り文字が連続していても正しくパースできる', () => {
        const result = parseInput('circus_backend,  PROJ-123');
        expect(result).toEqual({
            folder: 'circus_backend',
            issueId: 'PROJ-123'
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
});

describe('processStreamEvent', () => {
    it('systemイベントをパースできる', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const line = JSON.stringify({
            type: 'system',
            subtype: 'init',
            session_id: 'test-session',
            tools: ['Bash', 'Read', 'Edit']
        });

        const result = processStreamEvent(line);

        expect(result.type).toBe('system');
        expect(result.session_id).toBe('test-session');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('セッション開始'));
        consoleSpy.mockRestore();
    });

    it('assistantのテキストイベントをパースできる', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const line = JSON.stringify({
            type: 'assistant',
            message: {
                content: [{ type: 'text', text: 'コードを分析します' }]
            }
        });

        const result = processStreamEvent(line);

        expect(result.type).toBe('assistant');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('コードを分析します'));
        consoleSpy.mockRestore();
    });

    it('assistantのツール使用イベントをパースできる', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const line = JSON.stringify({
            type: 'assistant',
            message: {
                content: [{
                    type: 'tool_use',
                    name: 'Bash',
                    input: { command: 'npm test' }
                }]
            }
        });

        const result = processStreamEvent(line);

        expect(result.type).toBe('assistant');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Bash'));
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('npm test'));
        consoleSpy.mockRestore();
    });

    it('resultイベントをパースできる', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const line = JSON.stringify({
            type: 'result',
            subtype: 'success',
            cost_usd: 0.0542,
            num_turns: 3,
            duration_ms: 12345,
            result: 'PRを作成しました'
        });

        const result = processStreamEvent(line);

        expect(result.type).toBe('result');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('$0.0542'));
        consoleSpy.mockRestore();
    });

    it('JSON以外の行はそのまま出力する', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const line = 'Claude Code starting for Backlog Issue: RA_DEV-81...';

        const result = processStreamEvent(line);

        expect(result.type).toBe('raw');
        expect(consoleSpy).toHaveBeenCalledWith(line);
        consoleSpy.mockRestore();
    });

    it('空行は無視する', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const result = processStreamEvent('   ');

        expect(result.type).toBe('raw');
        expect(consoleSpy).not.toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it('ツール結果のエラーを正しく表示する', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const line = JSON.stringify({
            type: 'user',
            message: {
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_123',
                    content: 'Error: file not found',
                    is_error: true
                }]
            }
        });

        const result = processStreamEvent(line);

        expect(result.type).toBe('user');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('❌'));
        consoleSpy.mockRestore();
    });

    it('trackerにアクティビティが記録される', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const tracker = new ProgressTracker(null, 'TEST-1', null);

        processStreamEvent(JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ファイルを確認します' }] }
        }), tracker);

        processStreamEvent(JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }
        }), tracker);

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

        const tracker = new ProgressTracker('C123456', 'TEST-1', '1234.5678', 60_000, mockPostFn);
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

        const tracker = new ProgressTracker('C123456', 'TEST-1', '1234.5678', 60_000, mockPostFn);
        await tracker._flush();

        expect(mockPostFn).not.toHaveBeenCalled();
        tracker.stop();
    });

    it('最大10件に制限される', async () => {
        const mockPostFn = vi.fn().mockResolvedValue('mock-ts');

        const tracker = new ProgressTracker('C123456', 'TEST-1', '1234.5678', 60_000, mockPostFn);
        for (let i = 0; i < 15; i++) {
            tracker.addActivity(`アクティビティ ${i}`);
        }
        await tracker._flush();

        const [channel, text, threadTs] = mockPostFn.mock.calls[0];
        // 直近10件のみ（5〜14）
        expect(text).toContain('アクティビティ 5');
        expect(text).toContain('アクティビティ 14');
        expect(text).not.toContain('アクティビティ 4');

        tracker.stop();
    });

    it('post失敗でもクラッシュしない', async () => {
        const mockPostFn = vi.fn().mockRejectedValue(new Error('network error'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const tracker = new ProgressTracker('C123456', 'TEST-1', '1234.5678', 60_000, mockPostFn);
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
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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
            json: vi.fn().mockResolvedValue({ ok: true, ts: '1234.5678' })
        });

        const result = await postToSlack('C123456', 'テストメッセージ', null, mockFetch);

        expect(result).toBe('1234.5678');
        expect(mockFetch).toHaveBeenCalledTimes(1);

        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('スレッド返信の場合thread_tsが含まれる', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

        const mockFetch = vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({ ok: true, ts: '1234.5679' })
        });

        const result = await postToSlack('C123456', 'スレッド返信', '1234.5678', mockFetch);

        expect(result).toBe('1234.5679');

        // リクエストボディを確認
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.thread_ts).toBe('1234.5678');

        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('Slack APIエラーの場合nullを返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const mockFetch = vi.fn().mockResolvedValue({
            json: vi.fn().mockResolvedValue({ ok: false, error: 'channel_not_found' })
        });

        const result = await postToSlack('C123456', 'テスト', null, mockFetch);

        expect(result).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith('Slack API エラー:', 'channel_not_found');

        consoleSpy.mockRestore();
        process.env.SLACK_BOT_TOKEN = originalToken;
    });

    it('ネットワークエラーの場合nullを返す', async () => {
        const originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

        const result = await postToSlack('C123456', 'テスト', null, mockFetch);

        expect(result).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith('Slack 送信エラー:', 'Network error');

        consoleSpy.mockRestore();
        process.env.SLACK_BOT_TOKEN = originalToken;
    });
});
