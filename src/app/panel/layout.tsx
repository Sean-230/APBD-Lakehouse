import React from "react";
import { LakehouseProvider } from "@/components/LakehouseContext";
import { AppShell } from "@/components/AppShell";

export default function PanelLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <LakehouseProvider>
      <AppShell>{children}</AppShell>
    </LakehouseProvider>
  );
}
