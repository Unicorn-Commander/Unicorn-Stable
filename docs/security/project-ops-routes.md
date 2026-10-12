# Project-Ops route boundary

Stable exposes three Project-Ops-backed routes. All three authenticate through
`get_current_user` and then use `require_po_staff`:

| Route | Stable-side gate | Project-Ops identity | Stable-side effect |
| --- | --- | --- | --- |
| `GET /api/v1/po/projects` | Existing instance-admin realm role | `PROJECTOPS_SERVICE_PAT` when set; otherwise `PROJECTOPS_SERVICE_JWT` | Returns projects visible to the configured service user |
| `POST /api/v1/messages/{message_id}/promote-to-po-task` | Existing instance-admin realm role, plus the caller email must be present | Same server-side PAT/JWT selection; the task description starts `Promoted from Stable by <caller email>` | Creates a task and records the promotion metadata on the Stable message |
| `POST /api/v1/rooms/for-project` | Existing instance-admin realm role | Same server-side PAT/JWT selection for `get_project` | Creates a private channel as the Stable caller, or explicitly joins an existing private channel only for the staff-gated call |

`require_po_staff` reuses `is_instance_admin`, the existing
`STABLE_ADMIN_ROLES` allowlist used by the instance-branding and agent-access
admin surfaces. Its default role names are `stable-admin`, `realm-admin`, and
`admin`; operators can use the existing environment variable to change that
allowlist. This checkout has no separate organization-membership model or
staff role, so no new role name or membership rule was added. Room owner/admin
membership remains room-scoped and is not treated as instance-wide Project-Ops
staff authority.

Guest credentials continue to fail authentication with `401`; an authenticated
non-staff member receives `403` before any Project-Ops call or project-channel
lookup.

Home `Today` keeps its caller-bearer-first behavior. If that caller-scoped
Project-Ops token is unavailable, the server PAT/JWT fallback is filtered by the
Stable caller email, so it only displays that caller's due tasks.

Open item (a): the Keycloak audience mapper / Brigade exchange that would make
the caller-bearer path accepted by Project-Ops remains infrastructure work for
the orchestrator. This lane does not mint, add, or rotate any credential.
