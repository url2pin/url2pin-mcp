import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTools, explainFailure } from '../src/tools.js';
import { createClient } from '../src/client.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');

/** A fake API: routes map "METHOD path" to a function returning { status, json }. Records every call. */
function fakeClient(routes) {
  const calls = [];
  const run = (method, path, body) => {
    calls.push({ method, path, body });
    const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
    if (!key) throw new Error(`unexpected ${method} ${path}`);
    const { status = 200, json = {} } = routes[key](body, calls);
    return Promise.resolve({ ok: status < 400, status, json });
  };
  return { calls, get: (p) => run('GET', p), post: (p, b) => run('POST', p, b) };
}

const tool = (client, name, opts = {}) => {
  let t = NOW;
  const tools = buildTools(client, { sleep: async (ms) => { t += ms; }, now: () => t, waitSeconds: 50, ...opts });
  return tools.find((x) => x.name === name).handler;
};

const BOARDS = {
  accounts: [
    { account_id: 'acc-1', account_name: 'Home Finds', boards: [{ id: '111', name: 'Kitchen' }, { id: '222', name: 'Gifts' }] },
  ],
};

test('generate_pins asks for 4 pins by default, tags the source as mcp, and returns the pins once ready', async () => {
  let polls = 0;
  const c = fakeClient({
    'POST /api/v1/pins/generate': () => ({ status: 202, json: { job_id: 'job-1' } }),
    'GET /api/v1/pins/status/job-1': () => (++polls < 3 ? { json: { status: 'processing' } } : { json: { status: 'ready', pins: [{ imageUrl: 'https://img/1.png', title: 'Pretty mug' }] } }),
  });
  const r = await tool(c, 'generate_pins')({ url: 'https://www.amazon.com/dp/B0TEST?tag=me-20' });
  assert.equal(r.isError, false);
  assert.deepEqual(c.calls[0].body, { url: 'https://www.amazon.com/dp/B0TEST?tag=me-20', count: 4, source: 'mcp' });
  assert.match(r.text, /1 pin ready/);
  assert.match(r.text, /https:\/\/img\/1\.png/);
  assert.match(r.text, /schedule_pins/);
});

test('generate_pins hands back the job_id instead of waiting past the limit', async () => {
  const c = fakeClient({
    'POST /api/v1/pins/generate': () => ({ status: 202, json: { job_id: 'job-2' } }),
    'GET /api/v1/pins/status/job-2': () => ({ json: { status: 'processing' } }),
  });
  const r = await tool(c, 'generate_pins')({ url: 'https://example.com/p' });
  assert.equal(r.isError, false);
  assert.match(r.text, /check_pins with job_id "job-2"/);
  const polls = c.calls.filter((x) => x.path.startsWith('/api/v1/pins/status')).length;
  assert.ok(polls >= 4 && polls <= 6, `polled ${polls} times in 50 s`);
});

test('a failed job and a bad key both come back as errors with a next step', async () => {
  const failed = fakeClient({
    'GET /api/v1/pins/status/j': () => ({ json: { status: 'failed', error: 'Could not read the page.' } }),
  });
  const r1 = await tool(failed, 'check_pins')({ job_id: 'j' });
  assert.equal(r1.isError, true);
  assert.match(r1.text, /Could not read the page/);

  const noKey = fakeClient({ 'POST /api/v1/pins/generate': () => ({ status: 401, json: { code: 'invalid_api_key' } }) });
  const r2 = await tool(noKey, 'generate_pins')({ url: 'https://example.com' });
  assert.equal(r2.isError, true);
  assert.match(r2.text, /url2pin\.com\/my-account/);
});

test('schedule_pins spaces pins out from start_at and sends the board\'s own account', async () => {
  const c = fakeClient({
    'GET /api/v1/boards': () => ({ json: BOARDS }),
    'POST /api/v1/pins/schedule': (body, calls) => ({ json: { scheduled_pin: { id: `sp-${calls.length}` } } }),
  });
  const r = await tool(c, 'schedule_pins')({
    image_urls: ['https://img/a.png', 'https://img/b.png', 'https://img/a.png'],
    board_id: '111',
    start_at: '2026-11-17T18:00:00Z',
    hours_between: 12,
  });
  assert.equal(r.isError, false);
  const sent = c.calls.filter((x) => x.path === '/api/v1/pins/schedule').map((x) => x.body);
  assert.equal(sent.length, 2, 'duplicate image URLs are scheduled once');
  assert.deepEqual(sent.map((b) => b.scheduled_for), ['2026-11-17T18:00:00.000Z', '2026-11-18T06:00:00.000Z']);
  assert.ok(sent.every((b) => b.account_id === 'acc-1' && b.board_id === '111'));
  assert.ok(sent.every((b) => !('post_immediately' in b)));
  assert.match(r.text, /2 of 2 pin\(s\) scheduled to "Kitchen"/);
});

