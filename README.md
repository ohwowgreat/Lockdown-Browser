# ExamLock

Browser-based lockdown exams for a classroom. Teachers build an exam, open it
with a join code, and watch a live monitor. Students join by name and code, the
exam goes fullscreen, and leaving the tab or window is flagged.

React 19 and Vite on the front end. Express 5, Socket.IO and SQLite on the back
end. One Node process serves the API, the socket, and the built frontend.

## Run

```bash
npm install
npm run dev        # Vite dev server on 5173 proxying to the API on 3001
npm run build      # production bundle into dist/
npm start          # serve dist/ and the API from one process
```

Environment variables, all optional:

| Variable | Purpose |
|---|---|
| `PORT` | API and static port, default 3001 |
| `DB_PATH` | SQLite file, default `server/examlock.db` |
| `UPLOADS_PATH` | Folder for uploaded question files, default `uploads/` |
| `JWT_SECRET` | Token signing secret. Set this in production. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Seed or promote a superadmin account on startup |

Node 20.19 or newer is required.

## Locked-down devices

ExamLock can see what happens in its own tab, not what floats above the
browser or sits on a second device. `docs/device-lockdown.md` lists the kiosk
and single-app options per platform, what each one buys, what to allow through
URL filters (the Desmos calculators load from `www.desmos.com`), and when a
native client would be worth building.

## Tests

```bash
npm test
```

Each test file starts its own server on a free port against a throwaway
database, so the suite never touches real data.

- `test/http.test.mjs` covers the API: student payload shape, session ownership,
  CSV export.
- `test/socket.test.mjs` covers Socket.IO access: who may join the live feed,
  what students receive, who may pause.
- `test/e2e.test.mjs` drives the built app in headless Chromium. It skips when
  Playwright is not available. To enable it either install Playwright as a dev
  dependency and its Chromium build:

  ```bash
  npm i -D playwright && npx playwright install chromium
  ```

  or point the suite at an existing install with `PLAYWRIGHT_PATH` and,
  if needed, `CHROMIUM_PATH`.
