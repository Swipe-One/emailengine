'use strict';

const logger = require('./logger');
const LogtailLogger = require('./logtail-logger');
const os = require('os');

/**
 * Production monitoring and logging utilities
 * Provides comprehensive logging for production issues
 */
class ProductionMonitor {
    constructor() {
        this.memoryThresholds = {
            warning: 0.8, // 80% memory usage
            critical: 0.9, // 90% memory usage
            restart: 0.95 // 95% memory usage
        };
        
        this.monitoringInterval = null;
        this.lastMemoryCheck = Date.now();
        
        // Initialize Logtail logger for BetterStack integration
        this.logtailLogger = new LogtailLogger();
        
        // Start monitoring if in production
        this.startMonitoring();
    }
    
    /**
     * Start production monitoring
     */
    startMonitoring() {
        if (this.monitoringInterval) {
            return;
        }
        
        // Monitor memory every 30 seconds
        this.monitoringInterval = setInterval(() => {
            this.checkMemoryUsage();
        }, 30000);
        
        logger.info({ msg: 'Production monitoring started', interval: '30s' });
        
        // Log to BetterStack as well
        this.logtailLogger.info('Production monitoring started', {
            interval: '30s',
            memoryThresholds: this.memoryThresholds
        });
    }
    
    /**
     * Stop production monitoring
     */
    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
            logger.info({ msg: 'Production monitoring stopped' });
            
