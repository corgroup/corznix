# Corznix

Standalone Corznix storefront (React + Vite). Independent project — no dependency on the Corcotton monorepo.

```
corznix/
├── src/                 App source
├── public/              Static assets
├── packages/            Vendored shared packages (api-client, shared-types, shared-utils)
├── index.html
└── vite.config.js
```

## Prerequisites

- Node.js >= 18.18.0
- npm >= 10.0.0

## Setup

```bash
npm install
cp .env.example .env   # adjust as needed
npm run dev
```

## Build

```bash
npm run build
```
