import React, { useEffect, useRef, useState } from 'react';
import { Camera, Monitor, Video, Shield, User, Loader2 } from 'lucide-react';
import { socket } from '../lib/socket';

interface CctvProps {
  mode: 'streamer' | 'viewer';
  streamerId?: string; // Required for viewer
}

export const CctvModule: React.FC<CctvProps> = ({ mode, streamerId }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeStreamer, setActiveStreamer] = useState<string | null>(streamerId || null);

  const iceConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ]
  };

  useEffect(() => {
    if (mode === 'streamer') {
      startStreaming();
    } else {
      // If we don't have a streamerId, listen for one
      if (!streamerId) {
        socket.on('cctv_available', ({ streamerId: id }) => {
          console.log('Streamer found:', id);
          setActiveStreamer(id);
        });
        socket.on('cctv_unavailable', ({ streamerId: id }) => {
          if (activeStreamer === id) setActiveStreamer(null);
        });
      }
    }

    socket.on('cctv_signal', async ({ from, signal }) => {
      let pc = peersRef.current.get(from);

      if (signal.type === 'offer') {
        if (!pc) pc = createPeerConnection(from);
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('cctv_signal', { to: from, signal: answer });
      } else if (signal.type === 'answer') {
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(signal));
      } else if (signal.candidate) {
        if (pc) await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    });

    if (mode === 'streamer') {
      socket.on('cctv_user_joined', async ({ userId }) => {
        console.log('User joined stream:', userId);
        const pc = createPeerConnection(userId);
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => pc.addTrack(track, streamRef.current!));
        }
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('cctv_signal', { to: userId, signal: offer });
      });
    }

    return () => {
      stopAll();
      socket.off('cctv_available');
      socket.off('cctv_unavailable');
      socket.off('cctv_user_joined');
      socket.off('cctv_signal');
    };
  }, [mode, streamerId, activeStreamer]);

  const startStreaming = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 1280, height: 720, frameRate: 15 }, 
        audio: false 
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setIsStreaming(true);
      setError(null);
      socket.emit('cctv_ready');
    } catch (err: any) {
      setError(err.message || 'Camera access denied');
      setIsStreaming(false);
    }
  };

  const createPeerConnection = (userId: string) => {
    const pc = new RTCPeerConnection(iceConfig);
    peersRef.current.set(userId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('cctv_signal', { to: userId, signal: { candidate: event.candidate } });
      }
    };

    if (mode === 'viewer') {
      pc.ontrack = (event) => {
        console.log('Received track from streamer');
        if (videoRef.current) videoRef.current.srcObject = event.streams[0];
      };
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        peersRef.current.delete(userId);
      }
    };

    return pc;
  };

  const joinStream = () => {
    if (activeStreamer) {
      socket.emit('cctv_join', activeStreamer);
    }
  };

  const stopAll = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    peersRef.current.forEach(pc => pc.close());
    peersRef.current.clear();
    setIsStreaming(false);
  };

  return (
    <div className="relative w-full aspect-video rounded-3xl overflow-hidden bg-slate-900 border-4 border-slate-800 shadow-2xl group">
      {/* Overlay: Status */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
        <div className={`px-3 py-1 rounded-full text-[10px] font-bold tracking-widest uppercase flex items-center gap-2 backdrop-blur-md border ${
          mode === 'streamer' ? (isStreaming ? 'bg-red-500/20 text-red-500 border-red-500/30' : 'bg-slate-500/20 text-slate-400 border-slate-500/30') :
          (activeStreamer ? 'bg-green-500/20 text-green-500 border-green-500/30' : 'bg-amber-500/20 text-amber-500 border-amber-500/30')
        }`}>
          <div className={`w-2 h-2 rounded-full ${
            mode === 'streamer' ? (isStreaming ? 'bg-red-500 animate-pulse' : 'bg-slate-500') :
            (activeStreamer ? 'bg-green-500 animate-pulse' : 'bg-amber-500')
          }`} />
          {mode === 'streamer' ? (isStreaming ? 'LIVE TRANSMIT' : 'STANDBY') : (activeStreamer ? 'LIVE FEED' : 'SEARCHING')}
        </div>
      </div>

      {mode === 'viewer' && !videoRef.current?.srcObject && activeStreamer && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/80 backdrop-blur-sm z-20 transition-all">
          <Loader2 className="w-10 h-10 text-blue-500 animate-spin mb-4" />
          <button 
            onClick={joinStream}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold transition-all active:scale-95 shadow-lg shadow-blue-500/20"
          >
            Connect to Main Camera
          </button>
        </div>
      )}

      {mode === 'viewer' && !activeStreamer && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 z-20">
          <Monitor className="w-12 h-12 opacity-20 mb-4" />
          <p className="text-sm font-bold opacity-40 uppercase tracking-widest text-center px-8">
            Main Camera Offline<br/>
            <span className="text-[10px] font-normal">Waiting for Laptop transmission...</span>
          </p>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-950/90 text-red-400 z-30 p-8 text-center">
          <div className="space-y-2">
            <Camera className="w-10 h-10 mx-auto mb-2 opacity-50" />
            <p className="font-bold">Hardware Error</p>
            <p className="text-xs opacity-80">{error}</p>
          </div>
        </div>
      )}

      <video 
        ref={videoRef} 
        autoPlay 
        playsInline 
        muted={mode === 'streamer'} 
        className={`w-full h-full object-cover transition-all duration-700 ${mode === 'streamer' ? 'grayscale brightness-75 contrast-125' : ''}`} 
      />

      {/* Retro HUD */}
      <div className="absolute inset-0 pointer-events-none border-[20px] border-transparent p-4 flex flex-col justify-between opacity-40">
        <div className="flex justify-between items-start">
          <div className="w-8 h-8 border-t-2 border-l-2 border-white/40" />
          <div className="w-8 h-8 border-t-2 border-r-2 border-white/40" />
        </div>
        <div className="flex justify-between items-end">
          <div className="w-8 h-8 border-b-2 border-l-2 border-white/40" />
          <div className="w-8 h-8 border-b-2 border-r-2 border-white/40" />
        </div>
      </div>

      <div className="absolute bottom-4 left-6 right-6 flex justify-between items-center z-10">
        <div className="flex flex-col">
          <span className="text-[9px] font-mono text-white/40 uppercase tracking-tighter">Location</span>
          <span className="text-[11px] font-bold text-white/80">{mode === 'streamer' ? 'MAIN CONSOLE (LAPTOP)' : 'REMOTE VIEWER'}</span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[9px] font-mono text-white/40 uppercase tracking-tighter">Network</span>
          <span className="text-[11px] font-bold text-white/80">LATENCY: 42ms || 1080p</span>
        </div>
      </div>

      <div className="absolute inset-0 pointer-events-none mix-blend-overlay opacity-30 bg-[url('https://grainy-gradients.vercel.app/noise.svg')]" />
    </div>
  );
};
