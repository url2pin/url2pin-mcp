// The URL2Pin tools. Each handler returns { text, isError } so it can be tested without an MCP
// client; index.js wraps it in the MCP result shape.
//
// Written for an assistant to read: short sentences, the next step spelled out, and the app link
// where the person can check or change anything.

import { z } from 'zod';

export const APP_URL = 'https://url2pin.com';
const SCHEDULED_PAGE = `${APP_URL}/scheduled-pins`;
const KEYS_PAGE = `${APP_URL}/my-account#api-keys`;
const PRICING_PAGE = `${APP_URL}/pricing`;

const POLL_MS = 10_000;
const MAX_SCHEDULE_PER_CALL = 20;
// Ten minutes from now at the earliest, so a pin is never due before the person has seen the reply.
const MIN_LEAD_MS = 10 * 60 * 1000;

const ok = (text) => ({ text, isError: false });
const bad = (text) => ({ text, isError: true });

/** Turns any API failure into one sentence with what to do about it. */
export function explainFailure(r, action = 'That') {
  const code = r?.json?.code;
  const msg = String(r?.json?.error?.message || r?.json?.error || r?.json?.message || '').trim();
  if (r?.status === 401 || code === 'invalid_api_key') {
    return `The URL2Pin API key is missing or wrong. Create one at ${KEYS_PAGE} (API keys section) and set it as URL2PIN_API_KEY in this MCP server's settings.`;
  }
  if (r?.status === 402 || code === 'upgrade_required') {
    return `${msg || 'This needs a paid plan.'} Plans: ${PRICING_PAGE}`;
  }
  if (code === 'pinterest_not_connected') return msg || `Connect a Pinterest account at ${SCHEDULED_PAGE} first.`;
  if (code === 'too_many_jobs') return msg;
  if (code === 'network') return msg;
  const reason = msg || `URL2Pin answered with HTTP ${r?.status}`;
  return `${action} did not work: ${reason}${/[.!?]$/.test(reason) ? '' : '.'}`;
}

function formatPins(pins) {
  return pins
    .map((p, i) => {
      const lines = [`${i + 1}. ${p.title || '(no title)'}`, `   image: ${p.imageUrl}`];
      if (p.description) lines.push(`   description: ${p.description}`);
      return lines.join('\n');
    })
    .join('\n');
}

function boardsText(accounts) {
  const out = [];
  for (const a of accounts) {
    out.push(`Pinterest account: ${a.account_name || '(unnamed)'} (account_id: ${a.account_id})`);
    if (a.needs_reconnect) {
      out.push(`  This account needs reconnecting at ${SCHEDULED_PAGE}.`);
      continue;
    }
    if (!a.boards?.length) out.push('  No boards yet. Create one on Pinterest first.');
    for (const b of a.boards || []) out.push(`  - ${b.name} (board_id: ${b.id})${b.privacy === 'SECRET' ? ' [secret]' : ''}`);
  }
  return out.join('\n');
}

/** One line per pin for the board picks: the chosen board, or why there is none. */
function matchLine(m, i) {
  const who = `Pin ${i + 1}${m.title ? ` "${m.title}"` : ''}`;
  if (m.error === 'draft_not_found') return `${who}: no draft with that image on this account.`;
  if (m.confidence === 'strong') return `${who}: ${m.board_name} (board_id: ${m.board_id}, sure match)`;
  if (m.confidence === 'weak') return `${who}: maybe ${m.board_name} (board_id: ${m.board_id}, weak match, check with the person)`;
  return `${who}: no board fits. Ask the person which board, or create a new board on Pinterest.`;
}

