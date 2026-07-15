import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Job Radar — Remote contract opportunities",
  description: "Strictly matched remote sales and marketing contract roles across Sweden and EMEA.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="sv">
      <body>{children}</body>
    </html>
  );
}
