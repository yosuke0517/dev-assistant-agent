import 'dotenv/config';
import { execFile } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import express, { type Request, type Response } from 'express';
import fetch from 'node-fetch';
import pty from 'node-pty';
import {
    type AgentMode,
    buildReviewModeBlock,
    getReviewModeDisplay,
    parseReviewMode,
    type ReviewModeDisplay,
} from './lib/review-mode.js';
import {
    type FetchFn,
    formatMention,
    postToSlack,
    type RetryOptions,
    type SlackReply,
    type WaitForSlackReplyOptions,
    waitForSlackReply,
} from './lib/slack.js';
import { captureRawBody, verifySlackSignature } from './lib/slack-signature.js';

export { formatMention, postToSlack, waitForSlackReply };
export { buildReviewModeBlock, getReviewModeDisplay, parseReviewMode };
export { captureRawBody, verifySlackSignature };
export type {
    AgentMode,
    FetchFn,
    RetryOptions,
    SlackReply,
    WaitForSlackReplyOptions,
    ReviewModeDisplay,
};

export interface RepoConfig {
    displayName: string;
    isGitHub: boolean;
}

/**
 * フォルダ名（エイリアス）からリポジトリ設定を返す
 * GitHub Issuesを使うリポジトリと、Backlogを使うリポジトリを区別する
 */
export function getRepoConfig(folder: string): RepoConfig {
    switch (folder) {
        case 'agent':
            return { displayName: 'dev-assistant-agent', isGitHub: true };
        case 'jjp':
            return { displayName: 'jjp-loadsheet', isGitHub: true };
        default:
            return { displayName: folder, isGitHub: false };
    }
}

type PostFn = typeof postToSlack;

const app = express();
app.use(express.urlencoded({ extended: true, verify: captureRawBody }));
app.use(express.json({ verify: captureRawBody }));

export interface RelatedRepo {
    name: string;
    branch?: string;
}

interface ExtractRelatedResult {
    cleanedText: string;
    relatedRepos: RelatedRepo[];
}

/**
 * 入力テキストから --related オプションを抽出する
 * 例: "circus_agent_ecosystem RA_DEV-81 develop --related circus_backend:develop"
 * → { cleanedText: "circus_agent_ecosystem RA_DEV-81 develop", relatedRepos: [{ name: "circus_backend", branch: "develop" }] }
 */
export function extractRelatedRepos(text: string): ExtractRelatedResult {
    const relatedRepos: RelatedRepo[] = [];
    const cleaned = text.replace(
        /--related\s+(\S+)/g,
        (_, repoSpec: string) => {
            const colonIndex = repoSpec.indexOf(':');
            if (colonIndex === -1) {
                relatedRepos.push({ name: repoSpec });
            } else {
                relatedRepos.push({
                    name: repoSpec.substring(0, colonIndex),
                    branch: repoSpec.substring(colonIndex + 1),
                });
            }
            return '';
        },
    );
    return {
        cleanedText: cleaned.replace(/\s{2,}/g, ' ').trim(),
        relatedRepos,
    };
}

interface ParsedInput {
    folder: string;
    issueId: string | undefined;
    baseBranch: string | undefined;
    userRequest: string | undefined;
}

/**
 * 入力テキストをフォルダ名・課題ID・ベースブランチ・ユーザー要望に分割
 * 例: "circus_backend RA_DEV-81 develop" -> { folder, issueId, baseBranch }
 * 例: "circus_backend RA_DEV-85 feat/RA_DEV-85 CIでテスト時にエラーが出てるので修正してほしい"
 *   -> { folder, issueId, baseBranch, userRequest }
 */
export function parseInput(rawText: string): ParsedInput {
    const trimmed = rawText.trim();
    if (!trimmed) {
        return {
            folder: '',
            issueId: undefined,
            baseBranch: undefined,
            userRequest: undefined,
        };
    }

    const delimiterPattern = /[,、 ]+/;
    const parts: string[] = [];
    let remaining = trimmed;

    for (let i = 0; i < 3 && remaining; i++) {
        const match = remaining.match(delimiterPattern);
        if (match && match.index !== undefined) {
            parts.push(remaining.substring(0, match.index));
            remaining = remaining.substring(match.index + match[0].length);
        } else {
            parts.push(remaining);
            remaining = '';
            break;
        }
    }

    // "undefined" 文字列はフロントエンド等で値未設定時に渡されることがあるため除外
    const rawBranch = parts[2];
    const baseBranch =
        rawBranch && rawBranch !== 'undefined' ? rawBranch : undefined;

    return {
        folder: parts[0],
        issueId: parts[1],
        baseBranch,
        userRequest: remaining || undefined,
    };
}

/**
 * /do コマンドのモーダルビュー定義を構築する
 * private_metadata にチャンネルIDを含めて、Submitハンドラで取得できるようにする
 */
/**
 * TARGET_REPOSITORIES 環境変数からリポジトリ選択肢を生成する
 * 形式: "repo1,repo2,repo3"
 */
export function buildRepoOptions(): Array<{
    text: { type: 'plain_text'; text: string };
    value: string;
}> {
    const envValue = process.env.TARGET_REPOSITORIES;
    if (!envValue) {
        throw new Error(
            'TARGET_REPOSITORIES 環境変数が設定されていません。カンマ区切りでリポジトリ名を指定してください。',
        );
    }
    return envValue
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
        .map((name) => ({
            text: { type: 'plain_text' as const, text: name },
            value: name,
        }));
}

export function buildDoModalView(channelId: string): Record<string, unknown> {
    return {
        type: 'modal',
        callback_id: 'do_modal',
        private_metadata: JSON.stringify({ channel_id: channelId }),
        title: { type: 'plain_text', text: 'エージェントに指示' },
        submit: { type: 'plain_text', text: '実行' },
        close: { type: 'plain_text', text: 'キャンセル' },
        blocks: [
            {
                type: 'input',
                block_id: 'repository',
                label: {
                    type: 'plain_text',
                    text: 'リポジトリ（複数選択可）',
                },
                element: {
                    type: 'multi_static_select',
                    action_id: 'value',
                    placeholder: {
                        type: 'plain_text',
                        text: 'リポジトリを選択',
                    },
                    options: buildRepoOptions(),
                },
            },
            {
                type: 'input',
                block_id: 'pbi',
                label: { type: 'plain_text', text: 'PBI番号' },
                element: { type: 'plain_text_input', action_id: 'value' },
            },
            {
                type: 'input',
                block_id: 'base_branch',
                label: { type: 'plain_text', text: 'ベースブランチ' },
                element: { type: 'plain_text_input', action_id: 'value' },
                optional: true,
            },
            {
                type: 'input',
                block_id: 'fix_description',
                label: { type: 'plain_text', text: '指示内容' },
                element: {
                    type: 'plain_text_input',
                    action_id: 'value',
                    multiline: true,
                },
                optional: true,
            },
            buildReviewModeBlock(),
        ],
    };
}

