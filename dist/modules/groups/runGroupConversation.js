// src/modules/groups/runGroupConversation.ts
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { getGenAI } from "../../config/genai.js";
import { getGeminiSafetySettings, computeAgeFromBirthDate } from "../../shared/utils/safety.js";
import { sanitizeForJson } from "../../shared/utils/text.js";
/**
 * IMPORTANT FIX (per il tuo bug):
 * In chat di gruppo NON possiamo inviare i messaggi degli altri assistenti con role="model"
 * (o "assistant") perché Gemini li interpreta come "sue" risposte precedenti e può comportarsi
 * in modo imprevedibile (tra cui risposte vuote / nessun testo al turno successivo).
 *
 * Qui trasformiamo TUTTA la cronologia in "trascrizione" lato user:
 * - ogni messaggio viene inviato come role="user" con un prefisso parlante
 * - il messaggio corrente dell'assistente viene generato come risposta del modello
 *
 * Così ogni assistente fa una chiamata indipendente e vede la storia completa come CONTENUTO,
 * non come "output del modello" precedente.
 */
function nowSpeakerLabelUser(user) {
    const full = `${user.name ?? ""} ${user.surname ?? ""}`.trim();
    return full ? `UTENTE (${full})` : "UTENTE";
}
function speakerLabelAssistant(a) {
    return `ASSISTENTE (${a.name} ${a.surname})`;
}
function normalizeInlineBase64(input) {
    const idx = input.indexOf("base64,");
    if (idx >= 0)
        return input.slice(idx + "base64,".length).trim();
    return input.trim();
}
function mapInlineParts(parts) {
    return parts.map((p) => {
        if (p.type === "text")
            return { text: p.text };
        return {
            inlineData: {
                mimeType: p.mimeType,
                data: normalizeInlineBase64(p.dataBase64)
            }
        };
    });
}
function pickRandomOrder(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
function extractTextFromParts(parts) {
    return parts
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.text : ""))
        .join(" ")
        .trim();
}
function cleanMentionToken(s) {
    return s
        .trim()
        .replace(/[^\p{L}\p{N}_-]+/gu, "") // rimuove punteggiatura finale tipo "," ":" "."
        .toLowerCase();
}
/**
 * Mention valida solo a inizio stringa oppure dopo whitespace.
 * Evita false mention su email tipo "a@b.com".
 * Supporta "@Nome" e "@Nome Cognome" e punteggiatura dopo.
 */
