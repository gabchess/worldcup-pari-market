"use client";

/**
 * Wallet-adapter scaffold. Wraps the app in ConnectionProvider +
 * WalletProvider + WalletModalProvider so market/page.tsx can render
 * <WalletMultiButton /> and any future T3/T4 <TxButton /> can call
 * useWallet()/useConnection(). No tx-signing logic here -- connect only,
 * per T1 scope.
 */
import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";

import "@solana/wallet-adapter-react-ui/styles.css";

/** Public devnet cluster RPC, deliberately separate from the Helius key used
 * server-side by api/market/route.ts. That key is never sent to the client
 * or logged. Wallet-signed deposit and claim transactions only need a devnet RPC to
 * submit against; a paid Helius key has no reason to ship in the client
 * bundle just to satisfy that. */
const DEVNET_ENDPOINT = clusterApiUrl("devnet");

export function AppWalletProvider({ children }: { children: React.ReactNode }) {
  // Phantom + Solflare cover the two most-used devnet-testing extension
  // wallets; other Wallet Standard wallets (Backpack included) register
  // themselves automatically and don't need an explicit adapter entry here.
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <ConnectionProvider endpoint={DEVNET_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
