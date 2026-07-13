/**
 * Solana devnet explorer link helpers. Extracted from market/page.tsx so
 * <TxButton /> can link to a submitted signature
 * without duplicating the URL template.
 */
export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function explorerAddr(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}
