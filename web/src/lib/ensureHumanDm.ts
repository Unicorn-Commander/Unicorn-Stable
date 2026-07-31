import { api, type PeopleDirectoryEntry, type Room } from "@/services/api";
import { useAppStore } from "@/stores/appStore";

/**
 * Open or create the canonical 1:1 human DM with a directory person.
 *
 * Uses server `POST /api/v1/dms/ensure` (idempotent, race-safe). The client
 * fallback remains only as a last resort if the endpoint is missing at
 * runtime (older servers during a rolling deploy).
 */
export async function ensureHumanDm(
  person: Pick<PeopleDirectoryEntry, "id" | "username" | "display_name">,
): Promise<Room> {
  try {
    return await api.ensureHumanDm(person.id);
  } catch (err) {
    // Older dogfood nodes may not have /dms/ensure yet during a rolling deploy.
    const status = (err as { status?: number }).status;
    if (status === 404 || status === 405) {
      console.warn("ensureHumanDm: server ensure missing, using fallback", err);
      return ensureHumanDmFallback(person);
    }
    throw err;
  }
}

function nameCandidates(person: {
  username: string;
  display_name: string;
}): string[] {
  const display = (person.display_name || "").trim();
  const username = (person.username || "").trim();
  const labels = new Set<string>();
  for (const raw of [display, username]) {
    if (!raw) continue;
    labels.add(raw.toLowerCase());
    labels.add(`dm with ${raw}`.toLowerCase());
    labels.add(`chat with ${raw}`.toLowerCase());
  }
  return [...labels];
}

function roomLabel(room: Room): string {
  return (room.display_name || room.name || "").trim().toLowerCase();
}

/**
 * Best-effort client path when the server has no ensure-DM endpoint yet:
 * 1. Scan loaded rooms for an existing 1:1 human DM whose name matches
 * 2. Else createRoom(type=dm) + inviteUserToRoom(participant_id)
 */
async function ensureHumanDmFallback(person: {
  id: string;
  username: string;
  display_name: string;
}): Promise<Room> {
  const candidates = nameCandidates(person);
  const rooms = useAppStore.getState().rooms;
  const existing = rooms.find((room) => {
    if (room.type !== "dm") return false;
    if (room.brigade_agent_id) return false;
    // Prefer true 1:1 (me + them). Group-ish DMs mis-typed as dm are rare.
    if (room.member_count > 2) return false;
    return candidates.includes(roomLabel(room));
  });
  if (existing) return existing;

  const display =
    person.display_name?.trim() || person.username?.trim() || "Direct message";
  const room = await api.createRoom({
    name: `DM with ${display}`,
    description: "",
    type: "dm",
    member_ids: [],
    agent_ids: [],
  });
  try {
    await api.inviteUserToRoom(room.id, { participant_id: person.id });
  } catch (err) {
    console.warn("ensureHumanDm: invite failed for", person.id, err);
    // Room still exists; user can re-invite from within if needed.
  }
  return room;
}