/**
 * Slack views.open APIを呼び出してモーダルを開く
 */
export async function openModal(
    triggerId: string,
    channelId: string,
    fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<boolean> {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
        console.error('SLACK_BOT_TOKEN 未設定');
        return false;
    }

    try {
        const res = await fetchFn('https://slack.com/api/views.open', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                trigger_id: triggerId,
                view: buildDoModalView(channelId),
            }),
        });
        const data = await res.json();
        if (!data.ok) {
            console.error('views.open API エラー:', data.error);
            return false;
        }
        return true;
    } catch (err: unknown) {
        console.error('views.open 送信エラー:', (err as Error).message);
        return false;
    }
}

/**
 * Slackモーダルのview_submissionペイロードから入力値を抽出する
 */
export interface ModalValues {
    folders: string[];
    branchName: string;
    issueId: string;
    baseBranch: string | undefined;
    userRequest: string | undefined;
    reviewMode: AgentMode;
}

interface SlackViewStateValues {
    [blockId: string]: {
        [actionId: string]: {
            type: string;
            value?: string | null;
            selected_option?: { value: string } | null;
            selected_options?: { value: string }[] | null;
        };
    };
}

export function parseModalValues(
    stateValues: SlackViewStateValues,
): ModalValues {
    // multi_static_select は selected_options を返す
    const selectedOptions =
        stateValues.repository?.value?.selected_options ?? [];
    const folders = selectedOptions.map((opt) => opt.value);
    const branchName = stateValues.branch?.value?.value ?? '';
    const issueId = stateValues.pbi?.value?.value ?? '';
    const baseBranch = stateValues.base_branch?.value?.value || undefined;
    const userRequest = stateValues.fix_description?.value?.value || undefined;
    const reviewMode = parseReviewMode(stateValues);

    return {
        folders,
        branchName,
        issueId,
        baseBranch,
        userRequest,
        reviewMode,
    };
}

function timestamp(): string {
    return `[${new Date().toLocaleString()}]`;
}

interface StreamEventBase {
    type: string;
    [key: string]: unknown;
}

interface ContentBlock {
    type: string;
    text?: string;
    name?: string;
    input?: Record<string, unknown>;
    content?: string | unknown[];
    is_error?: boolean;
    tool_use_id?: string;
}

interface StreamMessage {
    content?: ContentBlock[];
}

interface StreamEvent extends StreamEventBase {
    session_id?: string;
    tools?: string[];
    message?: StreamMessage;
    cost_usd?: number;
    num_turns?: number;
    duration_ms?: number;
    result?: string;
    subtype?: string;
}

/**
 * stream-json形式のイベントをパースしてログ出力する
 */
export function processStreamEvent(
    line: string,
    tracker: ProgressTracker | null = null,
): StreamEvent | { type: 'raw'; text: string } {
    let event: StreamEvent;
    try {
        event = JSON.parse(line);
    } catch {
        // stealth-run.shのechoなどJSON以外の行はそのまま出力
        if (line.trim()) console.log(line);
        return { type: 'raw', text: line };
    }

    switch (event.type) {
        case 'system':
            console.log(
                `${timestamp()} 📡 セッション開始 (session: ${event.session_id})`,
            );
            if (event.tools) {
                console.log(`  利用可能ツール: ${event.tools.join(', ')}`);
            }
            tracker?.addActivity('📡 セッション開始');
            break;

        case 'assistant': {
            const blocks = event.message?.content || [];
            for (const block of blocks) {
                if (block.type === 'text' && block.text) {
                    const preview =
                        block.text.substring(0, 300) +
                        (block.text.length > 300 ? '...' : '');
                    console.log(`${timestamp()} 💬 Claude: ${preview}`);
                    tracker?.addActivity(
                        `💬 ${block.text.substring(0, 100)}${block.text.length > 100 ? '...' : ''}`,
                    );
                } else if (block.type === 'tool_use') {
                    const inputSummary = summarizeToolInput(
                        block.name ?? '',
                        block.input,
                    );
                    console.log(
                        `${timestamp()} 🔧 ツール実行: ${block.name} ${inputSummary}`,
                    );
                    tracker?.addActivity(
                        `🔧 ${block.name} ${inputSummary}`.substring(0, 120),
                    );
                }
            }
            break;
        }

        case 'user': {
            const results = event.message?.content || [];
            for (const block of results) {
                if (block.type === 'tool_result') {
                    const content =
                        typeof block.content === 'string'
                            ? block.content
                            : JSON.stringify(block.content);
                    const preview = content?.substring(0, 200) || '';
                    const isError = block.is_error;
                    console.log(
                        `${timestamp()} ${isError ? '❌' : '📋'} ツール結果: ${preview}${content?.length > 200 ? '...' : ''}`,
                    );
                    if (isError)
                        tracker?.addActivity(
                            `❌ エラー: ${content?.substring(0, 80)}`,
                        );
                }
            }
            break;
        }

        case 'result':
            console.log(
                `${timestamp()} ✅ 完了 (コスト: $${event.cost_usd?.toFixed(4) || '?'}, ターン数: ${event.num_turns || '?'}, 所要時間: ${((event.duration_ms || 0) / 1000).toFixed(1)}s)`,
            );
            if (event.result) {
                console.log(
                    `${timestamp()} 📝 最終結果: ${event.result.substring(0, 500)}${event.result.length > 500 ? '...' : ''}`,
                );
            }
            break;

        default:
            break;
    }

    return event;
}

/**
 * Slack進捗通知用のトラッカー
 * processStreamEventから呼ばれ、直近のアクティビティを蓄積する
 * 1分ごとのタイマーでSlackに送信し、バッファをリセット
 */
export class ProgressTracker {
    channel: string | null;
    issueId: string;
    threadTs: string | null;
    intervalMs: number;
    activities: string[];
    timer: ReturnType<typeof setInterval> | null;
    private _post: PostFn;

    constructor(
        channel: string | null,
        issueId: string,
        threadTs: string | null,
        intervalMs = 60_000,
        postFn: PostFn = postToSlack,
    ) {
        this.channel = channel;
        this.issueId = issueId;
        this.threadTs = threadTs;
        this.intervalMs = intervalMs;
        this.activities = [];
        this.timer = null;
        this._post = postFn;
    }

