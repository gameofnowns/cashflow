import { redirect } from "next/navigation";

// This page simply serves the static HTML file
// The middleware skips auth for /stream routes
export default function StreamRedirect() {
  redirect("/cash-position-v5-stream.html");
}
