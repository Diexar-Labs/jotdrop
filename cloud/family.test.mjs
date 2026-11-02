import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCloudServer } from './server.mjs';
import { CloudClient } from './shared/client.mjs';
import { encryptEnvelope, generateVaultKey, hashToken, randomToken } from './shared/crypto.mjs';

const DAY = 24 * 60 * 60 * 1000, MINUTE = 60 * 1000;
const WEBHOOK_SECRET = 'whsec_family';
const STRIPE = { secretKey: 'sk_test_family', webhookSecret: WEBHOOK_SECRET, monthPrice: 'price_month', yearPrice: 'price_year', founderYearPrice: 'price_founder', founderLimit: 1,
  familyMonthPrice: 'price_family_month', familyYearPrice: 'price_family_year', familyFounderYearPrice: 'price_family_founder' };
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

async function fixture(t, { stripe = STRIPE } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jotdrop-family-test-'));
  const mails = [], sessions = [], subscriptions = new Map(), cancelled = [];
  let now = Date.parse('2026-11-02T08:00:00Z');
  const fetcher = async (url, options) => {
    const subscription = /^https:\/\/api\.stripe\.com\/v1\/subscriptions\/(sub_\w+)$/.exec(url);
    if (subscription && options?.method === 'DELETE') cancelled.push(subscription[1]);
    if (subscription) return new Response(JSON.stringify(subscriptions.get(subscription[1])), { status: subscriptions.has(subscription[1]) ? 200 : 404 });
    sessions.push(new URLSearchParams(options.body));
    return new Response(JSON.stringify({ id: `cs_${sessions.length}`, url: `https://checkout.stripe.com/c/pay/cs_${sessions.length}` }), { status: 200 });
  };
  const app = await createCloudServer({ dataDir, signupTrial: 0, mailer: async (mail) => { mails.push(mail); }, serverKey: randomToken(), enrollmentToken: randomToken(), clock: () => now, freeDeviceLimit: 100, signupsPerAddress: 1000, stripe, fetcher });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.port}`;
  const seconds = () => Math.floor(now / 1000);
  const api = async (path, body) => {
    const response = await fetch(`${url}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  // Stripe's subscription as it is now, with the price that was bought.
  const stripeHas = async (id, person, { price = 'price_family_year', status = 'active', periodEnd = seconds() + 365 * 86400, endedAt = null } = {}) => {
    subscriptions.set(id, { id, object: 'subscription', status, ended_at: endedAt, metadata: { vaultId: person.client.credentials.vaultId }, items: { data: [{ current_period_end: periodEnd, price: { id: price } }] } });
    const payload = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'customer.subscription.updated', created: seconds(), data: { object: { id, object: 'subscription' } } });
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${seconds()}.${payload}`).digest('hex');
    const response = await fetch(`${url}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${seconds()},v1=${signature}` }, body: payload });
    assert.equal(response.status, 200);
  };
  async function signUp(name) {
    now += MINUTE + 1;
    const email = `${name}@example.test`, vaultKey = generateVaultKey(), token = randomToken(), authKey = randomToken();
    const started = await api('/accounts', { email, authKey, kdf: { salt: b64(randomBytes(16)), memory: 65536, passes: 3, parallelism: 1 }, wrappedVaultKey: JSON.stringify(await encryptEnvelope(randomToken(), { vaultKey }, 'jotdrop:wrap:v1')), recoveryTokenHash: await hashToken(randomToken()), deviceName: 'Phone', deviceTokenHash: await hashToken(token) });
    assert.equal(started.status, 202);
    const code = mails.filter((mail) => mail.to === email && mail.kind === 'verify').at(-1).code;
    const verified = await api('/accounts/verify', { signupId: started.body.signupId, code });
    assert.equal(verified.status, 201);
    return { email, authKey, client: new CloudClient({ url, vaultId: verified.body.vaultId, deviceId: verified.body.deviceId, token, vaultKey }) };
  }
  return { signUp, stripeHas, sessions, cancelled, seconds, dbPath: app.dbPath, advance: (ms) => { now += ms; } };
}

const plan = async (person) => (await person.client.status()).plan;
const family = (person) => person.client.call('/family', 'GET');
const invite = (person) => person.client.call('/family/invites', 'POST', {});
const join_ = (person, token) => person.client.call('/family/join', 'POST', { token });
const remove = (person, accountId) => person.client.call(`/family/members/${accountId}`, 'DELETE');
const refused = async (promise, status, code) => {
  await assert.rejects(promise, (error) => { assert.equal(error.status, status); if (code) assert.equal(error.code, code); return true; });
};

test('checkout sells the family plan at its own prices, with the founder price for the first subscribers', async (t) => {
  const app = await fixture(t);
  const ana = await app.signUp('ana');
  assert.equal((await plan(ana)).familyCheckout, true);
  await ana.client.call('/account/checkout', 'POST', { interval: 'month', plan: 'family' });
  await ana.client.call('/account/checkout', 'POST', { interval: 'year', plan: 'family' });
  assert.deepEqual(app.sessions.map((form) => form.get('line_items[0][price]')), ['price_family_month', 'price_family_founder']);
  await refused(ana.client.call('/account/checkout', 'POST', { interval: 'year', plan: 'team' }), 400);
  // The one founder place in this fixture is taken: the next family pays the normal yearly price.
  await app.stripeHas('sub_ana', ana);
  const ben = await app.signUp('ben');
  await ben.client.call('/account/checkout', 'POST', { interval: 'year', plan: 'family' });
  assert.equal(app.sessions.at(-1).get('line_items[0][price]'), 'price_family_year');
});

test('without family prices there is no family checkout', async (t) => {
  const { familyMonthPrice, familyYearPrice, familyFounderYearPrice, ...plain } = STRIPE;
  const app = await fixture(t, { stripe: plain });
  const ana = await app.signUp('ana');
  assert.equal((await plan(ana)).familyCheckout, false);
  await refused(ana.client.call('/account/checkout', 'POST', { interval: 'year', plan: 'family' }), 503);
});

test('a family owner invites up to five people, who get Plus for as long as the family plan runs', async (t) => {
  const app = await fixture(t);
  const ana = await app.signUp('ana');
  // Free and individual Plus cannot invite.
  await refused(invite(ana), 402, 'family-required');
  await app.stripeHas('sub_single', ana, { price: 'price_year' });
  await refused(invite(ana), 402, 'family-required');
  const periodEnd = app.seconds() + 365 * 86400;
  await app.stripeHas('sub_family', ana, { periodEnd });

  const people = [];
  for (const name of ['ben', 'cas', 'dee', 'eva', 'fay']) {
    const person = await app.signUp(name);
    assert.equal((await plan(person)).name, 'free');
    const { token } = await invite(ana);
    assert.equal((await join_(person, token)).owner, 'ana@example.test');
    const current = await plan(person);
    assert.equal(current.name, 'plus');
    assert.equal(current.plusUntil, new Date(periodEnd * 1000 + DAY).toISOString());
    assert.equal(current.family, 'member');
    people.push(person);
  }
  // Six people with the owner: no seat left.
  await refused(invite(ana), 409, 'family-full');
  const view = await family(ana);
  assert.equal(view.role, 'owner');
  assert.deepEqual(view.members.map((member) => member.email), ['ben@example.test', 'cas@example.test', 'dee@example.test', 'eva@example.test', 'fay@example.test']);
  // A member sees who pays, not the others.
  const memberView = await family(people[0]);
  assert.equal(memberView.role, 'member');
  assert.equal(memberView.owner, 'ana@example.test');
  assert.equal(memberView.members, undefined);

  // The family plan ends: everyone is back to free, and nobody can be invited.
  app.advance(400 * DAY);
  assert.equal((await plan(people[0])).name, 'free');
  await refused(invite(ana), 402, 'family-required');
});

test('an invitation works once, for a week, and not for someone who already has a family', async (t) => {
  const app = await fixture(t);
  const ana = await app.signUp('ana'), ben = await app.signUp('ben'), cas = await app.signUp('cas'), dee = await app.signUp('dee');
  await app.stripeHas('sub_ana', ana);
  await app.stripeHas('sub_dee', dee);
  const { token } = await invite(ana);
  await refused(join_(ana, token), 409, 'own-family');
  await join_(ben, token);
  await refused(join_(cas, token), 404);
  // A family owner cannot join another family, a member cannot be in two.
  await refused(join_(dee, (await invite(ana)).token), 409, 'in-family');
  await refused(join_(ben, (await invite(dee)).token), 409, 'in-family');
  const late = (await invite(ana)).token;
  app.advance(7 * DAY + 1);
  await refused(join_(cas, late), 404);
  await refused(join_(cas, 'not-a-token'), 400);
});

test('a member can leave and the owner can remove a member; both end Plus at once', async (t) => {
  const app = await fixture(t);
  const ana = await app.signUp('ana'), ben = await app.signUp('ben'), cas = await app.signUp('cas');
  await app.stripeHas('sub_ana', ana);
  await join_(ben, (await invite(ana)).token);
  await join_(cas, (await invite(ana)).token);
  const { members } = await family(ana);
  const benRow = members.find((member) => member.email === ben.email), casRow = members.find((member) => member.email === cas.email);
  // Only the owner removes others.
  await refused(remove(ben, casRow.accountId), 404);
  await remove(ben, benRow.accountId);
  assert.equal((await plan(ben)).name, 'free');
  assert.equal((await family(ben)).role, null);
  await remove(ana, casRow.accountId);
  assert.equal((await plan(cas)).name, 'free');
  assert.deepEqual((await family(ana)).members, []);
});

test('someone whose old family ended and who now pays for a family is the owner, not a member', async (t) => {
  const app = await fixture(t);
  const ana = await app.signUp('ana'), ben = await app.signUp('ben'), cas = await app.signUp('cas');
  await app.stripeHas('sub_ana', ana, { periodEnd: app.seconds() + 30 * 86400 });
  await join_(ben, (await invite(ana)).token);
  app.advance(40 * DAY);
  await app.stripeHas('sub_ben', ben);
  assert.equal((await plan(ben)).family, 'owner');
  assert.equal((await family(ben)).role, 'owner');
  await join_(cas, (await invite(ben)).token);
  assert.deepEqual((await family(ben)).members.map((member) => member.email), ['cas@example.test']);
  // Ana pays again: Ben no longer takes a place in her family.
  await app.stripeHas('sub_ana_again', ana);
  assert.deepEqual((await family(ana)).members, []);
  assert.equal((await family(ben)).role, 'owner');
});

test('a server without family prices does not take the family away on the next Stripe event', async (t) => {
  const { familyMonthPrice, familyYearPrice, familyFounderYearPrice, ...plain } = STRIPE;
  const app = await fixture(t, { stripe: plain });
  const ana = await app.signUp('ana'), ben = await app.signUp('ben');
  await app.stripeHas('sub_ana', ana);
  // Marked as a family while the settings were there.
  const db = new DatabaseSync(app.dbPath);
  try { db.prepare("INSERT INTO family_subscriptions VALUES('sub_ana')").run(); } finally { db.close(); }
  await join_(ben, (await invite(ana)).token);
  // The renewal arrives on a server whose family settings went missing.
  await app.stripeHas('sub_ana', ana, { periodEnd: app.seconds() + 400 * 86400 });
  assert.equal((await plan(ben)).name, 'plus');
});

test('closing the owner account ends the family; closing a member account frees a seat', async (t) => {
  const app = await fixture(t);
  const ana = await app.signUp('ana'), ben = await app.signUp('ben'), cas = await app.signUp('cas');
  await app.stripeHas('sub_ana', ana);
  await join_(ben, (await invite(ana)).token);
  await join_(cas, (await invite(ana)).token);
  await cas.client.call('/account/delete', 'POST', { confirm: 'DELETE MY CLOUD', currentAuthKey: cas.authKey });
  assert.deepEqual((await family(ana)).members.map((member) => member.email), ['ben@example.test']);
  await ana.client.call('/account/delete', 'POST', { confirm: 'DELETE MY CLOUD', currentAuthKey: ana.authKey });
  assert.deepEqual(app.cancelled, ['sub_ana']);
  assert.equal((await plan(ben)).name, 'free');
  assert.equal((await family(ben)).role, null);
});
