// ==========================================
// 0. TAB NAVIGATION LOGIC
// ==========================================
function switchTab(tabId, clickedBtn) {
    const contents = document.querySelectorAll('.tab-content');
    contents.forEach(content => content.classList.remove('active-tab'));
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(btn => btn.classList.remove('active'));
    document.getElementById(tabId).classList.add('active-tab');
    clickedBtn.classList.add('active');
}

// ==========================================
// 1. INITIALIZE LIVE WEBCAM & FILE UPLOAD
// ==========================================
const videoElement = document.createElement('video');
videoElement.autoplay = true;
videoElement.playsInline = true;
videoElement.style.width = "100%";
videoElement.style.height = "100%";
videoElement.style.objectFit = "cover";
videoElement.style.borderRadius = "6px";

const cameraFeedDiv = document.getElementById("camera-feed");
const uploadedImgElement = document.getElementById("uploaded-image");
let uploadedBase64 = null; // Variable to store uploaded image data

cameraFeedDiv.appendChild(videoElement);

// Start webcam
navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
    .then(stream => {
        videoElement.srcObject = stream;
    })
    .catch(err => {
        console.error("Camera error:", err);
    });

// Handle File Upload
document.getElementById('file-upload').addEventListener('change', function(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            // Hide live video, show uploaded image
            videoElement.classList.add("hidden");
            uploadedImgElement.src = e.target.result;
            uploadedImgElement.classList.remove("hidden");
            
            // Extract the base64 string (remove the data:image/jpeg;base64, prefix)
            uploadedBase64 = e.target.result.split(',')[1];
        };
        reader.readAsDataURL(file);
    }
});

// ==========================================
// 2. UNIVERSAL WASTE CLASSIFICATION HELPERS
// ==========================================
const GRADE_META = {
    "Grade A": { className: "grade-a" },
    "Grade B": { className: "grade-b" },
    "Grade C": { className: "grade-c" }
};

// ==========================================
// 3. REAL GEMINI VISION API INTEGRATION
// ==========================================
const GEMINI_API_KEYS = [
    "AIzaSyBTBfW5qK2aN5biJ_qBl69ioO3pCiFnG48",
    "AIzaSyBLQCCnc7zBdfcXd5wfATRCD8XBTFW5N8A",
    "AIzaSyD5y7i96mIIq74WGzWZeSrBcVlypqcrXMU",
    "AIzaSyD-Z1nF0JQPiwiEqpzUZF34xyQ_pKxyzXw"
];
const GEMINI_MODELS_TO_TRY = [
    window.GEMINI_MODEL,
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.5-flash"
].filter((model, index, arr) => model && arr.indexOf(model) === index);

function getActiveGeminiApiKeys() {
    const runtimeKeys = Array.isArray(window.GEMINI_API_KEYS)
        ? window.GEMINI_API_KEYS
        : [];
    const runtimeSingle = window.GEMINI_API_KEY ? [window.GEMINI_API_KEY] : [];

    const allKeys = [...runtimeKeys, ...runtimeSingle, ...GEMINI_API_KEYS]
        .map(key => String(key || "").trim())
        .filter(key =>
            key &&
            !/^(YOUR_API_KEY_HERE|PASTE_SECOND_KEY_HERE|PASTE_THIRD_KEY_HERE|PASTE_FOURTH_KEY_HERE)$/i.test(key)
        );

    return allKeys.filter((key, index, arr) => arr.indexOf(key) === index);
}

function normalizeGrade(rawGrade) {
    const clean = String(rawGrade || "").trim().toUpperCase();
    if (/^(GRADE\s*)?A\b/.test(clean)) return "Grade A";
    if (/^(GRADE\s*)?B\b/.test(clean)) return "Grade B";
    if (/^(GRADE\s*)?C\b/.test(clean)) return "Grade C";
    if (/HIGH|REFURBISH|RESELL/.test(clean)) return "Grade A";
    if (/MEDIUM|MODERATE|RECOVERABLE/.test(clean)) return "Grade B";
    return "Grade C";
}

function normalizeReusability(rawReusability) {
    const clean = String(rawReusability || "").trim().toLowerCase();
    if (/high/.test(clean)) return "High";
    if (/medium|moderate/.test(clean)) return "Medium";
    if (/low/.test(clean)) return "Low";
    if (/not/.test(clean)) return "Not Recommended";
    return "Medium";
}

