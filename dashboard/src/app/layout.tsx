import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Cinzel } from "next/font/google";
import { AppWalletProvider } from "./providers";
import "./globals.css";

const cinzel = Cinzel({
  subsets: ["latin"],
  weight: ["600"],
  variable: "--font-cinzel",
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

export const metadata: Metadata = {
  title: "World Cup Pari-Market",
  description: "Proof-settled prediction market dashboard (devnet)",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} ${cinzel.variable}`}
    >
      <body>
        <AppWalletProvider>{children}</AppWalletProvider>
      </body>
    </html>
  );
}
