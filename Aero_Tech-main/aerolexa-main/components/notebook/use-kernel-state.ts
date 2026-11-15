import { useState } from "react";

export type KernelStatus = "loading" | "ready" | "fallback";

export interface UseKernelStateReturn {
  kernelStatus: KernelStatus;
  setKernelStatus: (status: KernelStatus) => void;
  kernelError: string | null;
  setKernelError: (error: string | null) => void;
}

export function useKernelState(): UseKernelStateReturn {
  const [kernelStatus, setKernelStatus] = useState<KernelStatus>("loading");
  const [kernelError, setKernelError] = useState<string | null>(null);
  return { kernelStatus, setKernelStatus, kernelError, setKernelError };
}
