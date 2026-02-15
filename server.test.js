import { describe, it, expect, vi } from 'vitest';
import { parseInput, processStreamEvent } from './server.js';

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
});
