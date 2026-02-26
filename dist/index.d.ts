declare function useEvent<T extends (...args: any[]) => any>(fn: T): T;

type EffectTaskCleanup = () => void;
interface EffectTaskScope {
    signal: AbortSignal;
    runId: number;
    isActive: () => boolean;
    commit: (fn: () => void) => void;
    onCleanup: (fn: EffectTaskCleanup) => void;
}
interface UseEffectTaskOptions {
    layout?: boolean;
    onError?: (err: unknown) => void;
    debugName?: string;
}
type EffectTask = (scope: EffectTaskScope) => void | EffectTaskCleanup | Promise<void | EffectTaskCleanup>;
declare function useEffectTask(task: EffectTask, deps: any[], options?: UseEffectTaskOptions): void;

export { type EffectTask, type EffectTaskCleanup, type EffectTaskScope, type UseEffectTaskOptions, useEffectTask, useEvent };
