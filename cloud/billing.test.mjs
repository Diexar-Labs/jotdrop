import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { CloudClient } from './shared/client.mjs';
import { randomToken } from './shared/crypto.mjs';

const DAY = 24 * 60 * 60 * 1000;
const WEBHOOK_SECRET = 'whsec_test_secret';
const STRIPE = { secretKey: 'sk_test_x', webhookSecret: WEBHOOK_SECRET, monthPrice: 'price_month', yearPrice: 'price_year', founderYearPrice: 'price_founder', founderLimit: 1 };

// A fake Stripe: Checkout Sessions, and the current state of each subscription, which the server fetches on every event.
async function fixture(t, { stripe = STRIPE } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-billing-test-'));
  const enrollmentToken = randomToken(), sessions = [], subscriptions = new Map();
  let now = Date.parse('2026-10-23T08:00:00Z'), stripeDown = false;
  const fetcher = async (url, options) => {
    if (stripeDown) throw new TypeError('fetch failed');
    const subscription = /^https:\/\/api\.stripe\.com\/v1\/subscriptions\/(sub_\w+)$/.exec(url);
    if (subscription) return new Response(JSON.stringify(subscriptions.get(subscription[1])), { status: subscriptions.has(subscription[1]) ? 200 : 404 });
    sessions.push({ url, options, form: new URLSearchParams(options.body) });
    return new Response(JSON.stringify({ id: `cs_${sessions.length}`, url: `https://checkout.stripe.com/c/pay/cs_${sessions.length}` }), { status: 200 });
  };
  const app = await createCloudServer({ dataDir, enrollmentToken, enrollmentLimit: 3, clock: () => now, stripe: stripe ?? undefined, fetcher });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const seconds = () => Math.floor(now / 1000);
  const webhook = async (event, { secret = WEBHOOK_SECRET, at = seconds() } = {}) => {
    const payload = JSON.stringify(event);
    const signature = createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex');
    const response = await fetch(`${url}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${at},v1=${signature}` }, body: payload });
    return response.status;
  };
  // Stripe's subscription as it is now; the event only names it.
  const stripeHas = (id, vaultId, { status = 'active', periodEnd, endedAt = null, metadata = {} }) => {
    subscriptions.set(id, { id, object: 'subscription', status, ended_at: endedAt, metadata: { vaultId, ...metadata }, items: { data: [{ current_period_end: periodEnd }] } });
    return webhook({ id: `evt_${randomUUID()}`, type: 'customer.subscription.updated', created: seconds(), data: { object: { id, object: 'subscription' } } });
  };
  return { create: async () => (await CloudClient.create({ url, enrollmentToken, deviceName: 'Phone' })).client, webhook, stripeHas, sessions, url, dbPath: app.dbPath, seconds,
    advance: (ms) => { now += ms; }, now: () => now, stripeDown: (down) => { stripeDown = down; } };
}

const checkout = (client, interval) => client.call('/account/checkout', 'POST', { interval });
const plan = async (client) => (await client.status()).plan;
const iso = (ms) => new Date(ms).toISOString();

test('checkout starts a Stripe Managed Payments subscription for this cloud', async (t) => {
  const cloud = await fixture(t);
  const client = await cloud.create();
  assert.equal((await checkout(client, 'month')).url, 'https://checkout.stripe.com/c/pay/cs_1');
  const [{ url, options, form }] = cloud.sessions;
  assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(options.headers.Authorization, 'Bearer sk_test_x');
  assert.equal(form.get('mode'), 'subscription');
  assert.equal(form.get('managed_payments[enabled]'), 'true');
  assert.equal(form.get('line_items[0][price]'), 'price_month');
  assert.equal(form.get('line_items[0][quantity]'), '1');
  assert.equal(form.get('client_reference_id'), client.credentials.vaultId);
  assert.equal(form.get('subscription_data[metadata][vaultId]'), client.credentials.vaultId);
  assert.equal(form.get('success_url'), `${cloud.url}/?plus=welcome`);
  // A session left open cannot be paid much later, next to a newer one.
  assert.equal(Number(form.get('expires_at')), cloud.seconds() + 30 * 60);
  await assert.rejects(checkout(client, 'week'), (error) => error.status === 400);
});

