import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

/**
 * Last-resort net for the whole UI.
 *
 * Without it, any uncaught error during render unmounts the tree and leaves the
 * dark <div id="root"> empty - the app looks like a black screen with no clue
 * that it crashed or why. Showing the stack here means a bad build is obvious
 * (and reportable) instead of looking like "the server is down".
 */
class RootBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 24, minHeight: "100vh", background: "#0e1116", color: "#e6edf3" }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>H3 Director Studio failed to start</h2>
        <p style={{ margin: "0 0 14px", color: "#9aa7b4", fontSize: 13 }}>
          The UI threw an error before it could render. The backend may still be running — this is a
          front-end bug, and the details below are what to report.
        </p>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            fontFamily: "ui-monospace, Consolas, monospace",
            fontSize: 12,
            color: "#ff7b72",
            background: "#141a22",
            border: "1px solid #2a3441",
            borderRadius: 6,
            padding: 12,
          }}
        >
          {String(error.stack ?? error.message ?? error)}
        </pre>
        <button onClick={() => location.reload()} style={{ marginTop: 14, padding: "6px 12px" }}>
          Reload
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </React.StrictMode>,
);
