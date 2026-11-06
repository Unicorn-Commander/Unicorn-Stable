# Room findability

Stable uses one set of naming and placement rules everywhere a room can be
found: the sidebar, room header, quick switcher, and call UI.

## Product rules

**A — Explicit names win.** If a room has a non-empty `display_name`, render it
verbatim (trimmed) in every surface. A bridge-created `group_dm` is still a
room: its title is never made from `bridge_pair`, a counterpart, or a member
list. Untitled rooms use the stable room name; untitled thread children use
their first message, shortened to about 60 characters, and say `New thread`
only while empty.

**B — People and names determine placement.** A `group_dm` with two or more
human members belongs in Direct/Groups even when agents are also members, and
so does any `group_dm` that somebody gave a title (a customer-call room, a
bridge-created working room such as "Bureau of Readiness · Magic Unicorn"),
whatever its human count. An agent conversation is a `dm`, an `agent_hub`, or
an untitled `group_dm` whose only other members are agents. Agent conversations
belong in Agents; human groups do not disappear there.

**C — Threads stay with their parent.** A `-t-` child is nested below its
parent, and the parent row can collapse or expand its children. Children with
messages sort before empty children; an empty child sorts last.

**D — Room type is visible.** Rows or headers carry a small secondary type
label: Channel, Group, DM, Agent hub, or Meeting. Existing room icons remain
the visual cue; the text is the accessible, searchable cue.

## Deferred to the next lane

- Search across member names.
- A richer visual/type-label design beyond the small text label.
- An audit script for finding old or misclassified room titles.

- A collapsed conversation group previews its latest thread; expanded, the thread rows carry their own previews and the group row shows none (no line appears twice).
