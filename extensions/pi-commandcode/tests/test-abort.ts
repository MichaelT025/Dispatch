/**
 * Abort tests against the real streamCommandCode core.
 */

import assert from "node:assert/strict"
import { after, before, beforeEach, describe, it } from "node:test"

import {
  collectEvents,
  createTestDeps,
  createTestEventStream,
  makeContext,
  makeModel,
  startMockCommandCodeServer,
  type MockCommandCodeServer,
} from "./helpers.ts"

let server: MockCommandCodeServer

before(async () => {
  server = await startMockCommandCodeServer()
})

after(async () => {
  await server.close()
})

beforeEach(() => {
  server.reset()
})

describe("streamCommandCode — abort behavior", () => {
  it("emits aborted error when signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const { streamCommandCode } = createTestDeps({ apiBase: server.baseUrl() })

    const events = await collectEvents(
      streamCommandCode(makeModel(), makeContext(), {
        apiKey: "mock-key",
        signal: controller.signal,
      }),
    )

    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "error"],
    )
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(error.reason, "aborted")
    assert.equal(error.error.stopReason, "aborted")
    assert.equal(server.requestCount(), 0)
  })

  it("emits aborted error and cancels the response reader mid-stream", async () => {
    server.mockResponse({
      type: "success",
      events: [JSON.stringify({ type: "text-delta", text: "first" })],
      hangAfterLast: true,
      // Exercise a response slower than the old 50ms abort timer.
      responseDelay: 100,
    })
    const controller = new AbortController()
    const { streamCommandCode } = createTestDeps({
      apiBase: server.baseUrl(),
      createStream: () => {
        const stream = createTestEventStream()
        const push = stream.push.bind(stream)
        stream.push = (event) => {
          push(event)
          if (event.type === "text_delta") controller.abort()
        }
        return stream
      },
    })

    const stream = streamCommandCode(makeModel(), makeContext(), {
      apiKey: "mock-key",
      signal: controller.signal,
    })

    const events = await collectEvents(stream, 5_000).finally(() => {
      // Also release a hanging mock response if collection times out.
      controller.abort()
    })

    assert.ok(
      events.some((event) => event.type === "text_delta"),
      "stream should process data before abort",
    )
    const error = events.at(-1)
    assert.equal(error?.type, "error")
    if (error?.type !== "error") throw new Error("expected error")
    assert.equal(error.reason, "aborted")
    assert.equal(error.error.errorMessage, "Request aborted")
    const deadline = Date.now() + 5_000
    while (!server.responseClosedBeforeEnd() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(server.responseClosedBeforeEnd(), "abort should close the hanging upstream response")
  })
})
