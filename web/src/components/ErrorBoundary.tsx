import { Component, type ErrorInfo, type ReactNode } from "react";
import { StableMark } from "@/components/StableMark";

interface Props {
  children: ReactNode;
  /** Names what broke in the fallback copy, e.g. "the chat area". Lets a
   * per-panel boundary read clearly instead of "this view". */
  label?: string;
  /** Root-level boundary: fill the whole viewport and offer a page reload (a
   * panel boundary can only reset its subtree; the root can't recover the app
   * in place, so it reloads). Panel boundaries stay inline + offer Reset. */
  fullScreen?: boolean;
}

interface State {
  err: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", this.props.label ?? "", err, info);
  }

  reset = () => this.setState({ err: null });

  render() {
    if (!this.state.err) return this.props.children;
    const { label, fullScreen } = this.props;
    return (
      <div
        className={
          fullScreen
            ? "flex min-h-screen w-full flex-1 items-center justify-center p-6"
            : "flex min-h-[60vh] flex-1 items-center justify-center p-6"
        }
      >
        <div className="card animate-fade-in w-full max-w-xl p-8 text-center text-sm text-slate-200">
          <div className="relative mx-auto mb-5 h-12 w-12">
            <div
              className="absolute -inset-3 rounded-full bg-stable-purple/25 blur-xl"
              aria-hidden="true"
            />
            <StableMark className="relative h-12 w-12" />
          </div>
          <h2 className="font-display text-lg font-semibold text-slate-50">
            {label
              ? `Something broke in ${label}.`
              : "Something broke rendering this view."}
          </h2>
          <p className="mx-auto mt-1.5 max-w-sm text-xs text-slate-400">
            {fullScreen
              ? "Something went wrong loading the app. Reloading usually clears it."
              : "The rest of the app is still alive. Try a different channel, or click reset."}
          </p>
          <pre className="mt-4 max-h-48 overflow-auto rounded-xl border border-rose-500/20 bg-slate-950/80 p-3 text-left text-[11px] leading-relaxed text-rose-300/90">
            {String(this.state.err.stack ?? this.state.err.message ?? this.state.err)}
          </pre>
          <div className="mt-5 flex items-center justify-center gap-2.5">
            {fullScreen ? (
              <button
                onClick={() => window.location.reload()}
                className="gradient-bg focus-ring rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-glow-iris transition hover:opacity-95 active:scale-[0.98]"
              >
                Reload app
              </button>
            ) : (
              <button
                onClick={this.reset}
                className="gradient-bg focus-ring rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-glow-iris transition hover:opacity-95 active:scale-[0.98]"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
