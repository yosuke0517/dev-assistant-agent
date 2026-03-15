import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureRawBody, verifySlackSignature } from './lib/slack-signature.js';

/** テスト用のSlack署名を生成する */
function generateSignature(
    secret: string,
    timestamp: string,
    body: string,
): string {
    const sigBasestring = `v0:${timestamp}:${body}`;
    const hash = createHmac('sha256', secret)
        .update(sigBasestring)
        .digest('hex');
    return `v0=${hash}`;
}

function createMockReq(headers: Record<string, string> = {}, rawBody?: Buffer) {
    return {
        headers,
        rawBody,
    } as unknown as Parameters<ReturnType<typeof verifySlackSignature>>[0];
}

function createMockRes() {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const res: any = {
        statusCode: 200,
        body: '',
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        send(text: string) {
            res.body = text;
            return res;
        },
    };
    return res;
}

describe('captureRawBody', () => {
    it('リクエストにrawBodyを保存する', () => {
        const req = createMockReq();
        const res = createMockRes();
        const buf = Buffer.from('test body');

        captureRawBody(req, res, buf);

        expect(req.rawBody).toBe(buf);
    });
});

describe('verifySlackSignature', () => {
    const secret = 'test-signing-secret';
    const body = 'token=test&team_id=T1234';
    const rawBody = Buffer.from(body);

    let originalEnv: string | undefined;

    beforeEach(() => {
        originalEnv = process.env.SLACK_SIGNING_SECRET;
    });

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.SLACK_SIGNING_SECRET = originalEnv;
        } else {
            delete process.env.SLACK_SIGNING_SECRET;
        }
    });

    it('有効な署名でnextが呼ばれる', () => {
        const middleware = verifySlackSignature(secret);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = generateSignature(secret, timestamp, body);
        const req = createMockReq(
            {
                'x-slack-request-timestamp': timestamp,
                'x-slack-signature': signature,
            },
            rawBody,
        );
        const res = createMockRes();
        const next = vi.fn();

        middleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
    });

    it('署名ヘッダーがない場合は401を返す', () => {
        const middleware = verifySlackSignature(secret);
        const req = createMockReq({}, rawBody);
        const res = createMockRes();
        const next = vi.fn();

        middleware(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toBe('Missing Slack signature headers');
    });

    it('タイムスタンプのみでシグネチャがない場合は401を返す', () => {
        const middleware = verifySlackSignature(secret);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const req = createMockReq(
            { 'x-slack-request-timestamp': timestamp },
            rawBody,
        );
        const res = createMockRes();
        const next = vi.fn();

        middleware(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
    });

    it('5分以上古いタイムスタンプは拒否する', () => {
        const middleware = verifySlackSignature(secret);
        const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);
        const signature = generateSignature(secret, oldTimestamp, body);
        const req = createMockReq(
            {
                'x-slack-request-timestamp': oldTimestamp,
                'x-slack-signature': signature,
            },
            rawBody,
        );
        const res = createMockRes();
        const next = vi.fn();

        middleware(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toBe('Request timestamp too old');
    });

    it('不正な署名は拒否する', () => {
        const middleware = verifySlackSignature(secret);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const req = createMockReq(
            {
                'x-slack-request-timestamp': timestamp,
                'x-slack-signature': 'v0=invalidsignature',
            },
            rawBody,
        );
        const res = createMockRes();
        const next = vi.fn();

        middleware(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toBe('Invalid request signature');
    });

    it('rawBodyがない場合は401を返す', () => {
        const middleware = verifySlackSignature(secret);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = generateSignature(secret, timestamp, body);
        const req = createMockReq({
            'x-slack-request-timestamp': timestamp,
            'x-slack-signature': signature,
        });
        const res = createMockRes();
        const next = vi.fn();

        middleware(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toBe('Unable to verify request signature');
    });

    it('SLACK_SIGNING_SECRET環境変数が未設定の場合はスキップする', () => {
        delete process.env.SLACK_SIGNING_SECRET;
        const middleware = verifySlackSignature(undefined);
        const req = createMockReq({});
        const res = createMockRes();
        const next = vi.fn();

        middleware(req, res, next);

        expect(next).toHaveBeenCalled();
    });

    it('環境変数からSLACK_SIGNING_SECRETを読み取る', () => {
        process.env.SLACK_SIGNING_SECRET = secret;
        const middleware = verifySlackSignature();
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = generateSignature(secret, timestamp, body);
        const req = createMockReq(
            {
                'x-slack-request-timestamp': timestamp,
                'x-slack-signature': signature,
            },
            rawBody,
        );
        const res = createMockRes();
        const next = vi.fn();

        middleware(req, res, next);

        expect(next).toHaveBeenCalled();
    });

    it('異なるシークレットで生成された署名は拒否する', () => {
        const middleware = verifySlackSignature(secret);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const wrongSignature = generateSignature(
            'wrong-secret',
            timestamp,
            body,
        );
        const req = createMockReq(
            {
                'x-slack-request-timestamp': timestamp,
                'x-slack-signature': wrongSignature,
            },
            rawBody,
        );
        const res = createMockRes();
        const next = vi.fn();

        middleware(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toBe('Invalid request signature');
    });
});
