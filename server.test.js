import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { app, parseInput, notifySlack } from './server.js';

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

describe('POST /do エンドポイント', () => {
    let server;
    const TEST_PORT = 3001;

    beforeAll(() => {
        return new Promise((resolve) => {
            server = app.listen(TEST_PORT, () => {
                resolve();
            });
        });
    });

    afterAll(() => {
        return new Promise((resolve) => {
            server.close(() => {
                resolve();
            });
        });
    });

    it('text なしで 400 を返す', async () => {
        const response = await fetch(`http://localhost:${TEST_PORT}/do`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain('指示（フォルダ名と課題キー）を入力してください');
    });

    it('課題キーなしで 400 を返す', async () => {
        const response = await fetch(`http://localhost:${TEST_PORT}/do`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'circus_backend' })
        });

        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain('課題キー（例: PROJ-123）が不足しています');
    });

    it('正常入力で 200 とレスポンス文言を返す', async () => {
        const response = await fetch(`http://localhost:${TEST_PORT}/do`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'circus_backend PROJ-123' })
        });

        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain('circus_backend');
        expect(text).toContain('課題 PROJ-123 の対応を開始しました');
    });
});

describe('notifySlack', () => {
    it('正常系: fetch が呼ばれる', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200
        });
        vi.stubGlobal('fetch', mockFetch);

        await notifySlack('https://hooks.slack.com/test', 'テストメッセージ');

        expect(mockFetch).toHaveBeenCalledWith(
            'https://hooks.slack.com/test',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'テストメッセージ' })
            }
        );

        vi.unstubAllGlobals();
    });

    it('異常系: fetch が失敗してもクラッシュしない', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('ネットワークエラー'));
        vi.stubGlobal('fetch', mockFetch);

        // エラーがスローされないことを確認
        await expect(notifySlack('https://hooks.slack.com/test', 'テストメッセージ')).resolves.toBeUndefined();

        vi.unstubAllGlobals();
    });
});
