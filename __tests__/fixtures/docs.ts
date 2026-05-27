// Fixture: README with a Redux state management section
export const README_WITH_REDUX = `
# My App

A simple shopping cart application.

## Getting Started

Install dependencies with \`npm install\` and run \`npm start\`.

## State Management

We use Redux Toolkit with createSlice for all global state. The cart state is managed
in \`src/store/cart.ts\` using a \`cartSlice\` with reducers for adding and removing items.

\`\`\`typescript
import { createSlice } from '@reduxjs/toolkit';
const cartSlice = createSlice({ name: 'cart', ... });
\`\`\`

The Redux store is provided at the root of the app via \`<Provider store={store}>\`.

## API

All API calls go through \`src/api/client.ts\`.

## Database

We use PostgreSQL as our primary datastore, accessed via the \`pg\` library.
Connection is managed via \`Pool\` from the \`pg\` package.
`.trim();

// Fixture: ARCHITECTURE.md with API versioning section
export const ARCHITECTURE_WITH_V1_API = `
# Architecture

## Overview

A monolithic Node.js application with an Express REST API.

## API Versioning

All API endpoints are versioned under \`/api/v1/\`. The users endpoint is at
\`/api/v1/users\` and returns paginated results.

## Authentication

JWT tokens are used for all authenticated endpoints.

## Database

PostgreSQL is our primary database. We use raw SQL via the \`pg\` library.
No ORM is used — all queries are hand-written for performance.
`.trim();

// Fixture: doc with no relevant content (should produce no candidates)
export const UNRELATED_CHANGELOG = `
# Changelog

## v1.2.0

- Fixed a typo in the login button
- Updated dependencies

## v1.1.0

- Initial release
`.trim();

// Fixture: README with a configuration table mentioning model defaults
export const README_WITH_CONFIG_TABLE = `
# Knowledge Diff

A GitHub Action that detects documentation drift.

## Configuration

| Input | Default | Description |
|---|---|---|
| \`llm-provider\` | \`openai\` | LLM backend: \`openai\`, \`anthropic\`, or \`gemini\`. |
| \`llm-model\` | \`gpt-4o\` / \`claude-3-5-sonnet-20241022\` / \`gemini-2.5-flash\` | Override the model. |
| \`sensitivity\` | \`medium\` | Drift threshold: \`low\`, \`medium\`, \`high\`. |

## How It Works

The action parses the PR diff and matches code changes against documentation sections.
`.trim();
