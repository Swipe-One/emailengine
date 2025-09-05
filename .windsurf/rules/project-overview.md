---
trigger: always_on
---

This file provides guidance to Windsurf when working with code in this repository.

## Development Commands

### Development and Testing
- `npm run dev` - Start development server with verbose logging (port 7003)
- `npm run single` - Start single worker instance with debugging enabled
- `npm run gmail` - Start server configured for Gmail testing (2 workers, port 7003)
- `npm test` - Run full test suite (uses Grunt with Redis flush, server startup, and Node.js test runner)
- `npm run lint` - ESLint all source files
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check code formatting without modifying files

### Build and Distribution  
- `npm run build-source` - Clean build without dev dependencies
- `npm run build-dist` - Build executable binaries with pkg (compressed)
- `npm run build-dist-fast` - Build executable binaries (debug mode)

### Maintenance
- `npm run licenses` - Generate licenses.html from dependencies
- `npm run gettext` - Extract translatable strings to POT files
- `npm run update` - Update dependencies and regenerate static files

## Architecture Overview

EmailEngine is a self-hosted email automation platform that provides unified REST API access to IMAP, SMTP, Gmail API, and MS Graph API resources.

### Core Components

#### Main Server (`server.js`)
The main entry point that orchestrates worker threads and manages the overall application lifecycle. Key responsibilities:
- Worker thread management (IMAP, webhooks, document processing)
- License validation and upgrade checks
- Metrics collection and Prometheus endpoint
- Configuration management with wild-config

#### Workers (`workers/`)
Background processes handling specific tasks:
- **`api.js`** - REST API server (Hapi.js framework)  
- **`imap.js`** - IMAP connection management and email sync
- **`webhooks.js`** - Webhook delivery system
- **`documents.js`** - Document processing and AI operations
- **`submit.js`** - Email submission queue processing
- **`smtp.js`** - SMTP proxy server

#### Email Clients (`lib/email-client/`)
Protocol-specific email client implementations:
- **`base-client.js`** - Abstract base class with common functionality
- **`imap-client.js`** - Standard IMAP protocol implementation
- **`gmail-client.js`** - Gmail API integration
- **`outlook-client.js`** - Microsoft Graph API integration

#### Core Libraries (`lib/`)
- **`account.js`** - Account management and authentication
- **`tools.js`** - Utility functions and helpers
- **`routes-ui.js`** - Web UI routing and handlers  
- **`webhooks.js`** - Webhook management system
- **`schemas.js`** - Joi validation schemas
- **`oauth2-apps.js`** - OAuth2 provider configurations

### Database and Caching
- **Redis** - Primary data store for account states, message metadata, queues
- **BullMQ** - Job queue system built on Redis
- **ElasticSearch** (optional) - Full-text search and analytics

### Configuration System
- Uses `wild-config` for hierarchical configuration management
- Default config: `config/default.toml`
- Environment-specific overrides supported
- CLI arguments and environment variables override config files

### Testing Strategy
- Node.js built-in test runner (`node --test`)
- Grunt orchestrates test lifecycle (Redis flush, server startup, test execution)
- Tests located in `test/` directory
- 2-minute timeout for tests to accommodate external API operations

### Code Quality
- ESLint with custom configuration (formatting rules disabled for Prettier)
- Prettier for code formatting
- Pre-commit hooks may be present

## Development Notes

### Worker Scaling
Worker counts configurable via TOML config:
```toml
[workers]
imap = 4
webhooks = 1
imapProxy = 1
```

### Redis Dependencies
All functionality depends on Redis availability. Connection string format:
```
redis://127.0.0.1:6379/8
```

### License Validation
EmailEngine requires license validation for production use beyond 14-day trial. License checks occur during startup and periodic intervals.

### Email Protocol Support
- IMAP4rev1 via ImapFlow library
- SMTP via Nodemailer
- Gmail API via Google APIs
- Microsoft Graph API for Outlook/Exchange

### Security Considerations
- Secrets encrypted in Redis using configurable encryption key
- OAuth tokens stored encrypted
- Rate limiting implemented
- CORS configuration available
- Optional Basic Auth for API access