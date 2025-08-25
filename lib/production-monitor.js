'use strict';

const logger = require('./logger');
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
        
        // Start monitoring if in production
        if (process.env.NODE_ENV === 'production') {
            this.startMonitoring();
        }
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
    }
    
    /**
     * Stop production monitoring
     */
    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
            logger.info({ msg: 'Production monitoring stopped' });
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
        
        // Log memory usage
        if (memoryUsagePercent > this.memoryThresholds.restart) {
            logger.warn({
                msg: 'Memory usage critical - restart imminent',
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
        } else if (memoryUsagePercent > this.memoryThresholds.warning) {
            logger.warn({
                msg: 'Memory usage high - monitor',
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
        
        logger.info({
            msg: `Worker lifecycle: ${event}`,
            event: 'worker_lifecycle',
            ...logData
        });
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
        
        logger.info({
            msg: `Account assignment: ${event}`,
            event: 'account_assignment',
            ...logData
        });
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
        
        logger.warn({
            msg: 'SMTP timeout detected',
            event: 'smtp_timeout',
            ...logData
        });
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
        
        logger.error({
            msg: 'Worker failure detected',
            event: 'worker_failure',
            ...logData
        });
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
        
        logger.warn({
            msg: `IMAP connection issue: ${event}`,
            event: 'imap_connection_issue',
            ...logData
        });
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
        
        logger.warn({
            msg: `Account verification issue: ${event}`,
            event: 'account_verification_issue',
            ...logData
        });
    }
    
    /**
     * Log worker load distribution
     */
    logWorkerLoadDistribution(data) {
        const logData = {
            timestamp: new Date().toISOString(),
            ...data
        };
        
        logger.info({
            msg: 'Worker load distribution',
            event: 'worker_load_distribution',
            ...logData
        });
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
