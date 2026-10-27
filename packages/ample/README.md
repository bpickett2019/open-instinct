# @open-instinct/ample

Web app deploys for Open Instinct through [Ample](https://ample.computer):
`ample_deploy`, `ample_logs`, `ample_apps` and `ample_app_delete`. See
[docs/AMPLE.md](../../docs/AMPLE.md).

```ts
import { ampleTools } from "@open-instinct/ample";

registry.registerMany(
  ampleTools({
    credentials: { clientId, clientSecret }, // or { token }
    workspaceDir,
    resolvePath: (p) => resolveInsideWorkspace(workspaceDir, p),
  }),
);
```

The tools run the `ample` CLI (`bin`, default `ample` on `PATH`) with a
short-lived access token and an allowlisted environment (`PATH`, `HOME`,
`LANG`, `TZ`, `TMPDIR`), not the agent's other environment credentials.
Pass `run` to replace the process runner in tests.

## Dispatch and isolation boundaries

Every CLI invocation checks `ToolContext.assertBusinessDispatch`, when present,
and the abort signal **after** authentication completes and immediately before
dispatch. This includes planning, applying answers, deployment, deletion, reads,
and refused-token retries. A pre-aborted signal also rejects in the process
runner before spawning anything. These fences prevent a new invocation after
revocation; they do not undo a remote operation already accepted by Ample.

The CLI runs as the agent's OS user, without a separate sandbox. Workspace path
checks and the environment allowlist are not proof of host isolation.

Official contract inspected on 2026-10-23:

- [Ample OpenAPI](https://ample.computer/openapi.json), version `0.1.36`,
  `createDeployment` (`POST /v1/deployments`), describes the CLI submitting
  packaged files, detected build/start commands, and environment.
  `finalizeDeployment` (`POST /v1/deployments/{id}/finalize`) completes the
  upload phase and activates the release.
- The [Node deployment guide](https://ample.computer/guides/deploy-node-app)
  says Ample installs dependencies and runs a build when present.
- The [official homepage](https://ample.computer/) promises a separate microVM
  for each deployed app. This describes remote app isolation, not the local CLI.
- The [official installer](https://get.ample.computer/install.sh) downloads a
  platform binary from `https://get.ample.computer/latest`; it does not provide
  the CLI implementation source.

These sources describe a remote deployment/upload contract but do not establish
whether every project-controlled build/install hook runs remotely rather than
on the CLI host. No official CLI implementation source was identified in the
linked developer resources or source search. Consequently this business
deployment boundary cannot claim proven host isolation. That evidence gap is
not evidence of local code execution: spawning the trusted CLI alone does not
establish an RCE vulnerability.
