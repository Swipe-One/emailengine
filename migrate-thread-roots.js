#!/usr/bin/env node

'use strict';

const fs = require('fs');
const Redis = require('ioredis');

// Load the same configuration as the main application
if (!process.env.EE_ENV_LOADED) {
    require('dotenv').config({ quiet: true });
    process.env.EE_ENV_LOADED = 'true';
}

const config = require('wild-config');
const redisUrl = require('./lib/redis-url');

// Default Redis configuration (same as in lib/db.js)
config.dbs = config.dbs || {
    redis: 'redis://127.0.0.1:6379/8'
};

const readEnvValue = key => {
    if (key in process.env) {
        return process.env[key];
    }

    if (typeof process.env[`${key}_FILE`] === 'string' && process.env[`${key}_FILE`]) {
        try {
            process.env[key] = fs.readFileSync(process.env[`${key}_FILE`], 'utf-8').replace(/\r?\n$/, '');
            console.log(`Loaded environment value from file: ${key}`);
        } catch (err) {
            console.error(`Failed to load environment value from file: ${key}`, err);
        }
        return process.env[key];
    }
};

const redisConf = readEnvValue('EENGINE_REDIS') || readEnvValue('REDIS_URL') || config.dbs.redis;
const REDIS_CONF = Object.assign(
    {
        maxRetriesPerRequest: null,
        showFriendlyErrorStack: true,
        retryStrategy(times) {
            const delay = !times ? 1000 : Math.min(2 ** times * 500, 15 * 1000);
            console.log(`Redis connection retry: attempt ${times}, delay ${delay}ms`);
            return delay;
        },
        reconnectOnError(err) {
            console.error('Redis connection error:', err.message);
            return true;
        },
        offlineQueue: true
    },
    typeof redisConf === 'string' ? redisUrl(redisConf) : redisConf || {}
);

class ThreadRootMigrator {
    constructor(jsonFilePath, options = {}) {
        this.jsonFilePath = jsonFilePath;
        this.batchSize = options.batchSize || 100;
        this.dryRun = options.dryRun || false;
        this.redis = new Redis(REDIS_CONF);
        
        this.stats = {
            totalAccounts: 0,
            processedAccounts: 0,
            totalThreadRoots: 0,
            addedThreadRoots: 0,
            errors: 0
        };
        
        // Detailed per-account results for stats file
        this.accountResults = [];
    }

    async connect() {
        try {
            await this.redis.ping();
            console.log('✅ Connected to Redis successfully');
        } catch (err) {
            console.error('❌ Failed to connect to Redis:', err.message);
            throw err;
        }
    }

    async loadData() {
        try {
            console.log(`📂 Loading data from: ${this.jsonFilePath}`);
            const jsonData = fs.readFileSync(this.jsonFilePath, 'utf-8');
            const data = JSON.parse(jsonData);
            
            if (!Array.isArray(data)) {
                throw new Error('JSON file should contain an array of account records');
            }
            
            console.log(`✅ Loaded ${data.length} account records`);
            return data;
        } catch (err) {
            console.error('❌ Failed to load JSON data:', err.message);
            throw err;
        }
    }

    async checkExistingData(accountId) {
        const key = `iar:tr:${accountId}`;
        const count = await this.redis.scard(key);
        return count;
    }

    async migrateAccount(accountData) {
        const { connectedAccountId, firstMessageIds } = accountData;
        
        if (!connectedAccountId || !Array.isArray(firstMessageIds) || firstMessageIds.length === 0) {
            console.log(`⚠️  Skipping invalid record for account: ${connectedAccountId}`);
            return { success: false, reason: 'invalid_data' };
        }

        const key = `iar:tr:${connectedAccountId}`;
        
        // Check if account already has thread roots
        const existingCount = await this.checkExistingData(connectedAccountId);
        if (existingCount > 0) {
            console.log(`⚠️  Account ${connectedAccountId} already has ${existingCount} thread roots, skipping`);
            return { success: false, reason: 'already_exists', existingCount };
        }

        if (this.dryRun) {
            console.log(`🔍 [DRY RUN] Would add ${firstMessageIds.length} thread roots for account ${connectedAccountId}`);
            return { success: true, added: firstMessageIds.length, dryRun: true };
        }

        try {
            // Use Redis transaction for atomicity
            const multi = this.redis.multi();
            
            // Add all firstMessageIds as thread roots for this account
            // Preserve original case per RFC 5322 standards
            for (const messageId of firstMessageIds) {
                let normalizedId = messageId.trim();
                // Ensure brackets are present
                if (!normalizedId.startsWith('<')) normalizedId = '<' + normalizedId;
                if (!normalizedId.endsWith('>')) normalizedId = normalizedId + '>';
                // Keep original case - don't use toLowerCase()
                multi.sadd(key, normalizedId);
            }
            
            const results = await multi.exec();
            
            // Check if all operations succeeded
            let addedCount = 0;
            for (const [err, result] of results) {
                if (err) {
                    throw err;
                }
                addedCount += result;
            }
            
            console.log(`✅ Account ${connectedAccountId}: added ${addedCount} thread roots (${firstMessageIds.length} total)`);
            return { success: true, added: addedCount, total: firstMessageIds.length };
            
        } catch (err) {
            console.error(`❌ Failed to migrate account ${connectedAccountId}:`, err.message);
            return { success: false, reason: 'redis_error', error: err.message };
        }
    }

