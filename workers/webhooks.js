'use strict';

const { parentPort } = require('worker_threads');

const packageData = require('../package.json');
const config = require('wild-config');
const { createHmac } = require('crypto');
const logger = require('../lib/logger');
const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');
const { eventLoopBlockIntegration } = require('@sentry/node-native');
const sentryDsn = process.env.SENTRY_DSN || process.env.EENGINE_SENTRY_DSN;
if (sentryDsn) {
    Sentry.init({
        dsn: sentryDsn,
        release: `${packageData.name}@${packageData.version}`,
        environment: process.env.EENGINE_ENV || process.env.NODE_ENV || 'production',
        tracesSampleRate: 1.0,
        profileSessionSampleRate: 1.0,
        profileLifecycle: 'trace',
        integrations: [nodeProfilingIntegration(), eventLoopBlockIntegration({ threshold: 500 })]
    });
    Sentry.setTag('worker', 'webhooks');
    Sentry.setContext('process', { pid: process.pid, worker: 'webhooks' });
    process.on('beforeExit', () => {
        Sentry.flush(2000).catch(() => {});
    });
}
const { webhooks: Webhooks } = require('../lib/webhooks');

const { GooglePubSub } = require('../lib/oauth/pubsub/google');

const { readEnvValue, threadStats, getDuration, retryAgent, getServiceSecret } = require('../lib/tools');

const Bugsnag = require('@bugsnag/js');
if (readEnvValue('BUGSNAG_API_KEY')) {
    Bugsnag.start({
        apiKey: readEnvValue('BUGSNAG_API_KEY'),
        appVersion: packageData.version,
        logger: {
            debug(...args) {
                logger.debug({ msg: args.shift(), worker: 'webhooks', source: 'bugsnag', args: args.length ? args : undefined });
            },
            info(...args) {
                logger.debug({ msg: args.shift(), worker: 'webhooks', source: 'bugsnag', args: args.length ? args : undefined });
            },
            warn(...args) {
                logger.warn({ msg: args.shift(), worker: 'webhooks', source: 'bugsnag', args: args.length ? args : undefined });
            },
            error(...args) {
                logger.error({ msg: args.shift(), worker: 'webhooks', source: 'bugsnag', args: args.length ? args : undefined });
            }
        }
    });
    logger.notifyError = Bugsnag.notify.bind(Bugsnag);
}

const { redis, queueConf } = require('../lib/db');
const { Worker } = require('bullmq');
const settings = require('../lib/settings');

const { REDIS_PREFIX, ACCOUNT_DELETED_NOTIFY, MESSAGE_NEW_NOTIFY } = require('../lib/consts');
const he = require('he');

const { fetch: fetchCmd } = require('undici');

config.queues = config.queues || {
    notify: 1
};

const DEFAULT_EENGINE_TIMEOUT = 10 * 1000;

const EENGINE_TIMEOUT = getDuration(readEnvValue('EENGINE_TIMEOUT') || config.service.commandTimeout) || DEFAULT_EENGINE_TIMEOUT;

const NOTIFY_QC = (readEnvValue('EENGINE_NOTIFY_QC') && Number(readEnvValue('EENGINE_NOTIFY_QC'))) || config.queues.notify || 1;

let callQueue = new Map();
let mids = 0;

async function call(message, transferList) {
    return new Promise((resolve, reject) => {
        let mid = `${Date.now()}:${++mids}`;

        let ttl = Math.max(message.timeout || 0, EENGINE_TIMEOUT || 0);
        let timer = setTimeout(() => {
            let err = new Error('Timeout waiting for command response [T6]');
            err.statusCode = 504;
            err.code = 'Timeout';
            err.ttl = ttl;
            reject(err);
        }, ttl);

        callQueue.set(mid, { resolve, reject, timer });

        try {
            parentPort.postMessage(
                {
                    cmd: 'call',
                    mid,
                    message
                },
                transferList
            );
        } catch (err) {
            clearTimeout(timer);
            callQueue.delete(mid);
            return reject(err);
        }
    });
}

const googlePubSub = new GooglePubSub({
    call
});

function getAccountKey(account) {
    return `${REDIS_PREFIX}iad:${account}`;
}

async function metrics(logger, key, method, ...args) {
    try {
        parentPort.postMessage({
            cmd: 'metrics',
            key,
            method,
            args
        });
    } catch (err) {
        logger.error({ msg: 'Failed to post metrics to parent', err });
    }
}

async function onCommand(command) {
    switch (command.cmd) {
        case 'resource-usage':
            return threadStats.usage();
        case 'googlePubSub':
            await googlePubSub.update(command.app);
            return true;
        default:
            logger.debug({ msg: 'Unhandled command', command });
            return 999;
    }
}

