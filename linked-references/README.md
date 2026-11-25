# linked-references

A skill: every numbered reference Claude mentions becomes a link, with its title when the sentence doesn't already say what it is.

> Blocked on [ABC-123](https://example.atlassian.net/browse/ABC-123) (Retry failed webhook deliveries) and [#88](https://github.com/owner/repo/pull/88) (Add a backoff to the sender).

instead of "Blocked on ABC-123 and #88".

## Install

```
/plugin install linked-references --marketplace rgs-io/claude-mods
```

## What it links

- **GitHub PRs and issues** (`#123`, `owner/repo#123`) and **commits**, through `gh`.
- **Jira and Linear tickets** (`ABC-123`), through the Atlassian and Linear MCPs. It works out which tracker a key belongs to from the conversation, CLAUDE.md and the repo's history, or by asking whichever trackers are connected. It finds your Jira site the same way, or from the Atlassian MCP. To pin a prefix to a tracker, say so in CLAUDE.md, e.g. "`ABC-` tickets are at https://example.atlassian.net".
- **Anything else with an ID** (a Sentry issue, a CI run, a wiki page) that a connected MCP or CLI can look up.

Titles are always fetched, never guessed. When a lookup fails, the ID stays unlinked with a short note, so no broken links ship.
