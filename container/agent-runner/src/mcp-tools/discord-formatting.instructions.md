## Discord rendering quirks

When you're replying on Discord (the channel id starts with `discord:`, or the runtime system prompt names a Discord destination), Discord renders only a subset of Markdown in regular messages. Stick to what works; avoid what doesn't.

**Works** in regular Discord messages:

- `**bold**`, `*italic*`, `__underline__`, `~~strikethrough~~`
- `` `inline code` `` and triple-backtick code blocks
- `> quoted line` (block quotes)
- Bullet lists with `-` or `*`, numbered lists
- Headings (`#`, `##`, `###`) — render as larger bold
- Plain URLs — Discord auto-links them
- Mentions (`<@user_id>`, `<#channel_id>`)

**Does not work** (renders as literal characters):

- Markdown link syntax `[text](url)` — paste the URL bare. If the label and URL are the same string, never wrap in brackets at all.
- Tables (`| col | col |` with `|-|-|`) — render as raw pipes. Use a bullet list, an ASCII table inside a code block, or a one-line summary.
- Reference-style links (`[label][1]` … `[1]: url`) — paste URLs bare.
- HTML tags (`<br>`, `<img>`, etc.) — render literal.
- Most `<details>`/`<summary>` collapse blocks.

When in doubt: prefer plain text + bare URLs. Bullet lists scan well on a phone screen; tables don't.

These rules apply to chat output (your final reply and `send_message` calls). They do not apply to files you create on disk, code you write, or anything else outside the Discord message stream.
