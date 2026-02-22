import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createServer,
    handleAskHuman,
} from './mcp-servers/slack-human-interaction/index.js';

describe('handleAskHuman', () => {
    let originalChannel: string | undefined;
    let originalThreadTs: string | undefined;

    beforeEach(() => {
        originalChannel = process.env.SLACK_CHANNEL;
        originalThreadTs = process.env.SLACK_THREAD_TS;
    });

    afterEach(() => {
        if (originalChannel !== undefined) {
            process.env.SLACK_CHANNEL = originalChannel;
        } else {
            delete process.env.SLACK_CHANNEL;
        }
        if (originalThreadTs !== undefined) {
            process.env.SLACK_THREAD_TS = originalThreadTs;
        } else {
            delete process.env.SLACK_THREAD_TS;
        }
    });

    it('Slack未設定の場合はエラーを返す', async () => {
        const result = await handleAskHuman('テスト質問', null, {
            channel: '',
            threadTs: '',
        });

        expect(result.content[0].text).toContain('Slack未設定');
        expect(result.isError).toBe(true);
    });

    it('環境変数からチャンネル・スレッド情報を取得できる', async () => {
        process.env.SLACK_CHANNEL = 'C_ENV_TEST';
        process.env.SLACK_THREAD_TS = '9999.0000';

        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: 'はい', user: 'U123' });

        const result = await handleAskHuman('質問です', null, {
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        expect(mockPost).toHaveBeenCalledWith(
            'C_ENV_TEST',
            expect.any(String),
            '9999.0000',
        );
        expect(result.content[0].text).toBe('はい');
    });

    it('質問をSlackに投稿し、ユーザーの回答を返す', async () => {
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi.fn().mockResolvedValue({
            text: 'パターンAでお願いします',
            user: 'U123',
        });

        const result = await handleAskHuman(
            'どちらのパターンで実装しますか？',
            'A: シンプル、B: 高機能',
            {
                channel: 'C123456',
                threadTs: '1234.5678',
                postFn: mockPost,
                waitReplyFn: mockWaitReply,
            },
        );

        expect(result.content[0].text).toBe('パターンAでお願いします');

        // 投稿メッセージに質問内容が含まれることを検証
        const postedMessage = mockPost.mock.calls[0][1];
        expect(postedMessage).toContain('どちらのパターンで実装しますか？');
        expect(postedMessage).toContain('A: シンプル、B: 高機能');
    });

    it('質問メッセージにquestionとcontextが含まれる', async () => {
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: 'OK', user: 'U123' });

        await handleAskHuman(
            'DBスキーマを変更してよいですか？',
            '既存テーブルのカラム追加が必要です',
            {
                channel: 'C123456',
                threadTs: '1234.5678',
                postFn: mockPost,
                waitReplyFn: mockWaitReply,
            },
        );

        const postedMessage = mockPost.mock.calls[0][1];
        expect(postedMessage).toContain('DBスキーマを変更してよいですか？');
        expect(postedMessage).toContain('既存テーブルのカラム追加が必要です');
        expect(postedMessage).toContain('Claude Codeからの質問');
    });

    it('ownerSlackMemberIdが指定されている場合メンションが含まれる', async () => {
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: 'OK', user: 'U123' });

        await handleAskHuman('質問です', null, {
            channel: 'C123456',
            threadTs: '1234.5678',
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
            ownerSlackMemberId: 'U99999999',
        });

        const postedMessage = mockPost.mock.calls[0][1];
        expect(postedMessage).toContain('<@U99999999>');
        expect(postedMessage).toContain('Claude Codeからの質問');
    });

    it('ownerSlackMemberIdが未指定の場合メンションが含まれない', async () => {
        const originalOwner = process.env.OWNER_SLACK_MEMBER_ID;
        delete process.env.OWNER_SLACK_MEMBER_ID;

        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: 'OK', user: 'U123' });

        await handleAskHuman('質問です', null, {
            channel: 'C123456',
            threadTs: '1234.5678',
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        const postedMessage = mockPost.mock.calls[0][1];
        expect(postedMessage).not.toContain('<@');
        expect(postedMessage).toMatch(/^❓/);

        if (originalOwner !== undefined) {
            process.env.OWNER_SLACK_MEMBER_ID = originalOwner;
        }
    });

    it('contextが省略されても動作する', async () => {
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: 'はい', user: 'U123' });

        const result = await handleAskHuman('進めてよいですか？', undefined, {
            channel: 'C123456',
            threadTs: '1234.5678',
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        const postedMessage = mockPost.mock.calls[0][1];
        expect(postedMessage).toContain('進めてよいですか？');
        expect(postedMessage).not.toContain('背景・補足');
        expect(result.content[0].text).toBe('はい');
    });

    it('Slack投稿失敗時はエラーを返す', async () => {
        const mockPost = vi.fn().mockResolvedValue(null);

        const result = await handleAskHuman('質問', null, {
            channel: 'C123456',
            threadTs: '1234.5678',
            postFn: mockPost,
        });

        expect(result.content[0].text).toContain('送信に失敗');
        expect(result.isError).toBe(true);
    });

    it('タイムアウト時はタイムアウトメッセージを返す（isErrorなし）', async () => {
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi.fn().mockResolvedValue(null);

        const result = await handleAskHuman('質問', null, {
            channel: 'C123456',
            threadTs: '1234.5678',
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
            timeoutMs: 100,
        });

        expect(result.content[0].text).toContain('タイムアウト');
        expect(result.isError).toBeUndefined();
    });

    it('waitReplyFnにtimeoutMsが渡される', async () => {
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: 'OK', user: 'U123' });

        await handleAskHuman('質問', null, {
            channel: 'C123456',
            threadTs: '1234.5678',
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
            timeoutMs: 60_000,
        });

        // waitReplyFnの引数を検証
        expect(mockWaitReply).toHaveBeenCalledWith(
            'C123456',
            '1234.5678',
            '1234.5680',
            { timeoutMs: 60_000 },
        );
    });

    it('スレッドTsを正しく指定してSlackに投稿する', async () => {
        const mockPost = vi.fn().mockResolvedValue('1234.5690');
        const mockWaitReply = vi
            .fn()
            .mockResolvedValue({ text: '了解', user: 'U123' });

        await handleAskHuman('テスト', null, {
            channel: 'C999',
            threadTs: '1234.5678',
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        // postFnの引数: (channel, message, threadTs)
        expect(mockPost).toHaveBeenCalledWith(
            'C999',
            expect.any(String),
            '1234.5678',
        );
    });

    it('空の質問文字列の場合はエラーを返す', async () => {
        const result = await handleAskHuman('', null, {
            channel: 'C123456',
            threadTs: '1234.5678',
        });

        expect(result.content[0].text).toContain('質問内容が空です');
        expect(result.isError).toBe(true);
    });

    it('空白のみの質問文字列の場合はエラーを返す', async () => {
        const result = await handleAskHuman('   ', null, {
            channel: 'C123456',
            threadTs: '1234.5678',
        });

        expect(result.content[0].text).toContain('質問内容が空です');
        expect(result.isError).toBe(true);
    });

    it('questionがnullの場合はエラーを返す', async () => {
        const result = await handleAskHuman(null, null, {
            channel: 'C123456',
            threadTs: '1234.5678',
        });

        expect(result.content[0].text).toContain('質問内容が空です');
        expect(result.isError).toBe(true);
    });

    it('postFnが例外をスローした場合はエラーを返す', async () => {
        const mockPost = vi.fn().mockRejectedValue(new Error('Network error'));

        const result = await handleAskHuman('質問です', null, {
            channel: 'C123456',
            threadTs: '1234.5678',
            postFn: mockPost,
        });

        expect(result.content[0].text).toContain('例外が発生しました');
        expect(result.content[0].text).toContain('Network error');
        expect(result.isError).toBe(true);
    });

    it('waitReplyFnが例外をスローした場合はエラーを返す', async () => {
        const mockPost = vi.fn().mockResolvedValue('1234.5680');
        const mockWaitReply = vi
            .fn()
            .mockRejectedValue(new Error('Connection lost'));

        const result = await handleAskHuman('質問です', null, {
            channel: 'C123456',
            threadTs: '1234.5678',
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        expect(result.content[0].text).toContain('例外が発生しました');
        expect(result.content[0].text).toContain('Connection lost');
        expect(result.isError).toBe(true);
    });
});

describe('createServer', () => {
    it('サーバーインスタンスを作成できる', () => {
        const server = createServer();
        expect(server).toBeDefined();
    });

    it('依存性を注入してサーバーを作成できる', () => {
        const mockPost = vi.fn();
        const mockWaitReply = vi.fn();

        const server = createServer({
            channel: 'C123456',
            threadTs: '1234.5678',
            postFn: mockPost,
            waitReplyFn: mockWaitReply,
        });

        expect(server).toBeDefined();
    });
});
