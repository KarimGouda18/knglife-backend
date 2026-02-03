export function getBearerToken(req) {
    const h = req.header("authorization") ?? req.header("Authorization");
    if (!h)
        return null;
    const m = h.match(/^Bearer\s+(.+)$/i);
    return m?.[1]?.trim() ?? null;
}
