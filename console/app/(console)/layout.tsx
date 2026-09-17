import type { Metadata, Viewport } from "next";
import "./olien.css";
import { OlienShell } from "@/components/olien/shell";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: { default: "Olien", template: "%s | Olien" },
  description: "Olien is a multisig account. Members propose, approve and execute USDC payments together.",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0b",
};

// No switch guards this. Inside Recourse the console was a feature behind a flag, and
// an unset flag served a waitlist page instead; here the console is the whole product,
// so a missing variable must not be able to turn it off.
export default function OlienConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <OlienShell>{children}</OlienShell>
    </Providers>
  );
}