    start(): void {
        if (!this.channel) return;
        this.timer = setInterval(() => this._flush(), this.intervalMs);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** イベントから進捗メッセージを追加 */
    addActivity(message: string): void {
        this.activities.push(message);
    }

    async _flush(): Promise<void> {
        if (!this.channel || this.activities.length === 0) return;

        // 直近のアクティビティをまとめて送信（最大10件）
        const recent = this.activities.slice(-10);
        this.activities = [];

        const text = `⏳ *${this.issueId}* 進捗レポート\n${recent.map((a) => `• ${a}`).join('\n')}`;

        try {
            await this._post(this.channel, text, this.threadTs);
        } catch (err: unknown) {
            console.error('進捗通知の送信に失敗:', (err as Error).message);
        }
    }
}

interface InteractiveHandlerOptions {
    postFn?: PostFn;
    waitReplyFn?: typeof waitForSlackReply;
    timeoutMs?: number;
    originalCommand?: string;
    userRequest?: string;
}

interface UserDecision {
    action: 'retry' | 'abort';
    message: string;
}

/**
 * エラー発生時にSlackでユーザーに確認し、リトライ判定を行うハンドラー
 * processStreamEventと連携してエラーを自動検知する
 */
export class InteractiveHandler {
    channel: string | null;
    threadTs: string | null;
    originalCommand: string | undefined;
    userRequest: string | undefined;
    private _post: PostFn;
    private _waitReply: typeof waitForSlackReply;
    timeoutMs: number;

    constructor(
        channel: string | null,
        threadTs: string | null,
        options: InteractiveHandlerOptions = {},
    ) {
        this.channel = channel;
        this.threadTs = threadTs;
        this.originalCommand = options.originalCommand;
        this.userRequest = options.userRequest;
        this._post = options.postFn || postToSlack;
        this._waitReply = options.waitReplyFn || waitForSlackReply;
        this.timeoutMs = options.timeoutMs || 10_800_000;
    }

    /**
     * エラー発生時にSlackでユーザーに確認を送り、返信を待つ
     */
    async askUser(errorSummary: string): Promise<UserDecision> {
        if (!this.channel || !this.threadTs) {
            return {
                action: 'abort',
                message: 'Slackチャンネル/スレッド未設定',
            };
        }

        const mention = formatMention();
        const commandSection = this.originalCommand
            ? ['', '*実行コマンド:*', `\`/do ${this.originalCommand}\``, '']
            : [''];
        const userRequestSection = this.userRequest
            ? ['', '*指示内容:*', this.userRequest, '']
            : [];
        const question = [
            `${mention}⚠️ *エラーが発生しました*`,
            '```',
            errorSummary.substring(0, 500),
            '```',
            ...commandSection,
            ...userRequestSection,
            '続行方法を返信してください:',
            '• `retry` または `再実行` → 同じタスクを再実行',
            '• `abort` または `中断` → タスクを中断',
            '• その他のメッセージ → 指示内容をプロンプトに追加して再実行',
            '',
            `_${Math.floor(this.timeoutMs / 60_000)}分以内に返信がない場合は自動で中断します_`,
        ].join('\n');

        const questionTs = await this._post(
            this.channel,
            question,
            this.threadTs,
        );
        if (!questionTs) {
            return { action: 'abort', message: 'Slack送信失敗' };
        }

        console.log(`${timestamp()} 🔄 Slackでユーザーの返信を待機中...`);

        const reply = await this._waitReply(
            this.channel,
            this.threadTs,
            questionTs,
            {
                timeoutMs: this.timeoutMs,
            },
        );

        if (!reply) {
            return { action: 'abort', message: 'タイムアウト（返信なし）' };
        }

        const normalized = reply.text.trim().toLowerCase();
        if (normalized === 'abort' || normalized === '中断') {
            return { action: 'abort', message: reply.text };
        }
        // 'retry', '再実行', またはその他のメッセージは全てretryとして扱う
        return { action: 'retry', message: reply.text };
    }
}

interface FollowUpHandlerOptions {
    postFn?: PostFn;
    waitReplyFn?: typeof waitForSlackReply;
    timeoutMs?: number;
}

interface FollowUpDecision {
    action: 'follow_up' | 'end';
    message: string;
}

/**
 * タスク完了後にSlackスレッドでフォローアップ（追加依頼）を待つハンドラー
 */
export class FollowUpHandler {
    channel: string | null;
    threadTs: string | null;
    private _post: PostFn;
    private _waitReply: typeof waitForSlackReply;
    timeoutMs: number;

    constructor(
        channel: string | null,
        threadTs: string | null,
        options: FollowUpHandlerOptions = {},
    ) {
        this.channel = channel;
        this.threadTs = threadTs;
        this._post = options.postFn || postToSlack;
        this._waitReply = options.waitReplyFn || waitForSlackReply;
        this.timeoutMs = options.timeoutMs || 10_800_000;
    }

