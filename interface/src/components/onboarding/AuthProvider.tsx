"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createSiweMessage } from "viem/siwe";
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useSignMessage,
  useSwitchChain,
} from "wagmi";
import { arcTestnet } from "@/lib/chain";
import {
  AUTH_SESSION_EVENT,
  clearAuthSession,
  getAuthSessionSnapshot,
  loadAuthSession,
  saveAuthSession,
  SIWE_DOMAIN,
} from "@/lib/api/config";
import { getNonce, verifySiwe } from "@/lib/api/client";
import type { AuthSession } from "@/lib/api/types";

type AuthContextValue = {
  session: AuthSession | null;
  address: `0x${string}` | undefined;
  isConnected: boolean;
  isLoggingIn: boolean;
  login: () => Promise<void>;
  logout: () => void;
  connectWallet: () => Promise<void>;
  ensureSession: () => Promise<AuthSession>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function subscribeAuthSession(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(AUTH_SESSION_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(AUTH_SESSION_EVENT, onStoreChange);
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { address, isConnected, chainId } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const activeChainId = useChainId();
  const session = useSyncExternalStore(
    subscribeAuthSession,
    getAuthSessionSnapshot,
    () => null,
  );
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const connectWallet = useCallback(async () => {
    const connector = connectors[0];
    if (!connector) throw new Error("No wallet connector available.");
    await connectAsync({ connector, chainId: arcTestnet.id });
    if (activeChainId !== arcTestnet.id) {
      await switchChainAsync({ chainId: arcTestnet.id });
    }
  }, [connectAsync, connectors, activeChainId, switchChainAsync]);

  const login = useCallback(async () => {
    if (!address) throw new Error("Connect a wallet first.");
    setIsLoggingIn(true);
    try {
      if (chainId !== arcTestnet.id) {
        await switchChainAsync({ chainId: arcTestnet.id });
      }
      const { nonce } = await getNonce();
      const message = createSiweMessage({
        address,
        chainId: arcTestnet.id,
        domain: SIWE_DOMAIN,
        nonce,
        uri: typeof window !== "undefined" ? window.location.origin : `https://${SIWE_DOMAIN}`,
        version: "1",
      });
      const signature = await signMessageAsync({ message });
      const next = await verifySiwe(message, signature);
      saveAuthSession(next);
    } finally {
      setIsLoggingIn(false);
    }
  }, [address, chainId, signMessageAsync, switchChainAsync]);

  const logout = useCallback(() => {
    clearAuthSession();
    disconnect();
  }, [disconnect]);

  const ensureSession = useCallback(async () => {
    const current = loadAuthSession();
    if (current) return current;
    await login();
    const next = loadAuthSession();
    if (!next) throw new Error("Login failed.");
    return next;
  }, [login]);

  const value = useMemo(
    () => ({
      session,
      address,
      isConnected,
      isLoggingIn,
      login,
      logout,
      connectWallet,
      ensureSession,
    }),
    [
      session,
      address,
      isConnected,
      isLoggingIn,
      login,
      logout,
      connectWallet,
      ensureSession,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
