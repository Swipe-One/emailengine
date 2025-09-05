'use strict';

// Lazy-initialize Sentry only when a DSN is provided to avoid hard dependency at runtime
let _initialized = false;
let _sentry = null;

function initSentry(workerType) {
    try {
        if (_initialized) {
            return _sentry;
        }

        const dsn = process.env.SENTRY_DSN || process.env.EENGINE_SENTRY_DSN;
        if (!dsn) {
            // Sentry not configured; no-op
            return null;
        }

        // Require inside function to avoid module resolution errors if packages are not installed
        const Sentry = require('@sentry/node');
        const { nodeProfilingIntegration } = require('@sentry/profiling-node');
        const packageData = require('../package.json');

        const environment = process.env.EENGINE_ENV || process.env.NODE_ENV || 'production';
        const release = `${packageData.name}@${packageData.version}`;

        Sentry.init({
            dsn,
            release,
            environment,
            tracesSampleRate: 1.0,
            // Continuous/UI profiling bound to trace lifecycle
            profileSessionSampleRate: 1.0,
            profileLifecycle: 'trace',
            integrations: [nodeProfilingIntegration()],
        });

        if (workerType) {
            Sentry.setTag('worker', workerType);
            Sentry.setContext('process', {
                pid: process.pid,
                worker: workerType,
            });
        }

        // Ensure events are flushed on shutdown
        const flushAndExit = async (code) => {
            try {
                await Sentry.flush(2000);
            } catch (err) {
                // ignore
            } finally {
                if (typeof code === 'number') {
                    process.exit(code);
                }
            }
        };
        process.on('beforeExit', () => {
            // best-effort flush, do not exit here as Node controls lifecycle
            Sentry.flush(2000).catch(() => {});
        });
        process.on('uncaughtException', err => {
            Sentry.captureException(err);
            flushAndExit(1);
        });
        process.on('unhandledRejection', reason => {
            Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
            // do not exit automatically; allow worker supervisors to decide
            Sentry.flush(2000).catch(() => {});
        });
        for (const sig of ['SIGTERM', 'SIGINT']) {
            process.on(sig, () => flushAndExit(0));
        }

        _initialized = true;
        _sentry = Sentry;
        return Sentry;
    } catch (err) {
        // If Sentry is not installed or fails to init, do not crash the app
        // eslint-disable-next-line no-console
        console.warn('[sentry] Initialization skipped:', err && err.message);
        return null;
    }
}

function getSentry() {
    return _sentry;
}

async function flush(timeoutMs = 2000) {
    if (_sentry) {
        try {
            await _sentry.flush(timeoutMs);
        } catch (err) {
            // ignore
        }
    }
}

module.exports = { initSentry, getSentry, flush };