test('a paid period turns Plus on until its end; Plus then follows Stripe, whatever order events arrive in', async (t) => {
  const cloud = await fixture(t);
  const client = await cloud.create(), vaultId = client.credentials.vaultId;
  const periodEnd = cloud.seconds() + 30 * 24 * 60 * 60;
  assert.equal(await cloud.stripeHas('sub_1', vaultId, { periodEnd }), 200);
  let current = await plan(client);
  assert.equal(current.name, 'plus');
  assert.equal(current.subscribed, true);
  // A day of grace covers the renewal that arrives after the period ends.
  assert.equal(current.plusUntil, iso(periodEnd * 1000 + DAY));
  await assert.rejects(checkout(client, 'year'), (error) => error.status === 409);
  // Cancelled at the end of the period: Plus ends then.
  cloud.advance(30 * DAY);
  await cloud.stripeHas('sub_1', vaultId, { status: 'canceled', periodEnd, endedAt: periodEnd });
  current = await plan(client);
  assert.equal(current.subscribed, false);
  assert.equal(current.plusUntil, iso(periodEnd * 1000));
  // An old event about this subscription changes nothing: the server reads the current state from Stripe.
  assert.equal(await cloud.webhook({ id: 'evt_old', type: 'customer.subscription.created', created: 1, data: { object: { id: 'sub_1', object: 'subscription' } } }), 200);
  assert.equal((await plan(client)).plusUntil, iso(periodEnd * 1000));
  // A slower webhook that read the subscription before it ended cannot bring Plus back: Stripe never reopens it.
  await cloud.stripeHas('sub_1', vaultId, { periodEnd: periodEnd + 999999 });
  assert.equal((await plan(client)).plusUntil, iso(periodEnd * 1000));
  assert.ok((await checkout(client, 'month')).url);
});

test('a renewal that is not paid does not extend Plus, and a cancellation cuts it off when it happens', async (t) => {
  const cloud = await fixture(t);
  const client = await cloud.create(), vaultId = client.credentials.vaultId;
  const firstEnd = cloud.seconds() + 365 * 24 * 60 * 60, secondEnd = firstEnd + 365 * 24 * 60 * 60;
  await cloud.stripeHas('sub_1', vaultId, { periodEnd: firstEnd });
  // Stripe moves to the next period before the renewal is paid.
  cloud.advance(365 * DAY);
  await cloud.stripeHas('sub_1', vaultId, { status: 'past_due', periodEnd: secondEnd });
  assert.equal((await plan(client)).plusUntil, iso(firstEnd * 1000 + DAY));
  cloud.advance(10 * DAY);
  await cloud.stripeHas('sub_1', vaultId, { status: 'canceled', periodEnd: secondEnd, endedAt: cloud.seconds() });
  assert.equal((await plan(client)).plusUntil, iso(firstEnd * 1000 + DAY));
  assert.equal((await plan(client)).name, 'free');
});

test('a refund that ends the subscription early ends Plus at that moment', async (t) => {
  const cloud = await fixture(t);
  const client = await cloud.create(), vaultId = client.credentials.vaultId;
  const periodEnd = cloud.seconds() + 365 * 24 * 60 * 60;
  await cloud.stripeHas('sub_1', vaultId, { periodEnd });
  cloud.advance(3 * DAY);
  await cloud.stripeHas('sub_1', vaultId, { status: 'canceled', periodEnd, endedAt: cloud.seconds() });
  assert.equal((await plan(client)).plusUntil, iso(cloud.now()));
});

test('two subscriptions for one cloud: ending one keeps Plus from the other', async (t) => {
  const cloud = await fixture(t);
  const client = await cloud.create(), vaultId = client.credentials.vaultId;
  const monthEnd = cloud.seconds() + 30 * 24 * 60 * 60, yearEnd = cloud.seconds() + 365 * 24 * 60 * 60;
  await cloud.stripeHas('sub_month', vaultId, { periodEnd: monthEnd });
  await cloud.stripeHas('sub_year', vaultId, { periodEnd: yearEnd });
  await cloud.stripeHas('sub_month', vaultId, { status: 'canceled', periodEnd: monthEnd, endedAt: cloud.seconds() });
  const current = await plan(client);
  assert.equal(current.subscribed, true);
  assert.equal(current.plusUntil, iso(yearEnd * 1000 + DAY));
});