    /**
     * フォローアップの依頼をSlackスレッドで待機する
     */
    async waitForFollowUp(issueLabel: string): Promise<FollowUpDecision> {
        if (!this.channel || !this.threadTs) {
            return {
                action: 'end',
                message: 'Slackチャンネル/スレッド未設定',
            };
        }

        const mention = formatMention();
        const prompt = [
            `${mention}💡 *${issueLabel}* の対応が完了しました。質問や追加の依頼があればこのスレッドに返信してください。`,
            '',
            '• 質問や確認事項、修正・追加の依頼を自由に記述してください',
            '• `終了` または `end` → セッションを終了',
            '',
            `_${Math.floor(this.timeoutMs / 60_000)}分以内に返信がない場合は自動でセッションを終了します_`,
        ].join('\n');

        const questionTs = await this._post(
            this.channel,
            prompt,
            this.threadTs,
        );
        if (!questionTs) {
            return { action: 'end', message: 'Slack送信失敗' };
        }

        console.log(`${timestamp()} 💡 フォローアップの返信を待機中...`);

        const reply = await this._waitReply(
            this.channel,
            this.threadTs,
            questionTs,
            {
                timeoutMs: this.timeoutMs,
            },
        );

        if (!reply) {
            return { action: 'end', message: 'タイムアウト（返信なし）' };
        }

        const normalized = reply.text.trim().toLowerCase();
        if (normalized === '終了' || normalized === 'end') {
            return { action: 'end', message: reply.text };
        }

        return { action: 'follow_up', message: reply.text };
    }
}

function summarizeToolInput(
    toolName: string,
    input?: Record<string, unknown>,
): string {
    if (!input) return '';
    switch (toolName) {
        case 'Bash':
            return `> ${(input.command as string) || ''}`.substring(0, 150);
        case 'Read':
            return `📄 ${(input.file_path as string) || ''}`;
        case 'Edit':
            return `✏️ ${(input.file_path as string) || ''}`;
        case 'Write':
            return `📝 ${(input.file_path as string) || ''}`;
        case 'Glob':
            return `🔍 ${(input.pattern as string) || ''}`;
        case 'Grep':
            return `🔎 "${(input.pattern as string) || ''}" in ${(input.path as string) || '.'}`;
        case 'Task':
            return `🤖 ${(input.description as string) || ''}`;
        default:
            return JSON.stringify(input).substring(0, 100);
    }
}

interface SpawnWorkerResult {
    exitCode: number;
    output: string;
}

/**
 * Claude Codeワーカープロセスを起動し、完了を待つ
 */
export function spawnWorker(
    folder: string,
    issueId: string,
    tracker: ProgressTracker | null,
    extraPrompt: string | null = null,
    baseBranch: string | null = null,
    followUpMessage: string | null = null,
    userRequest: string | null = null,
    relatedRepos: RelatedRepo[] = [],
    branchName: string | null = null,
    reviewMode: AgentMode = 'implement',
): Promise<SpawnWorkerResult> {
    return new Promise((resolve) => {
        // Claude Code内から起動された場合のネスト検出を回避
        const childEnv = { ...process.env };
        delete childEnv.CLAUDECODE;
        delete childEnv.CLAUDE_CODE_SSE_PORT;
        delete childEnv.CLAUDE_CODE_ENTRYPOINT;

        const args = ['./stealth-run.sh', folder, issueId];
        if (baseBranch) args.push(baseBranch);
        if (extraPrompt) args.push(extraPrompt);

        // worktree パスを生成して stealth-run.sh に渡す
        const worktreeRepoName = getRepoConfig(folder).displayName;
        const worktreePath = `/tmp/finegate-worktrees/${worktreeRepoName}-${Date.now()}`;

        // PTY経由で起動（バッファリング防止のためTTYが必要）
        const worker = pty.spawn('/bin/zsh', args, {
            name: 'xterm-256color',
            cols: 200,
            rows: 50,
            cwd: process.cwd(),
            env: {
                ...childEnv,
                CI: 'true',
                FORCE_COLOR: '1',
                TERM: 'xterm-256color',
                WORKTREE_PATH: worktreePath,
                SLACK_CHANNEL: tracker?.channel || '',
                SLACK_THREAD_TS: tracker?.threadTs || '',
                ...(branchName && { BRANCH_NAME: branchName }),
                ...(followUpMessage && {
                    FOLLOW_UP_MESSAGE: followUpMessage,
                }),
                ...(userRequest && {
                    USER_REQUEST: userRequest,
                }),
                ...(relatedRepos.length > 0 && {
                    RELATED_REPOS: relatedRepos
                        .map(
                            (r) => `${r.name}${r.branch ? `:${r.branch}` : ''}`,
                        )
                        .join(','),
                }),
                ...(reviewMode === 'review' && { REVIEW_MODE: 'true' }),
                ...(reviewMode === 'review-fix' && {
                    REVIEW_FIX_MODE: 'true',
                }),
                ...(reviewMode === 'research' && {
                    RESEARCH_MODE: 'true',
                }),
            },
        });

        let output = '';
        let lineBuffer = '';

        // PTYからのstream-json(NDJSON)をリアルタイムでパース
        worker.onData((data: string) => {
            output += data;
            lineBuffer += data;

            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? ''; // 未完成の行はバッファに残す

            for (const line of lines) {
                // PTYのANSIエスケープシーケンスを除去してからパース
                const cleaned = line
                    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                    .replace(/\r/g, '')
                    .trim();
                if (!cleaned) continue;
                processStreamEvent(cleaned, tracker);
            }
        });

        worker.onExit(({ exitCode }: { exitCode: number }) => {
            // バッファに残った最後の行を処理
            if (lineBuffer.trim()) {
                const cleaned = lineBuffer
                    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                    .replace(/\r/g, '')
                    .trim();
                if (cleaned) processStreamEvent(cleaned, tracker);
            }

            resolve({ exitCode, output });
        });
    });
}

/**
 * 出力から最後のPR URLを抽出する
 * Claude Codeの出力には過去のPR URLが含まれる場合があるため、
 * 最後に出現するURLを返す（新しく作成されたPRが最後に出力されるため）
 */
export function extractLastPrUrl(output: string): string | null {
    const prUrlRegex =
        /https:\/\/(?:github\.com\/[^\s"]+\/pull\/\d+|[^\s"]+\.backlog\.(?:jp|com)\/[^\s"]+\/pullRequests\/\d+)/g;
    const matches = output.match(prUrlRegex);
    if (!matches || matches.length === 0) return null;
    return matches[matches.length - 1];
}

/**
 * stream-json出力からClaude Codeの最終結果テキストを抽出する
 * resultイベントのresultフィールドに最終的なテキスト出力が含まれる
 */
export function extractResultText(output: string): string | null {
    const cleaned = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const lines = cleaned.split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const event = JSON.parse(lines[i].trim()) as StreamEvent;
            if (
                event.type === 'result' &&
                event.subtype === 'success' &&
                event.result
            ) {
                return event.result;
            }
        } catch {
            // JSON以外の行は無視
        }
    }
    return null;
}

/**
 * 完了メッセージの結果部分を組み立てる
 * レビューモードではレポートをそのまま返し、
 * それ以外ではPR URLまたは結果テキストを返す
 */
export function buildResultMessage(
    output: string,
    reviewMode: AgentMode,
): string {
    const isReportMode = reviewMode === 'review' || reviewMode === 'research';
    const resultText = extractResultText(output);

    if (isReportMode && resultText) {
        const truncated =
            resultText.length > 3000
                ? `${resultText.substring(0, 3000)}...`
                : resultText;
        return `\n${truncated}`;
    }

    const prUrl = extractLastPrUrl(output);
    if (prUrl) {
        return `\nPRが作成されました: ${prUrl}`;
    }

    if (resultText) {
        const truncated =
            resultText.length > 1500
                ? `${resultText.substring(0, 1500)}...`
                : resultText;
        return `\n📝 実行結果:\n${truncated}`;
    }

    return '\nPRの作成を確認できませんでした。詳細はターミナルのログを確認してください。';
}

/** 出力からエラーサマリーを抽出する */
export function extractErrorSummary(output: string): string {
    // ANSIエスケープシーケンスを除去
    const cleaned = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    // stream-jsonからエラーイベントを探す
    const lines = cleaned.split('\n');
    const errors: string[] = [];

    for (const line of lines) {
        try {
            const event = JSON.parse(line.trim()) as StreamEvent;
            if (event.type === 'user' && event.message?.content) {
                for (const block of event.message.content) {
                    if (block.is_error && block.content) {
                        errors.push(block.content as string);
                    }
                }
            }
            // resultイベントのエラーも収集
            if (
                event.type === 'result' &&
                event.subtype === 'error_max_turns'
            ) {
                errors.push('最大ターン数に到達しました');
            }
            if (
                event.type === 'result' &&
                event.subtype !== 'success' &&
                event.result
            ) {
                errors.push(event.result);
            }
        } catch {
            // JSON以外の行でエラーっぽいものを拾う
            if (
                /error|Error|エラー|失敗/.test(line) &&
                line.trim().length > 5
            ) {
                errors.push(line.trim());
            }
        }
    }

    if (errors.length > 0) {
        return errors.slice(-5).join('\n');
    }
    return '原因不明のエラーで終了しました（ログを確認してください）';
}

/** Claude Codeの認証エラーかどうかを判定する */
export function isAuthenticationError(output: string): boolean {
    const cleaned = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    return /Not logged in.*Please run \/login/i.test(cleaned);
}

/** ユーザーの返信が肯定的かどうかを判定する */
export function isAffirmativeReply(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return [
        'はい',
        'yes',
        'y',
        'ok',
        'おk',
        'おけ',
        'いいよ',
        'うん',
        'する',
        '実行',
    ].some((word) => normalized === word || normalized.startsWith(word));
}

/**
 * `claude auth login` を実行して認証URLをキャプチャする
 * BROWSERを一時スクリプトに差し替えてURLをファイルに保存する
 */
export function captureAuthLoginUrl(
    options: {
        spawnFn?: typeof pty.spawn;
        urlFilePath?: string;
        timeoutMs?: number;
    } = {},
): Promise<{ url: string | null; exitCode: number }> {
    const {
        spawnFn = pty.spawn,
        urlFilePath = `/tmp/finegate-auth-url-${process.pid}.txt`,
        timeoutMs = 30_000,
    } = options;

    return new Promise((resolve) => {
        // BROWSER env を一時スクリプトに差し替え、URLをファイルに保存する
        const captureScript = `/tmp/finegate-capture-browser-${process.pid}.sh`;
        writeFileSync(
            captureScript,
            `#!/bin/bash\necho "$1" > "${urlFilePath}"\n`,
            { mode: 0o755 },
        );

        // claude auth login 起動（PTYでTTY必要）
        const childEnv = { ...process.env };
        delete childEnv.CLAUDECODE;
        delete childEnv.CLAUDE_CODE_SSE_PORT;
        delete childEnv.CLAUDE_CODE_ENTRYPOINT;
        childEnv.BROWSER = captureScript;

        const proc = spawnFn('/bin/zsh', ['-c', 'claude auth login'], {
            name: 'xterm-256color',
            cols: 120,
            rows: 30,
            cwd: process.cwd(),
            env: childEnv,
        });

        let output = '';
        let resolved = false;

        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                proc.kill();
                // タイムアウトでもURLファイルがあれば読み取る
                const url = readUrlFile(urlFilePath);
                cleanup(captureScript, urlFilePath);
                resolve({ url, exitCode: -1 });
            }
        }, timeoutMs);

