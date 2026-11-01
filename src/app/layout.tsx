import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Qwen — A space to think", description: "Your personal chat workspace, powered by your own Qwen model." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
