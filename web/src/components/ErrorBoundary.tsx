import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  err: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", err, info);
  }

  reset = () => this.setState({ err: null });

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="flex min-h-[60vh] flex-1 items-center justify-center p-6">
        <div className="max-w-xl rounded-xl border border-red-500/30 bg-slate-900 p-5 text-sm text-slate-200 shadow-2xl">
          <h2 className="mb-2 text-base font-semibold text-red-400">
            Something broke rendering this view.
          </h2>
          <p className="mb-3 text-xs text-slate-400">
            The rest of the app is still alive. Try a different channel, or
            click reset.
          </p>
          <pre className="mb-3 max-h-48 overflow-auto rounded bg-slate-950/80 p-2 text-[11px] text-red-300">
            {String(this.state.err.stack ?? this.state.err.message ?? this.state.err)}
          </pre>
          <button
            onClick={this.reset}
            className="rounded-md bg-stable-purple px-3 py-1.5 text-xs text-white hover:bg-stable-purple-light"
          >
            Reset
          </button>
        </div>
      </div>
    );
  }
}
