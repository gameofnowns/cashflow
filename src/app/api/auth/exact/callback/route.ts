import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/exact";

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
    if (isPopup) return popupHtml("oauth_error", "exact", error);
    return NextResponse.redirect(
      new URL(`/?exact_error=${encodeURIComponent(error)}`, request.url)
    );
  }

  if (!code) {
    if (isPopup) return popupHtml("oauth_error", "exact", "no_code");
    return NextResponse.redirect(
      new URL("/?exact_error=no_code", request.url)
    );
  }

  try {
    await exchangeCodeForTokens(code);
    if (isPopup) return popupHtml("oauth_complete", "exact");
    return NextResponse.redirect(
      new URL("/?exact_connected=true", request.url)
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Token exchange failed";
    if (isPopup) return popupHtml("oauth_error", "exact", msg);
    return NextResponse.redirect(
      new URL(`/?exact_error=${encodeURIComponent(msg)}`, request.url)
    );
  }
}