export function buildTools(client, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), waitSeconds = 50 } = {}) {
  async function waitForJob(jobId) {
    const deadline = now() + waitSeconds * 1000;
    for (;;) {
      const s = await client.get(`/api/v1/pins/status/${encodeURIComponent(jobId)}`);
      if (!s.ok) return bad(explainFailure(s, 'Checking the pins'));
      const status = s.json.status;
      if (status === 'ready') {
        const pins = Array.isArray(s.json.pins) ? s.json.pins : [];
        return ok(
          `${pins.length} pin${pins.length === 1 ? '' : 's'} ready. They are saved as drafts in URL2Pin (${SCHEDULED_PAGE}).\n\n` +
            `${formatPins(pins)}\n\n` +
            'To post them, call schedule_pins with these image URLs. Leave out board_id and each pin goes to the board that fits it best, ' +
            'or use suggest_boards first to show the person where they would go.'
        );
      }
      if (status === 'failed') return bad(`Making the pins failed: ${s.json.error || 'no reason given'}.`);
      if (now() + POLL_MS > deadline) {
        return ok(
          `Still making the pins (this usually takes about 2 minutes). Call check_pins with job_id "${jobId}" in about a minute.`
        );
      }
      await sleep(POLL_MS);
    }
  }

  return [
    {
      name: 'generate_pins',
      title: 'Make Pinterest pins from a link',
      description:
        'Turns one product or blog link (Amazon, Etsy, Shopify, any store or blog post) into Pinterest pins with AI images, titles and descriptions. ' +
        'The pins keep the exact link, so an affiliate tag stays on. Uses the account\'s monthly pin allowance (one per pin). ' +
        'Takes about 2 minutes: if it is not done when this returns, call check_pins with the job_id. Pins are saved as drafts; nothing is posted.',
      inputSchema: {
        url: z.string().describe('The full link the pins should point to, e.g. https://www.amazon.com/dp/B0... or a blog post URL.'),
        count: z.number().int().min(1).max(5).optional().describe('How many pins to make, 1 to 5. Default 4.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async ({ url, count }) => {
        const r = await client.post('/api/v1/pins/generate', { url, count: count ?? 4, source: 'mcp' });
        if (!r.ok) return bad(explainFailure(r, 'Starting the pins'));
        return waitForJob(r.json.job_id);
      },
    },
    {
      name: 'check_pins',
      title: 'Check on pins being made',
      description: 'Returns the finished pins for a job_id from generate_pins, or says they are still being made.',
      inputSchema: { job_id: z.string().describe('The job_id from generate_pins.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async ({ job_id }) => waitForJob(job_id),
    },
    {
      name: 'list_drafts',
      title: 'List draft pins',
      description:
        'Lists the newest draft pins on the account (made in URL2Pin, not yet necessarily posted), newest first. ' +
        'Each one says whether that image is already scheduled or posted, so the same pin is not scheduled twice.',
      inputSchema: {
        link: z.string().optional().describe('Only drafts for this exact link.'),
        limit: z.number().int().min(1).max(50).optional().describe('How many, default 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async ({ link, limit }) => {
        const qs = new URLSearchParams();
        if (link) qs.set('link', link);
        if (limit) qs.set('limit', String(limit));
        const r = await client.get(`/api/v1/pins/drafts${qs.size ? `?${qs}` : ''}`);
        if (!r.ok) return bad(explainFailure(r, 'Listing drafts'));
        const pins = r.json.pins || [];
        if (!pins.length) return ok('No draft pins yet. Use generate_pins to make some.');
        return ok(
          pins
            .map(
              (p, i) =>
                `${i + 1}. ${p.title || '(no title)'}${p.alreadyScheduledOrPosted ? ' [already scheduled or posted]' : ''}\n` +
                `   image: ${p.imageUrl}\n   link: ${p.link || '-'}\n   made: ${p.createdAt}`
            )
            .join('\n')
        );
      },
    },
    {
      name: 'list_boards',
      title: 'List Pinterest boards',
      description: 'Lists the connected Pinterest accounts and their boards, with the board_id that schedule_pins needs.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: async () => {
        const r = await client.get('/api/v1/boards');
        if (!r.ok) return bad(explainFailure(r, 'Listing boards'));
        return ok(boardsText(r.json.accounts || []));
      },
    },
    {
      name: 'suggest_boards',
      title: 'Pick a board for each pin',
      description:
        'Picks the best Pinterest board for each draft pin, using the same board matching as URL2Pin\'s own scheduler and Autopilot ' +
        '(it compares what the pin is about with each board\'s name and description). Each pick is a sure match, a weak match, or none. ' +
        'Nothing is scheduled. Use it to show the person where pins would go before schedule_pins.',
      inputSchema: {
        image_urls: z.array(z.string()).min(1).max(MAX_SCHEDULE_PER_CALL).describe('Image URLs of draft pins.'),
        account_id: z.string().optional().describe('Which connected Pinterest account. Default: the most recently connected one.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: async ({ image_urls, account_id }) => {
        const r = await client.post('/api/v1/boards/match', { image_urls, ...(account_id ? { account_id } : {}) });
        if (!r.ok) return bad(explainFailure(r, 'Picking boards'));
        return ok((r.json.results || []).map(matchLine).join('\n'));
      },
    },
    {
      name: 'create_board',
      title: 'Create a Pinterest board',
      description:
        'Creates a board on the person\'s Pinterest account. Give a name, or give image_urls of drafts and a name and description are suggested from them ' +
        '(the same suggestion as the "+ New board" button in URL2Pin). If a board with that name already exists, that board is returned and nothing new is made. ' +
        'The board is public unless secret is true. At most 3 per account per day through this server.',
      inputSchema: {
        name: z.string().max(50).optional().describe('Board name. Leave out to have one suggested from image_urls.'),
        description: z.string().max(250).optional(),
        image_urls: z.array(z.string()).max(10).optional().describe('Drafts the board is for, used to suggest a name.'),
        secret: z.boolean().optional().describe('Make it a secret board. Default false.'),
        account_id: z.string().optional().describe('Which connected Pinterest account. Default: the most recently connected one.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async ({ name, description, image_urls, secret, account_id }) => {
        if (!name && !image_urls?.length) return bad('Give a board name, or image_urls of drafts to name it from.');
        const r = await client.post('/api/v1/boards/create', {
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
          ...(image_urls?.length ? { image_urls } : {}),
          ...(secret ? { privacy: 'SECRET' } : {}),
          ...(account_id ? { account_id } : {}),
        });
        if (!r.ok) return bad(explainFailure(r, 'Creating the board'));
        const b = r.json.board || {};
        return ok(
          r.json.created
            ? `Created the board "${b.name}" (board_id: ${b.id}). Use this board_id with schedule_pins.`
            : `A board named "${b.name}" already exists (board_id: ${b.id}), so nothing new was made. Use this board_id with schedule_pins.`
        );
      },
    },
    {
      name: 'schedule_pins',
      title: 'Schedule pins to Pinterest',
      description:
        'Schedules draft pins (image URLs from generate_pins or list_drafts) to Pinterest, spaced out over time. ' +
        'Give board_id to put them all on one board, or leave it out and each pin goes to the board that fits it best (sure matches only). ' +
        'When some pins fit none of the boards, one new board is created for them on Pinterest, named after what they are about ' +
        '(the same as URL2Pin Autopilot does; set new_board_if_none to false to stop that). Pins that still fit nothing stay as drafts and are listed. ' +
        'The first pin goes out at start_at, the next one hours_between later, and so on. Pins are only scheduled, never posted instantly, ' +
        `and can be cancelled with cancel_scheduled or in the app until they go out. Up to ${MAX_SCHEDULE_PER_CALL} pins per call. ` +
        'Confirm the times (and the board, if the person named one) with the person before calling this.',
      inputSchema: {
        image_urls: z.array(z.string()).min(1).max(MAX_SCHEDULE_PER_CALL).describe('Image URLs of draft pins, in the order they should go out.'),
        board_id: z.string().optional().describe('From list_boards. Leave out to pick the best board for each pin automatically.'),
        start_at: z.string().describe('When the first pin goes out, ISO 8601 with a time zone, e.g. 2026-11-20T18:00:00-05:00. Must be at least 10 minutes from now.'),
        hours_between: z.number().min(1).max(168).optional().describe('Hours between pins. Default 24 (one a day).'),
        account_id: z.string().optional().describe('Which connected Pinterest account. Only needed with more than one.'),
        new_board_if_none: z.boolean().optional().describe('Without board_id: create one new board for pins that fit no existing board. Default true.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async ({ image_urls, board_id, start_at, hours_between, account_id, new_board_if_none }) => {
        const startMs = Date.parse(start_at);
        if (!Number.isFinite(startMs)) return bad('start_at is not a valid time. Use ISO 8601, e.g. 2026-11-20T18:00:00-05:00.');
        if (startMs < now() + MIN_LEAD_MS) return bad('start_at must be at least 10 minutes from now.');
        const gapMs = (hours_between ?? 24) * 3600 * 1000;
        const urls = [...new Set(image_urls.map((u) => String(u).trim()).filter(Boolean))];

        // plan: [{ url, boardId, boardName, accountId }] in posting order; held: lines for pins left as drafts.
        let plan = [];
        const held = [];
        let accountName = '';
        let newBoard = null;
        let boardNote = '';
        if (board_id) {
          const b = await client.get('/api/v1/boards');
          if (!b.ok) return bad(explainFailure(b, 'Checking the board'));
          const accounts = (b.json.accounts || []).filter((a) => !account_id || a.account_id === account_id);
          const owner = accounts.find((a) => (a.boards || []).some((x) => x.id === String(board_id)));
          if (!owner) {
            return bad(`There is no board with board_id ${board_id}${account_id ? ' on that account' : ''}. These are the boards:\n${boardsText(b.json.accounts || [])}`);
          }
          accountName = owner.account_name || '';
          const boardName = owner.boards.find((x) => x.id === String(board_id)).name;
          plan = urls.map((url) => ({ url, boardId: String(board_id), boardName, accountId: owner.account_id }));
        } else {
          const m = await client.post('/api/v1/boards/match', { image_urls: urls, ...(account_id ? { account_id } : {}) });
          if (!m.ok) return bad(explainFailure(m, 'Picking boards'));
          const acct = m.json.account_id;
          const results = (m.json.results || []).map((r, i) => ({ ...r, idx: i }));
          const placed = []; // { idx, url, boardId, boardName }
          const place = (r, boardId, boardName) => placed.push({ idx: r.idx, url: r.image_url, boardId, boardName, accountId: acct });
          let misfits = [];
          for (const r of results) {
            if (r.confidence === 'strong') place(r, r.board_id, r.board_name);
            else if (r.error) held.push(matchLine(r, r.idx).replace(/^Pin \d+/, `Not scheduled, pin ${r.idx + 1}`));
            else misfits.push(r);
          }

          // Pins that fit no board well: one new board, named after the first of them, the way
          // Autopilot does it. The rest are checked again with that board in the list.
          if (misfits.length && new_board_if_none !== false) {
            const seed = misfits[0];
            const c = await client.post('/api/v1/boards/create', { image_urls: [seed.image_url], account_id: acct });
            if (c.ok && c.json.created && c.json.board?.id) {
              newBoard = c.json.board;
              place(seed, newBoard.id, newBoard.name);
              const rest = misfits.slice(1);
              misfits = [];
              if (rest.length) {
                const again = await client.post('/api/v1/boards/match', { image_urls: rest.map((r) => r.image_url), account_id: acct });
                const byUrl = new Map(((again.ok && again.json.results) || []).map((x) => [x.image_url, x]));
                for (const r of rest) {
                  const x = byUrl.get(r.image_url);
                  if (x?.confidence === 'strong') place(r, x.board_id, x.board_name);
                  else misfits.push(r);
                }
              }
            } else if (!c.ok) {
              boardNote = `No new board was made: ${explainFailure(c, 'Creating a board')}`;
            } else {
              boardNote = `No new board was made: a board named "${c.json.board?.name}" already exists.`;
            }
          }
          for (const r of misfits) held.push(matchLine(r, r.idx).replace(/^Pin \d+/, `Not scheduled, pin ${r.idx + 1}`));
          // Posting order is the order the person gave, whichever board each pin went to.
          plan = placed.sort((a, b) => a.idx - b.idx);
        }

        const lines = [];
        let scheduled = 0;
        for (let i = 0; i < plan.length; i++) {
          const p = plan[i];
          const when = new Date(startMs + i * gapMs).toISOString();
          const r = await client.post('/api/v1/pins/schedule', {
            image_url: p.url,
            board_id: p.boardId,
            account_id: p.accountId,
            scheduled_for: when,
          });
          const label = `Pin ${i + 1} to "${p.boardName}"`;
          if (r.ok) {
            scheduled++;
            lines.push(`${label}: scheduled for ${when} (scheduled_pin_id: ${r.json.scheduled_pin?.id || '?'})`);
          } else if (r.status === 409) {
            lines.push(`${label}: skipped, this image was already posted to this board.`);
          } else if (r.status === 402 || r.json?.code === 'upgrade_required') {
            lines.push(`${label}: not scheduled. ${explainFailure(r)}`);
            if (i + 1 < plan.length) lines.push(`The other ${plan.length - i - 1} pin(s) were not scheduled either.`);
            break;
          } else {
            lines.push(`${label}: not scheduled. ${explainFailure(r, 'Scheduling')}`);
          }
        }
        const where = board_id ? ` to "${plan[0]?.boardName}"${accountName ? ` (${accountName})` : ''}` : ', each to the board that fits it';
        const head =
          `${scheduled} of ${urls.length} pin(s) scheduled${where}. Times are UTC.` +
          (newBoard ? `\nNew board created on Pinterest: "${newBoard.name}" (board_id: ${newBoard.id}), because some pins fit none of the existing boards.` : '');
        const tail =
          (boardNote ? `\n\n${boardNote}` : '') +
          (held.length ? `\n\n${held.join('\n')}\nTo schedule these, call schedule_pins again with the board_id the person chooses.` : '');
        return { text: `${head}\n${lines.join('\n')}${tail}\n\nSee or change them at ${SCHEDULED_PAGE}.`, isError: scheduled === 0 && !held.length };
      },
    },
    {
      name: 'list_scheduled',
      title: 'List scheduled pins',
      description: 'Lists pins waiting to go out to Pinterest (and any that failed), soonest first, with the scheduled_pin_id needed to cancel one.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('How many, default 20.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async ({ limit }) => {
        const r = await client.get(`/api/v1/pins/scheduled${limit ? `?limit=${limit}` : ''}`);
        if (!r.ok) return bad(explainFailure(r, 'Listing scheduled pins'));
        const pins = r.json.pins || [];
        if (!pins.length) return ok('Nothing is scheduled right now.');
        return ok(
          pins
            .map(
              (p) =>
                `- ${p.scheduledFor || '?'} [${p.status}] ${p.title || '(no title)'} (scheduled_pin_id: ${p.id})` +
                (p.error ? `\n  failed: ${p.error}` : '')
            )
            .join('\n') + `\n\nTimes are UTC. Manage them at ${SCHEDULED_PAGE}.`
        );
      },
    },
    {
      name: 'cancel_scheduled',
      title: 'Cancel scheduled pins',
      description: 'Cancels scheduled pins that have not gone out yet. The drafts stay, so they can be scheduled again.',
      inputSchema: { scheduled_pin_ids: z.array(z.string()).min(1).max(50).describe('From schedule_pins or list_scheduled.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      handler: async ({ scheduled_pin_ids }) => {
        const r = await client.post('/api/v1/pins/cancel', { scheduled_pin_ids });
        if (!r.ok) return bad(explainFailure(r, 'Cancelling'));
        const n = r.json.cancelled_count ?? 0;
        const asked = r.json.requested ?? scheduled_pin_ids.length;
        return ok(
          `Cancelled ${n} of ${asked}.` +
            (n < asked ? ' The others had already gone out, were already cancelled, or are not on this account.' : '')
        );
      },
    },
    {
      name: 'pins_left',
      title: 'Pins left this month',
      description: 'Shows the plan, how many pins are left this month and when the allowance resets.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async () => {
        const r = await client.get('/api/v1/account/usage');
        if (!r.ok) return bad(explainFailure(r, 'Reading usage'));
        const u = r.json;
        return ok(
          `Plan: ${u.plan}. Pins used: ${u.pins_used ?? '?'} of ${u.pins_limit ?? '?'}, ${u.pins_remaining ?? '?'} left.` +
            (u.pins_reset_at ? ` Resets ${u.pins_reset_at}.` : '')
        );
      },
    },
  ];
}
