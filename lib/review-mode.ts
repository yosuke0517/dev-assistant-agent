/**
 * PRレビューモード関連のロジック
 * モーダルUIブロック、表示ラベル生成など
 */

/**
 * /do モーダルのレビューモード選択ブロックを生成する
 */
export function buildReviewModeBlock(): Record<string, unknown> {
    return {
        type: 'input',
        block_id: 'review_mode',
        label: {
            type: 'plain_text',
            text: 'PRレビューモード',
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
            ],
        },
        optional: true,
    };
}

/**
 * レビューモードに応じた表示ラベルを返す
 */
export interface ReviewModeDisplay {
    modeLabel: string;
    modeEmoji: string;
    modeText: string;
}

export function getReviewModeDisplay(reviewMode: boolean): ReviewModeDisplay {
    return {
        modeLabel: reviewMode ? 'PRレビュー' : '実行',
        modeEmoji: reviewMode ? '🔍' : '🚀',
        modeText: reviewMode ? 'PRレビュー' : '対応',
    };
}

/**
 * Slackモーダルの state values から reviewMode を解析する
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
): boolean {
    const reviewModeValue =
        stateValues.review_mode?.value?.selected_option?.value ?? 'implement';
    return reviewModeValue === 'review';
}
