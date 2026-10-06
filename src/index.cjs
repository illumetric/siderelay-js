"use strict";
const { createHash } = require("node:crypto");
const RETRYABLE = new Set([408, 409, 425, 429]);
const DEFAULT_ENDPOINT = "https://collector.siderelay.com";
const result = (
  status,
  code,
  attempts,
  httpStatus = null,
  acknowledgements = [],
) => ({
  status,
  message: {
    received: "Received",
    retry: "Try again",
    configuration: "Check configuration",
  }[status],
  code,
  attempts,
  httpStatus,
  acknowledgements,
});

function hashIdentity(value, type = "email") {
  let normalized = String(value).trim().toLowerCase();
  if (type === "phone") normalized = normalized.replace(/\D/g, "");
  if (["first_name", "last_name"].includes(type))
    normalized = normalized.replace(/[\p{P}\s]/gu, "");
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizeEvent(input) {
  if (
    !input ||
    typeof input.event_id !== "string" ||
    !input.event_id.trim() ||
    input.event_id.length > 128
  )
    throw new Error("event_id_required");
  if (
    typeof input.event_name !== "string" ||
    !input.event_name.trim() ||
    input.event_name.length > 128
  )
    throw new Error("event_name_required");
  if (
    typeof input.occurred_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      input.occurred_at,
    ) ||
    !Number.isFinite(Date.parse(input.occurred_at))
  )
    throw new Error("event_time_required");
  if (
    input.permissions &&
    (typeof input.permissions !== "object" ||
      Object.entries(input.permissions).some(
        ([purpose, decision]) =>
          !["collection", "retention", "delivery"].includes(purpose) ||
          !["granted", "denied", "unknown"].includes(decision),
      ))
  )
    throw new Error("invalid_permissions");
  const consent = {
    analytics: "unknown",
    advertising: "unknown",
    personalization: "unknown",
    source: "custom",
    ...input.consent,
  };
  for (const purpose of ["analytics", "advertising", "personalization"]) {
    if (consent[purpose] === "not_required") consent[purpose] = "unknown";
    if (!["unknown", "granted", "denied"].includes(consent[purpose]))
      throw new Error("invalid_consent");
  }
  if (
    consent.global_privacy_control ||
    consent.sale_sharing_opt_out ||
    consent.targeted_advertising_opt_out
  ) {
    consent.advertising = "denied";
    consent.personalization = "denied";
  }
  const identity = { ...input.identity };
  for (const type of ["email", "phone", "user_id"]) {
    if (identity[type]) {
      identity[`${type}_sha256`] = hashIdentity(identity[type], type);
      delete identity[type];
    }
  }
  if (
    input.event_name === "purchase" &&
    (!Number.isFinite(input.properties?.value) ||
      !/^[A-Z]{3}$/.test(input.properties?.currency ?? "") ||
      !input.properties?.transaction_id)
  )
    throw new Error("purchase_details_required");
  const event = {
    event_id: input.event_id,
    event_name: input.event_name,
    occurred_at: new Date(input.occurred_at).toISOString(),
    environment: input.environment ?? "production",
    source: {
      type: "backend",
      name: "SideRelay JavaScript SDK",
      version: "0.1.1",
    },
    identity,
    consent,
    ...(input.permissions ? { permissions: input.permissions } : {}),
    context: input.context ?? {},
    properties: input.properties ?? {},
  };
  if (Buffer.byteLength(JSON.stringify(event), "utf8") > 96 * 1024)
    throw new Error("event_too_large");
  return event;
}

class SideRelay {
  #token;
  #endpoint;
  #transport;
  #sleep;
  #timeout;
  #attempts;
  #budget;
  constructor({
    token,
    endpoint = DEFAULT_ENDPOINT,
    transport = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = 5000,
    maxAttempts = 3,
    timeBudgetMs = 20000,
  }) {
    if (
      !/^sr_token_(test|live)_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/.test(
        token ?? "",
      )
    )
      throw new Error("Connection token is invalid");
    const url = new URL(endpoint);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error("Use HTTPS, or localhost for development");
    if (
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 10 ||
      timeoutMs <= 0 ||
      timeBudgetMs <= 0
    )
      throw new Error("Invalid retry settings");
    this.#token = token;
    this.#endpoint = url.origin;
    this.#transport = transport;
    this.#sleep = sleep;
    this.#timeout = timeoutMs;
    this.#attempts = maxAttempts;
    this.#budget = timeBudgetMs;
  }
  async track(event) {
    return this.#send([event], false);
  }
  async purchase(event) {
    return this.track({ ...event, event_name: "purchase" });
  }
  async lead(event) {
    return this.track({ ...event, event_name: "generate_lead" });
  }
  async batch(events) {
    return this.#send(events, true);
  }
  async #send(inputs, batch) {
    let events, body;
    try {
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100)
        throw new Error("invalid_batch");
      events = inputs.map(normalizeEvent);
      body = JSON.stringify(batch ? { events } : events[0]);
      if (Buffer.byteLength(body, "utf8") > (batch ? 200 : 96) * 1024)
        throw new Error("body_too_large");
    } catch (error) {
      return result("configuration", error.message, 0);
    }
    const started = Date.now();
    let httpStatus = null;
    for (let attempt = 1; attempt <= this.#attempts; attempt++) {
      let delay = Math.round(
        250 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5),
      );
      const remaining = this.#budget - (Date.now() - started);
      if (remaining <= 0)
        return result("retry", "time_budget_exceeded", attempt - 1, httpStatus);
      try {
        const response = await this.#transport(
          `${this.#endpoint}/v1/${batch ? "batch" : "events"}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.#token}`,
            },
            body,
            redirect: "error",
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(this.#timeout, remaining)),
            ),
          },
        );
        httpStatus = response.status;
        if (response.status === 202) {
          const payload = await response.json();
          const receipts = batch ? payload.acknowledgements : [payload];
          if (
            !Array.isArray(receipts) ||
            receipts.length !== events.length ||
            !receipts.every(
              (receipt, i) =>
                receipt?.durable === true &&
                ["accepted", "duplicate"].includes(receipt.status) &&
                receipt.event_id === events[i].event_id,
            )
          )
            return result(
              "retry",
              "invalid_acknowledgement",
              attempt,
              httpStatus,
            );
          return result("received", "accepted", attempt, httpStatus, receipts);
        }
        if (!RETRYABLE.has(response.status) && response.status < 500)
          return result(
            "configuration",
            "request_rejected",
            attempt,
            httpStatus,
          );
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const wait = Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(wait)) delay = Math.max(delay, wait);
        }
      } catch {
        /* A timeout may have happened after acceptance: retry the immutable IDs. */
      }
      if (
        attempt === this.#attempts ||
        Date.now() - started + delay >= this.#budget
      )
        return result("retry", "temporarily_unavailable", attempt, httpStatus);
      await this.#sleep(delay);
    }
  }
}
module.exports = { SideRelay, hashIdentity, normalizeEvent };
