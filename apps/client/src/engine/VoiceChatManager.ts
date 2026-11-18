/**
 * WebRTC Native Voice Chat Engine for AtelierSync Multi-User Drawing Rooms
 * Implements low-latency peer-to-peer audio mesh, voice activity detection (VAD), and mic controls.
 */

import { Socket } from 'socket.io-client';

interface VoicePeer {
  socketId: string;
  userId: string;
  displayName: string;
  isMuted: boolean;
  isSpeaking: boolean;
  audioElement?: HTMLAudioElement;
  connection?: RTCPeerConnection;
}

interface VoiceParticipant {
  userId: string;
  displayName: string;
  socketIds: string[];
  isMuted: boolean;
  isSpeaking: boolean;
}

type VoicePresence = Pick<VoicePeer, 'socketId' | 'userId' | 'displayName'> &
  Partial<Pick<VoicePeer, 'isMuted' | 'isSpeaking'>>;

export interface VoiceChatState {
  isInVoice: boolean;
  isMuted: boolean;
  isSpeaking: boolean;
  activePeers: VoiceParticipant[];
  inputDeviceId?: string;
  outputDeviceId?: string;
  error?: string | null;
}

type SinkSelectable = { setSinkId?: (id: string) => Promise<void> };
const CUE_NOTES = { join: [523, 784], leave: [784, 392], mute: [440, 330], unmute: [440, 660] } as const;

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

export class VoiceChatManager {
  private socket: Socket | null = null;
  private canvasId: string | null = null;
  private localStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private vadInterval: number | null = null;
  private cueContext: AudioContext | null = null;
  private inputDeviceId = localStorage.getItem('atelier_voice_input') ?? '';
  private outputDeviceId = localStorage.getItem('atelier_voice_output') ?? '';
  private joining = false;
  private selfUserId: string | undefined;

  private peers = new Map<string, VoicePeer>(); // socketId -> VoicePeer
  private isInVoice = false;
  private isMuted = false;
  private isSpeaking = false;

  private listeners = new Set<(state: VoiceChatState) => void>();

  constructor() {}

  public init(socket: Socket) {
    if (this.socket === socket) return;
    this.leaveVoice();
    this.socket = socket;
    this.setupSocketListeners();
    socket.on('disconnect', () => {
      if (this.socket === socket) this.leaveVoice();
    });
  }

  public setCanvasId(canvasId: string | null) {
    if (this.canvasId !== canvasId) {
      if (this.isInVoice) {
        this.leaveVoice();
      }
      this.canvasId = canvasId;
    }
  }

  public getState(): VoiceChatState {
    const participants = new Map<string, VoiceParticipant>();
    for (const peer of this.peers.values()) {
      const participant = participants.get(peer.userId);
      if (participant) {
        participant.socketIds.push(peer.socketId);
        participant.isMuted &&= peer.isMuted;
        participant.isSpeaking ||= !peer.isMuted && peer.isSpeaking;
      } else {
        participants.set(peer.userId, {
          userId: peer.userId,
          displayName: peer.displayName,
          socketIds: [peer.socketId],
          isMuted: peer.isMuted,
          isSpeaking: !peer.isMuted && peer.isSpeaking,
        });
      }
    }
    return {
      isInVoice: this.isInVoice,
      isMuted: this.isMuted,
      isSpeaking: this.isSpeaking,
      activePeers: Array.from(participants.values()),
      inputDeviceId: this.inputDeviceId,
      outputDeviceId: this.outputDeviceId,
    };
  }

  public subscribe(cb: (state: VoiceChatState) => void): () => void {
    this.listeners.add(cb);
    cb(this.getState());
    return () => this.listeners.delete(cb);
  }

  private notify() {
    const s = this.getState();
    for (const cb of this.listeners) {
      cb(s);
    }
  }

  private capture(deviceId: string) {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
  }

