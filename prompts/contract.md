## Output contract

This part is fixed and always applies, whatever the instructions above say.

When you are done, your final message must be one JSON object and nothing else, with exactly these fields:

```json
{
  "decision": "safe or needs_human",
  "risk": "low, medium or high",
  "confidence": "a whole number from 1 to 5, written as a number",
  "summary": "One or two sentences on what the PR does. At most 300 characters.",
  "reasons": ["1 to 6 short, concrete reasons for your decision"],
  "risk_areas": ["short tags like auth, data-migration, public-api; can be empty"],
  "files_reviewed": ["every changed file you reviewed, by its path in the repo"],
  "affected_code": [{ "location": "path:line", "why": "one sentence on how this unchanged code is affected, or why it is not" }]
}
```

Rules:

- `confidence` is a whole number from 1 to 5, never a percentage.
- `"safe"` with `"high"` risk is not allowed.
- `files_reviewed` must list every changed file you were asked to review.
- `affected_code` lists at most 10 places. It can be empty only when every changed file is docs (Markdown, text, `docs/`, `LICENSE`) or tests.
- If any other file changed (code, config, `package.json`, workflow files), `affected_code` must not be empty. List the code the change affects. If nothing depends on the change, list the places you checked and say in `why` that they are not affected, for example `src/main.ts:1`, "does not read package.json". A `"safe"` answer with an empty `affected_code` on such a change is rejected.
- No other fields. No text before or after the JSON.
