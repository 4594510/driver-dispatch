# The feedback check (for Claude)

Admins write comments, complaints, suggestions and requests on the dashboard (Feedback tab); the driver writes them in
the app (More → Comment, complaint or request). Each one is a row in the `feedback` table. Claude reads and answers
them through `/api/feedback` with the feedback key (below).

## The key

The key is `FEEDBACK_KEY` on the Railway service when set; otherwise the server makes one from `GOOGLE_MAPS_API_KEY`,
which the server and Claude's cloud sessions both hold. `scripts/feedback.mjs` uses the same key and never prints
it, so a cloud session needs nothing extra:

```sh
node scripts/feedback.mjs list                 # new items, oldest first
node scripts/feedback.mjs list new,needs_you
node scripts/feedback.mjs set <id> working "Looking at it."
```

Run `npm install` once first. In a cloud session, run Node with `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` so it can
reach the server. Never print the key in chat, a commit, an issue or a PR.

## Each check

1. `node scripts/feedback.mjs list` (GET /api/feedback?status=new, oldest first).
2. For each item, mark it taken: `node scripts/feedback.mjs set <id> working "Looking at it."`.
3. Do what it asks:
   - A change to the system: make it on a new branch with tests (`npm test`), open a pull request, and link it in
     the reply. Do not merge: main deploys to the live server.
   - Data the admin can change on the dashboard (families, places, PINs, settings): say where, in the reply.
   - A complaint about a ride: look at the booking and the audit log, and reply with what happened.
   - Something only Shloime can do (a key, a phone setting, a payment, a choice): status `needs_you` and a reply
     that says exactly what, in one or two plain steps.
4. Finish with `set <id> done "<what was done, with the PR link>"`, or `declined` with the reason when it
   can't or shouldn't be done (against the seating or service rules, unsafe, unclear: ask in the reply).
5. Report to Shloime: one short message listing what was done and what needs him. Nothing new: say nothing.

Statuses: `new`, `working`, `needs_you`, `done`, `declined`. The writer sees the reply on the dashboard or in the app.
