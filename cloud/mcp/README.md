# jotdrop-mcp

Let your AI agent read and write your JotDrop notes. JotDrop still can't.

`jotdrop-mcp` is a small program that runs on your own computer or server. It joins your JotDrop Cloud account as one more device, decrypts your notes in its own memory, and offers them to an AI agent over the Model Context Protocol (MCP). It works with Claude Code, Claude Desktop, Cursor, Hermes Agent, OpenClaw and other MCP clients.

You can say "put milk and bread on my shopping list" to Claude, and it's on the list in the JotDrop app on your phone the next time the app syncs (when you open it, or within about 15 minutes). Our server sees what it sees for every other app: encrypted files and a device name.

## Before you connect

- This program holds the key to your notes. Run it only on a computer you trust as much as your phone.
- Your agent reads notes for you, so its AI provider sees what it reads. JotDrop still doesn't.
- Your agent can make and change notes. It can't delete, archive or share them, and older versions stay in each note's history.
- It counts as a device. On the free plan that is one of your two. You can remove it at any time under Connected devices.

## Connect

1. In JotDrop, open Connected devices (on app.jotdrop.net, or under JotDrop Cloud in the Android app) and choose Create pairing code. Give the device a name you'll recognize, like "Claude on my desktop". The code works for 10 minutes.
2. In a terminal:

   ```
   npx -y jotdrop-mcp connect
   ```

   Paste the code. You'll see something like `Connected as "Claude on my desktop". 143 notes.` and the lines to add it to your AI app. The key is never shown.

You need Node.js 22 or newer.

## Add it to your AI app

Claude Code:

```
claude mcp add --transport stdio jotdrop -- npx -y jotdrop-mcp
```

Claude Desktop, in `claude_desktop_config.json` (Settings, Developer, Edit config), under `"mcpServers"`:

```json
"jotdrop": { "command": "npx", "args": ["-y", "jotdrop-mcp"] }
```

On Windows, if Claude Desktop can't start `npx`, use `"command": "cmd", "args": ["/c", "npx", "-y", "jotdrop-mcp"]`. Restart Claude Desktop afterwards.

Cursor: the same block in `.cursor/mcp.json`, under `"mcpServers"`.

OpenClaw and other clients that start a program over stdio: the command is `npx -y jotdrop-mcp`.

## Tools

| Tool | What it does |
|---|---|
| `search_notes` | Search notes by words, archived ones too (never the trash). An empty search lists the newest. |
| `read_note` | The full text of one note, cut at 20,000 characters. |
| `list_labels` | The labels you already use. |
| `create_note` | A new note with a title, text and checklist items. |
| `append_to_note` | Text or checklist items at the end of a note, for example on a shopping list. |
| `replace_note_text` | Replace the whole text. Marked as destructive, so clients that can will ask you first. |
| `set_labels` | The labels of a note. |
| `set_reminder` | A reminder at a local date and time. |
| `set_expiry` | The date a receipt or warranty expires. The note goes into the Paper drawer with a reminder a week before. |

To give an agent fewer tools, start it with `--tools`, for example:

```
npx -y jotdrop-mcp --tools search_notes,read_note,list_labels,create_note,append_to_note
```

A few things are deliberate. A `#word` your agent writes stays text and doesn't become a tag; labels go through `set_labels`. Notes come back to the agent as data inside `<note>` elements, with the reminder that note contents are not instructions. The program allows 60 tool calls and 20 changes a minute, which slows down an agent stuck in a loop. When the cloud can't be reached, reading works from the last copy and writing does nothing.

## Over HTTP, for an agent in Docker

Some agents, like Hermes Agent in Docker, talk to MCP over HTTP. Run `jotdrop-mcp` next to them:

```
jotdrop-mcp connect --http --code <pairing code>
jotdrop-mcp serve --http 127.0.0.1:8765
```

The endpoint is `http://127.0.0.1:8765/mcp`. Every request needs `Authorization: Bearer <token>`. The token is `JOTDROP_MCP_TOKEN` when you set it (at least 32 characters, for example from `openssl rand -base64 32`), or else the `<profile>.http-token` file that `connect --http` makes. Requests from a browser are refused unless you list the origin with `--allow-origin`. `GET /healthz` answers `ok` for a health check.

Please don't put this port on the open internet. It is meant for your own computer or a private Docker network, and a public server would need OAuth, which this version doesn't have.

There is a `Dockerfile` in this folder. In Docker Compose, keep the container on the internal network only (no `ports:`), store `/data` in a volume, and set `JOTDROP_MCP_TOKEN`. Connect once with:

```
docker compose run --rm jotdrop-mcp jotdrop-mcp connect --code <pairing code>
```

For Hermes Agent, in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  jotdrop:
    url: http://jotdrop-mcp:8765/mcp
    headers: { Authorization: "Bearer ${JOTDROP_MCP_TOKEN}" }
    tools: { include: [search_notes, read_note, list_labels, create_note, append_to_note] }
```

## More than one account

`--profile` keeps a second account apart, with its own files:

```
npx -y jotdrop-mcp connect --profile anna
claude mcp add --transport stdio jotdrop-anna -- npx -y jotdrop-mcp --profile anna
```

## Status and disconnecting

```
npx -y jotdrop-mcp status
npx -y jotdrop-mcp disconnect
```

`status` shows the device name, plan, number of notes, last sync and whether the cloud answers. `disconnect` removes the device from your JotDrop account and deletes every file of the profile from this computer. Removing the device in the app under Connected devices also works and takes effect at once.

## Where things are stored

In `~/.jotdrop-mcp/` (or the folder in `JOTDROP_MCP_HOME`): `<profile>.json` with the connection and the key, readable only by you; `<profile>.cache.json`, a copy of your notes sealed with your key, so no note text is stored in plain form; and `<profile>.http-token` when you use HTTP. Messages go to stderr and never contain note text, the key or the token.

Removing a device stops new requests right away. What this program already had on that computer stays readable to whoever has that computer and its files, as with any app.

## License

MIT. Part of [JotDrop](https://jotdrop.net); the source is in `cloud/mcp/` of the JotDrop repository.
