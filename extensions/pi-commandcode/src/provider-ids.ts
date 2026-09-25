/** Canonical login: owns `/login`, stored credentials and the auth.json key. Lists no models. */
export const LOGIN_PROVIDER_ID = "commandcode"
/** Selector for `free` models and, once a GOAT plan is verified, `plan` models. */
export const PLAN_PROVIDER_ID = "commandcode-plan"
/** Selector for `api` and unclassified models, plus `plan` models while the plan is unverified. */
export const API_PROVIDER_ID = "commandcode-api"
/** Every provider ID this extension registers; anything keyed on "is this Command Code?" must use it. */
export const COMMAND_CODE_PROVIDER_IDS: readonly string[] = [LOGIN_PROVIDER_ID, PLAN_PROVIDER_ID, API_PROVIDER_ID]