function stripCodeFences(rawText) {
    const text = String(rawText || "").trim();
    return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function parseGeminiWasteAnalysis(rawText) {
    const cleanText = stripCodeFences(rawText);
    if (!cleanText) {
        throw new Error("Gemini returned an empty response.");
    }

    let parsed;
    try {
        parsed = JSON.parse(cleanText);
    } catch (error) {
        throw new Error("Model response was not valid JSON.");
    }

    const outputs = Array.isArray(parsed.reusable_outputs)
        ? parsed.reusable_outputs.map(item => String(item).trim()).filter(Boolean).slice(0, 5)
        : [];

    const confidenceNumber = Number(parsed.confidence);
    const confidence = Number.isFinite(confidenceNumber)
        ? Math.max(0, Math.min(100, Math.round(confidenceNumber)))
        : null;

    return {
        wasteName: String(parsed.waste_name || parsed.material || "Unidentified Waste").trim(),
        wasteStream: String(parsed.waste_stream || parsed.category || "mixed").trim(),
        grade: normalizeGrade(parsed.grade),
        reusability: normalizeReusability(parsed.reusability),
        reusableOutputs: outputs,
        processingRoute: String(parsed.processing_route || parsed.recommended_action || "Manual sorting and specialized recycling").trim(),
        reason: String(parsed.reason || parsed.rationale || "").trim(),
        confidence
    };
}

function isQuotaError(message) {
    return /quota|resource_exhausted|429|rate limit|limit exceeded/i.test(String(message || ""));
}

function isModelUnavailableError(message) {
    return /not found|not supported/i.test(String(message || ""));
}

function shouldRotateApiKey(message, statusCode) {
    const msg = String(message || "");
    if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
        return true;
    }
    return /quota|resource_exhausted|rate limit|api key|permission|forbidden|billing|unauthorized/i.test(msg);
}

function maskKey(key) {
    const value = String(key || "");
    if (value.length <= 8) return value;
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function getUserFriendlyError(message) {
    const cleanMessage = String(message || "");
    if (/all gemini api keys failed/i.test(cleanMessage)) {
        return cleanMessage;
    }
    if (isQuotaError(cleanMessage)) {
        return "Usage limit reached for your Gemini API key/project. Wait for quota reset or increase quota/billing in Google AI Studio/Google Cloud.";
    }
    return cleanMessage || "Unknown API error";
}

async function callGeminiWithFallback(apiKeys, requestBody) {
    if (!apiKeys.length) {
        throw new Error("No Gemini API keys configured.");
    }

    const keyFailures = [];

    for (let keyIndex = 0; keyIndex < apiKeys.length; keyIndex += 1) {
        const apiKey = apiKeys[keyIndex];
        let lastErrorForKey = null;

        for (const model of GEMINI_MODELS_TO_TRY) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": apiKey
                },
                body: JSON.stringify(requestBody)
            });

            let data = {};
            try {
                data = await response.json();
            } catch (jsonError) {
                data = {};
            }

            if (response.ok) {
                return { data, model, keyIndex };
            }

            const message = data?.error?.message || `Gemini API request failed (${response.status})`;
            lastErrorForKey = new Error(`${model}: ${message}`);

            if (isModelUnavailableError(message)) {
                continue;
            }

            if (shouldRotateApiKey(message, response.status)) {
                break;
            }

            // Unknown non-model error: move to next key as fallback.
            break;
        }

        if (lastErrorForKey) {
            keyFailures.push(`Key ${keyIndex + 1} (${maskKey(apiKey)}): ${lastErrorForKey.message}`);
        }
    }

    const summary = keyFailures.length ? keyFailures.join(" | ") : "No compatible model/key combination found.";
    throw new Error(`All Gemini API keys failed. ${summary}`);
}

