// Mirrors shared/background-task-timeout.mjs, which the browser cannot import
// (only server/public is served). shared/background-task-timeout.test.mjs
// asserts the two stay identical.
//
// The settings slider shows this until the relay's own value loads, and keeps
// showing it if that request fails, so it must be the default the relay
// enforces: 4 hours. 0 means no limit only when chosen explicitly.

export const DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES = 240;
