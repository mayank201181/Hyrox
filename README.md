# Hyrox

**Can You Do HYROX?**: an unofficial readiness check for friends who train about five times a week, deployed on Vercel.

- `index.html`: the five qualities HYROX tests, a ten-question test with a scored verdict (Ready / Close / Team / Not yet), the course with 2026/27 Open weights, formats, an 8-week plan and a countdown to AIA HYROX Singapore. Each person enters their name before the test; their result is saved under that name when they finish.
- `results.html` (served at `/results`): passcode-protected board for the owner, showing everyone's score, verdict, quality breakdown, attempts and answers, with delete.
- `api/results.js`: Vercel Function. `POST` saves a result (one private JSON blob per name, latest attempt wins, last 10 scores kept); `GET` lists all results and `DELETE ?slug=` removes one. Both need the `x-results-key` header.

## Setup on Vercel

1. Connect a **private Vercel Blob store** to the project (Storage → Create → Blob). This adds `BLOB_READ_WRITE_TOKEN`; redeploy afterwards. Until then the API answers `503` and the page keeps answers on the device and retries on the next visit.
2. The owner passcode is stored as a salted scrypt hash in the private Blob store (`hyrox/config/passcode.json`), never in this public repo. Change it with `PUT /api/results` and body `{"passcode": "..."}`, sending the current passcode in `x-results-key`. Before one has been set, `RESULTS_KEY` (if present) or the long built-in passcode hashed in `api/results.js` works.

After 30 wrong passcodes in an hour, every passcode is refused until the hour is up. At most 30 different names are accepted.
