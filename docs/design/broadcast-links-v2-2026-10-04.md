# Broadcast links v2: design

Status: PROPOSED. Nothing in this document is built. An owner approves the decisions in section 9 before any lane starts.
Scope: the `/broadcast` feature (server/app/api/broadcast.py, web/src/lib/broadcast.ts, web/src/components/Broadcast).

## 1. What exists today

A room owner mints a broadcast token for one participant. The token is a credential: stored as a SHA-256 hash, shown
once, 8 hours by default and 24 hours at most, revocable. `POST /broadcast/join` exchanges it for a LiveKit token that
is subscribe-only and hidden, valid for at most one hour. The page at `/broadcast/:room/:identity` renders that one
participant. A link can ask for the camera or the screen (`source=`), audio is opt-in at mint, every join gets its own
viewer identity, and `/broadcast/active` reports one row per token with a viewer count. Everyone in the room sees a
"Broadcasting" badge on a participant who has a live link.

## 2. Three gaps

1. **Enforcement.** The LiveKit grant is room-wide. The page shows one participant by choice. A link holder who runs
   their own client can subscribe to every publisher in the room.
2. **Standing links.** A show keeps one browser source per seat in the broadcast software. Tokens die after 24 hours,
   so operators have been writing long-lived rows straight into the database, and every source dies on the same day.
3. **A whole-room view.** The composite grid page exists, but it only accepts the system recorder's token.

## 3. What LiveKit can and cannot enforce

Read from the LiveKit server source at tag v1.10.1 (the version this repository deploys) and again on the main branch
(latest release v1.13.7).

| Question | Answer | Where |
|---|---|---|
| Can a token limit WHICH publishers a participant may subscribe to? | No. The grant has `canSubscribe` and nothing narrower. | VideoGrant |
| Can the server subscribe a participant that has `canSubscribe=false`? | No. `subscribe()` returns `ErrNoSubscribePermission` before anything else, also for an admin `UpdateSubscriptions` call. Same on main. | pkg/rtc/subscriptionmanager.go |
| Who can stop a participant from subscribing to a given track? | Only that track's publisher, with track subscription permissions: an allow list of identities. Recorder participants are exempt. | pkg/rtc/room.go, pkg/rtc/uptrackmanager.go |
| Can the server set that allow list for a publisher? | No. It arrives on the publisher's own signal connection. RoomService has no call for it. | pkg/service/roomservice.go |
| Can the server see what a viewer subscribed to, and evict on a violation? | No. No subscription webhook, no list call. | webhook events, RoomService |
| Does a viewer's session end when its one-hour LiveKit token expires? | No. The server refreshes a connected client's token every five minutes. Revocation works because the server removes the viewer. | pkg/service/roommanager.go |

Conclusion: inside the call room, a per-participant boundary can only come from each publisher's client. A boundary
the server owns means the viewer is never in the call room.

## 4. Options for the enforcement gap

**A. Publisher allow lists.** Each publishing client sets track subscription permissions: everyone it can see, plus
the viewers of its own links, and nobody else. The SFU enforces it.
- Cost: every publisher must maintain the list on every join. That includes agent publishers on the server side.
- Risk: it is an allow list. A publisher whose client is asleep, stale or offline for a moment blocks a newcomer from
  seeing or hearing that publisher. A call where someone cannot be heard is a worse failure than the one being fixed.
- A stale client leaves its own publisher unprotected. Protection is per person and depends on that person's client.

**B. Keep the viewer out of the call room.**
- B1, a feed room: a server-side forwarder subscribes to one participant and republishes into a room that holds only
  that feed. The viewer's token is for the feed room. Real isolation and real-time, but the forwarder is new media
  infrastructure, and the available SDK path decodes and re-encodes every frame.
- B2, a media URL: participant egress to a low-latency stream that the broadcast software opens as a media source.
  The viewer never holds a LiveKit grant. It reuses the egress service that already runs. Unknowns: latency against
  the WebRTC page, CPU per feed, and audio sync between several feeds in one scene.

**C. Narrow what a leaked link is worth, and keep the honest wording.** These are enforced at `POST /broadcast/join`,
which is the only place a link turns into access:
- **Network lock.** A link remembers the first network that used it and refuses any other. A copied URL is useless
  elsewhere. The owner can clear the lock.
- **Viewer cap.** A link allows N viewers at once, one by default for a standing link. A second viewer is refused and
  retries. If a thief gets there first, the real source goes dark, which the operator sees at once.
- The existing controls stay: hash-only storage, expiry, revocation that evicts, the badge, the viewer count.

C does not stop a person who was GIVEN a link on purpose from looking at the rest of the room with their own client.
Only A or B does. Until one of them ships, the wording stays: a link is a room-scoped view credential.

