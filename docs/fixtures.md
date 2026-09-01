# Test fixtures

Sanitized HTML, JSON, and other upstream-response samples live under `test/fixtures/`. They are used by the Jest suite to exercise parsers, resolvers, and rankers without hitting the network.

## Source

Every fixture must have a header comment with:
- The upstream URL it was derived from (so future maintainers can re-fetch and verify).
- The date the fixture was captured.
- A one-line note describing what behavior it exercises.

## Sanitization

Before committing a fixture:

- Remove all `Cookie`, `Set-Cookie`, and `Authorization` headers / values.
- Remove user-agent strings, request IDs, and CSRF tokens.
- Remove usernames, emails, and IP addresses from embedded strings.
- Truncate long fields (like per-row descriptions) to a single representative example.
- Keep only the fields the parser actually consumes — strip everything else.
- Do NOT include actual APK bytes, signing material, or commercial application bundles.

## Re-recording

If an upstream source changes structure, re-capture the relevant fixture:

1. Identify the smallest test that exercises the broken parse path.
2. Save the new response to the matching `test/fixtures/<kind>/<name>` file.
3. Update the source URL / date in the header comment.
4. Re-run `npm test` — if any unrelated tests break, the fixture probably lost something important; re-scrub.