test('a payment after starting over reaches the new cloud through the account', async (t) => {
  const cloud = await fixture(t);
  const client = await cloud.create(), vaultId = client.credentials.vaultId, accountId = randomUUID();
  const db = new DatabaseSync(cloud.dbPath);
  try { db.prepare("INSERT INTO accounts(id,email,vaultId,kdf,authHash,wrappedVaultKey,createdAt,passwordChangedAt) VALUES(?,?,?,'{}','x','x','now','now')").run(accountId, 'person@example.com', vaultId); } finally { db.close(); }
  await checkout(client, 'month');
  assert.equal(cloud.sessions[0].form.get('subscription_data[metadata][accountId]'), accountId);
  assert.equal(cloud.sessions[0].form.get('customer_email'), 'person@example.com');
  // Stripe still has the id of the cloud that was replaced.
  const periodEnd = cloud.seconds() + 1000;
  await cloud.stripeHas('sub_1', '00000000-0000-4000-8000-000000000000', { periodEnd, metadata: { accountId } });
  assert.equal((await plan(client)).plusUntil, iso(periodEnd * 1000 + DAY));
});

test('the webhook only trusts Stripe-signed, recent events, and asks Stripe to retry when Stripe cannot be reached', async (t) => {
  const cloud = await fixture(t);
  const client = await cloud.create(), vaultId = client.credentials.vaultId;
  const event = { id: 'evt_1', type: 'customer.subscription.updated', created: cloud.seconds(), data: { object: { id: 'sub_1', object: 'subscription' } } };
  assert.equal(await cloud.webhook(event, { secret: 'whsec_wrong' }), 400);
  assert.equal(await cloud.webhook(event, { at: cloud.seconds() - 600 }), 400);
  cloud.stripeDown(true);
  assert.equal(await cloud.stripeHas('sub_1', vaultId, { periodEnd: cloud.seconds() + 1000 }), 502);
  assert.equal((await plan(client)).name, 'free');
  cloud.stripeDown(false);
  assert.equal(await cloud.webhook(event), 200);
  assert.equal((await plan(client)).name, 'plus');
  // Unknown clouds and other event types are acknowledged and ignored, so Stripe does not retry them.
  assert.equal(await cloud.stripeHas('sub_2', '00000000-0000-4000-8000-000000000000', { periodEnd: cloud.seconds() + 1000 }), 200);
  assert.equal(await cloud.webhook({ id: 'evt_x', type: 'invoice.paid', created: 1, data: { object: {} } }), 200);
});

test('the first paying subscribers get the founder price on the yearly plan', async (t) => {
  const cloud = await fixture(t);
  const first = await cloud.create(), second = await cloud.create();
  await checkout(first, 'year');
  assert.equal(cloud.sessions[0].form.get('line_items[0][price]'), 'price_founder');
  assert.equal((await plan(first)).founderPrice, true);
  // An abandoned payment does not use a founder place.
  await cloud.stripeHas('sub_abandoned', second.credentials.vaultId, { status: 'incomplete_expired', periodEnd: cloud.seconds() + 1000, endedAt: cloud.seconds() });
  assert.equal((await plan(second)).founderPrice, true);
  await cloud.stripeHas('sub_1', first.credentials.vaultId, { periodEnd: cloud.seconds() + 1000 });
  // The founder limit in this fixture is one subscriber.
  await checkout(second, 'year');
  assert.equal(cloud.sessions[1].form.get('line_items[0][price]'), 'price_year');
  assert.equal((await plan(second)).founderPrice, false);
});

test('without Stripe settings the server offers no checkout', async (t) => {
  const cloud = await fixture(t, { stripe: null });
  const client = await cloud.create();
  assert.equal((await plan(client)).checkout, false);
  await assert.rejects(checkout(client, 'month'), (error) => error.status === 503);
  assert.equal((await fetch(`${cloud.url}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 503);
});
