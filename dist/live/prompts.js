function normalizeSpaces(s) {
    return String(s ?? "").replace(/\s+/g, " ").trim();
}
export function buildAssistantLiveSystemPrompt(opts) {
    const mem = normalizeSpaces(opts.assistantMemory || "");
    const recall = (opts.recallText || "").trim();
    const sum = normalizeSpaces(opts.conversationSummary || "");
    return [
        `Sei "${opts.assistant.name} ${opts.assistant.surname}".`,
        `Sei in una sessione VOCALE (Live) di KNGLife.`,
        `Regole:`,
        `- Parla in italiano.`,
        `- Risposte concise, naturali, utili.`,
        `- Coerenza con relazione/età/genere e profilo assistente.`,
        `- Non fare l'assistente “vuoto”: se non capisci chiedi chiarimenti.`,
        ``,
        `MEMORIA A LUNGO TERMINE (assistente):`,
        mem || "(vuota)",
        ``,
        `RIASSUNTO CONVERSAZIONE CORRENTE:`,
        sum || "(vuoto)",
        ``,
        `RICHIAMI DA CONVERSAZIONI PRECEDENTI (se utili):`,
        recall || "(nessuno)",
        ``,
        `Profili (JSON):`,
        JSON.stringify({ user: opts.user, assistant: opts.assistant })
    ].join("\n");
}
export function buildInterviewLiveSystemPrompt(opts) {
    return [
        `Sei un'intervistatrice per l'onboarding di KNGLife.`,
        `Obiettivo: fare domande una alla volta, raccogliere info utili per costruire un profilo.`,
        `Regole:`,
        `- Italiano`,
        `- Una domanda per volta`,
        `- Se l'utente risponde in modo vago, chiedi chiarimenti`,
        `- Mantieni il ritmo: breve, chiaro, accessibile`,
        `- NSFW consentito per l'intervista: ${opts.interviewNsfwEnabled ? "SI" : "NO"}`,
        `- Allow explicit (safety): ${opts.allowExplicit ? "SI" : "NO"}`,
        ``,
        `Profilo utente (JSON):`,
        JSON.stringify(opts.user)
    ].join("\n");
}
