import { test } from "node:test";
import assert from "node:assert/strict";
import { SideRelay, hashIdentity, normalizeEvent } from "../src/index.js";
import { createRequire } from "node:module";
const token = `sr_token_test_${"a".repeat(24)}.${"b".repeat(43)}`;
const event = {
  event_id: "purchase:123",
  occurred_at: "2026-10-06T12:00:00Z",
  properties: { transaction_id: "123", value: 10, currency: "EUR" },
};
const receipt = (id = event.event_id) =>
  new Response(
    JSON.stringify({ status: "accepted", durable: true, event_id: id }),
    { status: 202 },
  );
test("ESM and CommonJS expose the same client", () =>
  assert.equal(
    createRequire(import.meta.url)("../src/index.cjs").SideRelay,
    SideRelay,
  ));
test("one token, default denied/unknown permissions, durable receipt", async () => {
  const client = new SideRelay({
    token,
    transport: async (url, options) => {
      assert.equal(url, "https://collector.siderelay.com/v1/events");
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      assert.equal(options.redirect, "error");
      const body = JSON.parse(options.body);
      assert.equal(body.consent.advertising, "unknown");
      assert.equal(body.event_id, event.event_id);
      return receipt();
    },
  });
  assert.equal((await client.purchase(event)).status, "received");
});
test("retries keep identical body and hash identity before sending", async () => {
  const bodies = [];
  const client = new SideRelay({
    token,
    sleep: async () => {},
    transport: async (_, options) => {
      bodies.push(options.body);
      return bodies.length === 1
        ? new Response("", { status: 503 })
        : receipt();
    },
  });
  const outcome = await client.purchase({
    ...event,
    identity: { email: " TEST@example.com " },
  });
  assert.equal(outcome.attempts, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(
    JSON.parse(bodies[0]).identity.email_sha256,
    hashIdentity("test@example.com"),
  );
  assert.equal(JSON.parse(bodies[0]).identity.email, undefined);
});
test("validation and authentication failures do not retry", async () => {
  let calls = 0;
  const client = new SideRelay({
    token,
    transport: async () => {
      calls++;
      return new Response("", { status: 401 });
    },
  });
  assert.equal(
    (await client.purchase({ ...event, event_id: "" })).status,
    "configuration",
  );
  assert.equal(calls, 0);
  assert.equal((await client.purchase(event)).status, "configuration");
  assert.equal(calls, 1);
});
test("honors long Retry-After by handing work back to the host queue", async () => {
  const client = new SideRelay({
    token,
    transport: async () =>
      new Response("", { status: 429, headers: { "retry-after": "60" } }),
  });
  assert.equal((await client.purchase(event)).attempts, 1);
});
test("batch validates receipts and enforces size", async () => {
  const client = new SideRelay({
    token,
    transport: async () =>
      new Response(
        JSON.stringify({
          acknowledgements: [
            { durable: true, status: "accepted", event_id: event.event_id },
          ],
        }),
        { status: 202 },
      ),
  });
  assert.equal(
    (await client.batch([{ ...event, event_name: "purchase" }])).status,
    "received",
  );
  assert.equal(
    (await client.batch(Array(101).fill(event))).status,
    "configuration",
  );
});
test("GPC overrides explicit advertising grant", async () => {
  const client = new SideRelay({
    token,
    transport: async (_, options) => {
      assert.equal(JSON.parse(options.body).consent.advertising, "denied");
      return receipt();
    },
  });
  await client.purchase({
    ...event,
    consent: { advertising: "granted", global_privacy_control: true },
  });
});
test("non-durable response is never Received", async () => {
  const client = new SideRelay({
    token,
    transport: async () => new Response("{}", { status: 202 }),
  });
  assert.equal((await client.purchase(event)).status, "retry");
});
test("shared protocol fixtures normalize timestamps and match hashes", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixtures = JSON.parse(
    await readFile(
      new URL("../fixtures/protocol-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const { normalizeEvent } = await import("../src/index.js");
  assert.equal(
    normalizeEvent(fixtures.input).occurred_at,
    "2026-10-06T12:00:00.000Z",
  );
  for (const fixture of fixtures.hashes)
    assert.equal(hashIdentity(fixture.input, fixture.type), fixture.sha256);
});

test("separate privacy choices survive serialization and invalid choices do not send", async () => {
  const event = normalizeEvent({
    event_id: "permission:1",
    event_name: "generate_lead",
    occurred_at: "2026-10-06T12:00:00Z",
    permissions: { retention: "denied", delivery: "unknown" },
  });
  assert.deepEqual(event.permissions, {
    retention: "denied",
    delivery: "unknown",
  });
  assert.throws(() =>
    normalizeEvent({ ...event, permissions: { delivery: true } }),
  );
});
