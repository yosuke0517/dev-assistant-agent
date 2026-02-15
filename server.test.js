import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseInput, processStreamEvent, ProgressTracker } from './server.js';

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
        const tracker = new ProgressTracker(null, 'TEST-1');

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

    it('responseUrlがない場合タイマーは開始しない', () => {
        const tracker = new ProgressTracker(null, 'TEST-1');
        tracker.start();
        expect(tracker.timer).toBeNull();
        tracker.stop();
    });

    it('アクティビティが蓄積される', () => {
        const tracker = new ProgressTracker('https://hooks.slack.com/test', 'TEST-1');
        tracker.addActivity('💬 テスト1');
        tracker.addActivity('🔧 テスト2');
        expect(tracker.activities).toHaveLength(2);
        tracker.stop();
    });

    it('flushでアクティビティがリセットされる', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true });

        const tracker = new ProgressTracker('https://hooks.slack.com/test', 'TEST-1', 60_000, mockFetch);
        tracker.addActivity('💬 テスト');
        await tracker._flush();

        expect(tracker.activities).toHaveLength(0);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // 送信内容を確認
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.text).toContain('TEST-1');
        expect(body.text).toContain('テスト');

        tracker.stop();
    });

    it('アクティビティが空の場合flushしない', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true });

        const tracker = new ProgressTracker('https://hooks.slack.com/test', 'TEST-1', 60_000, mockFetch);
        await tracker._flush();

        expect(mockFetch).not.toHaveBeenCalled();
        tracker.stop();
    });

    it('最大10件に制限される', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true });

        const tracker = new ProgressTracker('https://hooks.slack.com/test', 'TEST-1', 60_000, mockFetch);
        for (let i = 0; i < 15; i++) {
            tracker.addActivity(`アクティビティ ${i}`);
        }
        await tracker._flush();

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        // 直近10件のみ（5〜14）
        expect(body.text).toContain('アクティビティ 5');
        expect(body.text).toContain('アクティビティ 14');
        expect(body.text).not.toContain('アクティビティ 4');

        tracker.stop();
    });

    it('fetch失敗でもクラッシュしない', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const tracker = new ProgressTracker('https://hooks.slack.com/test', 'TEST-1', 60_000, mockFetch);
        tracker.addActivity('テスト');
        await expect(tracker._flush()).resolves.toBeUndefined();

        consoleSpy.mockRestore();
        tracker.stop();
    });
});