test('schedule_pins refuses an unknown board and lists the real ones, scheduling nothing', async () => {
  const c = fakeClient({ 'GET /api/v1/boards': () => ({ json: BOARDS }) });
  const r = await tool(c, 'schedule_pins')({ image_urls: ['https://img/a.png'], board_id: '999', start_at: '2026-11-17T18:00:00Z' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Kitchen \(board_id: 111\)/);
  assert.equal(c.calls.filter((x) => x.path === '/api/v1/pins/schedule').length, 0);
});

test('schedule_pins refuses a time in the past or too soon', async () => {
  const c = fakeClient({});
  const r = await tool(c, 'schedule_pins')({ image_urls: ['https://img/a.png'], board_id: '111', start_at: '2026-11-16T12:05:00Z' });
  assert.equal(r.isError, true);
  assert.match(r.text, /10 minutes/);
  assert.equal(c.calls.length, 0);
});

test('schedule_pins stops at the free-post limit and says how many were left out', async () => {
  let n = 0;
  const c = fakeClient({
    'GET /api/v1/boards': () => ({ json: BOARDS }),
    'POST /api/v1/pins/schedule': () => (++n === 1 ? { json: { scheduled_pin: { id: 'sp-1' } } } : { status: 402, json: { code: 'upgrade_required', error: "You've used your 3 free Pinterest posts." } }),
  });
  const r = await tool(c, 'schedule_pins')({ image_urls: ['https://img/1', 'https://img/2', 'https://img/3', 'https://img/4'], board_id: '222', start_at: '2026-11-17T18:00:00Z' });
  assert.equal(c.calls.filter((x) => x.path === '/api/v1/pins/schedule').length, 2);
  assert.match(r.text, /1 of 4/);
  assert.match(r.text, /url2pin\.com\/pricing/);
  assert.match(r.text, /other 2 pin\(s\) were not scheduled/);
});

test('schedule_pins reports an already-posted image as skipped and carries on', async () => {
  let n = 0;
  const c = fakeClient({
    'GET /api/v1/boards': () => ({ json: BOARDS }),
    'POST /api/v1/pins/schedule': () => (++n === 1 ? { status: 409, json: { already_posted_to_board: true } } : { json: { scheduled_pin: { id: 'sp-2' } } }),
  });
  const r = await tool(c, 'schedule_pins')({ image_urls: ['https://img/1', 'https://img/2'], board_id: '111', start_at: '2026-11-17T18:00:00Z' });
  assert.equal(r.isError, false);
  assert.match(r.text, /Pin 1 to "Kitchen": skipped/);
  assert.match(r.text, /Pin 2 to "Kitchen": scheduled/);
});

const MATCH = {
  account_id: 'acc-1',
  source: 'embedding',
  results: [
    { image_url: 'https://img/mug', title: 'Pretty mug', board_id: '111', board_name: 'Kitchen', score: 0.55, confidence: 'strong' },
    { image_url: 'https://img/tree', title: 'Xmas tree', board_id: '111', board_name: 'Kitchen', score: 0.3, confidence: 'weak' },
    { image_url: 'https://img/bow', title: 'Gift bow', board_id: '222', board_name: 'Gifts', score: 0.47, confidence: 'strong' },
    { image_url: 'https://img/odd', title: 'Odd thing', board_id: null, board_name: null, score: 0.1, confidence: 'none' },
  ],
};

test('schedule_pins without a board puts each sure match on its own board and holds the rest as drafts', async () => {
  const c = fakeClient({
    'POST /api/v1/boards/match': () => ({ json: MATCH }),
    'POST /api/v1/pins/schedule': (body, calls) => ({ json: { scheduled_pin: { id: `sp-${calls.length}` } } }),
  });
  const r = await tool(c, 'schedule_pins')({
    image_urls: MATCH.results.map((x) => x.image_url),
    start_at: '2026-11-17T18:00:00Z',
    new_board_if_none: false,
  });
  const sent = c.calls.filter((x) => x.path === '/api/v1/pins/schedule').map((x) => x.body);
  assert.deepEqual(sent.map((b) => [b.image_url, b.board_id, b.account_id]), [['https://img/mug', '111', 'acc-1'], ['https://img/bow', '222', 'acc-1']]);
  // The held pins do not leave gaps: the two scheduled ones go out one day apart.
  assert.deepEqual(sent.map((b) => b.scheduled_for), ['2026-11-17T18:00:00.000Z', '2026-11-18T18:00:00.000Z']);
  assert.equal(c.calls.some((x) => x.path === '/api/v1/boards'), false, 'no board list needed');
  assert.equal(r.isError, false);
  assert.match(r.text, /2 of 4 pin\(s\) scheduled, each to the board that fits it/);
  assert.match(r.text, /Pin 1 to "Kitchen": scheduled/);
  assert.match(r.text, /Pin 2 to "Gifts": scheduled/);
  assert.match(r.text, /Not scheduled, pin 2 "Xmas tree": maybe Kitchen .*weak match/);
  assert.match(r.text, /Not scheduled, pin 4 "Odd thing": no board fits/);
});

test('schedule_pins with only weak matches schedules nothing but is not an error', async () => {
  const c = fakeClient({ 'POST /api/v1/boards/match': () => ({ json: { account_id: 'acc-1', results: [MATCH.results[1]] } }) });
  const r = await tool(c, 'schedule_pins')({ image_urls: ['https://img/tree'], start_at: '2026-11-17T18:00:00Z', new_board_if_none: false });
  assert.equal(c.calls.filter((x) => x.path === '/api/v1/pins/schedule').length, 0);
  assert.equal(r.isError, false);
  assert.match(r.text, /0 of 1/);
  assert.match(r.text, /with the board_id the person chooses/);
});

test('pins that fit no board get ONE new board named after the first of them; the rest are checked again', async () => {
  let matches = 0;
  const c = fakeClient({
    'POST /api/v1/boards/match': () =>
      ++matches === 1
        ? { json: MATCH }
        : { json: { account_id: 'acc-1', results: [{ image_url: 'https://img/odd', title: 'Odd thing', board_id: null, confidence: 'none' }] } },
    'POST /api/v1/boards/create': () => ({ json: { account_id: 'acc-1', created: true, board: { id: '333', name: 'Christmas Decor' } } }),
    'POST /api/v1/pins/schedule': (body, calls) => ({ json: { scheduled_pin: { id: `sp-${calls.length}` } } }),
  });
  const r = await tool(c, 'schedule_pins')({ image_urls: MATCH.results.map((x) => x.image_url), start_at: '2026-11-17T18:00:00Z' });
  const creates = c.calls.filter((x) => x.path === '/api/v1/boards/create');
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].body, { image_urls: ['https://img/tree'], account_id: 'acc-1' }, 'named after the first misfit');
  // The re-check only covers the pins still without a board.
  assert.deepEqual(c.calls.filter((x) => x.path === '/api/v1/boards/match')[1].body.image_urls, ['https://img/odd']);
  const sent = c.calls.filter((x) => x.path === '/api/v1/pins/schedule').map((x) => [x.body.image_url, x.body.board_id, x.body.scheduled_for]);
  assert.deepEqual(sent, [
    ['https://img/mug', '111', '2026-11-17T18:00:00.000Z'],
    ['https://img/tree', '333', '2026-11-18T18:00:00.000Z'],
    ['https://img/bow', '222', '2026-11-19T18:00:00.000Z'],
  ], 'the order the person gave, whichever board');
  assert.match(r.text, /3 of 4/);
  assert.match(r.text, /New board created on Pinterest: "Christmas Decor" \(board_id: 333\)/);
  assert.match(r.text, /Not scheduled, pin 4 "Odd thing": no board fits/);
});

