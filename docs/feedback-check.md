# The feedback check (for Claude)

Admins write comments, complaints, suggestions and requests on the dashboard (Feedback tab); the driver writes them in
the app (More → Comment, complaint or request). Each one is a row in the `feedback` table. Claude reads and answers
them through `/api/feedback`, with the key in the `FEEDBACK_KEY` variable on the Railway service.

## Getting the key

The key lives only in Railway. A cloud session has `RAILWAY_API_TOKEN` (a project token for "Driver - Dispatch"):

```sh
curl -s https://backboard.railway.com/graphql/v2 -H "Project-Access-Token: $RAILWAY_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"query":"query { projectToken { projectId environmentId } }"}'
# then: variables(projectId, environmentId, serviceId: "21676c36-bc16-424f-8106-84c21db7fcd1") { FEEDBACK_KEY }
```

Never print the key in chat, a commit, an issue or a PR.

## Each check

1. `GET https://dirver-dispatch-production.up.railway.app/api/feedback?status=new` with
   `Authorization: Bearer $FEEDBACK_KEY`. Oldest first.
2. For each item, mark it taken: `PATCH /api/feedback/<id>` with `{"status":"working","reply":"Looking at it."}`.
3. Do what it asks:
   - A change to the system: make it on a new branch with tests (`npm test`), open a pull request, and link it in
     the reply. Do not merge: main deploys to the live server.
   - Data the admin can change on the dashboard (families, places, PINs, settings): say where, in the reply.
   - A complaint about a ride: look at the booking and the audit log, and reply with what happened.
   - Something only Shloime can do (a key, a phone setting, a payment, a choice): status `needs_you` and a reply
     that says exactly what, in one or two plain steps.
4. Finish with `{"status":"done","reply":"<what was done, with the PR link>"}`, or `declined` with the reason when it
   can't or shouldn't be done (against the seating or service rules, unsafe, unclear: ask in the reply).
5. Report to Shloime: one short message listing what was done and what needs him. Nothing new: say nothing.

Statuses: `new`, `working`, `needs_you`, `done`, `declined`. The writer sees the reply on the dashboard or in the app.
