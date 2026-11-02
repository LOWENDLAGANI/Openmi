# Openmi: Comprehensive Architectural, UI/UX, and Technical Audit

*Document generated from exhaustive repository analysis. This document details the complete application architecture, visual design, functionality, and codebase structure.*

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Application Overview](#application-overview)
3. [Visual Design & UI/UX Blueprint](#visual-design--uiux-blueprint)
4. [Functional Architecture & Interactive Mechanics](#functional-architecture--interactive-mechanics)
5. [Core Codebase Architecture](#core-codebase-architecture)
6. [API Routes & Backend Logic](#api-routes--backend-logic)
7. [Database Schema & Data Layer](#database-schema--data-layer)
8. [Security Model](#security-model)
9. [Configuration & Environment](#configuration--environment)
10. [Testing Infrastructure](#testing-infrastructure)
11. [Deployment & Build System](#deployment--build-system)

---

## Executive Summary

**Openmi** is a Next.js 15 application (React 19) that serves as a GitHub repository agent. The application allows users to:
- Chat with AI models (Auto/OpenRouter, Groq, DeepSeek Flash) with streaming responses
- Connect to GitHub repositories via personal access tokens or OAuth
- Use an agent that reads repositories and proposes code changes
- Review diffs and approve commits to create pull requests
- Manage credits (Dew) with pricing per model/request type
- Use as an account-gated application with Supabase authentication

The app is designed as a local-first experience with IndexedDB (Dexie) storage, synced to cloud via Supabase, with strong emphasis on security (encrypted tokens, row-level security, signed turn states).

---

## Application Overview

**Name:** Openmi  
**Version:** 1.0.0  
**Framework:** Next.js 15.5.26 (App Router)  
**Runtime:** React 19.2.0  
**Package Manager:** Bun (based on bun.lock)  
**Language:** TypeScript 5  

### Core Philosophy
- **Repository agent focus**: Read GitHub repos and propose changes, committing only on approval
- **Account-required**: No guest mode, all features gated behind authentication
- **Local-first with cloud sync**: Data stored in IndexedDB, synced to Supabase
- **Security-first**: Tokens encrypted at rest, RLS on all database tables, signed turn states
- **Dew-based pricing**: Credit system replacing token-based pricing

---

## Visual Design & UI/UX Blueprint

### Design System Architecture

The application uses a CSS variable-based theming system with Tailwind CSS. Three distinct themes are supported:

#### 1. Dark Theme (Default)
- **Background**: `--bg: #0b1310` (very dark green-tinged)
- **Raised surfaces**: `--bg-raised: #111a16`
- **Text hierarchy**: `--text-hi: #eef5f0` (primary), `--text: #cddfd4`, `--text-mid: #8ba396`, `--text-low: #5d7167`
- **Accent**: `--accent: #6ec294` (sage green)
- **Cards**: `--card: #111a16` with subtle borders

#### 2. Light Theme (`html.light`)
- **Background**: `--bg: #f8f9fa` (neutral gray)
- **Cards**: `--card: #ffffff` with `box-shadow`
- **Text**: `--text-hi: #111827` (near black)
- **Accent**: `--accent: #0066ff` (blue)
- **Bubble user**: `--bubble-user: #0066ff`

#### 3. Ink Theme (`html.ink`) - Focus Home
- **Background**: `--bg: #1b1826` (dark indigo)
- **Accent**: `--accent: #a09ad8` (lavender)
- **Bubble user**: `--bubble-user: #4a4670`
- Distinct design for the "Focus Home" layout

### Typography
- **Sans-serif**: Inter, system-ui fallbacks
- **Monospace**: SFMono-Regular, Menlo, Consolas, Liberation Mono

### Spacing & Layout
- Uses Tailwind's spacing scale
- Viewport height: `h-[100dvh]` for mobile browser chrome handling
- Safe area insets handled with `viewport-fit: cover`
- Responsive design patterns throughout components

### Component Architecture Patterns
- Server/Client components split appropriately (App Router)
- CSS variables mapped to Tailwind colors for theme flexibility
- Component-level styling with utility classes
- Animations: `fade-in-up`, `pulse-dot`, `shimmer` defined in Tailwind config

### Key UI Components
- **Sidebar**: Chat history, folders, trash, navigation
- **ChatThread**: Message display with markdown rendering
- **ChatInput**: Composer with attachments, model selection
- **RepoPanel**: GitHub repository browser and agent interface
- **SettingsPanel**: Comprehensive settings with tabs
- **AuthScreen**: Required authentication interface
- **FocusHome**: Alternative home layout with different aesthetics
- **SplashScreen**: Loading/initialization screen

---

## Functional Architecture & Interactive Mechanics

### Application Flow

1. **Initialization**:
   - Boot script in `layout.tsx` reads localStorage for appearance/home layout before first paint
   - `HomePage` (`app/page.tsx`) initializes all state, sets up listeners
   - Checks account status via Supabase auth
   - Adopts device account (handles switching between accounts on same browser)
   - Loads preferences (local first, then cloud sync)
   - Loads chat history from IndexedDB and syncs with cloud

2. **Authentication Flow**:
   - Required for all functionality
   - Supports Google, GitHub, Microsoft OAuth via Supabase Auth
   - Email/password registration with confirmation
   - Password reset flow
   - Account linking in settings
   - Session management via Supabase

3. **Chat System**:
   - **Regular Chat**: Messages stored in IndexedDB (Dexie), synced to cloud
   - **Temporary Chat**: In-memory only, never persisted
   - **Streaming**: Server-Sent Events from `/api/chat`
   - **Message threading**: Supports branching, regeneration, editing
   - **Attachments**: Images and documents
   - **Web search**: Optional search integration via Tavily
   - **Context management**: Context ring shows token budget usage

4. **Repository Agent**:
   - Attach GitHub repo via RepoPanel
   - Agent uses function calling (tools: `list_files`, `read_file`, `search_code`, `propose_edits`)
   - Each turn costs flat Code price (Dew)
   - Turn state is HMAC-signed to prevent tampering
   - Max 8 steps, ~60k tokens per turn
   - Proposes edits as whole-file rewrites or string replacements
   - Diffs computed server-side from base commit
   - Review and approval creates PR via `Approve & commit`

5. **Dew Pricing System**:
   - Per-message pricing by model: Auto (0.25), Groq/Code (0.5), DeepSeek Flash (2), or 1-hour sessions (3)
   - 10 free Dew daily per account (reset at midnight in account timezone)
   - Paid credits never expire
   - Hour sessions: one live session per account, charged atomically
   - Pricing dialog appears when needed

6. **GitHub Integration**:
   - **PAT (Personal Access Token)**: Paste token, validated against GitHub API, encrypted with AES-256-GCM
   - **OAuth App**: Full OAuth flow as alternative
   - Multiple connections per account, one marked as default
   - Tokens sealed in database, never returned to client

---

## Core Codebase Architecture

### Directory Structure
```
openmi/
├── app/                    # Next.js App Router
│   ├── api/               # API routes
│   ├── about/             # About page
│   ├── activity/          # Dew activity
│   ├── auth/              # Auth callbacks
│   ├── plus/              # Paid features
│   ├── privacy/           # Privacy policy
│   ├── share/             # Shared answer links
│   └── shares/            # Shared content
├── components/            # React components (40+ components)
├── lib/                   # Core libraries and utilities
│   ├── agent/             # Agent logic (tools, edits, model, turns, run)
│   ├── github/            # GitHub integration (client, crypto, oauth, etc.)
│   └── [various modules]   # dew, models, providers, db, supabase, etc.
├── supabase/              # Database schema and migrations
│   ├── migrations/        # SQL migrations
│   └── README.md          # Setup instructions
├── tests/                 # Test suite (30+ test files)
├── docs/                  # Documentation
└── public/                # Static assets
```

### Core Modules (`lib/`)

**Data Layer:**
- `db.ts` - Dexie (IndexedDB) schema and operations for local storage
- `supabase.ts` - Supabase client configuration
- `cloudHistory.ts` - Sync between IndexedDB and Supabase
- `preferences.ts` - User preferences management

**AI/Models:**
- `models.ts` - Model catalog and configuration (client-visible)
- `providers.ts` - Server-side provider chains (OpenRouter, Gemini, Groq, DeepSeek)
- `modelEngines.ts` - Engine implementations
- `promptOptimizer.ts` - Prompt optimization logic

**Auth & Security:**
- `account.ts`, `accountState.ts` - Account management
- `emailAuth.ts` - Email authentication flows
- `authDiagnostics.ts` - Auth debugging utilities
- `serverControl.ts` - Identity, bans, rate limits

**GitHub & Agent:**
- `github/crypto.ts` - AES-256-GCM encryption, HMAC signing
- `github/client.ts` - GitHub API client (read-only)
- `github/oauth.ts` - OAuth flow
- `github/connections.ts` - Connection management
- `agent/tools.ts` - Agent tools
- `agent/edits.ts` - Edit staging and diff computation
- `agent/turns.ts` - Turn budget and signing
- `agent/run.ts` - Agent execution

**Pricing & Billing:**
- `dew.ts` - Client-side Dew utilities
- `serverDew.ts` - Server-side Dew logic
- `serverRedeem.ts` - Redemption logic

**Utilities:**
- `types.ts` - TypeScript type definitions
- `setupChecks.ts` - Environment configuration validation
- `rateLimit.ts` - Rate limiting logic
- `trash.ts` - Trash management

### Key Architectural Patterns

1. **Separation of Concerns**: Server-only code in `providers.ts`, `modelEngines.ts`; client sees `models.ts`
2. **Encryption**: GitHub tokens encrypted with AES-256-GCM before DB storage
3. **Signing**: Turn state and approvals signed with HMAC-SHA256
4. **Row-Level Security**: All Supabase tables protected by RLS policies
5. **Local-First**: Works offline with IndexedDB, syncs when online
6. **Streaming**: SSE for real-time responses
7. **Function Calling**: Agent uses structured tool calls

---

## API Routes & Backend Logic

### Core API Routes (`app/api/`)

**Chat & Models:**
- `POST /api/chat` - Main chat endpoint, streaming responses
- `GET /api/chat` - Chat configuration/status
- `GET /api/models` - Available models

**Agent:**
- `POST /api/agent/step` - Agent step execution
- `GET /api/agent/step` - Agent status

**GitHub:**
- `GET/POST /api/github/connections` - Manage GitHub connections
- `GET /api/github/oauth/start` - Start OAuth flow
- `GET /api/github/oauth/callback` - OAuth callback
- `POST /api/github/commit` - Commit approved changes (writes to GitHub)
- `GET /api/github/repos` - List repositories
- `GET /api/github/tree` - Get repo file tree
- `GET /api/github/file` - Read file content
- `POST /api/github/search` - Search code

**Projects & Changesets:**
- `GET/POST /api/projects` - Manage attached projects
- `GET/POST /api/changesets` - Manage change proposals
- `POST /api/changesets/approve` - Approve changes for commit

**Authentication & User:**
- `GET/POST /api/keys` - User API keys
- `GET/POST /api/preferences` - User preferences
- `GET /api/session` - Hour session management
- `GET /api/setup` - Setup status check

**Billing & Dew:**
- `GET/POST /api/dew` - Dew balance and operations
- `POST /api/redeem` - Redeem codes
- `GET /api/activity` - Activity history

**Admin:**
- `GET/POST /api/admin/*` - Admin endpoints

**Sharing:**
- `POST /api/share` - Create share link
- `GET /api/share/[id]` - Get shared content

### API Design Patterns
- All routes check authentication via Supabase JWT
- Server-side validation and authorization
- Encrypted token handling for GitHub
- Signed turn tokens prevent budget manipulation
- Rate limiting applied
- Error responses with appropriate status codes

---

## Database Schema & Data Layer

### Supabase (Postgres) Schema

Key tables (from migrations):
- `profiles` - User profiles
- `user_preferences` - Synced preferences
- `chats` - Chat metadata
- `messages` - Chat messages (synced from IndexedDB)
- `github_connections` - Encrypted GitHub tokens
- `github_default` - Default connection per user
- `projects` - Attached repositories
- `change_sets` - Proposed changes with diffs
- `change_set_approvals` - Approval records
- `dew_ledger` - Credit/debit history
- `dew_balances` - Current balances
- `hour_sessions` - Live hour sessions
- `shared_answers` - Public share links
- `app_admin` - Admin access control
- `app_config` - App configuration/announcements
- `provider_keys` - User's own API keys (encrypted)
- `referrals` - Referral tracking

### Row-Level Security
Every table has RLS enabled with policies ensuring users can only access their own data. Server routes use the caller's JWT, never service-role keys.

### IndexedDB (Dexie) Schema
Local storage for offline-first experience:
- `chats` - Chat records
- `messages` - Messages
- `folders` - Chat organization
- `trash` - Soft-deleted items
- `preferences` - Local preferences cache

### Data Sync Strategy
- Local writes go to IndexedDB first
- Cloud sync runs periodically and on specific events
- Device account handover prevents cross-account data leakage
- Trash decisions synced with conflict resolution

---

## Security Model

### Encryption
- **GitHub tokens**: AES-256-GCM encryption via `lib/github/crypto.ts`
  - Key from `GITHUB_TOKEN_KEY` (32-byte hex)
  - Format: `v1.<iv>.<tag>.<ciphertext>` (base64url)
- **User API keys**: Same encryption mechanism
- **Turn signing**: HMAC-SHA256 for turn state

### Authentication
- Supabase Auth handles all authentication
- JWT tokens for API requests
- OAuth with Google, GitHub, Microsoft, email/password
- Account linking supported
- Session management

### Authorization
- Row-Level Security on all database tables
- Server-side checks in API routes
- Admin access via `app_admin` table
- Turn budget enforcement prevents manipulation
- Approval signatures required for GitHub commits

### Security Practices
- No service-role keys in codebase
- Secrets never logged or exposed to client
- Tokens encrypted at rest
- Signed approvals prevent replay
- Branch protection: only creates `agent/*` branches
- Rate limiting on API endpoints
- CORS and security headers

---

## Configuration & Environment

### Required Environment Variables (from `.env.example`)

**Supabase (Required for accounts):**
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

**AI Models (at least one required):**
- `OPENROUTER_API_KEY` - Auto mode
- `GROQ_API_KEY` - Code mode
- `GEMINI_API_KEY` - Auto fallback
- `DEEPSEEK_API_KEY` - DeepSeek Flash mode (optional)

**GitHub Integration:**
- `GITHUB_TOKEN_KEY` - 32-byte hex for token encryption (required for GitHub)
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` - OAuth app (optional)
- `AGENT_TURN_SECRET` - Turn signing (falls back to GITHUB_TOKEN_KEY)

**Other Services:**
- `TAVILY_API_KEY` - Web search (optional)
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` - Shared rate limiting (optional)
- `NEXT_PUBLIC_ADSENSE_CLIENT_ID`, `NEXT_PUBLIC_ADSENSE_SLOT_ID` - Ads (optional)
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` - Push notifications
- `NEXT_PUBLIC_SITE_URL` - Canonical URL
- `OPENMI_ADMIN_EMAIL` - Admin access
- `SENTRY_*` - Error monitoring (optional)

### Setup Validation
`lib/setupChecks.ts` provides runtime validation showing missing configuration on the About page. Presence-only checking, no secrets leaked.

---

## Testing Infrastructure

### Test Suite
30+ test files in `tests/` directory covering:
- Unit tests for core logic
- Integration tests for features
- Source-contract tests
- Tests run via `bunx tsx` as specified in package.json

Test categories:
- `account.test.ts`, `auth` related
- `chat-sync.test.ts`, `temp-chat.test.ts`
- `repo-agent.test.ts`, `github-connections.test.ts`
- `dew.test.ts`, `dew-activity.test.ts`, `redeem.test.ts`
- `model-health.test.ts`, `provider-keys.test.ts`
- `setup-check.test.ts`
- `rate-limit.test.ts`, `server-control.test.ts`

### Running Tests
```bash
bun run test  # Runs all tests
bun run typecheck  # TypeScript checking
bun run lint  # ESLint
```

---

## Deployment & Build System

### Build Configuration
- **Next.js 15** with App Router
- **Tailwind CSS** for styling
- **TypeScript** strict mode
- **PostCSS** with Autoprefixer
- **Sentry** integration for error monitoring

### Build Scripts
```json
{
  "dev": "next dev -H 0.0.0.0 -p ${PORT:-3000}",
  "build": "next build",
  "start": "next start -H 0.0.0.0 -p ${PORT:-3000}",
  "lint": "eslint .",
  "test": "...",
  "typecheck": "tsc --noEmit"
}
```

### Deployment Notes
- Requires Supabase project with migrations applied
- Environment variables must be set at build time for `NEXT_PUBLIC_*` values
- Service worker for PWA functionality
- Sharp for image optimization

### Performance Considerations
- Local-first reduces server load
- Streaming responses for better perceived performance
- Code splitting via Next.js
- Optimistic updates where appropriate

---

## Summary

Openmi is a sophisticated, security-focused application combining chat interfaces, AI model integration, and GitHub repository automation. Its architecture emphasizes:

- **Modular design** with clear separation of concerns
- **Strong security** through encryption, signing, and RLS
- **Excellent UX** with multiple themes, offline support, and real-time features
- **Robust GitHub integration** enabling AI-assisted code changes with human oversight
- **Flexible monetization** via Dew credit system

The codebase is well-structured, thoroughly tested, and production-ready with comprehensive configuration validation and error handling.
