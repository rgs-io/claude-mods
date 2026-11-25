---
name: linked-references
description: "Links for numbered references. Use whenever a reply, summary, PR, commit, Slack draft or doc mentions something known by an ID: a GitHub PR or issue (#123), a Jira or Linear ticket (ABC-123), a commit SHA, an incident or build number."
---

# Linked references

A bare ID is a dead end for the reader: they must leave to look it up. So every ID the user will read reaches them as a **link**, and as a **link with a title** unless the surrounding sentence already says what it is.

## Rules

- Every mention is a markdown link to the thing itself: `[#123](https://github.com/owner/repo/pull/123)`. Link each mention, including repeats in a list or table.
- The title comes from the source, fetched, never guessed from the ID or the branch name. Add it after the link when the reader couldn't tell from context what the thing is: `[ABC-123](…) (Retry failed webhook deliveries)`. Leave it off when the sentence already carries the topic, e.g. "the PR adding retries, [#123](…), is merged".
- Keep a title short: the source's title, trimmed to a few words if it is long.
- When a lookup fails (no access, no such ID), keep the ID unlinked and say so in one clause, e.g. "ABC-123 (couldn't fetch it)", so a broken link never ships.
- Fetch many IDs together: one `gh` or MCP call per ID, all in the same turn.

## Where the link and title come from

| Reference | Lookup |
| --- | --- |
| GitHub PR or issue (`#123`, `owner/repo#123`) | `gh pr view 123 --json url,title` (or `gh issue view`); add `-R owner/repo` when it isn't the current repo. `gh api repos/{owner}/{repo}/issues/123 --jq '.html_url,.title'` answers for either kind. |
| Jira (`ABC-123`) | The Atlassian MCP: `getJiraIssue` for the summary. The link is `<site>/browse/ABC-123`, the site as below. |
| Linear (`ABC-123`) | The Linear MCP's `get_issue`, which returns both `url` and `title`. |
| Commit SHA | `gh browse <sha> -n` for the URL; `git log -1 --format=%s <sha>` for the subject. |
| Anything else with an ID (Sentry issue, CI run, incident, wiki page) | The matching MCP, CLI or API. If none is reachable, follow the lookup-failed rule. |

## Jira or Linear, and which Jira site

`ABC-123` looks the same in both. Decide once per key prefix and reuse the answer for the rest of the conversation:

1. **What the context already says.** A tracker URL for that prefix earlier in the conversation, in CLAUDE.md or memory, or in the repo's branch names, commit messages or PR bodies (`git log --grep=ABC- -n 5`) settles it, site included.
2. **Ask the connected trackers.** With only one of the two MCPs connected, use it. With both, look the ID up in both in the same turn and keep the one that finds it.
3. **The Jira site.** Take it from where step 1 found it, or call the Atlassian MCP's `getAccessibleAtlassianResources`: one site is the answer; with several, the one where `getJiraIssue` finds the ID.
4. **No tracker reachable.** If step 1 gave a site, link the ID and add a title only if the context gives one. Otherwise follow the lookup-failed rule.

## Formats

- Terminal replies, PR bodies, commits, GitHub comments, Linear and Jira markdown: `[label](url)`.
- Slack: raw markdown pasted into the composer, so `[ABC-123](url)` too (see the `writing-for-slack` skill).

Done when every ID in the text is a working link, and every one whose topic isn't clear from the sentence has its fetched title beside it.
