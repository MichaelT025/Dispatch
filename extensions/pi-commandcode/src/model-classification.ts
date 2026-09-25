import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * User-owned Command Code model classification.
 *
 * The live Provider API says which models exist; it says nothing about plan
 * eligibility. That judgement lives in one JSON file the user can edit and
 * reload with `/commandcode-refresh` instead of a compiled-in allowlist.
 * Classification only chooses the selector a model appears in: Command Code's
 * service still decides what each request is charged against.
 */

export const MODEL_CLASSIFICATION_VERSION = 1
export const MODEL_CLASSIFICATION_FILE_NAME = "commandcode-model-classification.json"
export const PACKAGED_CLASSIFICATION_PATH = fileURLToPath(
  new URL(`../config/${MODEL_CLASSIFICATION_FILE_NAME}`, import.meta.url),
)

/** `hidden` holds IDs that are listed live but must stay out of both selectors. */
export const MODEL_CLASSES = ["plan", "free", "api", "hidden"] as const
export type ModelClass = (typeof MODEL_CLASSES)[number]

export interface ModelClassification {
  version: typeof MODEL_CLASSIFICATION_VERSION
  reviewedOn?: string
  plan: readonly string[]
  free: readonly string[]
  api: readonly string[]
  hidden: readonly string[]
}

export type ClassificationSource = "user" | "seeded" | "last-good" | "packaged"

