import { action } from "./_generated/server";
import { v } from "convex/values";
import { GoogleGenerativeAI } from "@google/generative-ai";
export const processAlert = action({
    args: {
        text: v.string(),
    },
    handler: async (ctx, args) => {
        const apiKey = process.env.GOOGLE_API_KEY;
        if (!apiKey) {
            throw new Error("Missing GOOGLE_API_KEY");
        }
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const systemPrompt = `Você é um analista de inteligência do sistema Grid 48, focado em consciência situacional regional.
Sua tarefa é extrair e estruturar informações críticas do texto de alerta/notícia recebido.
Você DEVE retornar APENAS um objeto JSON estrito com a seguinte estrutura e NADA MAIS:
{
  "title": "Título rápido do alerta",
  "summary": "Resumo direto e objetivo do evento",
  "category": "transito | seguranca | clima | outro (escolha uma adequada)",
  "severity": "baixa | media | alta | critica",
  "coordinates": {
    "lat": -27.5954,
    "lng": -48.5480
  }
}
MUITO IMPORTANTE: Tente deduzir as coordenadas aproximadas (latitude e longitude) se o texto mencionar locais na Grande Florianópolis (como Via Expressa, BR-101, Ponte Pedro Ivo, Ponte Colombo Salles, Estreito, Ipiranga, São José, Palhoça, Biguaçu etc). Caso não seja possível determinar o local exato com segurança, forneça uma coordenada aproximada para a região citada ou para o centro de Florianópolis (-27.5954, -48.5480).`;
        const result = await model.generateContent({
            contents: [
                { role: "user", parts: [{ text: args.text }] }
            ],
            systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
            generationConfig: {
                responseMimeType: "application/json",
            }
        });
        const responseText = result.response.text();
        return JSON.parse(responseText);
    },
});
