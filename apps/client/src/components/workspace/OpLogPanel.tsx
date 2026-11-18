import React, { useEffect, useState } from 'react';
import { Activity, Trash2 } from 'lucide-react';
import { PreviewLatencyStat, useSocket, useSocketTelemetry } from '../../context/SocketContext';

/** Live operation log (dockable panel), with how late other painters' live strokes arrive. */
export const OpLogPanel: React.FC = () => {
  const { getPreviewLatency, members } = useSocket();
  const { eventLogs, clearLogs } = useSocketTelemetry();
  // Polled once a second: previews arrive far too often to push through React state
  const [latency, setLatency] = useState<PreviewLatencyStat[]>([]);
  useEffect(() => {
    const tick = () => setLatency(getPreviewLatency());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [getPreviewLatency]);
  const nameOf = (userId: string) => members.find((m) => m.userId === userId)?.displayName ?? '畫師';
  const fmt = (ms: number) => (ms < 1 ? '<1ms' : `${Math.round(ms)}ms`);
  const tone = (ms: number) => (ms < 50 ? 'text-emerald-400' : ms < 150 ? 'text-amber-400' : 'text-rose-400');

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="border-b border-neutral-800 px-2 py-1.5" aria-label="即時筆觸延遲">
        <div className="mb-1 flex items-center gap-1 text-[11px] font-bold text-neutral-300">
          <Activity className="h-3 w-3" /> 別人筆觸到你畫面的延遲
        </div>
        {latency.length === 0 ? (
          <div className="text-[10px] text-neutral-500">還沒有其他人在畫（有人下筆時會顯示）</div>
        ) : (
          <table className="w-full font-mono text-[10px]">
            <thead className="text-neutral-500">
              <tr><th className="text-left font-normal">畫師</th><th className="text-right font-normal">中位數</th><th className="text-right font-normal">95%</th><th className="text-right font-normal">最近</th></tr>
            </thead>
            <tbody>
              {latency.map((l) => (
                <tr key={l.socketId}>
                  <td className="max-w-[7rem] truncate text-neutral-300">{nameOf(l.userId)}</td>
                  <td className={`text-right ${tone(l.p50)}`}>{fmt(l.p50)}</td>
                  <td className={`text-right ${tone(l.p95)}`}>{fmt(l.p95)}</td>
                  <td className={`text-right ${tone(l.last)}`}>{fmt(l.last)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex justify-end px-2 pt-1.5">
        <button type="button" onClick={clearLogs} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-white">
          <Trash2 className="h-3 w-3" /> 清空
        </button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2 font-mono text-[11px]">
        {eventLogs.length === 0 ? (
          <div className="py-6 text-center text-neutral-500">尚無任何操作記錄</div>
        ) : eventLogs.map((log) => (
          <div key={log.id} className="rounded border border-neutral-800 bg-neutral-950/60 p-1.5 leading-relaxed">
            <div className="mb-0.5 flex items-center justify-between text-[10px] text-neutral-500">
              <span className="font-semibold" style={{ color: log.color || undefined }}>[{log.type}]</span>
              <span>{log.time}</span>
            </div>
            <div className="break-words text-neutral-300">{log.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
};
