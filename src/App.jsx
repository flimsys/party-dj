import React from "react";

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 backdrop-blur bg-slate-950/70 border-b border-slate-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <span className="text-xl font-bold">Party DJ (clean build)</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <div className="p-4 bg-slate-900/40 rounded-2xl border border-slate-800 shadow-sm">
          <h2 className="text-lg font-bold mb-2">It works 🎉</h2>
          <p className="opacity-80">
            This is a safe skeleton with **no Firebase or YouTube** yet.
            Once you see this render, we’ll add features back one at a time.
          </p>
        </div>
      </main>

      <footer className="max-w-6xl mx-auto px-4 pb-8 text-xs opacity-60">
        Built for quick parties.
      </footer>
    </div>
  );
}
