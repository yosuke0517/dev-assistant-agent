/**
 * モード関連のロジック
 * モーダルUIブロック、表示ラベル生成など
 */

/**
 * エージェントモードの型定義
 */
export type AgentMode = 'implement' | 'review' | 'review-fix' | 'research';

/**
 * /do モーダルのモード選択ブロックを生成する
 */
export function buildReviewModeBlock(): Record<string, unknown> {
    return {
        type: 'input',
        block_id: 'review_mode',
        label: {
            type: 'plain_text',
            text: 'モード',
        },
        element: {
            type: 'static_select',
            action_id: 'value',
            placeholder: {
                type: 'plain_text',
                text: 'モードを選択',
            },
            initial_option: {
                text: { type: 'plain_text', text: '実装' },
                value: 'implement',
            },
            options: [
                {
                    text: { type: 'plain_text', text: '実装' },
                    value: 'implement',
                },
                {
                    text: {
                        type: 'plain_text',
                        text: 'PRレビュー',
                    },
                    value: 'review',
                },
                {
                    text: {
                        type: 'plain_text',
                        text: 'PRレビューFB対応',
                    },
                    value: 'review-fix',
                },
                {
                    text: {
                        type: 'plain_text',
                        text: '調査（リサーチ）',
                    },
                    value: 'research',
                },
            ],
        },
        optional: true,
    };
}

/**
 * モードに応じた表示ラベルを返す
 */
export interface ReviewModeDisplay {
    modeLabel: string;
    modeEmoji: string;
    modeText: string;
}

export function getReviewModeDisplay(mode: AgentMode): ReviewModeDisplay {
    switch (mode) {
        case 'review':
            return {
                modeLabel: 'PRレビュー',
                modeEmoji: '🔍',
                modeText: 'PRレビュー',
            };
        case 'review-fix':
            return {
                modeLabel: 'PRレビューFB対応',
                modeEmoji: '🔧',
                modeText: 'レビューFB対応',
            };
        case 'research':
            return {
                modeLabel: '調査（リサーチ）',
                modeEmoji: '🔬',
                modeText: '調査',
            };
        default:
            return {
                modeLabel: '実行',
                modeEmoji: '🚀',
                modeText: '対応',
            };
    }
}

/**
 * Slackモーダルの state values から mode を解析する
 */
export function parseReviewMode(
    stateValues: Record<
        string,
        Record<
            string,
            {
                selected_option?: { value: string } | null;
            }
        >
    >,
): AgentMode {
    const modeValue =
        stateValues.review_mode?.value?.selected_option?.value ?? 'implement';
    if (
        modeValue === 'review' ||
        modeValue === 'review-fix' ||
        modeValue === 'research'
    ) {
        return modeValue;
    }
    return 'implement';
}