  public async setInputDevice(deviceId: string) {
    const oldStream = this.localStream;
    if (oldStream && deviceId !== this.inputDeviceId) {
      const stream = await this.capture(deviceId);
      const track = stream.getAudioTracks()[0];
      const previousTrack = oldStream.getAudioTracks()[0];
      if (oldStream !== this.localStream) {
        track.stop();
        return;
      }
      track.enabled = !this.isMuted;
      const replaced: RTCRtpSender[] = [];
      try {
        for (const peer of this.peers.values()) {
          const sender = peer.connection?.getSenders().find((s) => s.track === previousTrack);
          if (!sender) continue;
          await sender.replaceTrack(track);
          replaced.push(sender);
        }
        if (oldStream !== this.localStream) {
          track.stop();
          return;
        }
      } catch (err) {
        await Promise.allSettled(replaced.map((sender) => sender.replaceTrack(previousTrack)));
        track.stop();
        throw err;
      }
      track.enabled = !this.isMuted;
      this.localStream = stream;
      previousTrack.stop();
      this.stopAudioAnalysis();
      this.setupAudioAnalysis(stream);
    }
    this.inputDeviceId = deviceId;
    localStorage.setItem('atelier_voice_input', deviceId);
    this.notify();
  }

  public async setOutputDevice(deviceId: string) {
    const tester: SinkSelectable = document.createElement('audio');
    if (!tester.setSinkId) return;
    await tester.setSinkId(deviceId);
    const outputs = Array.from(this.peers.values(), (peer) => peer.audioElement).filter((audio) => audio !== undefined);
    const changes = await Promise.allSettled(outputs.map((audio) => (audio as SinkSelectable).setSinkId?.(deviceId)));
    if (changes.some((change) => change.status === 'rejected')) {
      await Promise.allSettled(outputs.map((audio) => (audio as SinkSelectable).setSinkId?.(this.outputDeviceId)));
      throw new Error('Failed to set audio output');
    }
    this.outputDeviceId = deviceId;
    localStorage.setItem('atelier_voice_output', deviceId);
    await (this.cueContext as (AudioContext & SinkSelectable) | null)?.setSinkId?.(deviceId).catch(() => {});
    this.notify();
  }

  private prepareCues() {
    try {
      this.cueContext ??= new AudioContext();
      void this.cueContext.resume().catch(() => {});
      if (this.outputDeviceId) {
        void (this.cueContext as AudioContext & SinkSelectable).setSinkId?.(this.outputDeviceId).catch(() => {});
      }
    } catch {
      // Voice still works when Web Audio playback is unavailable.
    }
  }

  private playCue(cue: keyof typeof CUE_NOTES) {
    const context = this.cueContext;
    if (!context) return;
    CUE_NOTES[cue].forEach((frequency, i) => {
      const start = context.currentTime + i * 0.065;
      const tone = context.createOscillator();
      const volume = context.createGain();
      tone.frequency.value = frequency;
      volume.gain.setValueAtTime(0, start);
      volume.gain.linearRampToValueAtTime(0.085, start + 0.014);
      volume.gain.exponentialRampToValueAtTime(0.001, start + 0.1);
      tone.connect(volume).connect(context.destination);
      tone.onended = () => { tone.disconnect(); volume.disconnect(); };
      tone.start(start);
      tone.stop(start + 0.105);
    });
  }

  public async joinVoice(userId?: string): Promise<void> {
    const socket = this.socket;
    const canvasId = this.canvasId;
    if (!socket?.connected || !canvasId || this.isInVoice || this.joining) return;
    this.joining = true;
    this.prepareCues();

    try {
      const stream = await this.capture(this.inputDeviceId).catch(async (err: unknown) => {
        if (!this.inputDeviceId || !(err instanceof DOMException) || !['NotFoundError', 'OverconstrainedError'].includes(err.name)) throw err;
        await this.setInputDevice('');
        return this.capture('');
      });
      if (this.canvasId !== canvasId || this.socket !== socket || !socket.connected) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.localStream = stream;
      this.selfUserId = userId;
      this.isInVoice = true;
      this.isMuted = false;

      // 2. Setup VAD (Voice Activity Detection)
      this.setupAudioAnalysis(stream);

      // 3. Announce to room via Socket.io
      this.socket.emit('voice_join', { canvasId: this.canvasId });
      this.playCue('join');
      this.notify();
    } catch (err: any) {
      console.error('[Voice] Failed to get mic audio:', err);
      this.isInVoice = false;
      this.notify();
      throw new Error('無法取得麥克風權限，請確認瀏覽器麥克風設定');
    } finally {
      this.joining = false;
    }
  }

