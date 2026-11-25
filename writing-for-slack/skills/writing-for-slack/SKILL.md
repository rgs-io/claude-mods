---
name: writing-for-slack
description: "Formatting for a message the user will copy and paste into Slack, so Slack formats it on paste. Use when asked to write or draft a Slack message, reply or announcement for the user to send themselves. Messages you post directly through a Slack MCP tool keep that tool's own rules."
---

# Writing for Slack

The user pastes the message into Slack's composer, which turns literal markdown characters into formatting. So the message has to reach the clipboard as raw characters, with nothing pre-rendered.

## Formatting

| Want | Type |
| --- | --- |
| Bold | `**bold**` |
| Italic | `_italic_` |
| Inline code | `` `code` `` |
| Code block | three backticks on the lines above and below the code |
| Bullet | `- ` at the start of the line |
| Emoji | `:emojiname:`, e.g. `:tada:` |

- Every bullet starts with a plain `-` and a space. It is the only marker that formats on paste, so `•`, `◦`, `*` and other bullet characters stay out of the message.
- Every emoji is its `:emojiname:` text, never the Unicode character.

## Delivery

Put the message in a four-backtick fenced block, with nothing else inside it. The fence is the only wrapper: a blockquote would put `>` on every copied line, so the block starts at the left margin with no `>` prefix. The terminal renders markdown in normal reply text and would eat the `**` and `_` before the user can copy them; the fence keeps them literal, and four backticks leave room for a code block inside the message.

Keep each paragraph and bullet on one unwrapped line, so the paste has no stray line breaks.

Done when the fenced text, pasted as is, needs no editing to format correctly in Slack.
