import { getBearerToken } from "../utils/http.js";
import { getAuth } from "../../config/firebase.js";
export async function requireAuth(req, res, next) {
    try {
        const token = getBearerToken(req);
        if (!token) {
            return res.status(401).json({ ok: false, error: "MISSING_BEARER_TOKEN" });
        }
        const decoded = await getAuth().verifyIdToken(token);
        req.user = decoded;
        return next();
    }
    catch (err) {
        return res.status(401).json({ ok: false, error: "INVALID_ID_TOKEN" });
    }
}
