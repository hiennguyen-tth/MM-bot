'use strict';

const https = require('https');
const TelegramAlert = require('../../src/alerts/TelegramAlert');

// Mock https.request
jest.mock('https');

function makeMockReq() {
    const req = { write: jest.fn(), end: jest.fn(), on: jest.fn() };
    return req;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('TelegramAlert – no-op when unconfigured', () => {
    test('send() does nothing without token', async () => {
        const alert = new TelegramAlert({});
        await alert.send('hello');
        expect(https.request).not.toHaveBeenCalled();
    });

    test('send() does nothing without chatId', async () => {
        const alert = new TelegramAlert({ botToken: 'tok' });
        await alert.send('hello');
        expect(https.request).not.toHaveBeenCalled();
    });

    test('maybeSendMetrics() does nothing without token', async () => {
        const alert = new TelegramAlert({});
        await alert.maybeSendMetrics({ realizedPnl: '0', hourlyPnl: '0', fills: 0, fillRate: '0', adverseFillRatio: '0', maxDrawdown: '0', avgSpreadCaptured: '0' }, 'ranging');
        expect(https.request).not.toHaveBeenCalled();
    });
});

describe('TelegramAlert – send()', () => {
    test('makes HTTPS POST to Telegram API', async () => {
        const req = makeMockReq();
        https.request.mockImplementation((opts, cb) => {
            cb({ statusCode: 200 });
            return req;
        });

        const alert = new TelegramAlert({ botToken: 'mytoken', chatId: '12345' });
        await alert.send('Test message');

        expect(https.request).toHaveBeenCalledWith(
            expect.objectContaining({
                hostname: 'api.telegram.org',
                path: '/botmytoken/sendMessage',
                method: 'POST',
            }),
            expect.any(Function)
        );
        expect(req.write).toHaveBeenCalled();
        expect(req.end).toHaveBeenCalled();
    });

    test('resolves without throwing on network error', async () => {
        const req = makeMockReq();
        req.on.mockImplementation((event, cb) => {
            if (event === 'error') cb(new Error('ECONNREFUSED'));
        });
        https.request.mockReturnValue(req);

        const alert = new TelegramAlert({ botToken: 'tok', chatId: '99' });
        await expect(alert.send('fail')).resolves.toBeUndefined();
    });
});

describe('TelegramAlert – sendShutdown()', () => {
    test('sends shutdown message with reason and metrics', async () => {
        const req = makeMockReq();
        https.request.mockImplementation((opts, cb) => {
            cb({ statusCode: 200 });
            return req;
        });

        const alert = new TelegramAlert({ botToken: 'tok', chatId: '1' });
        const metrics = { realizedPnl: '-5.00', maxDrawdown: '5.00', fills: 3, adverseFillRatio: '0.67' };
        await alert.sendShutdown('daily_loss_limit', -5, metrics);

        const body = JSON.parse(req.write.mock.calls[0][0]);
        expect(body.text).toContain('SHUTDOWN');
        expect(body.text).toContain('daily_loss_limit');
    });
});

describe('TelegramAlert – maybeSendMetrics()', () => {
    const metrics = {
        realizedPnl: '12.34', hourlyPnl: '1.23', fillRate: '0.0500',
        fills: 10, adverseFillRatio: '0.1000', maxDrawdown: '0.50', avgSpreadCaptured: '0.00001',
    };

    test('sends metrics on first call', async () => {
        const req = makeMockReq();
        https.request.mockImplementation((opts, cb) => {
            cb({ statusCode: 200 });
            return req;
        });

        const alert = new TelegramAlert({ botToken: 'tok', chatId: '1', metricsIntervalMs: 1000 });
        await alert.maybeSendMetrics(metrics, 'ranging');

        expect(https.request).toHaveBeenCalledTimes(1);
        const body = JSON.parse(req.write.mock.calls[0][0]);
        expect(body.text).toContain('PnL');
        expect(body.text).toContain('ranging');
    });

    test('throttles: does not send again before interval', async () => {
        const req = makeMockReq();
        https.request.mockImplementation((opts, cb) => {
            cb({ statusCode: 200 });
            return req;
        });

        const alert = new TelegramAlert({ botToken: 'tok', chatId: '1', metricsIntervalMs: 60_000 });
        await alert.maybeSendMetrics(metrics, 'ranging');
        await alert.maybeSendMetrics(metrics, 'ranging'); // should be throttled
        expect(https.request).toHaveBeenCalledTimes(1);
    });
});
