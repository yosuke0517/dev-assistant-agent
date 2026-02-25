import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('start-daemon.sh', () => {
    const scriptPath = path.join(__dirname, 'start-daemon.sh');

    it('スクリプトファイルが存在することを確認', () => {
        expect(fs.existsSync(scriptPath)).toBe(true);
    });

    it('実行権限が付与されていることを確認', () => {
        const stats = fs.statSync(scriptPath);
        // owner execute bit (0o100)
        const hasExecutePermission = (stats.mode & 0o111) !== 0;
        expect(hasExecutePermission).toBe(true);
    });

    it('shebang が正しいことを確認', () => {
        const content = fs.readFileSync(scriptPath, 'utf8');
        expect(content.startsWith('#!/bin/bash')).toBe(true);
    });

    it('caffeinate -s コマンドが含まれていることを確認', () => {
        const content = fs.readFileSync(scriptPath, 'utf8');
        expect(content).toContain('caffeinate -s');
    });

    it('--dev フラグで開発モードが起動できることを確認', () => {
        const content = fs.readFileSync(scriptPath, 'utf8');
        expect(content).toContain('--dev');
        expect(content).toContain('npm run dev');
    });

    it('本番モードで npm start が使用されることを確認', () => {
        const content = fs.readFileSync(scriptPath, 'utf8');
        expect(content).toContain('npm start');
    });
});

describe('launchd plist files', () => {
    const launchdDir = path.join(__dirname, 'launchd');

    it('サーバー用 plist が存在することを確認', () => {
        const plistPath = path.join(
            launchdDir,
            'com.finegate.dev-assistant-agent.plist',
        );
        expect(fs.existsSync(plistPath)).toBe(true);
    });

    it('cloudflared 用 plist が存在することを確認', () => {
        const plistPath = path.join(
            launchdDir,
            'com.finegate.cloudflared.plist',
        );
        expect(fs.existsSync(plistPath)).toBe(true);
    });

    it('サーバー plist に caffeinate が含まれていることを確認', () => {
        const plistPath = path.join(
            launchdDir,
            'com.finegate.dev-assistant-agent.plist',
        );
        const content = fs.readFileSync(plistPath, 'utf8');
        expect(content).toContain('caffeinate');
        expect(content).toContain('-s');
    });

    it('サーバー plist に KeepAlive が設定されていることを確認', () => {
        const plistPath = path.join(
            launchdDir,
            'com.finegate.dev-assistant-agent.plist',
        );
        const content = fs.readFileSync(plistPath, 'utf8');
        expect(content).toContain('<key>KeepAlive</key>');
        expect(content).toContain('<true/>');
    });

    it('cloudflared plist に KeepAlive が設定されていることを確認', () => {
        const plistPath = path.join(
            launchdDir,
            'com.finegate.cloudflared.plist',
        );
        const content = fs.readFileSync(plistPath, 'utf8');
        expect(content).toContain('<key>KeepAlive</key>');
        expect(content).toContain('<true/>');
    });

    it('plist ファイルが有効な XML であることを確認', () => {
        const plistFiles = [
            'com.finegate.dev-assistant-agent.plist',
            'com.finegate.cloudflared.plist',
        ];

        for (const file of plistFiles) {
            const plistPath = path.join(launchdDir, file);
            // plutil で XML 検証（macOS 標準コマンド）
            try {
                execSync(`plutil -lint "${plistPath}"`, {
                    encoding: 'utf8',
                    stdio: 'pipe',
                });
            } catch (error) {
                // plutil が存在しない環境（CI の Linux 等）ではスキップ
                if (error.message?.includes('command not found')) {
                    return;
                }
                throw new Error(`Invalid plist XML in ${file}: ${error}`);
            }
        }
    });
});