        proc.onData((data: string) => {
            output += data;
            // 出力からもURLを探す（バックアップ）
            const match = output.match(
                /https:\/\/(?:console\.anthropic\.com|accounts\.anthropic\.com|claude\.ai)[^\s"')]+/,
            );
            if (match && !resolved) {
                // URLを発見したが、プロセスはコールバック待ちのため終了させない
                // ファイルにも書き込む（captureScriptがまだ動いていない可能性）
                try {
                    if (!existsSync(urlFilePath)) {
                        writeFileSync(urlFilePath, match[0]);
                    }
                } catch {
                    /* ignore */
                }
            }
        });

        proc.onExit(({ exitCode }: { exitCode: number }) => {
            clearTimeout(timeout);
            if (!resolved) {
                resolved = true;
                const url =
                    readUrlFile(urlFilePath) || extractUrlFromOutput(output);
                cleanup(captureScript, urlFilePath);
                resolve({ url, exitCode });
            }
        });
    });
}

function readUrlFile(filePath: string): string | null {
    try {
        if (existsSync(filePath)) {
            const content = readFileSync(filePath, 'utf-8').trim();
            return content || null;
        }
    } catch {
        /* ignore */
    }
    return null;
}

function extractUrlFromOutput(output: string): string | null {
    const match = output.match(
        /https:\/\/(?:console\.anthropic\.com|accounts\.anthropic\.com|claude\.ai)[^\s"')]+/,
    );
    return match ? match[0] : null;
}

function cleanup(...files: string[]): void {
    for (const f of files) {
        try {
            unlinkSync(f);
        } catch {
            /* ignore */
        }
    }
}

/**
 * `claude auth status` を実行して認証状態を確認する
 */
export function checkAuthStatus(
    execFn: typeof execFile = execFile,
): Promise<{ loggedIn: boolean; email?: string }> {
    return new Promise((resolve) => {
        execFn('claude', ['auth', 'status'], (error, stdout) => {
            if (error) {
                resolve({ loggedIn: false });
                return;
            }
            try {
                const status = JSON.parse(stdout);
                resolve({
                    loggedIn: !!status.loggedIn,
                    email: status.email,
                });
            } catch {
                resolve({ loggedIn: false });
            }
        });
    });
}

/** Playwright MCPのユーザーデータディレクトリ */
const PLAYWRIGHT_USER_DATA_DIR = '/tmp/finegate-playwright-data';

/**
 * Playwright MCPクライアントを起動して接続する
 */
export async function createPlaywrightClient(
    options: { headless?: boolean; userDataDir?: string } = {},
): Promise<Client> {
    const { headless = false, userDataDir = PLAYWRIGHT_USER_DATA_DIR } =
        options;

    if (!existsSync(userDataDir)) {
        mkdirSync(userDataDir, { recursive: true });
    }

    const args = [
        '@playwright/mcp',
        '--browser',
        'chrome',
        '--user-data-dir',
        userDataDir,
    ];
    if (headless) {
        args.push('--headless');
    }

    const transport = new StdioClientTransport({
        command: 'npx',
        args,
    });

    const client = new Client({
        name: 'finegate-login',
        version: '1.0.0',
    });

    await client.connect(transport);
    return client;
}

export interface LoginHandlerOptions {
    postFn?: PostFn;
    waitReplyFn?: typeof waitForSlackReply;
    timeoutMs?: number;
    captureAuthLoginUrlFn?: typeof captureAuthLoginUrl;
    checkAuthStatusFn?: typeof checkAuthStatus;
    createPlaywrightClientFn?: typeof createPlaywrightClient;
    sleepFn?: (ms: number) => Promise<void>;
}

/**
 * 認証エラー時のログインフローを処理する
 * 1. Slackでユーザーに/login実行の確認を取る
 * 2. claude auth loginを実行してURLをキャプチャ
 * 3. Playwright MCPでブラウザを操作して認証を完了
 * 4. 認証成功時にtrueを返す
 */
export class LoginHandler {
    channel: string;
    threadTs: string;
    private _post: PostFn;
    private _waitReply: typeof waitForSlackReply;
    private _captureAuthLoginUrl: typeof captureAuthLoginUrl;
    private _checkAuthStatus: typeof checkAuthStatus;
    private _createPlaywrightClient: typeof createPlaywrightClient;
    private _sleep: (ms: number) => Promise<void>;
    timeoutMs: number;

    constructor(
        channel: string,
        threadTs: string,
        options: LoginHandlerOptions = {},
    ) {
        this.channel = channel;
        this.threadTs = threadTs;
        this._post = options.postFn || postToSlack;
        this._waitReply = options.waitReplyFn || waitForSlackReply;
        this._captureAuthLoginUrl =
            options.captureAuthLoginUrlFn || captureAuthLoginUrl;
        this._checkAuthStatus = options.checkAuthStatusFn || checkAuthStatus;
        this._createPlaywrightClient =
            options.createPlaywrightClientFn || createPlaywrightClient;
        this._sleep =
            options.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.timeoutMs = options.timeoutMs || 180_000; // 3分
    }

    /**
     * ログインフロー全体を実行する
     */
    async execute(): Promise<boolean> {
        const mention = formatMention();

        // 1. ユーザーに確認
        const askTs = await this._post(
            this.channel,
            `${mention}🔐 *Claude Codeが未認証状態です*\n\`/login\` を実行しますか？（はい / いいえ）`,
            this.threadTs,
        );
        if (!askTs) return false;

        console.log(`${timestamp()} 🔐 Slackでログイン確認を待機中...`);
        const reply = await this._waitReply(
            this.channel,
            this.threadTs,
            askTs,
            { timeoutMs: 300_000 }, // 5分
        );

        if (!reply || !isAffirmativeReply(reply.text)) {
            await this._post(
                this.channel,
                '🔐 ログインをスキップしました。',
                this.threadTs,
            );
            return false;
        }

        await this._post(
            this.channel,
            '🔐 ログイン処理を開始します...',
            this.threadTs,
        );

        // 2. claude auth login を起動（バックグラウンドでコールバック待ち）
        // captureAuthLoginUrl は URL取得後もプロセスが生きている（コールバック待ち）
        // タイムアウトを長くしてブラウザ操作の時間を確保
        const authPromise = this._captureAuthLoginUrl({
            timeoutMs: this.timeoutMs,
        });

        // URLファイルが作られるまで少し待つ
        await this._sleep(3_000);

        // URLファイルを直接読む（プロセス終了前でもURLが取得できる）
        const urlFilePath = `/tmp/finegate-auth-url-${process.pid}.txt`;
        let authUrl = readUrlFile(urlFilePath);

        if (!authUrl) {
            // もう少し待ってからリトライ
            await this._sleep(5_000);
            authUrl = readUrlFile(urlFilePath);
        }

        if (!authUrl) {
            // authPromise が終了していればそこからURLを取得
            const result = await authPromise;
            authUrl = result.url;
        }

        if (!authUrl) {
            await this._post(
                this.channel,
                '❌ 認証URLの取得に失敗しました。サーバー上で手動で `claude auth login` を実行してください。',
                this.threadTs,
            );
            return false;
        }

        console.log(
            `${timestamp()} 🔐 認証URL取得: ${authUrl.substring(0, 80)}...`,
        );

        // 3. Playwright MCP でブラウザ操作
        let playwrightClient: Client | null = null;
        try {
            playwrightClient = await this._createPlaywrightClient();

            // ブラウザでAuth URLに遷移
            await playwrightClient.callTool({
                name: 'browser_navigate',
                arguments: { url: authUrl },
            });

            await this._post(
                this.channel,
                '🌐 ブラウザでAnthropicの認証ページを開きました...',
                this.threadTs,
            );

            // ページ読み込み待ち
            await this._sleep(5_000);

            // ページのスナップショットを取得して状態を判定
            const snapshot = await playwrightClient.callTool({
                name: 'browser_snapshot',
                arguments: {},
            });
            const pageContent =
                (snapshot.content as Array<{ text?: string }>)?.[0]?.text || '';

            // 自動ログイン（リフレッシュトークンで完了）の判定
            if (this._isLoginComplete(pageContent)) {
                console.log(
                    `${timestamp()} 🔐 リフレッシュトークンで自動ログイン完了`,
                );
                await this._post(
                    this.channel,
                    '✅ リフレッシュトークンで自動ログインが完了しました！',
                    this.threadTs,
                );

                // auth loginプロセスの完了を待つ
                await authPromise;
                return await this._verifyAuth();
            }

            // 手動ログインが必要（メール認証のみサポート）
            // セキュリティ上の理由から、パスワードや2FAコードのSlack経由受け渡しが
            // 必要なGoogle認証は廃止し、OTPベースのメール認証のみを使用する
            await this._post(
                this.channel,
                '🔐 *ログインページが表示されました*\nメール認証でログインを行います...',
                this.threadTs,
            );

            const loginSuccess = await this._handleEmailLogin(
                playwrightClient,
                pageContent,
            );

            if (loginSuccess) {
                // コールバック完了を待つ
                await this._sleep(5_000);
                await authPromise;
                return await this._verifyAuth();
            }

            return false;
        } catch (error) {
            console.error(`${timestamp()} 🔐 Playwrightログインエラー:`, error);
            await this._post(
                this.channel,
                `❌ ブラウザ操作でエラーが発生しました: ${(error as Error).message}\nサーバー上で手動で \`claude auth login\` を実行してください。`,
                this.threadTs,
            );
            return false;
        } finally {
            if (playwrightClient) {
                try {
                    await playwrightClient.callTool({
                        name: 'browser_close',
                        arguments: {},
                    });
                } catch {
                    /* ignore */
                }
                try {
                    await playwrightClient.close();
                } catch {
                    /* ignore */
                }
            }
        }
    }

    /** ページのスナップショットからログイン完了を判定 */
    private _isLoginComplete(pageContent: string): boolean {
        // ログインページのキーワードが存在しない = リダイレクト済み
        const loginPageKeywords = [
            'sign in',
            'log in',
            'ログイン',
            'email',
            'password',
            'google',
            'continue with',
        ];
        const hasLoginKeyword = loginPageKeywords.some((kw) =>
            pageContent.toLowerCase().includes(kw),
        );
        // ログインキーワードがない場合、認証済み（コールバックにリダイレクトされた）
        return !hasLoginKeyword;
    }

    /** メール認証フローをPlaywrightで処理 */
    private async _handleEmailLogin(
        client: Client,
        pageContent: string,
    ): Promise<boolean> {
        try {
            // メールボタンをクリック（ページにある場合）
            if (pageContent.toLowerCase().includes('email')) {
                try {
                    await client.callTool({
                        name: 'browser_click',
                        arguments: { element: 'Continue with email' },
                    });
                    await this._sleep(2_000);
                } catch {
                    /* ボタンがない場合はすでにメール入力画面 */
                }
            }

            // メールアドレスを聞く
            const emailTs = await this._post(
                this.channel,
                '🔐 メールアドレスを入力してください:',
                this.threadTs,
            );
            if (!emailTs) return false;

            const emailReply = await this._waitReply(
                this.channel,
                this.threadTs,
                emailTs,
                { timeoutMs: 120_000 },
            );
            if (!emailReply) return false;

            await client.callTool({
                name: 'browser_fill_form',
                arguments: {
                    values: [{ ref: 'email', value: emailReply.text.trim() }],
                },
            });

            // 送信ボタン
            await client.callTool({
                name: 'browser_click',
                arguments: { element: 'Continue' },
            });

            await this._sleep(3_000);

            // 確認コード入力（メール認証はOTPが一般的）
            const codeTs = await this._post(
                this.channel,
                '🔐 メールに送信された確認コードを入力してください:',
                this.threadTs,
            );
            if (!codeTs) return false;

            const codeReply = await this._waitReply(
                this.channel,
                this.threadTs,
                codeTs,
                { timeoutMs: 300_000 }, // 5分（メール確認に時間がかかる）
            );
            if (!codeReply) return false;

            await client.callTool({
                name: 'browser_fill_form',
                arguments: {
                    values: [{ ref: 'code', value: codeReply.text.trim() }],
                },
            });

            await client.callTool({
                name: 'browser_click',
                arguments: { element: 'Continue' },
            });

            await this._sleep(5_000);
            return true;
        } catch (error) {
            console.error(`${timestamp()} 🔐 メール認証エラー:`, error);
            await this._post(
                this.channel,
                `⚠️ メール認証中にエラーが発生しました: ${(error as Error).message}`,
                this.threadTs,
            );
            return false;
        }
    }

    /** 認証状態を最終確認 */
    private async _verifyAuth(): Promise<boolean> {
        const status = await this._checkAuthStatus();
        if (status.loggedIn) {
            console.log(
                `${timestamp()} ✅ 認証確認完了: ${status.email || 'unknown'}`,
            );
            return true;
        }
        await this._post(
            this.channel,
            '❌ ログインに失敗しました。サーバー上で手動で `claude auth login` を実行してください。',
            this.threadTs,
        );
        return false;
    }
}

/**
 * エージェントタスクのパラメータ
 */
export interface AgentTaskParams {
    folder: string;
    issueId: string;
    baseBranch?: string;
    userRequest?: string;
    branchName?: string;
    relatedRepos: RelatedRepo[];
    channelId: string;
    rawCommand?: string;
    reviewMode?: AgentMode;
}

/**
 * エージェントタスクを実行する（Slack通知・リトライ・フォローアップを含む）
 * /do モーダルのSubmitハンドラから呼び出される
 */
export async function startAgentTask(params: AgentTaskParams): Promise<void> {
    const {
        folder,
        issueId,
        baseBranch,
        userRequest,
        branchName,
        relatedRepos,
        channelId,
        rawCommand,
        reviewMode,
    } = params;

    const repoConfig = getRepoConfig(folder);
    const displayName = repoConfig.displayName;
    const issueLabel = repoConfig.isGitHub
        ? `GitHub Issue #${issueId}`
        : issueId;

    // 関連リポジトリの表示名リスト
    const relatedDisplayNames = relatedRepos.map(
        (r) => getRepoConfig(r.name).displayName,
    );
    const allRepoNames =
        relatedDisplayNames.length > 0
            ? `${displayName}, ${relatedDisplayNames.join(', ')}`
            : displayName;

    const { modeLabel, modeEmoji, modeText } = getReviewModeDisplay(
        reviewMode ?? 'implement',
    );
    console.log(
        `\n${timestamp()} 🚀 ${modeLabel}開始: ${allRepoNames}, ID: ${issueLabel}`,
    );

    // 1. 親メッセージを chat.postMessage で投稿 → ts (スレッドID) 取得
    const startMessage =
        relatedDisplayNames.length > 0
            ? `${modeEmoji} *${allRepoNames}* にて *${issueLabel}* の${modeText}を開始しました（複数リポジトリ）。\n進捗はこのスレッドでお知らせします。`
            : `${modeEmoji} *${displayName}* にて *${issueLabel}* の${modeText}を開始しました。\n進捗はこのスレッドでお知らせします。`;
    const parentTs = await postToSlack(channelId, startMessage);

    // 2. Slack進捗通知トラッカー（1分ごとにスレッドへ進捗を送信）
    const tracker = new ProgressTracker(channelId, issueId, parentTs);
    tracker.start();

    // 3. インタラクティブハンドラー（エラー時にSlackで確認）
    const interactive = new InteractiveHandler(channelId, parentTs, {
        originalCommand: rawCommand || undefined,
        userRequest: userRequest || undefined,
    });

    const MAX_RETRIES = 3;
    let attempt = 0;
    let lastExitCode = 0;
    let lastOutput = '';
    let extraPrompt: string | null = null;

    while (attempt < MAX_RETRIES) {
        attempt++;
        if (attempt > 1) {
            console.log(
                `\n${timestamp()} 🔄 リトライ実行 (${attempt}/${MAX_RETRIES})`,
            );
            await postToSlack(
                channelId,
                `🔄 *${issueLabel}* をリトライ実行します (${attempt}/${MAX_RETRIES})`,
                parentTs,
            );
        }

        const { exitCode, output } = await spawnWorker(
            folder,
            issueId,
            tracker,
            extraPrompt,
            baseBranch || null,
            null,
            userRequest || null,
            relatedRepos,
            branchName || null,
            reviewMode ?? 'implement',
        );
        lastExitCode = exitCode;
        lastOutput = output;

        if (exitCode !== 0 && output.trim() === '') {
            console.error(
                `⚠️ プロセスが出力なしで異常終了 (Exit Code: ${exitCode})。環境変数を確認してください。`,
            );
        }
        console.log(
            `\n${timestamp()} ${exitCode === 0 ? '✅' : '❌'} 実行完了 (Exit Code: ${exitCode})`,
        );

        // 正常終了ならループ終了
        if (exitCode === 0) break;

        // 認証エラーの場合: Slackで確認してPlaywright MCPでログイン試行
        if (isAuthenticationError(output)) {
            console.error(
                `${timestamp()} 🔐 Claude Codeが未認証状態です。ログインフローを開始します。`,
            );

            if (!parentTs) break;

            const loginHandler = new LoginHandler(channelId, parentTs);
            const loginSuccess = await loginHandler.execute();

            if (loginSuccess) {
                // ログイン成功: このリトライをカウントせずに再実行
                attempt--;
                console.log(
                    `${timestamp()} 🔐 ログイン成功。タスクを再実行します。`,
                );
                await postToSlack(
                    channelId,
                    '🔐 ログインに成功しました。タスクを再実行します。',
                    parentTs,
                );
                continue;
            }

            // ログイン失敗または拒否: 終了
            break;
        }

        // 最大リトライ回数に達した場合はループ終了
        if (attempt >= MAX_RETRIES) {
            console.log(
                `${timestamp()} ⛔ 最大リトライ回数 (${MAX_RETRIES}) に到達`,
            );
            break;
        }

        // 異常終了: Slackでユーザーに確認
        const errorSummary = extractErrorSummary(output);
        const decision = await interactive.askUser(errorSummary);

        if (decision.action === 'abort') {
            console.log(
                `${timestamp()} ⛔ ユーザーが中断を選択: ${decision.message}`,
            );
            await postToSlack(
                channelId,
                `⛔ ユーザーの指示により中断しました: ${decision.message}`,
                parentTs,
            );
            break;
        }

        // retry: ユーザーの追加指示があればプロンプトに含める
        const normalized = decision.message.trim().toLowerCase();
        if (normalized !== 'retry' && normalized !== '再実行') {
            extraPrompt = decision.message;
            console.log(
                `${timestamp()} 💡 ユーザーからの追加指示: ${decision.message}`,
            );
        } else {
            extraPrompt = null;
        }
    }

    // 4. タイマー停止
    tracker.stop();

    // 5. 完了メッセージをスレッドに投稿
    if (channelId && parentTs) {
        const resultMessage = buildResultMessage(
            lastOutput,
            reviewMode ?? 'implement',
        );
        const retryInfo = attempt > 1 ? ` (試行回数: ${attempt})` : '';

        try {
            const mention = formatMention();
            await postToSlack(
                channelId,
                `${mention}${lastExitCode === 0 ? '✅' : '❌'} *${issueLabel}* の${modeText}が${lastExitCode === 0 ? '完了' : '終了'}しました！ (Exit Code: ${lastExitCode})${retryInfo}${resultMessage}`,
                parentTs,
            );
        } catch (err) {
            console.error('Slackへの通知に失敗しました:', err);
        }
    }

    // 6. フォローアップループ: タスク成功後に追加依頼を待機
    if (lastExitCode === 0 && channelId && parentTs) {
        const followUpHandler = new FollowUpHandler(channelId, parentTs);
        const MAX_FOLLOW_UPS = 5;
        let followUpCount = 0;

        while (followUpCount < MAX_FOLLOW_UPS) {
            const decision = await followUpHandler.waitForFollowUp(issueLabel);

            if (decision.action === 'end') {
                console.log(
                    `${timestamp()} 📋 フォローアップセッション終了: ${decision.message}`,
                );
                if (
                    decision.message !== 'Slackチャンネル/スレッド未設定' &&
                    decision.message !== 'Slack送信失敗'
                ) {
                    await postToSlack(
                        channelId,
                        '📋 セッションを終了しました。お疲れ様でした！',
                        parentTs,
                    );
                }
                break;
            }

            followUpCount++;
            console.log(
                `${timestamp()} 📝 フォローアップ (${followUpCount}/${MAX_FOLLOW_UPS}): ${decision.message}`,
            );
            await postToSlack(
                channelId,
                `🔄 対応を開始します (${followUpCount}回目)\n> ${decision.message}`,
                parentTs,
            );

            // フォローアップワーカー起動
            tracker.start();

            const { exitCode: fuExitCode } = await spawnWorker(
                folder,
                issueId,
                tracker,
                null,
                baseBranch || null,
                decision.message,
                null,
                relatedRepos,
                branchName || null,
            );

            tracker.stop();

            console.log(
                `\n${timestamp()} ${fuExitCode === 0 ? '✅' : '❌'} フォローアップ完了 (Exit Code: ${fuExitCode})`,
            );

            const mention = formatMention();
            await postToSlack(
                channelId,
                `${mention}${fuExitCode === 0 ? '✅' : '❌'} 対応が${fuExitCode === 0 ? '完了' : '終了'}しました (Exit Code: ${fuExitCode})`,
                parentTs,
            );

            if (fuExitCode !== 0) {
                break;
            }
        }

        if (followUpCount >= MAX_FOLLOW_UPS) {
            await postToSlack(
                channelId,
                `📋 フォローアップの最大回数 (${MAX_FOLLOW_UPS}) に達したためセッションを終了します。`,
                parentTs,
            );
        }
    }
}

/**
 * /do スラッシュコマンドハンドラー
 * モーダルを開いてユーザー入力を受け付ける
 */
app.post('/do', verifySlackSignature(), async (req: Request, res: Response) => {
    const triggerId = req.body.trigger_id;
    const channelId = req.body.channel_id;

    if (!triggerId) {
        res.status(400).send(
            'trigger_id が必要です。Slackのスラッシュコマンドから実行してください。',
        );
        return;
    }

    // 即座にack（Slack 3秒ルール）
    res.send('');

    // モーダルを開く
    const success = await openModal(triggerId, channelId);
    if (!success) {
        console.error('モーダルの表示に失敗しました');
    }
});

/**
 * Slack Interactivity エンドポイント
 * モーダルのSubmit（view_submission）を受け取り、エージェントタスクを開始する
 */
app.post(
    '/slack/interactions',
    verifySlackSignature(),
    async (req: Request, res: Response) => {
        let payload: {
            type: string;
            view?: {
                callback_id?: string;
                private_metadata?: string;
                state?: { values: SlackViewStateValues };
            };
        };

        try {
            payload = JSON.parse(req.body.payload);
        } catch {
            res.status(400).send('Invalid payload');
            return;
        }

        if (
            payload.type !== 'view_submission' ||
            payload.view?.callback_id !== 'do_modal'
        ) {
            // 未知のインタラクションタイプはackだけして無視
            res.send('');
            return;
        }

        // モーダル送信を受信 → 即座にack（モーダルを閉じる）
        res.send('');

        const stateValues = payload.view.state?.values;
        if (!stateValues) return;

        const {
            folders,
            branchName,
            issueId,
            baseBranch,
            userRequest,
            reviewMode,
        } = parseModalValues(stateValues);

        let channelId: string;
        try {
            const metadata = JSON.parse(payload.view.private_metadata || '{}');
            channelId = metadata.channel_id;
        } catch {
            console.error('private_metadata のパースに失敗');
            return;
        }

        const primaryFolder = folders[0] ?? '';
        if (!channelId || !primaryFolder || !issueId) {
            console.error('必須フィールドが不足:', {
                channelId,
                folder: primaryFolder,
                issueId,
            });
            return;
        }

        // 2つ目以降のリポジトリは関連リポジトリとして扱う
        const relatedRepos: RelatedRepo[] = folders.slice(1).map((name) => ({
            name,
        }));

        const rawCommand = `${folders.join(', ')} ${issueId}${baseBranch ? ` ${baseBranch}` : ''}`;

        // エージェントタスクを非同期で開始
        startAgentTask({
            folder: primaryFolder,
            issueId,
            baseBranch,
            userRequest,
            branchName: branchName || undefined,
            relatedRepos,
            channelId,
            rawCommand,
            reviewMode,
        });
    },
);

const PORT = 8787;
app.listen(PORT, () => {
    console.log('----------------------------------------------------');
    console.log(`Finegate Agent Server running on port ${PORT}`);
    console.log('Slack設定:');
    console.log('  Slash Command URL: http://あなたのトンネルURL/do');
    console.log(
        '  Interactivity URL: http://あなたのトンネルURL/slack/interactions',
    );
    console.log('----------------------------------------------------');
});
