# Headless node / Docker — design only

## Intended boundary

A future host would authenticate through the control SDK, obtain explicitly authorized node registration/scoped credentials, supervise the `local-exec-daemon` process, rotate/revoke credentials and own shutdown/recovery. It must work without the official App GUI but must NOT invent credentials, bypass approval/server authority or assume registration RPCs are already implemented.

This repository organization adds **no registration business logic, host CLI, Dockerfile, image or successful-registration stub**. `packages/headless-node` is a design location, intentionally NOT an executable npm workspace. `deploy/headless` is documentation only. No Docker plugin or deployment is needed for this change.

## Future dependencies and acceptance (not completed)

- Host → existing grokbot-control SDK + daemon process; daemon never imports CLI/MCP.
- App replacement path: official IPC handoff/supervisor. Headless path: separate host owns scoped credentials/supervision. Same execution kernel, different owner; do not make headless defaults alter official compatibility.
- Registration/renew/revoke need evidence and dedicated approval/scope tests. Docker requires explicit volume/root boundaries, non-secret configuration, externally supplied credentials, signal propagation, non-root/reduced capabilities, and mock-first acceptance.
- A future image build is not a proof of node registration. Keep deployment and registry publication separately authorized.

Open questions: precise supported identity/registration flow, account/team isolation, device lifecycle, root/volume policy, credential storage/rotation, update ownership, and container capability limits. All remain unimplemented.