function captureCompressedFrameBase64() {
    if (!videoElement.videoWidth || !videoElement.videoHeight) {
        throw new Error("Camera is not ready. Wait for preview, then scan again.");
    }

    const maxDimension = 1024;
    const srcWidth = videoElement.videoWidth;
    const srcHeight = videoElement.videoHeight;
    const scale = Math.min(1, maxDimension / Math.max(srcWidth, srcHeight));
    const targetWidth = Math.max(1, Math.round(srcWidth * scale));
    const targetHeight = Math.max(1, Math.round(srcHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0, targetWidth, targetHeight);

    // Lower quality to reduce payload and quota pressure.
    return canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
}

async function handleScan() {
    const btn = document.getElementById("scanBtn");
    btn.innerText = "Analyzing via Gemini AI...";
    btn.disabled = true;

    try {
        const apiKeys = getActiveGeminiApiKeys();
        if (!apiKeys.length) {
            throw new Error("Gemini API key is missing. Set GEMINI_API_KEYS (up to 4 keys) in app.js or window.GEMINI_API_KEYS.");
        }

        let base64Image;

        // Determine if we are scanning a file upload or the live webcam
        if (uploadedBase64) {
            base64Image = uploadedBase64;
        } else {
            base64Image = captureCompressedFrameBase64();
        }

        const promptText = [
            "You are a waste intelligence classifier.",
            "Analyze the dominant waste in this image. This can be electrical/electronic waste or any other material.",
            "Classify into Grade A, Grade B, or Grade C.",
            "Grade A: clean and high reuse value.",
            "Grade B: moderate contamination, reusable after processing.",
            "Grade C: heavily contaminated/hazardous or low reuse value.",
            "Respond with strict JSON only using this schema:",
            "{\"waste_name\":\"string\",\"waste_stream\":\"string\",\"grade\":\"A|B|C\",\"reusability\":\"High|Medium|Low|Not Recommended\",\"reusable_outputs\":[\"string\"],\"processing_route\":\"string\",\"confidence\":0,\"reason\":\"string\"}"
        ].join(" ");

        const requestBody = {
            contents: [{
                parts: [
                    { text: promptText },
                    { inline_data: { mime_type: "image/jpeg", data: base64Image } }
                ]
            }],
            generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.2
            }
        };

        const { data, model, keyIndex } = await callGeminiWithFallback(apiKeys, requestBody);

        const rawAnalysis = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        const wasteAnalysis = parseGeminiWasteAnalysis(rawAnalysis);

        console.log(`Gemini detected (key #${keyIndex + 1}, ${model}):`, wasteAnalysis);
        processIndustrialWaste(wasteAnalysis);

    } catch (error) {
        console.error("Gemini API error:", error);
        alert(`AI scan failed: ${getUserFriendlyError(error.message)}`);
    } finally {
        btn.innerText = "Capture & Analyze";
        btn.disabled = false;
    }
}

// ==========================================
// 4. UI UPDATE LOGIC
// ==========================================
function processIndustrialWaste(analysis) {
    const gradeText = analysis.grade || "Grade C";
    const gradeElement = document.getElementById("out-grade");
    const gradeMeta = GRADE_META[gradeText] || GRADE_META["Grade C"];

    gradeElement.innerText = gradeText;
    gradeElement.classList.remove("grade-a", "grade-b", "grade-c");
    gradeElement.classList.add(gradeMeta.className);

    const confidenceText = analysis.confidence !== null ? ` (${analysis.confidence}% confidence)` : "";
    const objectLine = `${analysis.wasteName} [${analysis.wasteStream}]${confidenceText}`;
    const outputsLine = analysis.reusableOutputs.length
        ? analysis.reusableOutputs.join(", ")
        : "No high-value reusable outputs identified";

    document.getElementById("out-macro").innerText = objectLine;
    document.getElementById("out-micro").innerText = outputsLine;

    const reusabilityElement = document.getElementById("out-reusability");
    if (reusabilityElement) {
        reusabilityElement.innerText = analysis.reusability;
    }

    const routeText = analysis.reason
        ? `${analysis.processingRoute}. ${analysis.reason}`
        : analysis.processingRoute;
    document.getElementById("out-buyer").innerText = routeText;

    generateTraceabilityQR(analysis);
    document.getElementById("certificateUI").classList.remove("hidden");
}

// ==========================================
// 5. QR CODE GENERATION
// ==========================================
function generateTraceabilityQR(analysis) {
    const certificateHash = [
        "ECOLOOP",
        analysis.wasteName,
        analysis.wasteStream,
        analysis.grade,
        `Reusability:${analysis.reusability}`,
        `Outputs:${analysis.reusableOutputs.join("|") || "None"}`,
        `Route:${analysis.processingRoute}`,
        "VERIFIED"
    ].join(" || ");

    new QRious({
        element: document.getElementById('qr-canvas'),
        value: certificateHash,
        size: 140,
        level: 'H'
    });
}

document.getElementById("scanBtn").addEventListener("click", handleScan);
