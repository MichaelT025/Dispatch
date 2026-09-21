export interface FetchCommandCodePlanOptions {
  apiKey?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Read the currently active Command Code plan without retaining credentials or
 * account data. Fail closed: an unavailable or unfamiliar response is not an
 * entitlement.
 */
export async function fetchCommandCodePlan({
  apiKey,
  baseUrl = "https://api.commandcode.ai",
  fetchImpl = fetch,
  signal,
  timeoutMs = 5000,
}: FetchCommandCodePlanOptions): Promise<string | undefined> {
  if (typeof apiKey !== "string" || apiKey.length === 0 || signal?.aborted) return undefined

  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")
  const controller = new AbortController()
  const abortFromOutside = () => controller.abort()
  signal?.addEventListener("abort", abortFromOutside, { once: true })
  const timer = setTimeout(() => controller.abort(), duration)

  try {
    const abortError = () => new Error("Command Code request aborted")
    const bounded = <T>(operation: Promise<T>): Promise<T> => {
      return new Promise<T>((resolve, reject) => {
        const cleanup = () => controller.signal.removeEventListener("abort", onAbort)
        const onAbort = () => {
          cleanup()
          reject(abortError())
        }
        controller.signal.addEventListener("abort", onAbort, { once: true })
        operation.then(resolve, reject).then(cleanup, cleanup)
        if (controller.signal.aborted) onAbort()
      })
    }

    const request = async (path: string): Promise<unknown> => {
      const response = await bounded(fetchImpl(`${normalizedBaseUrl}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: controller.signal,
      }))
      if (!response.ok) {
        try {
          void Promise.resolve(response.body?.cancel?.()).catch(() => undefined)
        } catch {
          // A response body is optional and cancellation is only best effort.
        }
        return undefined
      }
      return await bounded(Promise.resolve(response.json()))
    }

    const whoami = await request("/alpha/whoami")
    if (!isRecord(whoami)) return undefined

    let orgId: string | undefined
    if (isRecord(whoami.org) && typeof whoami.org.id === "string") {
      const trimmed = whoami.org.id.trim()
      if (trimmed) orgId = trimmed
    }
    const query = orgId === undefined ? "" : `?orgId=${encodeURIComponent(orgId)}`
    const subscriptions = await request(`/alpha/billing/subscriptions${query}`)
    if (!isRecord(subscriptions) || !isRecord(subscriptions.data)) return undefined

    const { status, planId } = subscriptions.data
    if (
      (status !== "active" && status !== "trialing") ||
      typeof planId !== "string" ||
      planId.length === 0
    ) {
      return undefined
    }
    return planId
  } catch {
    return undefined
  } finally {
    controller.abort()
    clearTimeout(timer)
    signal?.removeEventListener("abort", abortFromOutside)
  }
}
