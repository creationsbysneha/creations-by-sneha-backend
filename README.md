# Creations by Sneha API

Express API for studio login, invitation drafts, publishing, and photographs. Drafts live in Neon. Published invitations and their photographs live on Cloudflare R2. Guests open `/invite/:slug` from the public bucket and do not call this API.

## Local development

```bash
npm install
npx prisma generate
npm run db:deploy
npm run dev
```

Copy `.env.example` to `.env`. Put the Neon connection string in `DATABASE_URL`. That file is gitignored.

Studio logins are stored in Neon. There is no public registration. Add another studio login with `npm run admin:create` if you need one. That command reads `ADMIN_EMAIL` and `ADMIN_PASSWORD`. The password must be at least 12 characters and include a letter and a number. The command refuses to replace an existing administrator.

The API listens on port 4000. Sessions last `SESSION_TTL_HOURS` (12 by default), use an HttpOnly `SameSite=Lax` cookie, and require the `X-CSRF-Token` returned by login on every change. `FRONTEND_ORIGIN` is the only browser origin allowed to send credentials.

## Logging

`npm run dev` prints colorized pino logs. Production (`NODE_ENV=production`) writes JSON.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOG_LEVEL` | `debug` in development, `info` in production | Minimum level (`debug`, `info`, `warn`, `error`) |
| `LOG_HTTP_REQUESTS` | `true` | One line per request: method, path, status, duration, request id |
| `LOG_DATABASE_QUERIES` | `false` | Prisma query duration (no SQL parameters) |
| `LOG_R2_OPERATIONS` | `true` | Uploads, copies, deletes, missing objects, purge |
| `LOG_AUTH_EVENTS` | `true` | Sign-in, session, and authorization denials |

Passwords, cookies, tokens, database URLs, and R2 credentials are redacted. Request bodies are not logged.

## Storage

`STORAGE_DRIVER=r2` uses two Cloudflare R2 buckets:

- `creationsbysneha-assets` (`R2_BUCKET_NAME`) — published JSON and published photographs
- `creationsbysneha-private` (`R2_PRIVATE_BUCKET_NAME`) — draft uploads only

The API token needs Object Read and Write on those two buckets only. Credentials stay in the backend `.env`. Do not put them in the frontend.

`STORAGE_DRIVER=local` writes the same key layout under `storage/private` and `storage/public`, and serves the public folder at `/dev-public`. Use this only when you do not have R2 credentials.

`STORAGE_DRIVER=s3` is no longer used.

## Publishing

Saving a draft writes Neon only. It never changes the live JSON or public photographs.

**Publish** / **Publish changes** (studio logins only):

1. Checks the title, a unique lowercase slug, both couple names, the wedding date, and the venue name.
2. Copies each used photograph from the private bucket to a content-hashed public key (`media/{id}/{checksum16}.webp`) with `Cache-Control: public, max-age=31536000, immutable`. Existing public bytes are never overwritten.
3. Uploads `published/{slug}.json` with `Cache-Control: public, max-age=60, must-revalidate`.
4. Records the publication in Neon only after the upload succeeds. If the database write fails, the previous live JSON is put back.

Unpublishing deletes `published/{slug}.json` first. If that delete fails, the card stays published. Deleting a card does the same, then removes the draft.

Guests fetch `{R2_PUBLIC_BASE_URL}/published/{slug}.json` directly. The JSON contains absolute public image URLs. It never contains signed URLs, `/api/media` paths, passwords, or draft-only fields.

`GET /api/media/:id` is signed-in only, for studio previews.

## Cloudflare settings that stay manual

1. Create `creationsbysneha-assets` (public) and `creationsbysneha-private` (private).
2. Connect a custom domain to the public bucket for production. The `r2.dev` address is rate-limited and is for development only.
3. Public bucket CORS: GET and HEAD from the real site origins. No PUT, POST, or DELETE from the browser. Apply the current origins with `npm run r2:cors`.
4. Add a cache rule so `/published/*.json` is cached and respects the origin 60-second header.
5. Do not add lifecycle delete rules on either bucket.
6. Optionally create a zone purge token (`CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN`) so republish and unpublish drop the cached JSON immediately.

Check the buckets with `npm run r2:check`. That command writes and deletes a short probe object. It prints statuses only.

## Import and cleanup

`npm run db:import-json` reports what would be copied from `data/store.json`. Add `--apply` to write. It does not create new studio logins. Previously published cards are imported as drafts and must be published again.

`npm run storage:cleanup` is a dry run. Add `--apply` to delete confirmed orphans older than `STORAGE_CLEANUP_GRACE_HOURS` (48 by default). It never empties a bucket and never deletes by prefix. Studio logins can also post `{ "apply": false }` to `/api/admin/storage/cleanup`.

Do not run `--apply` until import, access, and publishing have been checked.

## Checks

```bash
npm run lint
npm test
npm run build
npm run db:status
```
