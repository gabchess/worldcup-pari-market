"use client";

/**
 * Wallet-adapter scaffold (T1, S194). Wraps the app in ConnectionProvider +
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

/** Public devnet cluster RPC -- deliberately NOT the Helius key
 * api/market/route.ts uses server-side (that key is read from
 * ~/secrets/helius-api-key.txt "never sent to the client, never logged").
 * Wallet-signed deposit/claim transactions (T3/T4) only need a devnet RPC to
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
