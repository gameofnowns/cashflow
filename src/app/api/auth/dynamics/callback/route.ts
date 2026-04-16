import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/dynamics";

function popupHtml(type: string, provider: string, error?: string) {
  const payload = error
    ? `{ type: "oauth_error", provider: "${provider}", error: ${JSON.stringify(error)} }`
    : `{ type: "oauth_complete", provider: "${provider}" }`;
  return new Response(
    `<!DOCTYPE html><html><body><script>
      window.opener?.postMessage(${payload}, window.location.origin);
      window.close();
    </script><p>${error ? "Error: " + error : "Connected."} You may close this window.</p></body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  const isPopup = request.nextUrl.searchParams.get("state") === "popup";

  if (error) {
    if (isPopup) return popupHtml("oauth_error", "dynamics", error);
    return NextResponse.redirect(
      new URL(`/?dynamics_error=${encodeURIComponent(error)}`, request.url)
    );
  }

  if (!code) {
    if (isPopup) return popupHtml("oauth_error", "dynamics", "no_code");
    return NextResponse.redirect(
      new URL("/?dynamics_error=no_code", request.url)
    );
  }

  try {
    await exchangeCodeForTokens(code);
    if (isPopup) return popupHtml("oauth_complete", "dynamics");
    return NextResponse.redirect(
      new URL("/?dynamics_connected=true", request.url)
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Token exchange failed";
    if (isPopup) return popupHtml("oauth_error", "dynamics", msg);
    return NextResponse.redirect(
      new URL(`/?dynamics_error=${encodeURIComponent(msg)}`, request.url)
    );
  }
}