    async migrate() {
        console.log('🚀 Starting thread roots migration...');
        console.log(`   Batch size: ${this.batchSize}`);
        console.log(`   Dry run: ${this.dryRun ? 'YES' : 'NO'}`);
        console.log('');

        await this.connect();
        const data = await this.loadData();
        
        this.stats.totalAccounts = data.length;
        
        // Process in batches
        for (let i = 0; i < data.length; i += this.batchSize) {
            const batch = data.slice(i, i + this.batchSize);
            console.log(`📦 Processing batch ${Math.floor(i / this.batchSize) + 1}/${Math.ceil(data.length / this.batchSize)} (accounts ${i + 1}-${i + batch.length})`);
            
            for (const accountData of batch) {
                try {
                    const result = await this.migrateAccount(accountData);
                    
                    this.stats.processedAccounts++;
                    
                    // Record detailed result for stats file
                    const accountResult = {
                        accountId: accountData.connectedAccountId,
                        success: result.success,
                        reason: result.reason || 'completed',
                        threadRootsExpected: accountData.firstMessageIds ? accountData.firstMessageIds.length : 0,
                        threadRootsAdded: result.added || 0,
                        existingCount: result.existingCount || 0,
                        error: result.error || null,
                        timestamp: new Date().toISOString()
                    };
                    this.accountResults.push(accountResult);
                    
                    if (result.success) {
                        this.stats.addedThreadRoots += result.added || 0;
                        this.stats.totalThreadRoots += result.total || result.added || 0;
                    } else {
                        if (result.reason !== 'already_exists') {
                            this.stats.errors++;
                        }
                    }
                    
                } catch (err) {
                    console.error(`❌ Unexpected error processing account ${accountData.connectedAccountId}:`, err);
                    this.stats.errors++;
                    
                    // Record error in detailed results
                    this.accountResults.push({
                        accountId: accountData.connectedAccountId,
                        success: false,
                        reason: 'unexpected_error',
                        threadRootsExpected: accountData.firstMessageIds ? accountData.firstMessageIds.length : 0,
                        threadRootsAdded: 0,
                        existingCount: 0,
                        error: err.message,
                        timestamp: new Date().toISOString()
                    });
                }
            }
            
            // Brief pause between batches
            if (i + this.batchSize < data.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        this.printStats();
        await this.saveStatsFile();
    }

    async verify() {
        console.log('🔍 Verifying migration...');
        
        const data = await this.loadData();
        let verified = 0;
        let errors = 0;
        
        for (const accountData of data) {
            const { connectedAccountId, firstMessageIds } = accountData;
            
            if (!connectedAccountId || !Array.isArray(firstMessageIds)) {
                continue;
            }
            
            const key = `iar:tr:${connectedAccountId}`;
            const existingCount = await this.redis.scard(key);
            
            if (existingCount === firstMessageIds.length) {
                verified++;
            } else {
                console.log(`❌ Account ${connectedAccountId}: expected ${firstMessageIds.length}, found ${existingCount}`);
                errors++;
            }
        }
        
        console.log(`\n✅ Verification complete: ${verified} accounts verified, ${errors} mismatches`);
    }

    printStats() {
        console.log('\n📊 Migration Statistics:');
        console.log('========================');
        console.log(`Total accounts: ${this.stats.totalAccounts}`);
        console.log(`Processed accounts: ${this.stats.processedAccounts}`);
        console.log(`Total thread roots to add: ${this.stats.totalThreadRoots}`);
        console.log(`Successfully added thread roots: ${this.stats.addedThreadRoots}`);
        console.log(`Errors: ${this.stats.errors}`);
        console.log(`Success rate: ${((this.stats.processedAccounts - this.stats.errors) / this.stats.processedAccounts * 100).toFixed(1)}%`);
        
        if (this.dryRun) {
            console.log('\n🔍 This was a DRY RUN - no actual changes were made');
        }
    }

    async saveStatsFile() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        
        // Save stats file outside the git repository
        const statsDir = '/home/emailengine-fork/migration-logs';
        const filename = `${statsDir}/migration-stats-${timestamp}.json`;
        
        // Create directory if it doesn't exist
        try {
            if (!fs.existsSync(statsDir)) {
                fs.mkdirSync(statsDir, { recursive: true });
            }
        } catch (err) {
            console.error(`⚠️  Could not create stats directory ${statsDir}, saving to current directory instead`);
            const fallbackFilename = `migration-stats-${timestamp}.json`;
            return await this.saveStatsToFile(fallbackFilename);
        }
        
        return await this.saveStatsToFile(filename);
    }

    async saveStatsToFile(filename) {
        const statsData = {
            migrationSummary: {
                timestamp: new Date().toISOString(),
                dryRun: this.dryRun,
                batchSize: this.batchSize,
                jsonFilePath: this.jsonFilePath,
                totalAccounts: this.stats.totalAccounts,
                processedAccounts: this.stats.processedAccounts,
                totalThreadRoots: this.stats.totalThreadRoots,
                addedThreadRoots: this.stats.addedThreadRoots,
                errors: this.stats.errors,
                successRate: ((this.stats.processedAccounts - this.stats.errors) / this.stats.processedAccounts * 100).toFixed(1)
            },
            accountResults: this.accountResults,
            resultsSummary: {
                successful: this.accountResults.filter(r => r.success && r.reason === 'completed').length,
                alreadyExists: this.accountResults.filter(r => r.reason === 'already_exists').length,
                invalidData: this.accountResults.filter(r => r.reason === 'invalid_data').length,
                redisErrors: this.accountResults.filter(r => r.reason === 'redis_error').length,
                unexpectedErrors: this.accountResults.filter(r => r.reason === 'unexpected_error').length
            }
        };

        try {
            const statsJson = JSON.stringify(statsData, null, 2);
            fs.writeFileSync(filename, statsJson, 'utf-8');
            console.log(`\n📊 Detailed stats saved to: ${filename}`);
            
            // Also log the key stats for quick reference
            console.log(`📈 Migration completed: ${statsData.resultsSummary.successful} successful, ${statsData.resultsSummary.alreadyExists} already existed, ${statsData.resultsSummary.redisErrors + statsData.resultsSummary.unexpectedErrors} errors`);
        } catch (err) {
            console.error(`❌ Failed to save stats file: ${err.message}`);
        }
    }

    async close() {
        await this.redis.quit();
        console.log('👋 Redis connection closed');
    }
}

// CLI interface
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage: node migrate-thread-roots.js <json-file-path> [options]');
        console.log('');
        console.log('Options:');
        console.log('  --dry-run         Show what would be done without making changes');
        console.log('  --batch-size=N    Process N accounts at a time (default: 100)');
        console.log('  --verify          Verify migration after completion');
        console.log('');
        console.log('Examples:');
        console.log('  node migrate-thread-roots.js ./local.personalEmails.firstMessageId.json --dry-run');
        console.log('  node migrate-thread-roots.js ./production.personalemails.firstMessageIds.json --batch-size=50');
        process.exit(1);
    }
    
    const jsonFilePath = args[0];
    const dryRun = args.includes('--dry-run');
    const verify = args.includes('--verify');
    const batchSizeArg = args.find(arg => arg.startsWith('--batch-size='));
    const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1]) : 100;
    
    if (!fs.existsSync(jsonFilePath)) {
        console.error(`❌ File not found: ${jsonFilePath}`);
        process.exit(1);
    }
    
    const migrator = new ThreadRootMigrator(jsonFilePath, { dryRun, batchSize });
    
    try {
        await migrator.migrate();
        
        if (verify && !dryRun) {
            await migrator.verify();
        }
        
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exit(1);
    } finally {
        await migrator.close();
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = ThreadRootMigrator;
