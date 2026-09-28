import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useUi } from "./ui";

/**
 * A thumbnail that opens its media in the app-wide full-screen viewer when
 * clicked. Used for every image/video preview so they all behave identically.
 */
export function MediaThumb({ kind, src, name, className, style, children }: {
  kind: "image" | "video";
  src: string;
  name?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const ui = useUi();
  return (
    <div
      className={className}
      style={style}
      title={name ? `Open ${name}` : "Open"}
      onClick={(e) => {
        e.stopPropagation();
        ui.openMedia({ kind, src, name });
      }}
    >
      {children ?? (kind === "video" ? (
        <video src={src} muted preload="metadata" />
      ) : (
        <img src={src} alt={name ?? ""} loading="lazy" />
      ))}
    </div>
  );
}

/** Anything the full-screen viewer can show. */
export interface MediaTarget {
  kind: "image" | "video";
  /** A ready-to-use URL — assetUrl() / imageUrl() / outputUrl() / exportUrl(). */
  src: string;
  name?: string;
}

/**
 * One full-screen viewer for the whole app. Mounted once at the root, so any
 * thumbnail anywhere can hand it a URL via `useUi().openMedia(...)` instead of
 * each view growing its own bespoke overlay.
 *
 * Click the backdrop or press Escape to close.
 */
export function MediaViewer({ media, onClose }: { media: MediaTarget; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} title="Close (Esc)">
        ✕
      </button>
      {media.name && <div className="lightbox-name">{media.name}</div>}
      <div className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
        {media.kind === "video" ? (
          <video src={media.src} controls autoPlay playsInline />
        ) : (
          <img src={media.src} alt={media.name ?? ""} />
        )}
      </div>
    </div>
  );
}