'use strict';

const { Logtail } = require('@logtail/node');
const logger = require('./logger');

/**
 * Logtail Logger for BetterStack integration
 * Handles logging production monitoring events to BetterStack Logtail
 */
class LogtailLogger {
    constructor() {
        this.logtail = null;
        this.isEnabled = false;
        this.init();
    }

    /**
     * Initialize Logtail connection
     */
    init() {
        try {
            const sourceToken = process.env.BETTERSTACK_SOURCE_TOKEN;
            const ingestHost = process.env.BETTERSTACK_INGEST_HOST;

            if (sourceToken && ingestHost) {
                this.logtail = new Logtail(sourceToken, {
                    endpoint: `https://${ingestHost}`
                });
                this.isEnabled = true;
                logger.info({ msg: 'Logtail logger initialized successfully', endpoint: ingestHost });
            } else {
                logger.info({ msg: 'Logtail logger disabled - missing environment variables', 
                    hasSourceToken: !!sourceToken, 
                    hasIngestHost: !!ingestHost 
                });
            }
        } catch (err) {
            logger.error({ msg: 'Failed to initialize Logtail logger', err });
            this.isEnabled = false;
        }
    }

    /**
     * Log a message to Logtail
     * @param {string} level - Log level (info, warn, error)
     * @param {string} message - Log message
     * @param {Object} context - Log context object
     */
    async log(level, message, context = {}) {
        if (!this.isEnabled || !this.logtail) {
            return;
        }

        try {
            const logContext = {
                ...context,
                timestamp: new Date().toISOString(),
                source: 'emailengine',
                environment: process.env.NODE_ENV || 'development'
            };

            switch (level) {
                case 'info':
                    await this.logtail.info(message, logContext);
                    break;
                case 'warn':
                    await this.logtail.warn(message, logContext);
                    break;
                case 'error':
                    await this.logtail.error(message, logContext);
                    break;
                default:
                    await this.logtail.info(message, logContext);
            }
        } catch (err) {
            // Log failure locally with context
            logger.error({ 
                msg: 'Failed to send log to Logtail', 
                level, 
                message,
                originalContext: context, 
                err 
            });
        }
    }

    /**
     * Log info level message
     * @param {string} message - Log message
     * @param {Object} context - Log context
     */
    async info(message, context = {}) {
        return this.log('info', message, context);
    }

    /**
     * Log warn level message
     * @param {string} message - Log message
     * @param {Object} context - Log context
     */
    async warn(message, context = {}) {
        return this.log('warn', message, context);
    }

    /**
     * Log error level message
     * @param {string} message - Log message
     * @param {Object} context - Log context
     */
    async error(message, context = {}) {
        return this.log('error', message, context);
    }

    /**
     * Check if Logtail is enabled
     * @returns {boolean}
     */
    isLogtailEnabled() {
        return this.isEnabled;
    }
}

module.exports = LogtailLogger;