test('no new board when the suggested name already exists, or the daily limit is reached', async () => {
  for (const [create, expect] of [
    [() => ({ json: { created: false, board: { id: '111', name: 'Kitchen' } } }), /a board named "Kitchen" already exists/],
    [() => ({ status: 429, json: { code: 'board_create_limit', error: '3 boards were already created through the API today on this account.' } }), /3 boards were already created/],
  ]) {
    const c = fakeClient({
      'POST /api/v1/boards/match': () => ({ json: { account_id: 'acc-1', results: [MATCH.results[1]] } }),
      'POST /api/v1/boards/create': create,
    });
    const r = await tool(c, 'schedule_pins')({ image_urls: ['https://img/tree'], start_at: '2026-11-17T18:00:00Z' });
    assert.equal(c.calls.filter((x) => x.path === '/api/v1/pins/schedule').length, 0);
    assert.match(r.text, expect);
    assert.match(r.text, /Not scheduled, pin 1 "Xmas tree"/);
  }
});

test('a board that is chosen by the person is never second-guessed: no matching, no new board', async () => {
  const c = fakeClient({
    'GET /api/v1/boards': () => ({ json: BOARDS }),
    'POST /api/v1/pins/schedule': () => ({ json: { scheduled_pin: { id: 'sp' } } }),
  });
  await tool(c, 'schedule_pins')({ image_urls: ['https://img/tree'], board_id: '222', start_at: '2026-11-17T18:00:00Z' });
  assert.equal(c.calls.some((x) => x.path.startsWith('/api/v1/boards/')), false);
});

