// src/worker/request-serde.ts — turn a Request/Response into a structured-cloneable
// plain object and back, so the unchanged worker handler can run on the engine thread.
// Bodies are read as text (all worker responses are Response.json/text); bounded sizes.

export interface WireRequest { method: string; url: string; headers: Record<string, string>; body: string | null; }
export interface WireResponse { status: number; headers: Record<string, string>; body: string; }

export async function serializeRequest(req: Request): Promise<WireRequest> {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return {
    method: req.method,
    url: req.url,
    headers: Object.fromEntries(req.headers),
    body: hasBody ? await req.text() : null,
  };
}

export function deserializeRequest(w: WireRequest): Request {
  return new Request(w.url, {
    method: w.method,
    headers: w.headers,
    ...(w.body !== null ? { body: w.body } : {}),
  });
}

export async function serializeResponse(res: Response): Promise<WireResponse> {
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
}

export function deserializeResponse(w: WireResponse): Response {
  return new Response(w.body, { status: w.status, headers: w.headers });
}
