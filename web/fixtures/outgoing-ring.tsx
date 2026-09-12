import { createRoot } from "react-dom/client";
import { useState } from "react";
import { OutgoingCallStatus } from "../src/components/Call/OutgoingCallStatus";
import { CallStartMenu } from "../src/components/Call/CallStartMenu";
import { VoiceContextForLab, type VoiceContextValue } from "../src/contexts/VoiceProvider";
import { useOutgoingCallStore } from "../src/stores/outgoingCallStore";
import { useCallUiStore } from "../src/stores/callUiStore";
import "../src/styles/globals.css";
function App() {
 const [agent, setAgent] = useState(false), [quiet, setQuiet] = useState(0), [rings, setRings] = useState(0);
 const value = { room:null,localParticipant:null,remoteParticipants:agent?[{identity:"agent-fixture",name:"Demo agent"}]:[],isConnected:true,isConnecting:false,error:null,audioBlocked:false,version:agent?2:1,
 connect:async()=>true,disconnect:()=>{},startAudio:async()=>{},repairAudio:async()=>{},claimScreenAudio:()=>{},releaseScreenAudio:()=>{},devices:{audioinput:[],videoinput:[],audiooutput:[]},selectedDevices:{audioinput:"",videoinput:"",audiooutput:""},refreshDevices:async()=>{},switchDevice:async()=>{},deviceSignal:{audioinput:true,videoinput:true} } as VoiceContextValue;
 return <VoiceContextForLab.Provider value={value}><main className="min-h-screen bg-slate-950 p-6 text-white">
 <h1>Outgoing call fixture</h1><p>Synthetic state; no call or invitation sent.</p>
 <button className="m-2 rounded border p-2" onClick={()=>{useCallUiStore.setState({activeCallRoomId:"fixture-room"});useOutgoingCallStore.getState().ring({callId:"fixture-call",roomId:"fixture-room",label:"Demo room",targets:[],expiresAt:new Date(Date.now()+45000).toISOString()});}}>Begin ring</button>
 <button className="m-2 rounded border p-2" onClick={()=>setAgent(true)}>Agent joins</button>
 <button className="m-2 rounded border p-2" onClick={()=>setAgent(false)}>Agent leaves</button>
 <button className="m-2 rounded border p-2" onClick={()=>{const call=useOutgoingCallStore.getState().call;if(call)useOutgoingCallStore.setState({call:{...call,phase:"ringing",expiresAt:new Date(Date.now()-10000).toISOString()}});window.dispatchEvent(new Event("pageshow"));}}>Resume past deadline</button>
 <div className="mt-32 flex justify-end"><CallStartMenu onRing={()=>setRings(v=>v+1)} onQuiet={()=>setQuiet(v=>v+1)}/></div>
 <p>Quiet joins: {quiet}; rings: {rings}</p>
 <OutgoingCallStatus/>
 </main></VoiceContextForLab.Provider>;
}
createRoot(document.getElementById("root")!).render(<App/>);