## 5. Standing links ("slots")

A slot is a link that keeps its URL.

- New table `broadcast_slots`: room, participant identity (or the whole room, section 6), source, audio allowed,
  key hash, created by, expires at, viewer cap, locked network, revoked at, last used at.
- URL: `/broadcast/slot/<slot id>?key=<secret>`. The page exchanges the key at `POST /broadcast/join` exactly as a
  token is exchanged today, and rejoins by itself.
- Lifetime: 90 days at most, shown to the owner. **Renew** extends the expiry and the URL does not change, so
  nothing is pasted again. **Rotate** issues a new key for the same slot and evicts current viewers; that is the
  answer to a leaked URL.
- Defaults that pay for the long life: network lock on, one viewer, owner-only, every create, renew, rotate and
  revoke written to the audit log.
- The 24-hour cap on ordinary tokens does not change. Short remains the default for a link made in the moment.
- A "Broadcast links" panel for owners lists tokens and slots: who, source, audio, viewers now, last used, expires,
  network lock, with renew, rotate and revoke.
- Operators stop writing rows into the database. The owner exports slot URLs once; renewal never changes them.

## 6. A whole-room link

Technically a per-participant link can already see the room (section 3). A whole-room link says so and supports it.

- Owner-only, and only when the room allows it: a room setting `broadcast_room_view`, off by default.
- It is a slot with identity `*` and renders the existing composite grid, watch-only.
- Consent: while a whole-room link is live, every member sees a room-level "This room is being broadcast" notice,
  not only a per-person badge, and a person who joins later sees it on entry. `/broadcast/active` reports it.
- A user-facing mint still cannot produce the recorder's token: the recorder keeps its own creator marker.

## 7. Threat model changes

| Attacker | Today | With C and slots | With A or B as well |
|---|---|---|---|
| Finds a URL in a config file, a screenshot or a stream | Sees the participant, and with their own client the room, until expiry or revocation | Refused from another network; refused while the real source holds the only seat | Same |
| Was given a link on purpose and gets curious | Can see the room with their own client | Same | Sees only the one participant |
| Guesses tokens | Rate limit per client, uniform refusal | Same, and slot ids are not secrets on their own | Same |
| Steals a one-hour LiveKit token from a running page | Room view until evicted | Same; revocation and rotation evict | Limited to the feed |
| An owner broadcasting people who do not know | Per-person badge | Room-level notice for a whole-room link | Same |

Long-lived URLs are a new cost. The network lock, the viewer cap, the owner's list and rotation are what pay for it.

## 8. API (draft)

```
POST   /broadcast/slots                 owner; body: room, participant_identity | "*", source, allow_audio,
                                        max_viewers (default 1), expires_in_days (1..90), lock_network (default true)
GET    /broadcast/slots?room=           owner; rows carry no secret
POST   /broadcast/slots/{id}/renew      owner; expires_in_days
POST   /broadcast/slots/{id}/rotate     owner; returns the new key once; evicts viewers
POST   /broadcast/slots/{id}/unlock     owner; clears the locked network
DELETE /broadcast/slots/{id}            owner; revokes and evicts
POST   /broadcast/join                  unchanged for tokens; also accepts {slot, key}; enforces lock and cap
GET    /broadcast/active                adds kind (participant | room) and slot id
```

Refusals at join stay uniform for an unknown, revoked or expired credential. "Wrong network" and "seat taken" are
logged with the prefix only, and the page shows a neutral "not available" state and retries.

## 9. Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | Network lock on by default for slots | Yes |
| D2 | Slot lifetime | 90 days, renewable, never unlimited |
| D3 | One viewer per slot by default | Yes for slots; ordinary tokens keep several viewers and the warning |
| D4 | Whole-room links | Yes, owner-only, off by default per room, with the room-level notice |
| D5 | Per-participant enforcement | Do not build A. Spend one day measuring B2 (latency, CPU per feed, audio sync). Keep the "room-scoped" wording until B ships |
| D6 | May an agent seat manage slots through the gateway | No. Owner creates and exports once; revisit with the approvals work |

## 10. Lanes, after approval

1. Server: `broadcast_slots` and its migration, the slot endpoints, network lock and viewer cap at join, audit
   entries, tests including a real-database test for the migration.
2. Web: the owner's "Broadcast links" panel, the room setting, the room-level notice.
3. Page: the `/broadcast/slot/:id` route, rejoin and retry, the whole-room mode on the composite grid.
4. Show tooling: read slot URLs from the owner's export; stop writing tokens with SQL.
5. Spike, one day, no merge: participant egress to a media URL, measured against the WebRTC page.

## 11. Out of scope

Guest access, recording, and the recorder token keep their current design.
