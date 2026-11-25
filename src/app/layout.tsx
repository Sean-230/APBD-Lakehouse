import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { LakehouseProvider } from "@/components/LakehouseContext";
import { AppShell } from "@/components/AppShell";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "SuraLake — APBD Surabaya Apache Iceberg Lakehouse",
  description:
    "Platform Data Lakehouse APBD Kota Surabaya berbasis Apache Iceberg Medallion (Bronze, Silver, Gold), Unified Multi-Format Ingestion, dan DuckDB SQL Explorer.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <LakehouseProvider>
          <AppShell>{children}</AppShell>
        </LakehouseProvider>
      </body>
    </html>
  );
}
