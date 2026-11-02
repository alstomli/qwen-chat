"use client";
import { useLayoutEffect, useRef, type ReactNode } from "react";

/** A visible paint opportunity after React commits answer text, not a compositor timestamp. */
export function AnswerPaint({ messageId, onPaint, children }: {
  messageId: string; onPaint?: (id: string, observed: number) => void; children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!onPaint || !node) return;
    let frame = 0; let visible = false; let reported = false;
    function schedule() {
      if (!visible || document.visibilityState !== "visible") { cancelAnimationFrame(frame); frame = 0; return; }
      if (reported || frame || !node?.textContent?.trim()) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (!visible || document.visibilityState !== "visible" || !node?.isConnected || reported) return;
          reported = true; onPaint!(messageId, performance.now());
        });
      });
    }
    const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; schedule(); });
    const changes = new MutationObserver(schedule);
    changes.observe(node, { childList: true, subtree: true, characterData: true });
    observer.observe(node);
    document.addEventListener("visibilitychange", schedule);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); changes.disconnect(); document.removeEventListener("visibilitychange", schedule); };
  }, [messageId, onPaint]);
  return <div className="markdown" ref={element}>{children}</div>;
}