// Start sending heartbeats to main thread
setInterval(() => {
    try {
        parentPort.postMessage({ cmd: 'heartbeat' });
    } catch (err) {
        // Ignore errors, parent might be shutting down
    }
}, 10 * 1000).unref();

// Send initial ready signal
parentPort.postMessage({ cmd: 'ready' });

parentPort.on('message', message => {
    if (message && message.cmd === 'resp' && message.mid && callQueue.has(message.mid)) {
        let { resolve, reject, timer } = callQueue.get(message.mid);
        clearTimeout(timer);
        callQueue.delete(message.mid);
        if (message.error) {
            let err = new Error(message.error);
            if (message.code) {
                err.code = message.code;
            }
            if (message.statusCode) {
                err.statusCode = message.statusCode;
            }
            if (message.info) {
                err.info = message.info;
            }
            return reject(err);
        } else {
            return resolve(message.response);
        }
    }

    if (message && message.cmd === 'call' && message.mid) {
        return onCommand(message.message)
            .then(response => {
                parentPort.postMessage({
                    cmd: 'resp',
                    mid: message.mid,
                    response
                });
            })
            .catch(err => {
                parentPort.postMessage({
                    cmd: 'resp',
                    mid: message.mid,
                    error: err.message,
                    code: err.code,
                    statusCode: err.statusCode
                });
            });
    }
});

