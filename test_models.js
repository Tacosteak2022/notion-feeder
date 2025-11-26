const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        // We can't list models directly with the high-level SDK easily in all versions, 
        // but we can try to just run a simple prompt on a few common names to see which one works.

        const candidates = [
            "gemini-1.5-flash",
            "gemini-1.5-flash-001",
            "gemini-1.5-flash-002",
            "gemini-1.5-flash-latest",
            "gemini-1.5-pro",
            "gemini-pro"
        ];

        console.log("Testing model availability...");

        for (const modelName of candidates) {
            try {
                process.stdout.write(`Testing ${modelName}... `);
                const model = genAI.getGenerativeModel({ model: modelName });
                const result = await model.generateContent("Hello");
                console.log(`SUCCESS! Response: ${result.response.text().trim()}`);
                return; // Found one!
            } catch (e) {
                console.log(`FAILED: ${e.message.split('\n')[0]}`);
            }
        }
        console.log("All attempts failed.");

    } catch (e) {
        console.error("Critical Error:", e);
    }
}

listModels();
