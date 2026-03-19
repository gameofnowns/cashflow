import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NOWN Cashflows",
  description: "Cash position dashboard — 12-month rolling forecast",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