export interface LoadedModelClassification {
  classification: ModelClassification
  source: ClassificationSource
  path: string
  /** Problems the user should fix; the file itself was not usable as written. */
  warnings: string[]
  /** Informational notes, such as the file having been created. */
  notes: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Validates a parsed classification document. Every problem is reported at
 * once so a single edit/refresh cycle can fix them all. An ID listed twice,
 * in one list or across lists, is an error: each model has exactly one class.
 */
export function parseModelClassification(value: unknown): ModelClassification {
  if (!isRecord(value)) throw new Error("expected a JSON object")
  const errors: string[] = []
  if (value.version !== MODEL_CLASSIFICATION_VERSION) {
    errors.push(`"version" must be ${MODEL_CLASSIFICATION_VERSION}`)
  }
  if (value.reviewedOn !== undefined && typeof value.reviewedOn !== "string") {
    errors.push(`"reviewedOn" must be a string`)
  }

  const seen = new Map<string, ModelClass>()
  const lists = {} as Record<ModelClass, string[]>
  for (const name of MODEL_CLASSES) {
    const raw = value[name]
    lists[name] = []
    if (raw === undefined && name === "hidden") continue
    if (!Array.isArray(raw)) {
      errors.push(`"${name}" must be an array of model IDs`)
      continue
    }
    raw.forEach((id, index) => {
      if (typeof id !== "string" || id.trim().length === 0) {
        errors.push(`"${name}[${index}]" must be a non-empty string`)
        return
      }
      if (id !== id.trim()) {
        errors.push(`"${name}[${index}]" (${JSON.stringify(id)}) has surrounding whitespace`)
        return
      }
      const previous = seen.get(id)
      if (previous) {
        errors.push(
          previous === name
            ? `"${id}" is listed more than once in "${name}"`
            : `"${id}" is listed in both "${previous}" and "${name}"`,
        )
        return
      }
      seen.set(id, name)
      lists[name].push(id)
    })
  }

  if (errors.length > 0) throw new Error(errors.join("; "))
  return {
    version: MODEL_CLASSIFICATION_VERSION,
    ...(typeof value.reviewedOn === "string" ? { reviewedOn: value.reviewedOn } : {}),
    ...lists,
  }
}

export function classifyModelId(classification: ModelClassification, id: string): ModelClass | undefined {
  return MODEL_CLASSES.find((name) => classification[name].includes(id))
}

export interface ClassificationReport {
  /** Live IDs present in no list. Shown as unclassified, never assumed plan or API. */
  unclassified: string[]
  /** Classified IDs that the live catalog no longer lists. */
  stale: string[]
}

export function reconcileModelClassification(
  classification: ModelClassification,
  liveIds: readonly string[],
): ClassificationReport {
  const live = new Set(liveIds)
  return {
    unclassified: liveIds.filter((id) => classifyModelId(classification, id) === undefined),
    stale: MODEL_CLASSES.flatMap((name) => classification[name].filter((id) => !live.has(id))),
  }
}

function formatIds(ids: readonly string[], limit = 8): string {
  const shown = ids.slice(0, limit).join(", ")
  return ids.length > limit ? `${shown}, … (+${ids.length - limit} more)` : shown
}

/** Human-readable warnings for a reconciliation; empty when the file matches the live catalog. */
export function describeClassificationReport(report: ClassificationReport, path: string): string[] {
  const lines: string[] = []
  if (report.unclassified.length > 0) {
    lines.push(
      `${report.unclassified.length} live Command Code model(s) are unclassified and are shown as "Unclassified" under commandcode-api: ${formatIds(report.unclassified)}. Add each ID to "plan", "free", "api" or "hidden" in ${path}, then run /commandcode-refresh.`,
    )
  }
  if (report.stale.length > 0) {
    lines.push(
      `${report.stale.length} classified Command Code model(s) are not in the live catalog: ${formatIds(report.stale)}. They are ignored; remove them from ${path} if they were retired.`,
    )
  }
  return lines
}

async function readClassificationFile(path: string): Promise<ModelClassification> {
  const contents = await readFile(path, "utf-8")
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (error) {
    throw new Error(`invalid JSON (${errorMessage(error)})`)
  }
  return parseModelClassification(parsed)
}

export interface LoadModelClassificationOptions {
  path: string
  packagedPath?: string
  /** Last classification successfully read from `path`, kept across a bad edit. */
  lastGood?: ModelClassification
}

/**
 * Reads the user's classification file on every call so edits apply on the
 * next refresh or session without reinstalling.
 *
 * - Missing file: created from the packaged defaults (never overwrites an
 *   existing file); if it cannot be written the packaged defaults are used.
 * - Unreadable or invalid file: left untouched and reported; the last good
 *   copy from this process is used, else the packaged defaults.
 */
export async function loadModelClassification(
  options: LoadModelClassificationOptions,
): Promise<LoadedModelClassification> {
  const { path, packagedPath = PACKAGED_CLASSIFICATION_PATH, lastGood } = options
  const loadPackaged = () => readClassificationFile(packagedPath)

  let userError: unknown
  try {
    return { classification: await readClassificationFile(path), source: "user", path, warnings: [], notes: [] }
  } catch (error) {
    userError = error
  }

  if ((userError as NodeJS.ErrnoException)?.code === "ENOENT") {
    const packagedText = await readFile(packagedPath, "utf-8")
    const packaged = parseModelClassification(JSON.parse(packagedText))
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, packagedText, { encoding: "utf-8", mode: 0o600, flag: "wx" })
      return {
        classification: packaged,
        source: "seeded",
        path,
        warnings: [],
        notes: [`Created ${path} from Dispatch's packaged defaults${packaged.reviewedOn ? ` (reviewed ${packaged.reviewedOn})` : ""}.`],
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        // Another session created it first; read that copy instead.
        return loadModelClassification(options)
      }
      return {
        classification: packaged,
        source: "packaged",
        path,
        warnings: [`Could not create ${path} (${errorMessage(error)}); using Dispatch's packaged model classification.`],
        notes: [],
      }
    }
  }

  const reason = `Ignoring ${path}: ${errorMessage(userError)}.`
  if (lastGood) {
    return {
      classification: lastGood,
      source: "last-good",
      path,
      warnings: [`${reason} Keeping the classification loaded before the edit; fix the file and run /commandcode-refresh.`],
      notes: [],
    }
  }
  return {
    classification: await loadPackaged(),
    source: "packaged",
    path,
    warnings: [`${reason} Using Dispatch's packaged model classification; fix the file and run /commandcode-refresh.`],
    notes: [],
  }
}
