import assert from "node:assert/strict"
import test from "node:test"
import { fetchCommandCodePlan } from "../src/plan.ts"

const response = (value, ok = true) => ({ ok, json: async () => value })

function fakeFetch(routes, seen = []) {
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    const route = routes.find(([suffix]) => url.endsWith(suffix))
    if (!route) throw new Error("unexpected request")
    return typeof route[1] === "function" ? route[1](url, init) : route[1]
  }
  return { fetchImpl, seen }
}

test("reads an org plan and uses only org.id", async () => {
  const { fetchImpl, seen } = fakeFetch([
    ["/alpha/whoami", response({ user: { id: "wrong" }, org: { id: " org-1 " } })],
    ["/alpha/billing/subscriptions?orgId=org-1", response({ data: { status: "active", planId: "goat" } })],
  ])
  assert.equal(await fetchCommandCodePlan({ apiKey: "key", baseUrl: "https://api.commandcode.ai/", fetchImpl }), "goat")
  assert.equal(seen[0].url, "https://api.commandcode.ai/alpha/whoami")
  assert.equal(seen[0].init.headers.Authorization, "Bearer key")
  assert.equal(seen[0].init.headers.Accept, "application/json")
  assert.equal(seen[0].init.redirect, "error")
})

test("supports personal accounts without an org query", async () => {
  const { fetchImpl, seen } = fakeFetch([
    ["/alpha/whoami", response({ user: { id: "ignored" }, org: null })],
    ["/alpha/billing/subscriptions", response({ data: { status: "trialing", planId: "trial" } })],
  ])
  assert.equal(await fetchCommandCodePlan({ apiKey: "key", fetchImpl }), "trial")
  assert.equal(seen[1].url, "https://api.commandcode.ai/alpha/billing/subscriptions")
})

test("fails closed for missing keys, bad responses, and expired plans", async () => {
  let calls = 0
  assert.equal(await fetchCommandCodePlan({ apiKey: "", fetchImpl: async () => { calls++ } }), undefined)
  assert.equal(calls, 0)
  for (const whoami of [null, {}, { org: { id: "x" } }]) {
    const { fetchImpl } = fakeFetch([["/alpha/whoami", response(whoami)]])
    assert.equal(await fetchCommandCodePlan({ apiKey: "key", fetchImpl }), undefined)
  }
  const { fetchImpl } = fakeFetch([
    ["/alpha/whoami", response({ org: null })],
    ["/alpha/billing/subscriptions", response({ data: { status: "canceled", planId: "goat" } })],
  ])
  assert.equal(await fetchCommandCodePlan({ apiKey: "key", fetchImpl }), undefined)
})

test("bounds a stalled fetch and response body", async () => {
  const stalledFetch = () => new Promise(() => {})
  assert.equal(await fetchCommandCodePlan({ apiKey: "key", fetchImpl: stalledFetch, timeoutMs: 10 }), undefined)
  const bodyStalls = async () => ({ ok: true, json: () => new Promise(() => {}) })
  assert.equal(await fetchCommandCodePlan({ apiKey: "key", fetchImpl: bodyStalls, timeoutMs: 10 }), undefined)
})

test("cancels unused error bodies and honors an aborted signal", async () => {
  let canceled = 0
  const errorFetch = async () => ({
    ok: false,
    body: { cancel: () => { canceled++; return Promise.resolve() } },
    json: async () => ({ data: { status: "active", planId: "wrong" } }),
  })
  assert.equal(await fetchCommandCodePlan({ apiKey: "key", fetchImpl: errorFetch }), undefined)
  assert.equal(canceled, 1)

  const external = new AbortController()
  let requestSignal
  const stalledFetch = async (_url, init) => {
    requestSignal = init.signal
    return new Promise(() => {})
  }
  const pending = fetchCommandCodePlan({ apiKey: "key", fetchImpl: stalledFetch, signal: external.signal, timeoutMs: 1000 })
  external.abort()
  assert.equal(await pending, undefined)
  assert.equal(requestSignal.aborted, true)
})
