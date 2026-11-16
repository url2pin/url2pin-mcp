# URL2Pin MCP server

Turn any product or blog link into Pinterest pins, then schedule them to your boards, from
Claude, ChatGPT, Cursor, VS Code or any app that supports the Model Context Protocol (MCP).

> "Make 4 pins for https://www.amazon.com/dp/B0... and schedule them to my Kitchen board, one a day from tomorrow at 6pm."

[URL2Pin](https://url2pin.com?ref=mcp) reads the page, writes the titles and descriptions, and
makes the pin images with AI. The pins keep your exact link, so your Amazon affiliate tag stays on.
They are posted through Pinterest's official API.

## What you need

1. A URL2Pin account ([free to start](https://url2pin.com?ref=mcp)).
2. An API key: **My account > API keys** at [url2pin.com/my-account](https://url2pin.com/my-account#api-keys).
3. A Pinterest account connected at [url2pin.com/scheduled-pins](https://url2pin.com/scheduled-pins) (only needed for scheduling).
4. Node.js 18 or newer.

## Set it up

### Claude Desktop

Settings > Developer > Edit Config, then add:

```json
{
  "mcpServers": {
    "url2pin": {
      "command": "npx",
      "args": ["-y", "url2pin-mcp"],
      "env": { "URL2PIN_API_KEY": "u2p_live_..." }
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add url2pin -e URL2PIN_API_KEY=u2p_live_... -- npx -y url2pin-mcp
```

### Cursor

Add the same `mcpServers` block as Claude Desktop to `~/.cursor/mcp.json`.

### VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "url2pin": {
      "command": "npx",
      "args": ["-y", "url2pin-mcp"],
      "env": { "URL2PIN_API_KEY": "u2p_live_..." }
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `generate_pins` | Makes 1 to 5 pins (default 4) from one link. About 2 minutes. Saved as drafts, nothing is posted. |
| `check_pins` | Gets the finished pins if `generate_pins` was still working when it returned. |
| `list_drafts` | Your newest draft pins, marked if already scheduled or posted. |
| `list_boards` | Your connected Pinterest accounts and boards. |
| `suggest_boards` | Picks the best board for each pin, with the same matching URL2Pin's scheduler and Autopilot use. Schedules nothing. |
| `create_board` | Creates a Pinterest board, with a name suggested from your pins if you don't give one. Never makes a duplicate. |
| `schedule_pins` | Schedules drafts, spaced out (default one a day). Up to 20 per call. Give a board, or leave it out and each pin goes to the board that fits it best, with one new board made for pins that fit none. |
| `list_scheduled` | Pins waiting to go out, and any that failed. |
| `cancel_scheduled` | Cancels scheduled pins before they go out. |
| `pins_left` | Your plan and pins left this month. |

## Safety

- **Nothing is posted instantly.** Pins are only scheduled, and can be cancelled with
  `cancel_scheduled` or in the app until they go out.
- **Only your own drafts can be scheduled.** The image must be one your account made in URL2Pin,
  and the pin keeps that draft's link. A key cannot post other images or change where a pin leads.
- **Boards are only picked when the match is sure.** For pins that fit none of your boards, one
  new board is made per request, named after what they are about (turn it off with
  `new_board_if_none: false`). It never duplicates a board name, and at most 3 boards a day per
  account are made this way. Pins that still fit nothing stay drafts and you are asked.
- **Same rules as the app.** Plan limits, free posts, the 800 character limit and the duplicate
  check all apply.
- Your key only spends your own pin allowance. Revoke it any time in My account.

## Settings

| Variable | Default | |
|---|---|---|
| `URL2PIN_API_KEY` | (required) | From My account > API keys. |
| `URL2PIN_WAIT_SECONDS` | `50` | How long `generate_pins` waits before handing back a job id. Lower it if your app times out tool calls. |
| `URL2PIN_API_URL` | URL2Pin's API | Only for testing. |

## Pricing

Pins come out of your URL2Pin plan, the same as making them in the app. See
[url2pin.com/pricing](https://url2pin.com/pricing?ref=mcp).

## Support

[url2pin.com/contact](https://url2pin.com/contact)

## License

MIT
