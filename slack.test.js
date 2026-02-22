import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForSlackReply } from './lib/slack.js';

describe('waitForSlackReply', () => {
    let originalToken;

    beforeEach(() => {
        originalToken = process.env.SLACK_BOT_TOKEN;
        process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    });

    afterEach(() => {
        if (originalToken !== undefined) {
            process.env.SLACK_BOT_TOKEN = originalToken;
        } else {
            delete process.env.SLACK_BOT_TOKEN;
        }
    });

    it('conversations.replies が ok:false を返した場合に console.error を呼ぶ', async () => {
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        const mockFetch = vi.fn().mockResolvedValue({
            json: async () => ({ ok: false, error: 'missing_scope' }),
        });

        const result = await waitForSlackReply(
            'C123',
            '1000.0000',
            '1000.0001',
            {
                intervalMs: 10,
                timeoutMs: 50,
                fetchFn: mockFetch,
            },
        );

        expect(result).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith(
            'Slack conversations.replies APIエラー:',
            'missing_scope',
            '(channel:',
            'C123',
            'ts:',
            '1000.0000',
            ')',
        );

        consoleSpy.mockRestore();
    });

    it('APIエラーが複数回発生しても console.error は1回だけ呼ばれる', async () => {
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        const mockFetch = vi.fn().mockResolvedValue({
            json: async () => ({ ok: false, error: 'missing_scope' }),
        });

        await waitForSlackReply('C123', '1000.0000', '1000.0001', {
            intervalMs: 10,
            timeoutMs: 80,
            fetchFn: mockFetch,
        });

        const apiErrorCalls = consoleSpy.mock.calls.filter(
            (args) => args[0] === 'Slack conversations.replies APIエラー:',
        );
        expect(apiErrorCalls).toHaveLength(1);

        consoleSpy.mockRestore();
    });

    it('APIエラー発生後のタイムアウトログにAPIエラーの旨が含まれる', async () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        const mockFetch = vi.fn().mockResolvedValue({
            json: async () => ({ ok: false, error: 'not_in_channel' }),
        });

        await waitForSlackReply('C123', '1000.0000', '1000.0001', {
            intervalMs: 10,
            timeoutMs: 50,
            fetchFn: mockFetch,
        });

        expect(logSpy).toHaveBeenCalledWith(
            expect.stringContaining('APIエラーが発生していたため'),
        );

        errorSpy.mockRestore();
        logSpy.mockRestore();
    });

    it('APIエラーなしのタイムアウトは通常のログを出力する', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // ok:true だが返信なし → タイムアウト
        const mockFetch = vi.fn().mockResolvedValue({
            json: async () => ({ ok: true, messages: [] }),
        });

        await waitForSlackReply('C123', '1000.0000', '1000.0001', {
            intervalMs: 10,
            timeoutMs: 50,
            fetchFn: mockFetch,
        });

        expect(logSpy).toHaveBeenCalledWith('Slack返信待ちタイムアウト');

        logSpy.mockRestore();
    });

    it('ユーザー返信が存在する場合は返信を返す', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            json: async () => ({
                ok: true,
                messages: [{ ts: '1000.0002', text: '了解です', user: 'U999' }],
            }),
        });

        const result = await waitForSlackReply(
            'C123',
            '1000.0000',
            '1000.0001',
            {
                intervalMs: 10,
                timeoutMs: 5000,
                fetchFn: mockFetch,
            },
        );

        expect(result).toEqual({ text: '了解です', user: 'U999' });
    });

    it('SLACK_BOT_TOKEN 未設定の場合は null を返す', async () => {
        delete process.env.SLACK_BOT_TOKEN;
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        const result = await waitForSlackReply(
            'C123',
            '1000.0000',
            '1000.0001',
        );

        expect(result).toBeNull();
        expect(consoleSpy).toHaveBeenCalledWith('SLACK_BOT_TOKEN 未設定');

        consoleSpy.mockRestore();
    });
});
