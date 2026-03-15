import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Slack署名検証に必要なリクエストプロパティ
 * express.urlencoded / express.json の verify コールバックで rawBody を保存する
 */
declare global {
    namespace Express {
        interface Request {
            rawBody?: Buffer;
        }
    }
}

/**
 * リクエストの rawBody を保存する verify コールバック
 * express.urlencoded() / express.json() の verify オプションに渡す
 */
export function captureRawBody(
    req: Request,
    _res: Response,
    buf: Buffer,
): void {
    req.rawBody = buf;
}

/**
 * Slackリクエストの署名を検証するミドルウェア
 *
 * - X-Slack-Request-Timestamp と X-Slack-Signature ヘッダーを検証
 * - タイムスタンプが5分以上古い場合はリプレイ攻撃として拒否
 * - HMAC-SHA256 で署名を検証
 */
export function verifySlackSignature(
    signingSecret?: string,
): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction): void => {
        const secret = signingSecret ?? process.env.SLACK_SIGNING_SECRET;
        if (!secret) {
            console.error(
                'SLACK_SIGNING_SECRET が設定されていません。署名検証をスキップします。',
            );
            next();
            return;
        }

        const timestamp = req.headers['x-slack-request-timestamp'] as
            | string
            | undefined;
        const slackSignature = req.headers['x-slack-signature'] as
            | string
            | undefined;

        if (!timestamp || !slackSignature) {
            res.status(401).send('Missing Slack signature headers');
            return;
        }

        // リプレイ攻撃防止: 5分以上古いリクエストを拒否
        const requestTimestamp = Number(timestamp);
        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - requestTimestamp) > 300) {
            res.status(401).send('Request timestamp too old');
            return;
        }

        const rawBody = req.rawBody;
        if (!rawBody) {
            res.status(401).send('Unable to verify request signature');
            return;
        }

        const sigBasestring = `v0:${timestamp}:${rawBody.toString()}`;
        const mySignature = `v0=${createHmac('sha256', secret).update(sigBasestring).digest('hex')}`;

        // タイミング攻撃を防ぐためにtimingSafeEqualを使用
        const sigBuffer = Buffer.from(slackSignature);
        const myBuffer = Buffer.from(mySignature);

        if (
            sigBuffer.length !== myBuffer.length ||
            !timingSafeEqual(sigBuffer, myBuffer)
        ) {
            res.status(401).send('Invalid request signature');
            return;
        }

        next();
    };
}
