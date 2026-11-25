# writing-for-slack

A skill: ask Claude for a Slack message and it comes back ready to paste.

Slack's composer formats markdown you paste into it, so the message comes back as raw characters in a block you can copy:

````
**Deploy is out** :tada:
- Search is _much_ faster
- `GET /orders` pages now
````

- `**bold**`, `_italic_`, `` `code` ``, code blocks, `-` bullets and `:emojiname:` emoji, which are the ones that format on paste.
- One unwrapped line per paragraph and bullet, so the paste has no stray line breaks.

Messages Claude posts itself through a Slack MCP keep that tool's own rules.

## Install

```
/plugin install writing-for-slack --marketplace rgs-io/claude-mods
```
