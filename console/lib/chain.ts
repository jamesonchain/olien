// The one place the console knows which chain it is on. Everything else asks here:
// the wagmi chain, the public client, explorer links, the gas token's name. The
// chain is chosen at build time by NEXT_PUBLIC_OLIEN_CHAIN; a deployment of the
// console serves one chain and one service, and the service's own answer at
// /api/treasury/chain is checked against this in Settings so a console pointed at
// the wrong service says so instead of showing the wrong links.
//
// Addresses and hosts below were verified on 2026-09-10: the Arc entries from the
// deployment file, the Monad USDC addresses from Circle's contract list and the
// testnet one called on chain (symbol USDC, version 2, six decimals).

import { createPublicClient, defineChain, http, type Chain } from "viem";
import type { DecodeContext, TokenInfo } from "./signing";

export type ChainSlug = "arc-testnet" | "monad-testnet" | "monad";

interface ChainSpec {
  slug: ChainSlug;
  id: number;
  name: string;
  native: { symbol: string; decimals: number };
  rpc: string;
  explorer: { name: string; url: string };
  usdc: `0x${string}`;
  eurc?: `0x${string}`;
  testnet: boolean;
}

const SPECS: Record<ChainSlug, ChainSpec> = {
  "arc-testnet": {
    slug: "arc-testnet",
    id: 5042002,
    name: "Arc Testnet",
    native: { symbol: "USDC", decimals: 18 },
    rpc: "https://arc-testnet.drpc.org",
    explorer: { name: "ArcScan", url: "https://testnet.arcscan.app" },
    usdc: "0x3600000000000000000000000000000000000000",
    eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    testnet: true,
  },
  "monad-testnet": {
    slug: "monad-testnet",
    id: 10143,
    name: "Monad Testnet",
    native: { symbol: "MON", decimals: 18 },
    rpc: "https://testnet-rpc.monad.xyz",
    explorer: { name: "MonadExplorer", url: "https://testnet.monadexplorer.com" },
    usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    testnet: true,
  },
  monad: {
    slug: "monad",
    id: 143,
    name: "Monad",
    native: { symbol: "MON", decimals: 18 },
    rpc: "https://rpc.monad.xyz",
    explorer: { name: "MonadExplorer", url: "https://monadexplorer.com" },
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    testnet: false,
  },
};

function chosen(): ChainSpec {
  const slug = (process.env.NEXT_PUBLIC_OLIEN_CHAIN ?? "arc-testnet") as ChainSlug;
  return SPECS[slug] ?? SPECS["arc-testnet"];
}

export const chainSpec = chosen();

export const olienChain: Chain = defineChain({
  id: chainSpec.id,
  name: chainSpec.name,
  nativeCurrency: { name: chainSpec.native.symbol, symbol: chainSpec.native.symbol, decimals: chainSpec.native.decimals },
  rpcUrls: { default: { http: [chainSpec.rpc] } },
  blockExplorers: { default: { name: chainSpec.explorer.name, url: chainSpec.explorer.url } },
  testnet: chainSpec.testnet,
});

export const olienPublicClient = createPublicClient({ chain: olienChain, transport: http() });

export const chainName = chainSpec.name;
export const nativeSymbol = chainSpec.native.symbol;
export const explorerName = chainSpec.explorer.name;
export const olienUsdcAddress = chainSpec.usdc;
export const explorerAddressUrl = (address: string) => `${chainSpec.explorer.url}/address/${address}`;
export const explorerTxUrl = (hash: string) => `${chainSpec.explorer.url}/tx/${hash}`;

// The tokens this console will read a transfer of. Fixed at build time on purpose: a
// list the service supplied could name any contract USDC, and a payment to it would
// then read as dollars.
export const olienTokens: TokenInfo[] = [
  { address: chainSpec.usdc, symbol: "USDC", decimals: 6 },
  ...(chainSpec.eurc ? [{ address: chainSpec.eurc, symbol: "EURC", decimals: 6 }] : []),
];

export const decodeContext = (account: string): DecodeContext => ({ account, tokens: olienTokens, native: chainSpec.native });
