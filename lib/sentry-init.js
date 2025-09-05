'use strict';

const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');
const packageData = require('../package.json');
const { readEnvValue } = require('./tools');
const { threadId, isMainThread } = require('worker_threads');

/**
 * Initialize Sentry for EmailEngine worker threads
 * @param {Object} options - Configuration options
 * @param {string} options.workerType - Type of worker (main, imap, api, webhooks, etc.)
 * @param {number} [options.eventLoopThreshold] - Event loop block threshold in ms
 * @param {boolean} [options.enableHttpInstrumentation] - Enable HTTP request instrumentation
 * @param {Object} [options.additionalTags] - Additional tags to add to all events
 * @param {Object} [options.additionalContext] - Additional context to set
 */
function initSentry(options = {}) {
    const {
        workerType = 'unknown',
        eventLoopThreshold = 750,
        enableHttpInstrumentation = false,
        additionalTags = {},
        additionalContext = {}
    } = options;

    // Only initialize if SENTRY_DSN is provided
    const sentryDsn = readEnvValue('SENTRY_DSN');
    if (!sentryDsn) {
        console.log(`Sentry not initialized for ${workerType} - no DSN provided`);
        return null;
    }

    const integrations = [
        nodeProfilingIntegration(),
        Sentry.eventLoopBlockIntegration({
            threshold: eventLoopThreshold,
            maxEventsPerHour: 10
        })
    ];

    // Add HTTP instrumentation for API workers
    if (enableHttpInstrumentation) {
        integrations.push(
            Sentry.httpIntegration({
                tracing: true,
                breadcrumbs: true,
                ignoreRequestUrls: [
                    // Ignore health check endpoints
                    /\/health$/,
                    /\/ping$/,
                    // Ignore static assets
                    /\.(js|css|png|jpg|jpeg|gif|ico|svg)$/,
                ]
            })
        );
    }

    try {
        Sentry.init({
            dsn: sentryDsn,
            environment: process.env.NODE_ENV || 'production',
            release: packageData.version,
            
            // Performance monitoring with full sampling as requested
            tracesSampleRate: 1.0,
            profilesSampleRate: 1.0,
            
            integrations,
            
            // Global tags for all events
            initialScope: {
                tags: {
                    worker_type: workerType,
                    thread_id: isMainThread ? 'main' : threadId,
                    version: packageData.version,
                    ...additionalTags
                },
                contexts: {
                    worker: {
                        type: workerType,
                        thread_id: isMainThread ? 'main' : threadId,
                        is_main_thread: isMainThread,
                        ...additionalContext
                    }
                }
            },
            
            // Filter sensitive data before sending to Sentry
            beforeSend(event) {
                // Remove sensitive headers
                if (event.request?.headers) {
                    delete event.request.headers.authorization;
                    delete event.request.headers.cookie;
                    delete event.request.headers['x-api-key'];
                }
                
                // Remove sensitive query parameters
                if (event.request?.query_string) {
                    event.request.query_string = event.request.query_string
                        .replace(/([?&])(token|key|password|secret)=[^&]*/gi, '$1$2=[REDACTED]');
                }
                
                // Remove sensitive data from extra context
                if (event.extra) {
                    ['password', 'token', 'key', 'secret', 'auth'].forEach(field => {
                        if (event.extra[field]) {
                            event.extra[field] = '[REDACTED]';
                        }
                    });
                }
                
                return event;
            },
            
            // Enhanced error capturing
            captureUnhandledRejections: true,
            captureUncaughtExceptions: true,
            
            // Debug logging in development
            debug: process.env.NODE_ENV === 'development',
            
            // Configure transport options for better reliability
            transportOptions: {
                // Increase buffer size for high-volume workers
                bufferSize: workerType === 'imap' ? 100 : 30,
            }
        });

        // Set up periodic memory and performance monitoring
        const monitoringInterval = setInterval(() => {
            try {
                const memUsage = process.memoryUsage();
                
                Sentry.setContext('performance', {
                    heap_used: memUsage.heapUsed,
                    heap_total: memUsage.heapTotal,
                    heap_used_percentage: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100),
                    external: memUsage.external,
                    rss: memUsage.rss,
                    timestamp: new Date().toISOString()
                });
                
                // Alert on high memory usage
                const memoryUsagePercent = (memUsage.heapUsed / memUsage.heapTotal);
                if (memoryUsagePercent > 0.9) {
                    Sentry.captureMessage(`High memory usage detected in ${workerType} worker`, {
                        level: 'warning',
                        contexts: {
                            memory: {
                                usage_percent: Math.round(memoryUsagePercent * 100),
                                heap_used: memUsage.heapUsed,
                                heap_total: memUsage.heapTotal
                            }
                        }
                    });
                }
            } catch (err) {
                console.error('Failed to update Sentry performance context:', err);
            }
        }, 60000); // Every minute

        // Clean up monitoring interval on process exit
        process.on('beforeExit', () => {
            clearInterval(monitoringInterval);
        });

        console.log(`Sentry initialized for ${workerType} worker (thread: ${isMainThread ? 'main' : threadId})`);
        
        return Sentry;
        
    } catch (err) {
        console.error(`Failed to initialize Sentry for ${workerType} worker:`, err);
        return null;
    }
}

/**
 * Wrapper to safely capture exceptions with additional context
 * @param {Error} error - The error to capture
 * @param {Object} context - Additional context for the error
 * @param {string} workerType - Type of worker reporting the error
 */
function captureWorkerException(error, context = {}, workerType = 'unknown') {
    try {
        Sentry.withScope(scope => {
            scope.setTag('error_source', 'worker_thread');
            scope.setTag('worker_type', workerType);
            
            // Add worker-specific context
            scope.setContext('worker_context', {
                worker_type: workerType,
                thread_id: isMainThread ? 'main' : threadId,
                ...context
            });
            
            Sentry.captureException(error);
        });
    } catch (captureErr) {
        console.error('Failed to capture exception with Sentry:', captureErr);
        console.error('Original error:', error);
    }
}

/**
 * Start a new Sentry transaction for performance monitoring
 * @param {string} name - Transaction name
 * @param {string} op - Transaction operation type
 * @param {Object} data - Additional transaction data
 * @param {string} workerType - Type of worker starting the transaction
 * @returns {Object} Sentry transaction
 */
function startWorkerTransaction(name, op, data = {}, workerType = 'unknown') {
    try {
        return Sentry.startTransaction({
            name,
            op,
            data: {
                worker_type: workerType,
                thread_id: isMainThread ? 'main' : threadId,
                ...data
            },
            tags: {
                worker_type: workerType
            }
        });
    } catch (err) {
        console.error('Failed to start Sentry transaction:', err);
        return null;
    }
}

module.exports = {
    initSentry,
    captureWorkerException,
    startWorkerTransaction,
    Sentry
};