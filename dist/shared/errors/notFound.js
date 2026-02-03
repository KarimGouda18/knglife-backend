export function notFoundHandler(req, res, _next) {
    res.status(404).json({
        ok: false,
        error: "NOT_FOUND",
        path: req.path
    });
}
