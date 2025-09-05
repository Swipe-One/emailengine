# EmailEngine Sentry Integration

This document describes the Sentry instrumentation implemented across EmailEngine worker threads for monitoring unresponsive IMAP workers and CPU spikes in production.

## Overview

Sentry has been integrated across all EmailEngine worker threads with:
- **Full transaction sampling** (100% as requested)
- **Event loop block detection** for each worker type
- **HTTP request instrumentation** for API endpoints
- **Memory usage monitoring** and alerting
- **Worker-specific tagging** for precise debugging

## Configuration

### Environment Variables

Set the following environment variable to enable Sentry:

```bash
export SENTRY_DSN="https://your-sentry-dsn@sentry.io/project-id"
```

### Trace Sampling Configuration

Current configuration uses **100% sampling** as requested:
- `tracesSampleRate: 1.0` - Captures all transactions
- `profilesSampleRate: 1.0` - Profiles all operations

## Worker Thread Instrumentation

### 1. Main Process (`server.js`)
- **Worker Type**: `main`
- **Event Loop Threshold**: 500ms
- **Tags**: `server_type: emailengine_main`
- **Monitoring**: Process-level metrics and worker management

### 2. IMAP Worker (`workers/imap.js`)
- **Worker Type**: `imap`
- **Event Loop Threshold**: 1000ms
- **Tags**: `worker_process: imap_sync`, `critical_component: email_processing`
- **Special Features**:
  - Account assignment transaction monitoring
  - Connection pool tracking in context
  - Sync operation performance tracking

### 3. API Worker (`workers/api.js`)
- **Worker Type**: `api`
- **Event Loop Threshold**: 500ms
- **Tags**: `worker_process: api_server`, `critical_component: http_interface`
- **Special Features**:
  - HTTP request/response instrumentation
  - Route-specific transaction naming
  - API error capturing (500+ status codes)
  - Hapi.js integration with `onRequest` and `onPreResponse` handlers

### 4. Webhooks Worker (`workers/webhooks.js`)
- **Worker Type**: `webhooks`
- **Event Loop Threshold**: 750ms
- **Tags**: `worker_process: webhook_delivery`, `critical_component: notification_system`
- **Features**: HTTP instrumentation for outbound webhook requests

### 5. Documents Worker (`workers/documents.js`)
- **Worker Type**: `documents`
- **Event Loop Threshold**: 1500ms (higher for AI operations)
- **Tags**: `worker_process: document_processing`, `critical_component: ai_operations`

### 6. Submit Worker (`workers/submit.js`)
- **Worker Type**: `submit`
- **Event Loop Threshold**: 1000ms
- **Tags**: `worker_process: email_submission`, `critical_component: smtp_delivery`

### 7. SMTP Worker (`workers/smtp.js`)
- **Worker Type**: `smtp`
- **Event Loop Threshold**: 1000ms
- **Tags**: `worker_process: smtp_proxy`, `critical_component: email_relay`

### 8. IMAP Proxy Worker (`workers/imap-proxy.js`)
- **Worker Type**: `imap-proxy`
- **Event Loop Threshold**: 750ms
- **Tags**: `worker_process: imap_proxy`, `critical_component: imap_relay`

## Key Features

### Event Loop Block Detection

Each worker monitors for event loop blocking with thresholds appropriate for their workload:
- API: 500ms (fast response required)
- IMAP: 1000ms (allows for sync operations)
- Documents: 1500ms (AI operations can be slow)

### Memory Monitoring

Automatic memory usage tracking every minute:
- Heap usage percentage
- Memory pressure alerts when usage > 90%
- Context includes active connections and accounts

### Error Handling

- Automatic exception capture with worker context
- Fallback to existing Bugsnag integration
- Sensitive data filtering (passwords, tokens, API keys)

### Transaction Monitoring

Critical operations instrumented with transactions:
- **IMAP**: Account assignment, connection management
- **API**: HTTP requests with method and endpoint
- **Worker Operations**: Custom transactions for key processes

## Usage Examples

### Testing Integration

```bash
# Test without Sentry (validates initialization logic)
node test-sentry.js

# Test with Sentry (sends actual events)
SENTRY_DSN="your-dsn" node test-sentry.js
```

### Monitoring Specific Operations

The IMAP worker includes transaction monitoring for account assignments:

```javascript
// Example: IMAP account assignment transaction
const transaction = startWorkerTransaction(
    'imap.account.assign',
    'imap_worker_operation',
    { 
        account: 'user@example.com',
        run_index: 1,
        total_accounts: 5 
    },
    'imap'
);
```

### Debugging Unresponsive Workers

Look for these Sentry events to identify worker issues:

1. **Event Loop Blocks**: Look for events tagged with specific worker types
2. **High Memory Usage**: Search for "High memory usage detected" messages
3. **Transaction Timeouts**: Filter transactions by duration
4. **Connection Failures**: Exception events with operation context

## Dashboard Queries

### Useful Sentry Queries

1. **IMAP Worker Performance**:
   ```
   transaction:imap.account.assign AND worker_type:imap
   ```

2. **Event Loop Blocks by Worker**:
   ```
   message:"Event loop block detected" AND worker_type:*
   ```

3. **Memory Pressure Issues**:
   ```
   message:"High memory usage detected"
   ```

4. **API Performance**:
   ```
   transaction.op:http.server AND worker_type:api
   ```

## Troubleshooting

### Common Issues

1. **No Events in Sentry**:
   - Verify `SENTRY_DSN` is set correctly
   - Check network connectivity to Sentry
   - Look for "Sentry not initialized" messages in logs

2. **Missing Worker Context**:
   - Ensure worker threads are starting after Sentry initialization
   - Check that worker-specific tags are being set

3. **Performance Impact**:
   - Monitor CPU usage with 100% sampling
   - Consider reducing `tracesSampleRate` if needed for production

### Debug Mode

Enable debug logging in development:

```bash
NODE_ENV=development SENTRY_DSN="your-dsn" npm run dev
```

## Next Steps

1. **Deploy with Environment Variable**: Set `SENTRY_DSN` in production
2. **Monitor Initial Data**: Watch for event loop blocks and memory issues
3. **Adjust Thresholds**: Fine-tune event loop thresholds based on production data
4. **Custom Dashboards**: Create Sentry dashboards for specific metrics
5. **Alerting**: Set up alerts for critical issues (worker unresponsiveness, memory pressure)

## Architecture Benefits

This instrumentation provides:
- **Thread-level visibility** into worker performance
- **Precise identification** of problematic operations
- **Memory leak detection** across all workers
- **HTTP request tracing** for API performance
- **Production debugging** capabilities for the 400+ account deployment

The integration maintains compatibility with existing Bugsnag setup and provides detailed context for debugging unresponsive IMAP workers and CPU spikes in production.