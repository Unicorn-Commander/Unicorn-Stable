from array import array
from types import SimpleNamespace
from agent_runtime.puppet_video import PuppetVideo, build_spec, LevelTimeline
from voice_relay.audio_heartbeat import AudioWindow
from voice_relay.agent import human_identity

def test_heartbeat_distinguishes_missing_frames_from_silence():
    window=AudioWindow()
    assert window.drain()['state']=='no_frames'
    window.feed(array('h',[0]*160))
    assert window.drain()=={'frames':1,'rms':0.0,'state':'silent'}
    window.feed(array('h',[16384]*160))
    assert window.drain()=={'frames':1,'rms':0.5,'state':'audio'}
    assert window.drain()['state']=='no_frames'

def test_only_own_playout_drives_mouth_and_finish_clears_backlog():
    now=[10.0]
    puppet=PuppetVideo(build_spec('fixture',None,{}),clock=lambda:now[0],own_playout_only=True)
    frame=SimpleNamespace(data=array('h',[16384]*160),sample_rate=16000,samples_per_channel=160)
    puppet.feed(frame)
    assert puppet.levels.busy_until==0
    puppet.begin_playout();puppet.feed(frame)
    assert puppet.levels.level_at()>0
    puppet.end_playout()
    assert puppet.levels.level_at()==0
    puppet.feed(frame)
    assert puppet.levels.busy_until==0

def test_reset_clears_release_envelope_too():
    timeline=LevelTimeline(lambda:1.0)
    timeline.push(1,1);assert timeline.level_at()==1
    timeline.reset();assert timeline.level_at()==0

def test_identity_does_not_require_user_metadata_but_requires_uuid():
    identity='fixture_00000000-0000-4000-8000-000000000001'
    assert human_identity(identity)==identity
    assert human_identity('voice-probe') is None
    assert human_identity('agent-fixture') is None


def test_linked_speaker_without_metadata_is_attributed():
    from voice_relay.agent import VoiceRelayAgent
    identity='fixture_00000000-0000-4000-8000-000000000001'
    relay=SimpleNamespace(_session=SimpleNamespace(room_io=SimpleNamespace(linked_participant=SimpleNamespace(identity=identity))),_lk_room=None)
    assert VoiceRelayAgent._speaker_identity(relay,SimpleNamespace())==identity