            // Log to BetterStack as well
            this.logtailLogger.info('Production monitoring stopped', {});
        }
    }
    
    /**
     * Check current memory usage and log alerts
     */
    checkMemoryUsage() {
        const memUsage = process.memoryUsage();
        const totalMem = os.totalmem();
        const usedMem = os.freemem();
        const memoryUsagePercent = (totalMem - usedMem) / totalMem;
        
        const memoryData = {
            memoryUsagePercent: Math.round(memoryUsagePercent * 100),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            rss: Math.round(memUsage.rss / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024),
            totalSystemMem: Math.round(totalMem / 1024 / 1024),
            freeSystemMem: Math.round(usedMem / 1024 / 1024)
        };
        
        // Log memory usage locally
        if (memoryUsagePercent > this.memoryThresholds.restart) {
            logger.warn({
                msg: 'Memory usage critical - restart imminent',
                event: 'memory_alert',
                level: 'critical',
                action: 'restart_imminent',
                ...memoryData
            });
            
            // Log to BetterStack
            this.logtailLogger.warn('Memory usage critical - restart imminent', {
                event: 'memory_alert',
                level: 'critical',
                action: 'restart_imminent',
                ...memoryData
            });
        } else if (memoryUsagePercent > this.memoryThresholds.critical) {
            logger.warn({
                msg: 'Memory usage critical - monitor closely',
                event: 'memory_alert',
                level: 'critical',
                action: 'monitor_closely',
                ...memoryData
            });
            
            // Log to BetterStack
            this.logtailLogger.warn('Memory usage critical - monitor closely', {
                event: 'memory_alert',
                level: 'critical',
                action: 'monitor_closely',
                ...memoryData
            });
        } else if (memoryUsagePercent > this.memoryThresholds.warning) {
            logger.warn({
                msg: 'Memory usage high - monitor',
                event: 'memory_alert',
                level: 'warning',
                action: 'monitor',
                ...memoryData
            });
            
            // Log to BetterStack
            this.logtailLogger.warn('Memory usage high - monitor', {
                event: 'memory_alert',
                level: 'warning',
                action: 'monitor',
                ...memoryData
            });
        }
        
        this.lastMemoryCheck = Date.now();
    }
    
    /**
     * Log worker lifecycle events
     */
    logWorkerLifecycle(event, data) {
        const logData = {
            workerType: data.workerType || 'unknown',
            threadId: data.threadId || 'unknown',
            timestamp: new Date().toISOString(),
            ...data
        };
        
        // Log locally
        logger.info({
            msg: `Worker lifecycle: ${event}`,
            event: 'worker_lifecycle',
            ...logData
        });
        
        // Log to BetterStack
        this.logtailLogger.info(`Worker lifecycle: ${event}`, logData);
    }
    
    /**
     * Log account assignment events
     */
    logAccountAssignment(event, data) {
        const logData = {
            account: data.account || 'unknown',
            worker: data.worker || 'unknown',
            timestamp: new Date().toISOString(),
            ...data
        };
        
        // Log locally
        logger.info({
            msg: `Account assignment: ${event}`,
            event: 'account_assignment',
            ...logData
        });
        
        // Log to BetterStack
        this.logtailLogger.info(`Account assignment: ${event}`, logData);
    }
    
    /**
     * Log SMTP timeout events
     */
    logSmtpTimeout(data) {
        const logData = {
            account: data.account || 'unknown',
            timeout: data.timeout || 'unknown',
            command: data.command || 'unknown',
            timestamp: new Date().toISOString(),
            ...data
        };
        
        // Log locally
        logger.warn({
            msg: 'SMTP timeout detected',
            event: 'smtp_timeout',
            ...logData
        });
        
        // Log to BetterStack
        this.logtailLogger.warn('SMTP timeout detected', logData);
    }
    
    /**
     * Log worker failure events
     */
    logWorkerFailure(data) {
        const logData = {
            workerType: data.workerType || 'unknown',
            threadId: data.threadId || 'unknown',
            exitCode: data.exitCode || 'unknown',
            error: data.error || 'unknown',
            timestamp: new Date().toISOString(),
            ...data
        };
        
        // Log locally
        logger.error({
            msg: 'Worker failure detected',
            event: 'worker_failure',
            ...logData
        });
        
        // Log to BetterStack
        this.logtailLogger.error('Worker failure detected', logData);
    }
    
    /**
     * Log IMAP connection issues
     */
    logImapConnectionIssue(event, data) {
        const logData = {
            account: data.account || 'unknown',
            worker: data.worker || 'unknown',
            error: data.error || 'unknown',
            timestamp: new Date().toISOString(),
            ...data
        };
        
        // Log locally
        logger.warn({
            msg: `IMAP connection issue: ${event}`,
            event: 'imap_connection_issue',
            ...logData
        });
        
        // Log to BetterStack
        this.logtailLogger.warn(`IMAP connection issue: ${event}`, logData);
    }
    
    /**
     * Log account verification issues
     */
    logAccountVerificationIssue(event, data) {
        const logData = {
            account: data.account || 'unknown',
            error: data.error || 'unknown',
            duration: data.duration || 'unknown',
            timestamp: new Date().toISOString(),
            ...data
        };
        
        // Log locally
        logger.warn({
            msg: `Account verification issue: ${event}`,
            event: 'account_verification_issue',
            ...logData
        });
        
        // Log to BetterStack
        this.logtailLogger.warn(`Account verification issue: ${event}`, logData);
    }
    
    /**
     * Log worker load distribution
     */
    logWorkerLoadDistribution(data) {
        const logData = {
            timestamp: new Date().toISOString(),
            ...data
        };
        
        // Log locally
        logger.info({
            msg: 'Worker load distribution',
            event: 'worker_load_distribution',
            ...logData
        });
        
        // Log to BetterStack
        this.logtailLogger.info('Worker load distribution', logData);
    }
    
    /**
     * Log account reassignment events
     */
    logAccountReassignment(data) {
        const logData = {
            account: data.account || 'unknown',
            fromWorker: data.fromWorker || 'unknown',
            toWorker: data.toWorker || 'unknown',
            reason: data.reason || 'unknown',
            timestamp: new Date().toISOString(),
            ...data
        };
        
        // Log locally
        logger.info({
            msg: 'Account reassignment',
            event: 'account_reassignment',
            ...logData
        });
        
        // Log to BetterStack
        this.logtailLogger.info('Account reassignment', logData);
    }
    
    /**
     * Log IMAP account assignment
     */
    logImapAccountAssignment(data) {
        const logData = {
            account: data.account || 'unknown',
            worker: data.worker || 'unknown',
            status: data.status || 'unknown',
            timestamp: new Date().toISOString(),
            ...data
        };
        
        // Log locally
        logger.info({
            msg: 'IMAP account assignment',
            event: 'imap_account_assignment',
            ...logData
        });
        
        // Log to BetterStack
        this.logtailLogger.info('IMAP account assignment', logData);
    }
    
    /**
     * Get current system health metrics
     */
    getSystemHealth() {
        const memUsage = process.memoryUsage();
        const totalMem = os.totalmem();
        const usedMem = os.freemem();
        const memoryUsagePercent = (totalMem - usedMem) / totalMem;
        
        return {
            memory: {
                usagePercent: Math.round(memoryUsagePercent * 100),
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
                rss: Math.round(memUsage.rss / 1024 / 1024),
                external: Math.round(memUsage.external / 1024 / 1024)
            },
            system: {
                totalMem: Math.round(totalMem / 1024 / 1024),
                freeMem: Math.round(usedMem / 1024 / 1024),
                uptime: process.uptime(),
                cpuCount: os.cpus().length
            },
            process: {
                pid: process.pid,
                version: process.version,
                platform: process.platform,
                arch: process.arch
            }
        };
    }
}

module.exports = ProductionMonitor;
