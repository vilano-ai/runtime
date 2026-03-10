interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  ASSETS: AssetBinding;
}

const INSTALLER_CACHE_CONTROL = "public, max-age=300";
const RELEASE_CACHE_CONTROL = "public, max-age=60";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.redirect("https://github.com/vilano-ai/runtime", 302);
    }

    if (url.pathname === "/install") {
      url.pathname = "/install.sh";
      return Response.redirect(url.toString(), 302);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status === 404) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers(assetResponse.headers);
    if (url.pathname === "/install.sh") {
      headers.set("content-type", "text/x-shellscript; charset=utf-8");
      headers.set("cache-control", INSTALLER_CACHE_CONTROL);
    } else if (url.pathname === "/release.json") {
      headers.set("content-type", "application/json; charset=utf-8");
      headers.set("cache-control", RELEASE_CACHE_CONTROL);
    }

    return new Response(assetResponse.body, {
      status: assetResponse.status,
      headers,
    });
  },
};
