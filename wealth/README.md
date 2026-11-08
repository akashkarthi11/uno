# Karthi Portfolio — Wealth Ledger

Standalone Vercel app. Required environment variables:
- WEALTH_DATABASE_URL: dedicated Neon PostgreSQL connection string (recommended separate database/schema role)
- WEALTH_SESSION_SECRET: random secret with at least 32 characters

Deploy from this repository with Root Directory `wealth`, Node.js 20+, no build command. API routes initialize isolated `wealth_users` and `wealth_transactions` tables. Every ledger query is scoped by authenticated user UUID. Do not point this app at a production database until the DB role is restricted to the wealth tables and backups are enabled.

This first release is a ledger foundation, not bank sync, market-price tracking, tax advice, or a full asset valuation engine.