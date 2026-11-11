// Browser-side trial decoder: talks to public/repair/probe-worker.js (ffmpeg in WebAssembly).

import type { Prober } from "./estimate";

interface Reply {
  id: number;
  ok: boolean;
  frame?: Uint8Array | null;
  errors?: boolean;
  error?: string;
}

export interface WasmProber extends Prober {
  dispose(): void;
}

/**
 * The WebAssembly ffmpeg build leaks memory on every run and takes the whole tab down after
 * roughly a hundred runs in one instance, so each instance is retired well before that.
 */
const RUNS_PER_INSTANCE = 40;

interface Instance {
  call(message: Record<string, unknown>, transfer?: Transferable[]): Promise<Reply>;
  terminate(): void;
}

async function startInstance(): Promise<Instance> {
  const worker = new Worker("/repair/probe-worker.js");
  const pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  worker.onmessage = (ev: MessageEvent<Reply>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) p.resolve(ev.data);
    else p.reject(new Error(ev.data.error ?? "probe failed"));
  };
  worker.onerror = (ev) => {
    for (const p of pending.values()) p.reject(new Error(ev.message || "worker error"));
    pending.clear();
  };

  const instance: Instance = {
    call: (message, transfer = []) =>
      new Promise<Reply>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...message, id }, transfer);
      }),
    terminate: () => worker.terminate(),
  };
  try {
    await instance.call({ type: "load" });
  } catch (e) {
    worker.terminate();
    throw e;
  }
  return instance;
}

export async function createWasmProber(): Promise<WasmProber> {
  // Fail early (and visibly) if the decoder cannot be loaded at all.
  let instance: Instance | null = await startInstance();
  let runs = 0;

  return {
    async decodeYuv(annexB, width, height, frame, codec = "h264") {
      if (!instance || runs >= RUNS_PER_INSTANCE) {
        instance?.terminate();
        instance = null;
        instance = await startInstance();
        runs = 0;
      }
      runs++;
      try {
        // The stream buffer is rebuilt for every trial, so it can be handed over.
        const reply = await instance.call({ type: "decode", stream: annexB, width, height, frame, codec }, [annexB.buffer]);
        return reply.frame ? { data: reply.frame, errors: reply.errors === true } : null;
      } catch {
        // A decoder that died on one candidate must not end the search: count it as a miss.
        instance?.terminate();
        instance = null;
        return null;
      }
    },
    dispose() {
      instance?.terminate();
      instance = null;
    },
  };
}
