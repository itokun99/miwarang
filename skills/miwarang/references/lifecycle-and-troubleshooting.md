# Lifecycle and troubleshooting

## Foreground

Foreground calls return the backend's final text and the v1 result envelope.
Validate the requested behavior, files, tests, and diff before reporting
success to the user.

## Background

Use `mode: "background"` only when asynchronous work is requested. Save the
returned run/session ID. Continue with unrelated orchestration, then call
`miwarang_wait` to get its final result or `miwarang_cancel` to stop it. Do
not start duplicate delegated work while that run is active.

In Senpi/OMO, the extension attaches the calling `omoThreadId` to background
runs. This identifies the originating thread for main-orchestrator
validation. Other hosts may not have a thread identity to attach.

## Cancellation

Command backends send `SIGTERM` to the process group and wait for a terminal
close. If the process ignores the grace period, Miwarang escalates to
`SIGKILL`. The run record captures the terminal state, exit code, and signal.
Koma interrupts its active turn and records its terminal state and signal.
Use the state returned by cancel/wait; an accepted cancellation is not proof
that a delegated task completed.

## Fallbacks

Miwarang tries the next configured backend for recognized provider failures,
such as quota exhaustion, rate limits, HTTP 429, and upstream session
failures. Non-provider failures (for example invalid command arguments or
configuration errors) stop the chain.

For a background call, fallback is possible only before a backend returns a
run ID. Once a run is running, wait for or cancel that run; do not retry it
on another backend unless the user explicitly asks for a separate attempt.

## Common failures

- **A legacy config is rejected:** remove v0.8 route/model keys and use the
  v0.9+ `backends` and `delegation` structure in `references/configuration.md`.
- **A backend is not found:** check its ID is present in `backends` and in
  the `delegation` list.
- **A harness agent is not found:** verify the backend's optional `agent`
  and command placeholders against that harness's configured agents. Remove
  the agent override if the harness should use its default.
- **The result is an error:** preserve the error, distinguish a provider
  failure from a configuration/command failure, and report it accurately.
- **The tool is unavailable in the host:** install or configure the correct
  adapter; do not claim a delegation occurred. The installer is
  `npx miwarang init` after npm publication, or `bun src/installer.ts init`
  from a checkout.
- **A result contains `omoThreadId`:** use it to identify the source OMO
  thread; the main orchestrator still validates the delegated changes.

After changing the extension or its configuration in a running Senpi session,
run `/reload`.
