'use client';

import { useEffect, useRef } from 'react';
import type { TranscriptSegment } from '@/lib/types';

interface TranscriptViewProps {
  segments: TranscriptSegment[];
}

/**
 * Render the most recent transcript segments with speaker labels.
 * Collapses interim segments under the latest final so the view doesn't flicker.
 */
export function TranscriptView({ segments }: TranscriptViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new segments
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [segments.length]);

  // Only show finals + the latest interim per speaker (cleaner than raw stream)
  const display = (() => {
    const finals = segments.filter((s) => s.isFinal);
    const latestInterimProspect = [...segments]
      .reverse()
      .find((s) => !s.isFinal && s.speaker === 'prospect');
    const latestInterimMe = [...segments]
      .reverse()
      .find((s) => !s.isFinal && s.speaker === 'me');
    const out: TranscriptSegment[] = [...finals];
    if (latestInterimProspect) out.push(latestInterimProspect);
    if (latestInterimMe) out.push(latestInterimMe);
    return out.sort((a, b) => a.timestamp - b.timestamp);
  })();

  if (display.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-text-dim text-xs">
        Transcript will appear here once the call starts.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto scrollbar-thin px-5 py-4 space-y-2"
    >
      {display.map((s) => (
        <div
          key={s.id}
          className={`text-sm leading-relaxed ${
            !s.isFinal ? 'opacity-50 italic' : ''
          }`}
        >
          <span
            className={`text-[10px] uppercase tracking-wider mr-2 font-medium ${
              s.speaker === 'prospect' ? 'text-signal-info' : 'text-accent-dim'
            }`}
          >
            {s.speaker === 'prospect' ? 'PROSPECT' : 'ME'}
          </span>
          <span className="text-text-secondary">{s.text}</span>
        </div>
      ))}
    </div>
  );
}
