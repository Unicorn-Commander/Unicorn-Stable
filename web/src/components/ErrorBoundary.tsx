import { Component, type ErrorInfo, type ReactNode } from "react";
import { StableMark } from "@/components/StableMark";

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
        <div className="card animate-fade-in w-full max-w-xl p-8 text-center text-sm text-slate-200">
          <div className="relative mx-auto mb-5 h-12 w-12">
            <div
              className="absolute -inset-3 rounded-full bg-stable-purple/25 blur-xl"
              aria-hidden="true"
            />
            <StableMark className="relative h-12 w-12" />
          </div>
          <h2 className="font-display text-lg font-semibold text-slate-50">
            Something broke rendering this view.
          </h2>
          <p className="mx-auto mt-1.5 max-w-sm text-xs text-slate-400">
            The rest of the app is still alive. Try a different channel, or
            click reset.
          </p>
          <pre className="mt-4 max-h-48 overflow-auto rounded-xl border border-rose-500/20 bg-slate-950/80 p-3 text-left text-[11px] leading-relaxed text-rose-300/90">
            {String(this.state.err.stack ?? this.state.err.message ?? this.state.err)}
          </pre>
          <button
            onClick={this.reset}
            className="gradient-bg focus-ring mt-5 rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-glow-iris transition hover:opacity-95 active:scale-[0.98]"
          >
            Reset
          </button>
        </div>
      </div>
    );
  }
}
