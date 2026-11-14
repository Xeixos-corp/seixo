// Tells the caller what the hosting layer saw of this very request: the IP
// address it arrived from.
//
// Why. "O que o servidor sabe" (ServerFootprintScreen.tsx) has always said, in
// the abstract, that the hosting provider logs every request with the IP, the
// approximate city and postcode and the internet provider. Showing someone
// their own address makes that concrete. Someone on a VPN sees the VPN's
// address instead, which is the lesson too.
//
// Only the address, and why. Tested on 2026-11-14: the entry layer logs the
// country, city, postcode and provider (request.cf.* in the edge logs), and
// even receives a cf-ipcountry header, but none of that reaches the function.
// What arrives is the address: cf-connecting-ip, which was checked against
// the caller's real public address and matches. The place could only be had
// by looking the address up somewhere, and this function will not do that:
// asking a geolocation service would send the person's IP to one more company,
// which is exactly what the screen warns about. The country, city and
// postcode fields stay in the response, null, so that if the platform ever
// passes them through, the app shows them without a new version.
//
// What it tells the server that it did not know: nothing. The address arrives
// with every request and is already in the hosting log before this runs. The
// function only hands it back to the one person it describes.
//
// It stores nothing and logs nothing. There is no console.log in this file on
// purpose; do not add one. The hosting provider still logs the call itself,
// as it logs every request, and the privacy policy says so.
//
// It runs only when the person presses the button on that screen; the app
// never calls it on its own. JWT verification stays on, so it answers Seixo
// accounts only.

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** The first non-empty header among `names`, trimmed, or null. */
function header(req: Request, ...names: string[]): string | null {
  for (const name of names) {
    const value = req.headers.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

Deno.serve((req: Request) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  // cf-connecting-ip is the client as the edge saw it. The forwarded chains
  // start with the same address and are only a fallback.
  const forwarded =
    header(req, "sb-forwarded-for", "x-forwarded-for")?.split(",")[0]?.trim() || null;
  const ip = header(req, "cf-connecting-ip") ?? forwarded;

  // Not passed through today (see above); kept so the app needs no change if
  // they ever are. "XX" and "T1" are Cloudflare's codes for unknown and Tor.
  const country = header(req, "cf-ipcountry");

  return json(
    {
      ip,
      country: country && country !== "XX" && country !== "T1" ? country : null,
      tor: country === "T1",
      city: header(req, "cf-ipcity"),
      region: header(req, "cf-region"),
      postalCode: header(req, "cf-postal-code"),
    },
    200,
  );
});
