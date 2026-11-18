import React, { useEffect, useId, useRef, useState } from 'react';
import {
  MessageSquare,
  Send,
  X,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Sparkles,
  Smile,
  Volume2,
  ShieldAlert,
  UserX,
  Users,
} from 'lucide-react';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { getUserColor } from '../utils/userColors';
import { useI18n } from '../context/I18nContext';
import { OverlayPresence } from './OverlayPresence';
import { VoiceDevices, VoiceMemberStatus } from './VoiceChatBar';

interface LiveChatDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

const QUICK_CHIPS = [
  '太神了！🎨',
  '我來鋪底色～',
  '線稿搞定 ✨',
  '摸魚喝茶 🐟',
  '大家加油！💪',
  '幫忙看一下這塊光影 💡',
];

export const LiveChatDrawer: React.FC<LiveChatDrawerProps> = ({ isOpen, onClose }) => {
  const { t } = useI18n();
  const titleId = useId();
  const { user } = useAuth();
  const isAdmin = user?.serverRole === 'admin';
  const {
    chatMessages,
    sendChatMessage,
    voiceState,
    joinVoice,
    leaveVoice,
    toggleVoiceMute,
    adminForceMuteVoice,
    adminKickVoice,
  } = useSocket();

  const [inputVal, setInputVal] = useState('');
  const [showVoiceMembers, setShowVoiceMembers] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Auto scroll to latest message
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [isOpen, onClose]);

  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputVal.trim()) return;
    sendChatMessage(inputVal.trim());
    setInputVal('');
  };

  const handleQuickChip = (chip: string) => {
    sendChatMessage(chip);
  };

  return (
    <OverlayPresence open={isOpen} kind="drawer">
    <div role="dialog" aria-modal="true" aria-labelledby={titleId}
      className="atelier-chat-backdrop fixed inset-x-0 bottom-0 z-50 flex justify-end overflow-hidden bg-black/60 backdrop-blur-sm"
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
      <div className="atelier-chat-panel w-full sm:w-96 max-w-full h-full bg-neutral-950 border-l border-neutral-800 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-4 py-3 border-b border-neutral-800 bg-neutral-900 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-indigo-600/20 text-indigo-400 border border-indigo-500/30">
              <MessageSquare className="w-4 h-4" />
            </div>
            <div>
              <h3 id={titleId} className="text-xs font-bold text-white flex items-center gap-1.5">
                {t.collab.liveChat}
              </h3>
              <p className="text-[10px] text-neutral-400">
                {voiceState.isInVoice
                  ? `🎙️ ${t.collab.voiceChat} (${voiceState.activePeers.length + 1})`
                  : `💬 ${t.collab.title}`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.common.close}
            className="atelier-no-drag atelier-icon-btn h-8 w-8 shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Voice Controls Bar */}
        <div className="px-4 py-2.5 bg-neutral-900/90 border-b border-neutral-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                voiceState.isInVoice ? 'bg-emerald-500 animate-pulse' : 'bg-neutral-600'
              }`}
            />
            <button
              type="button"
              onClick={() => voiceState.isInVoice && setShowVoiceMembers(!showVoiceMembers)}
              className="text-xs font-semibold text-neutral-200 hover:text-white flex items-center gap-1 transition"
            >
              <span>{voiceState.isInVoice ? '語音房間已連接' : '語音未開啟'}</span>
              {voiceState.isInVoice && (
                <span className="text-[10px] bg-neutral-800 px-1.5 py-0.2 rounded-full text-indigo-300 font-mono">
                  {voiceState.activePeers.length + 1}人 ▾
                </span>
              )}
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <VoiceDevices voice={voiceState} />
            {voiceState.isInVoice ? (
              <>
                <button
                  type="button"
                  onClick={toggleVoiceMute}
                  className={`p-1.5 rounded-lg text-xs font-medium transition ${
                    voiceState.isMuted
                      ? 'bg-rose-600/20 text-rose-300 border border-rose-500/30'
                      : 'bg-emerald-600 text-white'
                  }`}
                  title={voiceState.isMuted ? '取消靜音' : '靜音麥克風'}
                >
                  {voiceState.isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={leaveVoice}
                  className="px-2.5 py-1 rounded-lg bg-rose-600/20 text-rose-300 hover:bg-rose-600/30 border border-rose-500/30 text-[11px] font-semibold transition flex items-center gap-1"
                >
                  <PhoneOff className="w-3 h-3" />
                  <span>離開</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={joinVoice}
                className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold transition flex items-center gap-1.5 shadow"
              >
                <PhoneCall className="w-3 h-3" />
                <span>加入語音</span>
              </button>
            )}
          </div>
        </div>

        {/* Voice Room Peers Drawer (Visible when expanded or always if in voice) */}
        {voiceState.isInVoice && (showVoiceMembers || isAdmin) && (
          <div className="bg-neutral-900 border-b border-neutral-800 p-2.5 space-y-1.5 animate-in slide-in-from-top-2 duration-150">
            <div className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider flex items-center justify-between px-1">
              <span>語音通話成員</span>
              {isAdmin && <span className="text-amber-400 font-normal">管理員具強制權限</span>}
            </div>

            {/* My state row */}
            <div data-voice-user={user?.id} className="flex items-center justify-between p-1.5 rounded-lg bg-neutral-900/60 border border-neutral-800 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <div
                  className="w-5 h-5 rounded-full overflow-hidden border flex items-center justify-center shrink-0"
                  style={{
                    borderColor: user?.id ? getUserColor(user.id).hex : '#6366F1',
                    backgroundColor: `${user?.id ? getUserColor(user.id).hex : '#6366F1'}25`,
                  }}
                >
                  {user?.avatarUrl ? (
                    <img src={user.avatarUrl} alt="avatar" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-[9px] font-bold text-indigo-300">
                      {(user?.displayName || '我')[0]}
                    </span>
                  )}
                </div>
                <span className="font-medium text-white truncate text-xs">
                  {user?.displayName || '我'} (您)
                </span>
              </div>
              <div className="flex items-center gap-1 text-[11px]">
                <VoiceMemberStatus isMuted={voiceState.isMuted} isSpeaking={voiceState.isSpeaking} />
              </div>
            </div>

            {/* Active remote peers list */}
            {voiceState.activePeers.map((peer) => (
              <div
                key={peer.userId}
                data-voice-user={peer.userId}
                className="flex items-center justify-between p-1.5 rounded-lg bg-neutral-900/60 border border-neutral-800 text-xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className="w-5 h-5 rounded-full overflow-hidden border flex items-center justify-center shrink-0"
                    style={{
                      borderColor: getUserColor(peer.userId).hex,
                      backgroundColor: `${getUserColor(peer.userId).hex}25`,
                    }}
                  >
                    <span className="text-[9px] font-bold" style={{ color: getUserColor(peer.userId).hex }}>
                      {(peer.displayName || '友')[0]}
                    </span>
                  </div>
                  <span className="font-medium text-neutral-200 truncate text-xs">
                    {peer.displayName || '畫友'}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <div className="text-[11px]">
                    <VoiceMemberStatus isMuted={peer.isMuted} isSpeaking={peer.isSpeaking} />
                  </div>

                  {/* Admin Controls: Force Mute & Kick */}
                  {isAdmin && (
                    <div className="flex items-center gap-1 ml-1 pl-1 border-l border-neutral-700">
                      <button
                        type="button"
                        onClick={() => peer.socketIds.forEach(socketId => adminForceMuteVoice?.(socketId, peer.userId))}
                        className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 text-[10px] font-bold border border-amber-500/40 transition flex items-center gap-0.5"
                        title="管理員強制閉麥"
                      >
                        <MicOff className="w-2.5 h-2.5" />
                        <span>閉麥</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => peer.socketIds.forEach(socketId => adminKickVoice?.(socketId, peer.userId))}
                        className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 text-[10px] font-bold border border-rose-500/40 transition flex items-center gap-0.5"
                        title="管理員踢出語音"
                      >
                        <UserX className="w-2.5 h-2.5" />
                        <span>踢出</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Chat Messages List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {chatMessages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-neutral-500 gap-2">
              <Smile className="w-8 h-8 opacity-40 text-indigo-400" />
              <p className="text-xs font-medium">還沒有聊天訊息～</p>
              <p className="text-[11px] text-neutral-600">
                點擊下方快捷短語或輸入文字，與畫友即時交流吧！
              </p>
            </div>
          ) : (
            chatMessages.map((msg) => {
              const isMine = msg.userId === user?.id;
              const dateObj = new Date(msg.timestamp || Date.now());
              const timeStr = dateObj.toLocaleTimeString('zh-TW', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              });

              if (isMine) {
                // Sent by ME (Align Right)
                return (
                  <div key={msg.id} className="flex items-start justify-end gap-2.5 animate-in fade-in duration-150">
                    <div className="flex flex-col items-end max-w-[82%]">
                      <div className="flex items-center gap-1.5 mb-1 text-[10px]">
                        <span className="font-mono text-neutral-400 text-[9px]">{timeStr}</span>
                        <span className="font-bold text-indigo-300">
                          {user?.displayName || '我'}
                        </span>
                      </div>
                      {/* Chat Bubble (with stylish rounded tail) */}
                      <div className="relative bg-gradient-to-r from-indigo-600 to-indigo-500 text-white rounded-2xl rounded-tr-sm px-3.5 py-2 text-xs leading-relaxed break-words shadow-md shadow-indigo-600/20">
                        {msg.text}
                      </div>
                    </div>

                    {/* Avatar */}
                    <div
                      className="w-7 h-7 rounded-full overflow-hidden border shrink-0 flex items-center justify-center text-[10px] font-bold shadow-sm"
                      style={{
                        borderColor: user?.id ? getUserColor(user.id).hex : '#6366F1',
                        backgroundColor: `${user?.id ? getUserColor(user.id).hex : '#6366F1'}25`,
                      }}
                    >
                      {user?.avatarUrl ? (
                        <img src={user.avatarUrl} alt="avatar" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-indigo-300 font-bold">
                          {(user?.displayName || '我')[0]}
                        </span>
                      )}
                    </div>
                  </div>
                );
              }

              // Sent by OTHER PAINTERS (Align Left)
              const userColor = msg.color || getUserColor(msg.userId).hex;
              return (
                <div key={msg.id} className="flex items-start gap-2.5 animate-in fade-in duration-150">
                  {/* Avatar */}
                  <div
                    className="w-7 h-7 rounded-full overflow-hidden border shrink-0 flex items-center justify-center text-[10px] font-bold shadow-sm"
                    style={{
                      borderColor: userColor,
                      backgroundColor: `${userColor}25`,
                    }}
                  >
                    {msg.avatarUrl ? (
                      <img src={msg.avatarUrl} alt={msg.displayName} className="w-full h-full object-cover" />
                    ) : (
                      <span style={{ color: userColor }}>
                        {(msg.displayName || '畫')[0]}
                      </span>
                    )}
                  </div>

                  {/* Body */}
                  <div className="flex flex-col items-start max-w-[82%]">
                    <div className="flex items-center gap-1.5 mb-1 text-[10px]">
                      <span className="font-bold truncate max-w-[130px]" style={{ color: userColor }}>
                        {msg.displayName}
                      </span>
                      <span className="font-mono text-neutral-400 text-[9px]">{timeStr}</span>
                    </div>

                    {/* Chat Bubble (with stylish rounded left tail) */}
                    <div className="relative bg-neutral-900 text-neutral-100 border border-neutral-700/80 rounded-2xl rounded-tl-sm px-3.5 py-2 text-xs leading-relaxed break-words shadow-md">
                      {msg.text}
                    </div>
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Quick Chips Drawer */}
        <div className="px-3 py-2 border-t border-neutral-800/80 bg-neutral-950/40 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {QUICK_CHIPS.map((chip, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleQuickChip(chip)}
              className="px-2.5 py-1 bg-neutral-800/80 hover:bg-neutral-750 text-neutral-300 text-[11px] rounded-full shrink-0 border border-neutral-700/60 transition active:scale-95 whitespace-nowrap"
            >
              {chip}
            </button>
          ))}
        </div>

        {/* Message Input Box */}
        <form
          onSubmit={handleSend}
          className="p-3 border-t border-neutral-800 bg-neutral-950 flex items-center gap-2"
        >
          <input
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            placeholder={`${t.collab.placeholder}...`}
            className="flex-1 bg-neutral-900 border border-neutral-700/80 rounded-xl px-3.5 py-2 text-xs text-white placeholder:text-neutral-500 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={!inputVal.trim()}
            title={t.collab.send}
            className="p-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white transition shrink-0 shadow"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
    </OverlayPresence>
  );
};