  public leaveVoice() {
    if (!this.isInVoice) return;

    // 1. Close all peer connections
    for (const peer of this.peers.values()) {
      if (peer.connection) {
        peer.connection.close();
      }
      if (peer.audioElement) {
        peer.audioElement.srcObject = null;
        peer.audioElement.remove();
      }
    }
    this.peers.clear();

    // 2. Stop microphone tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    this.stopAudioAnalysis();

    this.isInVoice = false;
    this.isSpeaking = false;

    // 4. Notify server
    if (this.socket?.connected && this.canvasId) {
      this.socket.emit('voice_leave', { canvasId: this.canvasId });
    }

    this.playCue('leave');
    this.notify();
  }

  private stopAudioAnalysis() {
    if (this.vadInterval) {
      window.clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }

  public toggleMute(): boolean {
    if (!this.isInVoice || !this.localStream) return this.isMuted;

    this.isMuted = !this.isMuted;
    if (this.isMuted) this.isSpeaking = false;
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !this.isMuted;
    });

    this.emitVoiceState();

    this.playCue(this.isMuted ? 'mute' : 'unmute');
    this.notify();
    return this.isMuted;
  }

  private setupAudioAnalysis(stream: MediaStream) {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      const context = this.audioContext = new AudioCtx();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      void context.resume().catch(() => {});

      const samples = new Float32Array(analyser.fftSize);
      let lastSpeech = -Infinity;
      this.vadInterval = window.setInterval(() => {
        if (this.isMuted || context.state !== 'running') {
          lastSpeech = -Infinity;
          this.setSpeaking(false);
          return;
        }

        analyser.getFloatTimeDomainData(samples);
        let power = 0;
        for (const sample of samples) power += sample * sample;
        const rms = Math.sqrt(power / samples.length);
        const now = performance.now();
        // Use a lower threshold while speaking and hold the indicator through short pauses.
        if (rms >= (this.isSpeaking ? 0.012 : 0.018)) lastSpeech = now;
        this.setSpeaking(now - lastSpeech < 300);
      }, 100);
    } catch (e) {
      console.warn('[Voice] AudioContext setup failed:', e);
    }
  }

  private setSpeaking(val: boolean) {
    if (this.isSpeaking === val) return;
    this.isSpeaking = val;
    this.emitVoiceState();
    this.notify();
  }

  private emitVoiceState() {
    if (this.socket && this.canvasId) {
      this.socket.emit('voice_state', {
        canvasId: this.canvasId,
        isMuted: this.isMuted,
        isSpeaking: this.isSpeaking,
      });
    }
  }

  private isOwnConnection(socketId: string, userId: string) {
    return socketId === this.socket?.id || (this.selfUserId !== undefined && userId === this.selfUserId);
  }

  private setupSocketListeners() {
    if (!this.socket) return;

    // Users already in the room when we join
    this.socket.on(
      'voice_room_users',
      (data: { canvasId: string; users: VoicePresence[] }) => {
        if (data.canvasId !== this.canvasId || !this.isInVoice) return;

        for (const u of data.users) {
          void this.createPeerConnection(u, true);
        }
      }
    );

    // Another user joined voice
    this.socket.on(
      'voice_user_joined',
      (data: VoicePresence & { canvasId: string }) => {
        if (data.canvasId !== this.canvasId || !this.isInVoice) return;
        void this.createPeerConnection(data, false);
      }
    );

    // User left voice
    this.socket.on('voice_user_left', (data: { canvasId: string; socketId: string; userId: string }) => {
      if (data.canvasId !== this.canvasId) return;
      const peer = this.peers.get(data.socketId);
      if (peer) {
        if (peer.connection) peer.connection.close();
        if (peer.audioElement) {
          peer.audioElement.srcObject = null;
          peer.audioElement.remove();
        }
        this.peers.delete(data.socketId);
        this.notify();
      }
    });

    // WebRTC signaling
    this.socket.on(
      'voice_signal',
      async (data: {
        canvasId: string;
        fromSocketId: string;
        fromUserId: string;
        fromDisplayName: string;
        signalType: string;
        signalData: any;
      }) => {
        if (data.canvasId !== this.canvasId || !this.isInVoice) return;

        let peer = this.peers.get(data.fromSocketId);
        if (!peer) {
          peer = await this.createPeerConnection({
            socketId: data.fromSocketId, userId: data.fromUserId, displayName: data.fromDisplayName,
          }, false);
        }

        const pc = peer?.connection;
        if (!pc) return;

        try {
          if (data.signalType === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(data.signalData));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            this.socket?.emit('voice_signal', {
              canvasId: this.canvasId,
              targetSocketId: data.fromSocketId,
              signalType: 'answer',
              signalData: answer,
            });
          } else if (data.signalType === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(data.signalData));
          } else if (data.signalType === 'candidate' && data.signalData) {
            await pc.addIceCandidate(new RTCIceCandidate(data.signalData));
          }
        } catch (sigErr) {
          console.warn('[Voice] Signal handle error:', sigErr);
        }
      }
    );

    // Voice speaking/mute state
    this.socket.on(
      'voice_state',
      (data: { canvasId: string; socketId?: string; userId: string; isMuted: boolean; isSpeaking: boolean; inVoice?: boolean }) => {
        if (data.canvasId !== this.canvasId || !this.isInVoice || data.inVoice === false) return;
        let changed = false;
        for (const peer of this.peers.values()) {
          if (data.socketId ? peer.socketId === data.socketId : peer.userId === data.userId) {
            peer.isMuted = data.isMuted;
            peer.isSpeaking = !data.isMuted && data.isSpeaking;
            changed = true;
          }
        }
        if (changed) this.notify();
      }
    );

    // Admin force-muted notification
    this.socket.on('voice_force_muted', (data: { canvasId: string; byDisplayName: string }) => {
      if (data.canvasId !== this.canvasId || !this.isInVoice) return;
      if (!this.isMuted) {
        this.toggleMute();
      }
      this.notify();
    });

    // Admin kicked notification
    this.socket.on('voice_kicked', (data: { canvasId: string; byDisplayName: string }) => {
      if (data.canvasId !== this.canvasId) return;
      this.leaveVoice();
    });
  }

  private async createPeerConnection(
    presence: VoicePresence,
    isInitiator: boolean
  ): Promise<VoicePeer | undefined> {
    const { socketId, userId, displayName, isMuted = false, isSpeaking = false } = presence;
    if (this.isOwnConnection(socketId, userId)) return;
    const existing = this.peers.get(socketId);
    if (existing) return existing;
    const pc = new RTCPeerConnection(ICE_SERVERS);

    // Audio element to play remote stream
    const audio = document.createElement('audio');
    audio.autoplay = true;
    (audio as any).playsInline = true;

    const peer: VoicePeer = {
      socketId,
      userId,
      displayName,
      connection: pc,
      audioElement: audio,
      isMuted,
      isSpeaking,
    };

    this.peers.set(socketId, peer);
    this.notify();

    // Attach local mic tracks to peer connection
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    // Remote audio track received
    pc.ontrack = async (event) => {
      if (event.streams && event.streams[0]) {
        if (this.outputDeviceId) {
          await (audio as SinkSelectable).setSinkId?.(this.outputDeviceId).catch(() => {});
        }
        if (this.peers.get(socketId) !== peer) return;
        audio.srcObject = event.streams[0];
        audio.play().catch(() => {});
      }
    };

    // Forward ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && this.socket && this.canvasId) {
        this.socket.emit('voice_signal', {
          canvasId: this.canvasId,
          targetSocketId: socketId,
          signalType: 'candidate',
          signalData: event.candidate,
        });
      }
    };

    // If initiator, create and send SDP offer
    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (this.peers.get(socketId) !== peer) return;

        this.socket?.emit('voice_signal', {
          canvasId: this.canvasId,
          targetSocketId: socketId,
          signalType: 'offer',
          signalData: offer,
        });
      } catch (err) {
        console.error('[Voice] Failed to create offer for peer:', err);
      }
    }

    return peer;
  }
}