function detectMentionedAssistant(opts) {
    const re = /(?:^|\s)@([^\s@]{1,40})(?:\s+([^\s@]{1,40}))?/giu;
    let m;
    while ((m = re.exec(opts.text)) !== null) {
        const first = cleanMentionToken(m[1] ?? "");
        const second = cleanMentionToken(m[2] ?? "");
        if (!first)
            continue;
        for (const a of opts.assistants) {
            const name = cleanMentionToken(a.name);
            const surname = cleanMentionToken(a.surname);
            if (second) {
                if (first === name && second === surname)
                    return a;
            }
            else {
                if (first === name)
                    return a;
            }
        }
    }
    return null;
}
function canUserUseGroupNsfw(user) {
    const age = computeAgeFromBirthDate(user.birthDate);
    const isAdult = typeof age === "number" && age >= 18;
    return isAdult && user.nsfwEnabled;
}
function buildGroupSystemContext(opts) {
    const payload = {
        user: opts.user,
        group: opts.group,
        assistant: opts.assistant,
        otherAssistants: opts.otherAssistants
    };
    return [
        `Sei "${opts.assistant.name} ${opts.assistant.surname}" (assistantId: ${opts.assistant.id}).`,
        `Questa è una chat di GRUPPO dentro KNGLife.`,
        `Vedrai una trascrizione con messaggi di più assistenti: trattala come contesto conversazionale.`,
        `Regole:`,
        `- Rispondi in italiano.`,
        `- Mantieni la tua identità e la tua bio: NON parlare come gli altri assistenti.`,
        `- Sii coerente con età/genere/relazione del tuo personaggio.`,
        `- Se l'utente carica allegati (inline data), analizzali e rispondi.`,
        `- Se l'utente chiede di aggiungere dati alla bio, NON modificare nulla da solo: proponi una patch testuale e attendi conferma.`,
        `- Se il gruppo ha un CONTEXT, usalo come tema/role e integra quel contesto nel tono e nelle scelte narrative, senza diventare ripetitivo.`,
        ``,
        `Contesto gruppo: ${opts.group.context ?? "n/d"}`,
        ``,
        `Profili (JSON):`,
        JSON.stringify(payload)
    ].join("\n");
}
function buildTranscriptTurn(opts) {
    // Prepend label as a first text part, then append original parts (including inlineData)
    const label = { text: `${opts.speaker}: ` };
    const mapped = mapInlineParts(opts.parts);
    return [label, ...mapped];
}
async function runOneAssistantTurn(opts) {
    const ai = getGenAI();
    const useGroupWideNsfw = opts.groupHasNsfw && canUserUseGroupNsfw(opts.userProfile);
    const safetySettings = getGeminiSafetySettings({
        userBirthDate: opts.userProfile.birthDate,
        userNsfwEnabled: opts.userProfile.nsfwEnabled,
        assistantNsfwEnabled: useGroupWideNsfw ? true : opts.assistant.nsfwEnabled
    });
    const systemText = buildGroupSystemContext({
        user: {
            name: opts.userProfile.name,
            surname: opts.userProfile.surname,
            birthDate: opts.userProfile.birthDate,
            age: opts.userProfile.age,
            gender: opts.userProfile.gender,
            visualDisabilityLevel: opts.userProfile.visualDisabilityLevel,
            bio: opts.userProfile.bio,
            nsfwEnabled: opts.userProfile.nsfwEnabled
        },
        group: { name: opts.group.name, context: opts.group.context },
        assistant: {
            id: opts.assistant.id,
            name: opts.assistant.name,
            surname: opts.assistant.surname,
            age: opts.assistant.age,
            gender: opts.assistant.gender,
            relationship: opts.assistant.relationship,
            bio: opts.assistant.bio,
            nsfwEnabled: opts.assistant.nsfwEnabled,
            avatarSpec: opts.assistant.avatarSpec
        },
        otherAssistants: opts.allAssistants
            .filter((a) => a.id !== opts.assistant.id)
            .map((a) => ({ id: a.id, name: a.name, surname: a.surname }))
    });
    // ✅ CRITICAL: tutto come trascrizione user-side
    const contents = [{ role: "user", parts: [{ text: systemText }] }];
    const userLabel = nowSpeakerLabelUser({ name: opts.userProfile.name, surname: opts.userProfile.surname });
    for (const m of opts.history) {
        if (m.role === "user") {
            contents.push({
                role: "user",
                parts: buildTranscriptTurn({ speaker: userLabel, parts: m.parts })
            });
        }
        else {
            // Non sappiamo quale assistente ha parlato (history non porta assistantId),
            // quindi usiamo una label generica. L'importante è: NON role=model.
            contents.push({
                role: "user",
                parts: buildTranscriptTurn({ speaker: "ASSISTENTE (ALTRO)", parts: m.parts })
            });
        }
    }
    // last user message (quello appena inviato)
    contents.push({
        role: "user",
        parts: buildTranscriptTurn({ speaker: userLabel, parts: opts.lastUserParts })
    });
    // Log utile per verificare che Gemini venga chiamato N volte (una per assistente)
    // eslint-disable-next-line no-console
    console.log("[group-chat] generating for", opts.assistant.id, opts.assistant.name, opts.assistant.surname);
    const resp = await ai.models.generateContent({
        model: env.GEMINI_TEXT_MODEL,
        contents,
        config: {
            safetySettings,
            tools: [{ googleSearch: {} }]
        }
    });
    const raw = resp.candidates?.[0]?.content?.parts
        ?.map((p) => p.text)
        .filter(Boolean)
        .join("") ?? "";
    const out = sanitizeForJson(raw).trim();
    if (!out) {
        return "Non riesco a rispondere in questo momento (risposta vuota). Riprova riformulando la richiesta.";
    }
    return out;
}
export async function runGroupConversation(opts) {
    const lastText = extractTextFromParts(opts.lastUserParts);
    // ✅ mention solo se matcha davvero un assistente del gruppo
    const mentioned = detectMentionedAssistant({ text: lastText, assistants: opts.assistants });
    const targets = mentioned ? [mentioned] : pickRandomOrder(opts.assistants);
    const groupHasNsfw = opts.assistants.some((a) => a.nsfwEnabled);
    const results = [];
    // rollingHistory è la storia "logica": ogni risposta generata viene aggiunta qui
    // così l'assistente successivo la vede in contesto.
    let rollingHistory = [...opts.history];
    for (const a of targets) {
        const reply = await runOneAssistantTurn({
            history: rollingHistory,
            lastUserParts: opts.lastUserParts,
            userProfile: opts.userProfile,
            group: opts.group,
            assistant: a,
            allAssistants: opts.assistants,
            groupHasNsfw
        });
        results.push({ assistant: a, reply });
        // aggiungiamo la risposta al contesto per l'assistente successivo
        rollingHistory = [...rollingHistory, { role: "assistant", parts: [{ type: "text", text: reply }] }];
    }
    return results;
}
