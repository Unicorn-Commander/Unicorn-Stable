# Threat model — /broadcast route + guest access

Written before implementation, per the requirement that the PR carry a threat
model. Two new credential types enter the system; both are treated as
credentials, not URLs.

## 1. Design stance: default-deny, by construction

The failure mode to design against is documented in our own estate: on
2026-08-09 Knowledge-Ops was found granting `read:knowledge` to **every** OIDC
principal, so "passed the proxy" silently meant "authorized." The proxy was the
only real gate. The lesson is that *authentication must not imply
authorization*, and the only durable way to guarantee that is deny-by-default
in the app.

Therefore, the load-bearing rule here:

> **Guest and broadcast credentials are REJECTED by the standard
> `get_current_user` dependency.** Only endpoints that explicitly opt in, via a
> distinct dependency, accept them.

This is the inverse of the tempting implementation (resolve guests through the
same dependency and add checks per endpoint). It matters because it makes the
safe behavior the *default for code that doesn't exist yet*: any endpoint added
later is automatically guest-proof, with no reviewer vigilance required.
Endpoint-by-endpoint patching fails open the first time someone forgets.

Corollary: guests never touch Keycloak. The internal `.dev` realm brokers the
customer realm through `uc-trusted-broker`, whose `idp-create-user-if-unique`
execution is ALTERNATIVE with `trust_email=true` — an account is **silently
auto-created** on first login. Routing guests through any OIDC path risks
minting real realm identities for strangers, which would then inherit whatever
default scopes other internal apps grant. Guest identities are Stable-native,
stored as Participants with pseudo-sub `guest:<uuid>` (mirroring the existing
`brigade:<agent_id>` convention so no code has to handle a null `keycloak_sub`).

## 2. Broadcast token

**What it grants:** the ability to load a page that subscribes to a LiveKit
room and renders one participant's live camera — with no login. It renders a
human being's face. Treat accordingly.

| Property | Decision |
|---|---|
| Storage | DB row, SHA-256 hash only; raw shown once at mint (mirrors `agent_gateway_keys`) |
| Entropy | `secrets.token_urlsafe(32)` |
| Scope | ONE room + ONE participant |
| TTL | Short, configurable; default hours not days |
| Revocation | `revoked_at` checked on every use; revoking kills the LiveKit session |
| Logging | prefix only, never the raw token |
| LiveKit grant | `can_publish=False`, `can_publish_data=False`, `can_subscribe=True`, `hidden=True` |

**Residual risk (accepted, documented):** a LiveKit grant authorizes subscribe
at *room* granularity. A determined token holder running their own client could
subscribe to other participants in that room, not just the named one. The UI
renders only the target, but that is a client-side choice, not an enforcement
boundary. Mitigations: short TTL, per-participant scoping recorded and
auditable, and revocation. If per-participant enforcement is later required,
LiveKit's server-side subscription-permission API is the mechanism. **Do not
describe a broadcast link as "only shows that one person" — it is a
room-scoped view credential.**

**Consent — a deliberate design addition.** `hidden=True` means the OBS feed
does not pollute the call UI with a ghost participant, which is the whole point.
But combined with a no-login URL it means *a participant can be streamed to the
internet with no indication to them*. For a product whose pitch is sovereignty
and trust, silent capture is the wrong default even when the host is the one
doing it. So: the room shows a **"● Broadcasting" indicator** on any participant
with a live, unexpired broadcast token, visible to everyone in the room. The
feed stays invisible; the *fact of it* does not.

## 3. Guest access

**What it grants:** an unauthenticated human, holding a link (plus optional
passphrase), becomes an ephemeral participant in exactly one room.

Allowed (the minimum to be a guest on a show):
- read/post messages in **their** room
- WebSocket scoped to their room
- a LiveKit token for their room, `can_publish=True` (they are on the show)
- the member list of their room; their own participant record

Denied — and asserted by negative tests, not by inspection:
- any other room, by id or slug
- the channel browser / room list
- search (both message-search endpoints)
- the agent roster, agent binding, agent tools
- knowledge bases
- uploads, admin, entitlements, gateway key administration
- any Keycloak identity, suite entitlement, or cross-app federation

| Property | Decision |
|---|---|
| Invite storage | DB row: room_id, token hash, optional passphrase hash, expires_at, revoked_at, max_uses, use_count |
| Passphrase | hashed, never stored plaintext; optional per invite |
| Guest session | separate short-TTL session credential issued after invite+passphrase exchange |
| Identity | Participant with `keycloak_sub = guest:<uuid>`, `participant_type = GUEST` |
| Labeling | "Guest" badge in participant list and member list |
| Revocation | instant, reusing the existing WS force-revoke machinery; kills socket + LiveKit |

**Residual risks (accepted, stated):**
- A guest posts content into a room that federates onward (Meeting-Ops
  transcripts, Knowledge-Ops). Guests are labeled and rooms are host-created, so
  this is a moderation question, not an isolation break — but it is real, and
  hosts should know guest messages persist like any other.
- Link sharing is uncontrolled by nature. `max_uses` + short TTL + instant
  revoke are the controls; the link is a bearer credential.
- Guest display names are attacker-chosen. Render them as untrusted text
  (no markup, length-capped) and never key authorization on them.

## 4. Blast radius / rollout

Flagship carries 46 live users; a guest-scoping bug there is materially worse
than on dogfood. **Dogfood only** until the negative tests pass and Aaron
signs off explicitly. No changes to entitlements or the billing-mode flag.