test('create_board names it from drafts when no name is given, and says when it already existed', async () => {
  const made = fakeClient({ 'POST /api/v1/boards/create': () => ({ json: { created: true, board: { id: '9', name: 'Cozy Mugs' } } }) });
  const r1 = await tool(made, 'create_board')({ image_urls: ['https://img/mug'] });
  assert.deepEqual(made.calls[0].body, { image_urls: ['https://img/mug'] });
  assert.match(r1.text, /Created the board "Cozy Mugs" \(board_id: 9\)/);

  const existed = fakeClient({ 'POST /api/v1/boards/create': () => ({ json: { created: false, board: { id: '111', name: 'Kitchen' } } }) });
  const r2 = await tool(existed, 'create_board')({ name: 'kitchen', secret: true });
  assert.deepEqual(existed.calls[0].body, { name: 'kitchen', privacy: 'SECRET' });
  assert.match(r2.text, /already exists \(board_id: 111\), so nothing new was made/);

  const r3 = await tool(fakeClient({}), 'create_board')({});
  assert.equal(r3.isError, true);
});

test('suggest_boards shows each pick and schedules nothing', async () => {
  const c = fakeClient({ 'POST /api/v1/boards/match': () => ({ json: MATCH }) });
  const r = await tool(c, 'suggest_boards')({ image_urls: MATCH.results.map((x) => x.image_url) });
  assert.equal(c.calls.length, 1);
  assert.match(r.text, /Pin 1 "Pretty mug": Kitchen \(board_id: 111, sure match\)/);
  assert.match(r.text, /Pin 2 "Xmas tree": maybe Kitchen/);
  assert.match(r.text, /Pin 4 "Odd thing": no board fits/);
});

test('list_drafts flags images that are already scheduled or posted', async () => {
  const c = fakeClient({
    'GET /api/v1/pins/drafts': () => ({ json: { pins: [{ imageUrl: 'https://img/1', title: 'A', alreadyScheduledOrPosted: true }, { imageUrl: 'https://img/2', title: 'B', alreadyScheduledOrPosted: false }] } }),
  });
  const r = await tool(c, 'list_drafts')({ link: 'https://example.com/p' });
  assert.equal(c.calls[0].path, '/api/v1/pins/drafts?link=https%3A%2F%2Fexample.com%2Fp');
  assert.match(r.text, /1\. A \[already scheduled or posted\]/);
  assert.doesNotMatch(r.text, /2\. B \[/);
});

test('cancel_scheduled says when some pins could not be cancelled', async () => {
  const c = fakeClient({ 'POST /api/v1/pins/cancel': () => ({ json: { cancelled_count: 1, requested: 2 } }) });
  const r = await tool(c, 'cancel_scheduled')({ scheduled_pin_ids: ['a', 'b'] });
  assert.match(r.text, /Cancelled 1 of 2\. The others/);
});

test('every tool has a description, and only read tools are marked read-only', () => {
  const tools = buildTools(fakeClient({}));
  const readOnly = new Set(['check_pins', 'list_drafts', 'list_boards', 'suggest_boards', 'list_scheduled', 'pins_left']);
  for (const t of tools) {
    assert.ok(t.description.length > 40, t.name);
    assert.equal(Boolean(t.annotations.readOnlyHint), readOnly.has(t.name), t.name);
  }
  assert.equal(tools.find((t) => t.name === 'cancel_scheduled').annotations.destructiveHint, true);
});

test('explainFailure falls back to the server message', () => {
  assert.equal(explainFailure({ status: 500, json: { error: 'Could not read boards.' } }, 'Listing boards'), 'Listing boards did not work: Could not read boards.');
  assert.equal(explainFailure({ status: 503, json: {} }, 'Listing boards'), 'Listing boards did not work: URL2Pin answered with HTTP 503.');
});

test('the client sends the key header and turns a network error into a result, not a throw', async () => {
  const seen = [];
  const c = createClient({ apiKey: 'u2p_test', apiUrl: 'https://api.example/', fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response('{"ok":1}', { status: 200 }); } });
  const r = await c.get('/api/v1/account/usage');
  assert.equal(seen[0].url, 'https://api.example/api/v1/account/usage');
  assert.equal(seen[0].init.headers['x-api-key'], 'u2p_test');
  assert.equal(r.ok, true);
  const down = createClient({ apiKey: 'k', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const r2 = await down.post('/x', {});
  assert.equal(r2.ok, false);
  assert.equal(r2.json.code, 'network');
});
