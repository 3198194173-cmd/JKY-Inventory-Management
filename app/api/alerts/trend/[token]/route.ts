import { renderTrendThumbnail, trendDetailHtml, verifyTrendThumbnail } from "@/lib/dingtalk-trend-thumbnail";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const samples = verifyTrendThumbnail(token, process.env.DINGTALK_CLIENT_SECRET || "");
  if (!samples) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (new URL(request.url).searchParams.get("view") === "detail") return new Response(trendDetailHtml(samples), { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
  } });
  const png = await renderTrendThumbnail(samples);
  return new Response(new Uint8Array(png), { headers: {
    "Content-Type": "image/png", "Cache-Control": "public, max-age=86400, immutable",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  } });
}
