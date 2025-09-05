#!/usr/bin/env node
'use strict';

/**
 * Test script for EmailEngine Sentry integration
 * 
 * This script validates that Sentry is properly initialized across all worker types
 * and that event loop monitoring is working correctly.
 * 
 * Usage:
 * SENTRY_DSN=your_dsn_here node test-sentry.js
 */

process.env.NODE_ENV = 'development';

console.log('🔍 Testing Sentry Integration for EmailEngine\n');

// Test the shared Sentry initialization utility
console.log('1. Testing shared Sentry utility...');
const { initSentry, captureWorkerException, startWorkerTransaction } = require('./lib/sentry-init');

// Test different worker types
const workerTypes = [
    { type: 'main', threshold: 500, http: false },
    { type: 'api', threshold: 500, http: true },
    { type: 'imap', threshold: 1000, http: false },
    { type: 'webhooks', threshold: 750, http: true },
    { type: 'documents', threshold: 1500, http: false },
    { type: 'submit', threshold: 1000, http: false },
    { type: 'smtp', threshold: 1000, http: false },
    { type: 'imap-proxy', threshold: 750, http: false }
];

let successCount = 0;
let failureCount = 0;

console.log('\n2. Testing Sentry initialization for each worker type...');

workerTypes.forEach(({ type, threshold, http }) => {
    try {
        console.log(`   Testing ${type} worker...`);
        
        const sentry = initSentry({
            workerType: type,
            eventLoopThreshold: threshold,
            enableHttpInstrumentation: http,
            additionalTags: { test_mode: true },
            additionalContext: { test_run: true }
        });
        
        if (process.env.SENTRY_DSN) {
            if (sentry) {
                console.log(`   ✅ ${type} worker: Sentry initialized successfully`);
                
                // Test error capture
                const testError = new Error(`Test error from ${type} worker`);
                captureWorkerException(testError, { test: true, worker: type }, type);
                
                // Test transaction
                const transaction = startWorkerTransaction(
                    `test.${type}.operation`,
                    'test',
                    { test: true },
                    type
                );
                
                if (transaction) {
                    transaction.finish();
                    console.log(`   📊 ${type} worker: Transaction test completed`);
                }
                
                successCount++;
            } else {
                console.log(`   ❌ ${type} worker: Sentry initialization returned null`);
                failureCount++;
            }
        } else {
            if (!sentry) {
                console.log(`   ⚠️  ${type} worker: No SENTRY_DSN provided (expected behavior)`);
                successCount++;
            } else {
                console.log(`   ❌ ${type} worker: Unexpected initialization without DSN`);
                failureCount++;
            }
        }
    } catch (error) {
        console.log(`   ❌ ${type} worker: Initialization failed -`, error.message);
        failureCount++;
    }
});

console.log('\n3. Testing event loop blocking simulation...');

if (process.env.SENTRY_DSN) {
    console.log('   Creating intentional event loop block (3 seconds)...');
    const start = Date.now();
    while (Date.now() - start < 3000) {
        // Block event loop intentionally for testing
    }
    console.log('   ✅ Event loop block completed - check Sentry for event loop block events');
} else {
    console.log('   ⚠️  Skipping event loop block test (no SENTRY_DSN provided)');
}

console.log('\n4. Testing memory monitoring...');
console.log(`   Current memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);

// Force garbage collection if available
if (global.gc) {
    global.gc();
    console.log('   🗑️  Forced garbage collection');
}

console.log('\n📊 Test Summary:');
console.log(`   ✅ Successful initializations: ${successCount}/${workerTypes.length}`);
console.log(`   ❌ Failed initializations: ${failureCount}/${workerTypes.length}`);

if (process.env.SENTRY_DSN) {
    console.log(`   🔗 Sentry DSN provided: ${process.env.SENTRY_DSN.slice(0, 50)}...`);
    console.log('   📡 Check your Sentry dashboard for test events and transactions');
} else {
    console.log('   ⚠️  No SENTRY_DSN provided - only testing initialization logic');
    console.log('   💡 Set SENTRY_DSN environment variable to test full integration');
}

console.log('\n✅ Sentry integration test completed');

// Exit after a short delay to allow Sentry to send events
setTimeout(() => {
    process.exit(0);
}, 2000);