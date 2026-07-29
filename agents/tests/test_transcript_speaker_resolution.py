from types import SimpleNamespace

from agent_runtime.transcript_publisher import resolve_human


def participant(identity: str, name: str, sid: str, track_sid: str):
    publication = SimpleNamespace(sid=track_sid)
    return SimpleNamespace(
        identity=identity,
        name=name,
        sid=sid,
        track_publications={"mic": publication},
    )


def room_with(*participants):
    return SimpleNamespace(
        remote_participants={p.identity: p for p in participants},
    )


def test_linked_participant_wins_when_speaker_id_is_null_in_group_call():
    aaron = participant("person-aaron", "Aaron Stransky", "PA_1", "TR_1")
    shafen = participant("person-shafen", "Shafen Khan", "PA_2", "TR_2")
    room = room_with(aaron, shafen)

    assert resolve_human(room, None, shafen) == (
        "person-shafen",
        "Shafen Khan",
    )


def test_track_sid_resolves_the_actual_speaker():
    aaron = participant("person-aaron", "Aaron Stransky", "PA_1", "TR_1")
    shafen = participant("person-shafen", "Shafen Khan", "PA_2", "TR_2")
    room = room_with(aaron, shafen)

    assert resolve_human(room, "TR_2", aaron) == (
        "person-shafen",
        "Shafen Khan",
    )


def test_provider_diarization_label_is_not_presented_as_a_person():
    aaron = participant("person-aaron", "Aaron Stransky", "PA_1", "TR_1")
    shafen = participant("person-shafen", "Shafen Khan", "PA_2", "TR_2")
    room = room_with(aaron, shafen)

    assert resolve_human(room, "speaker_0") == (
        "human",
        "Unidentified speaker",
    )
