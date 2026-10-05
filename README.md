# Vista

Vista is a local-first data visualization studio. Import or paste a table, review its detected column types, explore chart recommendations, filter and customize visualizations, and save projects in the browser.

## Requirements

- Node.js 20 or later
- npm

## Run locally

```sh
npm install
npm run dev
```

## SaaS local setup

The current deployment is local-first; login, account creation, and cloud workspace access are disabled in the interface. The API and account implementation are retained. To run the SaaS backend locally when re-enabled:

1. Create a PostgreSQL database and copy `.env.example` to `.env`.
2. Set `DATABASE_URL` and generate an `AUTH_SECRET` with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
3. Configure SMTP before registering users; verification, recovery, and invitations use real email delivery.
4. Run `npm run db:migrate` once, then `npm run dev`. The development command starts the API and Vite together; `/api/health` reports whether the database is available.
5. Configure Stripe recurring price IDs, webhook signing secret, and S3-compatible credentials only when those integrations are ready. Without them, billing and object storage operations return explicit unavailable errors rather than simulated success.

Signing in does not upload or delete browser projects. Open **Conta**, select an organization, choose whether new saves should use cloud storage, then explicitly select local projects to copy. Local originals remain in the browser after migration.

## Validate

```sh
npm test
npm run build
```

## Features

- Editable tables, direct spreadsheet paste, and CSV, JSON, XLS, and XLSX import (20 MB file limit).
- Automatic profiles for numeric, categorical, text, boolean, date, and date-time columns; detected types can be corrected.
- Recommendations for comparisons, trends, proportions, distributions, relationships, and statistical summaries.
- Interactive chart editing, aggregation, sorting, Top N, Brazilian number formats, and equality, range, and text filters.
- Local projects with save, reopen, duplicate, rename, delete, and a multi-chart dashboard with reordering and card resizing. Projects are stored in IndexedDB, with automatic migration from older browser storage and a three-project limit per browser.
- JSON backups up to 100 MB to download and restore projects between browsers; restoration validates the backup and never partially imports when the project limit would be exceeded.
- Installable offline app shell on production builds. After the first online visit has completed caching, the interface can reopen offline; the local editor and saved projects remain on that device.
- Export filtered data as CSV, charts as SVG/PNG, and browser print-to-PDF. CSV cells that could be interpreted as spreadsheet formulas are escaped on export.
- Portuguese-first interface with a locale selector and a separate message catalog for localization.

## Data and sharing

The offline, local-first app works without an account or server. Projects are stored in this browser's IndexedDB; clearing site data or using another browser/device removes or does not include them. Use **Meus projetos → Baixar backup** to keep a portable JSON copy and **Restaurar backup** to bring it back. The browser-local project limit is three. Offline app files are cached after the first successful online load; opening the app offline does not make the initial download work without a connection.

With cloud mode, projects, datasets, and visualizations are stored in the selected PostgreSQL-backed organization.

Local sharing copies a URL-encoded snapshot into the link fragment. Cloud sharing uses a revocable opaque token; the dataset is not embedded in the URL. Anyone who has an active cloud share link can view its project until it is revoked or expires.

Spreadsheet parsing is loaded only when an XLS/XLSX file is imported; XLS/XLSX import reads the first worksheet. CSV, JSON, chart analysis, and saved projects run locally in the browser.
