"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type UploadReadyContextValue = {
  ready: boolean;
  markReady: () => void;
};

const UploadReadyContext = createContext<UploadReadyContextValue | null>(null);

export function UploadReadyProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const markReady = useCallback(() => {
    setReady((prev) => (prev ? prev : true));
  }, []);
  const value = useMemo(() => ({ ready, markReady }), [ready, markReady]);
  return (
    <UploadReadyContext.Provider value={value}>
      {children}
    </UploadReadyContext.Provider>
  );
}

export function useUploadReady(): UploadReadyContextValue {
  const ctx = useContext(UploadReadyContext);
  if (!ctx) {
    return { ready: true, markReady: () => {} };
  }
  return ctx;
}