const notifyWorker = new Worker(
    'notify',
    async job =>
        Sentry.startSpan(
            {
                name: 'webhook job',
                attributes: {
                    queue: job.queue?.name,
                    job_id: String(job.id),
                    event: job.name,
                    account: job.data?.account,
                    attempts_made: job.attemptsMade
                },
                forceTransaction: true
            },
            async () => {
                const accountKey = getAccountKey(job.data.account);

                // validate if we should even process this webhook
                const accountExists = await Sentry.startSpan(
                    { name: 'redis hexists account', attributes: { key: accountKey } },
                    () => redis.hexists(accountKey, 'account')
                );
                if (!accountExists && job.name !== ACCOUNT_DELETED_NOTIFY) {
                    logger.debug({
                        msg: 'Account is not enabled',
                        action: 'webhook',
                        queue: job.queue.name,
                        code: 'account_not_found',
                        job: job.id,
                        event: job.name,
                        account: job.data.account
                    });
                    return;
                }

                const webhooksEnabled = await Sentry.startSpan(
                    { name: 'settings get webhooksEnabled' },
                    () => settings.get('webhooksEnabled')
                );
                if (!webhooksEnabled) {
                    return;
                }

                let customRoute;
                let customMapping;
                if (job.data._route && job.data._route.id) {
                    customRoute = await Sentry.startSpan(
                        { name: 'Webhooks.getMeta', attributes: { route_id: job.data._route.id } },
                        () => Webhooks.getMeta(job.data._route.id)
                    );
                    customMapping = job.data._route.mapping;
                    delete job.data._route;
                    if (!customRoute || !customRoute.enabled || !customRoute.targetUrl) {
                        return;
                    }
                }

                const accountWebhooks = await Sentry.startSpan(
                    { name: 'redis hget webhooks', attributes: { key: accountKey } },
                    () => redis.hget(accountKey, 'webhooks')
                );

                const webhooks = (customRoute && customRoute.targetUrl) || accountWebhooks || (await settings.get('webhooks'));
                if (!webhooks) {
                    return;
                }

                let accountWebhooksCustomHeaders;
                const accountWebhooksCustomHeadersJson = await redis.hget(accountKey, 'webhooksCustomHeaders');
                if (accountWebhooksCustomHeadersJson) {
                    try {
                        accountWebhooksCustomHeaders = await Sentry.startSpan(
                            { name: 'parse webhook custom headers json' },
                            () => JSON.parse(accountWebhooksCustomHeadersJson)
                        );
                    } catch (err) {
                        logger.debug({
                            msg: 'Failed to parse custom webhook headers',
                            action: 'webhook',
                            event: job.name,
                            account: job.data.account,
                            json: accountWebhooksCustomHeadersJson,
                            err
                        });
                    }
                }

                if (!customRoute) {
                    const webhookEvents = (await Sentry.startSpan(
                        { name: 'settings get webhookEvents' },
                        () => settings.get('webhookEvents')
                    )) || [];
                    if (!webhookEvents.includes('*') && !webhookEvents.includes(job.name)) {
                        logger.trace({
                            msg: 'Webhook event not in whitelist',
                            action: 'webhook',
                            queue: job.queue.name,
                            code: 'event_not_whitelisted',
                            job: job.id,
                            event: job.name,
                            account: job.data.account,
                            webhookEvents,
                            data: job.data
                        });
                        return;
                    }

                    switch (job.data.event) {
                        case MESSAGE_NEW_NOTIFY: {
                            let isInbox = false;
                            if (
                                (job.data.account && job.data.path === 'INBOX') ||
                                job.data.specialUse === '\\Inbox' ||
                                (job.data.data && job.data.data.messageSpecialUse === '\\Inbox') ||
                                (job.data.data && job.data.data.labels && job.data.data.labels.includes('\\Inbox'))
                            ) {
                                isInbox = true;
                            }

                            if (!isInbox) {
                                const inboxNewOnly = (await settings.get('inboxNewOnly')) || false;
                                if (inboxNewOnly) {
                                    return;
                                }
                            }

                            break;
                        }
                    }
                }

                // only log some of the properties for webhooks, not full contents
                const filteredData = {};
                for (let key of Object.keys(job.data)) {
                    switch (key) {
                        case 'data': {
                            let filteredSubData = {};
                            let isPartial = false;
                            for (let dataKey of Object.keys(job.data.data)) {
                                switch (dataKey) {
                                    case 'id':
                                    case 'uid':
                                    case 'path':
                                    case 'messageId':
                                        filteredSubData[dataKey] = job.data.data[dataKey];
                                        break;
                                    default:
                                        isPartial = true;
                                }
                            }
                            if (isPartial) {
                                if (Object.keys(filteredSubData).length) {
                                    filteredSubData.partial = true;
                                } else {
                                    filteredSubData = true;
                                }
                            }
                            filteredData[key] = filteredSubData;
                            break;
                        }
                        default:
                            filteredData[key] = job.data[key];
                    }
                }

                logger.trace({
                    msg: 'Processing webhook',
                    action: 'webhook',
                    queue: job.queue.name,
                    code: 'processing',
                    job: job.id,
                    webhooks,
                    accountWebhooks: !!accountWebhooks,
                    event: job.name,
                    data: filteredData,
                    account: job.data.account,
                    route: customRoute && customRoute.id
                });

                const headers = {
                    'Content-Type': 'application/json',
                    'User-Agent': `${packageData.name}/${packageData.version} (+${packageData.homepage})`,
                    'X-EE-Wh-Id': (job.id || '').toString(),
                    'X-EE-Wh-Attempts-Made': (job.attemptsMade || 0).toString(),
                    'X-EE-Wh-Queued-Time': Math.round(Math.max(0, (Date.now() - job.timestamp) / 1000)) + 's'
                };

                const parsed = new URL(webhooks);
                let username, password;

                if (parsed.username) {
                    username = he.decode(parsed.username);
                    parsed.username = '';
                }

                if (parsed.password) {
                    password = he.decode(parsed.password);
                    parsed.password = '';
                }

                if (username || password) {
                    headers.Authorization = `Basic ${Buffer.from(he.encode(username || '') + ':' + he.encode(password || '')).toString('base64')}`;
                }

                if (customRoute) {
                    headers['X-EE-Wh-Custom-Route'] = customRoute.id;
                    for (let header of customRoute.customHeaders || []) {
                        headers[header.key] = header.value;
                    }
                } else {
                    const webhookCustomHeaders = await Sentry.startSpan(
                        { name: 'settings get webhooksCustomHeaders' },
                        () => settings.get('webhooksCustomHeaders')
                    );
                    for (let header of webhookCustomHeaders || []) {
                        headers[header.key] = header.value;
                    }
                }

                if (accountWebhooksCustomHeaders) {
                    for (let header of accountWebhooksCustomHeaders || []) {
                        headers[header.key] = header.value;
                    }
                }

                const start = Date.now();
                let duration;

                const webhookPayload = customMapping || job.data;
                if (webhookPayload.eventId) {
                    headers['X-EE-Wh-Event-Id'] = webhookPayload.eventId;
                    webhookPayload.eventId = undefined; // not included in JSON
                }
                const body = await Sentry.startSpan(
                    { name: 'json stringify webhook payload' },
                    () => Buffer.from(JSON.stringify(webhookPayload))
                );

                const serviceSecret = await getServiceSecret();
                headers['X-EE-Wh-Signature'] = await Sentry.startSpan(
                    { name: 'hmac sign webhook payload' },
                    () => {
                        const hmac = createHmac('sha256', serviceSecret);
                        hmac.update(body);
                        return hmac.digest('base64url');
                    }
                );

                try {
                    let res;
                    try {
                        res = await Sentry.startSpan(
                            {
                                name: 'webhook http post',
                                attributes: { method: 'POST', host: parsed.hostname, path: parsed.pathname }
                            },
                            () =>
                                fetchCmd(parsed.toString(), {
                                    method: 'post',
                                    body,
                                    headers,
                                    dispatcher: retryAgent
                                })
                        );
                        duration = Date.now() - start;
                    } catch (err) {
                        duration = Date.now() - start;
                        throw err;
                    }

                    if (!res.ok) {
                        const err = new Error(`Invalid response: ${res.status} ${res.statusText}`);
                        err.status = res.status;
                        throw err;
                    }

                    logger.trace({
                        msg: 'Webhook posted',
                        action: 'webhook',
                        queue: job.queue.name,
                        code: 'result_success',
                        job: job.id,
                        webhooks,
                        requestBodySize: body.length,
                        accountWebhooks: !!accountWebhooks,
                        event: job.name,
                        status: res.status,
                        account: job.data.account,
                        route: customRoute && customRoute.id
                    });

                    try {
                        if (customRoute) {
                            await Sentry.startSpan(
                                { name: 'redis hset clear webhookErrorFlag (custom route)' },
                                () => redis.hset(Webhooks.getWebhooksContentKey(), `${customRoute.id}:webhookErrorFlag`, JSON.stringify({}))
                            );
                        } else if (accountWebhooks) {
                            await Sentry.startSpan(
                                { name: 'redis hset clear webhookErrorFlag (account)' },
                                () => redis.hset(accountKey, 'webhookErrorFlag', JSON.stringify({}))
                            );
                        } else {
                            await Sentry.startSpan(
                                { name: 'settings clear webhookErrorFlag' },
                                () => settings.clear('webhookErrorFlag')
                            );
                        }
                    } catch (err) {
                        // ignore
                    }

                    metrics(logger, 'webhooks', 'inc', {
                        event: job.name,
                        status: 'success'
                    });
                } catch (err) {
                    logger.error({
                        msg: 'Failed posting webhook',
                        action: 'webhook',
                        queue: job.queue.name,
                        code: 'result_fail',
                        job: job.id,
                        webhooks,
                        requestBodySize: body.length,
                        accountWebhooks: !!accountWebhooks,
                        event: job.name,
                        account: job.data.account,
                        route: customRoute && customRoute.id,
                        err
                    });

                    try {
                        if (customRoute) {
                            await Sentry.startSpan(
                                { name: 'redis hset webhookErrorFlag (custom route)' },
                                () =>
                                    redis.hset(
                                        Webhooks.getWebhooksContentKey(),
                                        `${customRoute.id}:webhookErrorFlag`,
                                        JSON.stringify({
                                            event: job.name,
                                            message: err.message,
                                            time: Date.now(),
                                            url: customRoute.targetUrl
                                        })
                                    )
                            );
                        } else if (accountWebhooks) {
                            await Sentry.startSpan(
                                { name: 'redis hset webhookErrorFlag (account)' },
                                () =>
                                    redis.hset(
                                        accountKey,
                                        'webhookErrorFlag',
                                        JSON.stringify({
                                            event: job.name,
                                            message: err.message,
                                            time: Date.now(),
                                            url: webhooks
                                        })
                                    )
                            );
                        } else {
                            await Sentry.startSpan(
                                { name: 'settings set webhookErrorFlag' },
                                () =>
                                    settings.set('webhookErrorFlag', {
                                        event: job.name,
                                        message: err.message,
                                        time: Date.now(),
                                        url: webhooks
                                    })
                            );
                        }
                    } catch (err) {
                        // ignore
                    }

                    metrics(logger, 'webhooks', 'inc', {
                        event: job.name,
                        status: 'fail'
                    });

                    throw err;
                } finally {
                    if (duration) {
                        metrics(logger, 'webhookReq', 'observe', duration);
                    }
                }
            }
        ),
    Object.assign(
        {
            concurrency: Number(NOTIFY_QC) || 1
        },
        queueConf || {}
    )
);

notifyWorker.on('completed', async job => {
    metrics(logger, 'queuesProcessed', 'inc', {
        queue: 'notify',
        status: 'completed'
    });

    logger.info({
        msg: 'Notification queue entry completed',
        action: 'webhook',
        queue: job.queue.name,
        code: 'completed',
        job: job.id,
        account: job.data.account,
        route: job.data._route && job.data._route.id
    });
});

notifyWorker.on('failed', async job => {
    metrics(logger, 'queuesProcessed', 'inc', {
        queue: 'notify',
        status: 'failed'
    });

    logger.info({
        msg: 'Notification queue entry failed',
        action: 'webhook',
        queue: job.queue.name,
        code: 'failed',
        job: job.id,
        account: job.data.account,
        route: job.data._route && job.data._route.id,

        failedReason: job.failedReason,
        stacktrace: job.stacktrace,
        attemptsMade: job.attemptsMade
    });
});

googlePubSub
    .start()
    .then(() => {
        logger.info({ msg: 'Started processing Google pub/sub' });
    })
    .catch(err => {
        logger.fatal({ msg: 'Failed to start processing Google pub/sub', err });
    });

logger.info({ msg: 'Started Webhooks worker thread', version: packageData.version });
