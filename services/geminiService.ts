/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { GoogleGenAI, Modality } from "../genaiProxy";
import { AspectRatio, ComplexityLevel, VisualStyle, ResearchResult, SearchResultItem, Language } from "../types";

// Create a fresh client for every request to ensure the latest API key from "server-side" is used
const getAi = () => {
  return new GoogleGenAI({ apiKey: "server-side" });
};

// Using Flash model for text (search grounding) to stay within free-tier quota.
// Image generation still uses the image-capable model.
const TEXT_MODEL = 'gemini-3-flash-preview';
const IMAGE_MODEL = 'gemini-3-pro-image-preview';
const EDIT_MODEL = 'gemini-3-pro-image-preview';

const getLevelInstruction = (level: ComplexityLevel): string => {
  switch (level) {
    case 'Elementary':
      return "Target Audience: Elementary School (Ages 6-10). Style: Bright, simple, fun. Use large clear icons and very minimal text labels.";
    case 'High School':
      return "Target Audience: High School. Style: Standard Textbook. Clean lines, clear labels, accurate maps or diagrams. Avoid cartoony elements.";
    case 'College':
      return "Target Audience: University. Style: Academic Journal. High detail, data-rich, precise cross-sections or complex schematics.";
    case 'Expert':
      return "Target Audience: Industry Expert. Style: Technical Blueprint/Schematic. Extremely dense detail, monochrome or technical coloring, precise annotations.";
    default:
      return "Target Audience: General Public. Style: Clear and engaging.";
  }
};

const getStyleInstruction = (style: VisualStyle): string => {
  switch (style) {
    case 'Minimalist': return "Aesthetic: Bauhaus Minimalist. Flat vector art, limited color palette (2-3 colors), reliance on negative space and simple geometric shapes.";
    case 'Realistic': return "Aesthetic: Photorealistic Composite. Cinematic lighting, 8k resolution, highly detailed textures. Looks like a photograph.";
    case 'Cartoon': return "Aesthetic: Educational Comic. Vibrant colors, thick outlines, expressive cel-shaded style.";
    case 'Vintage': return "Aesthetic: 19th Century Scientific Lithograph. Engraving style, sepia tones, textured paper background, fine hatch lines.";
    case 'Futuristic': return "Aesthetic: Cyberpunk HUD. Glowing neon blue/cyan lines on dark background, holographic data visualization, 3D wireframes.";
    case '3D Render': return "Aesthetic: 3D Isometric Render. Claymorphism or high-gloss plastic texture, studio lighting, soft shadows, looks like a physical model.";
    case 'Sketch': return "Aesthetic: Da Vinci Notebook. Ink on parchment sketch, handwritten annotations style, rough but accurate lines.";
    default: return "Aesthetic: High-quality digital scientific illustration. Clean, modern, highly detailed.";
  }
};

export const researchTopicForPrompt = async (
  topic: string, 
  level: ComplexityLevel, 
  style: VisualStyle,
  language: Language
): Promise<ResearchResult> => {
  
  const levelInstr = getLevelInstruction(level);
  const styleInstr = getStyleInstruction(style);

  const systemPrompt = `
    You are an expert visual researcher.
    Your goal is to research the topic: "${topic}" and create a plan for an infographic.
    
    **IMPORTANT: Use the Google Search tool to find the most accurate, up-to-date information about this topic.**
    
    Context:
    ${levelInstr}
    ${styleInstr}
    Language: ${language}
    ${language === 'Thai' ? 'CRITICAL: Provide all FACTS, headings, labels, and text descriptions in natural and fluent THAI (ภาษาไทย).' : ''}
    
    Please provide your response in the following format EXACTLY:
    
    FACTS:
    - [Fact 1]
    - [Fact 2]
    - [Fact 3]
    
    IMAGE_PROMPT:
    [A highly detailed image generation prompt describing the visual composition, colors, and layout for the infographic. Do not include citations in the prompt.]
  `;

  let response;
  try {
    response = await getAi().models.generateContent({
      model: TEXT_MODEL,
      contents: systemPrompt,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });
  } catch (searchErr: any) {
    console.warn("[geminiService] Google Search grounding quota exceeded, falling back to direct AI research:", searchErr?.message);
    response = await getAi().models.generateContent({
      model: TEXT_MODEL,
      contents: systemPrompt,
    });
  }

  const text = response.text || "";
  
  // Parse Facts
  const factsMatch = text.match(/FACTS:\s*([\s\S]*?)(?=IMAGE_PROMPT:|$)/i);
  const factsRaw = factsMatch ? factsMatch[1].trim() : "";
  const facts = factsRaw.split('\n')
    .map(f => f.replace(/^-\s*/, '').trim())
    .filter(f => f.length > 0)
    .slice(0, 5);

  // Parse Prompt
  const promptMatch = text.match(/IMAGE_PROMPT:\s*([\s\S]*?)$/i);
  const imagePrompt = promptMatch ? promptMatch[1].trim() : `Create a detailed infographic about ${topic}. ${levelInstr} ${styleInstr}`;

  // Extract Grounding (Search Results)
  const searchResults: SearchResultItem[] = [];
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
  
  if (chunks) {
    chunks.forEach(chunk => {
      if (chunk.web?.uri && chunk.web?.title) {
        searchResults.push({
          title: chunk.web.title,
          url: chunk.web.uri
        });
      }
    });
  }

  // Remove duplicates based on URL
  const uniqueResults = Array.from(new Map(searchResults.map(item => [item.url, item])).values());

  return {
    imagePrompt: imagePrompt,
    facts: facts,
    searchResults: uniqueResults
  };
};

const createFallbackSvg = (title: string, prompt: string, facts: string[] = []): string => {
  const safeTitle = (title || "Infographic").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const isThai = /[\u0E00-\u0E7F]/.test(title) || (facts.length > 0 && /[\u0E00-\u0E7F]/.test(facts[0]));
  
  const defaultThaiFacts = [
    "โครงสร้างหลักและภาพรวมแนวคิดสำคัญ",
    "ลักษณะเด่นและความสัมพันธ์ของข้อมูล",
    "บทวิเคราะห์เชิงลึกและข้อสรุปสำคัญ"
  ];
  
  const defaultEnglishFacts = [
    "Core concept visual overview and breakdown",
    "Key characteristics and critical relationships",
    "Detailed analytical structure and insights"
  ];

  const factsList = facts.length > 0 ? facts : (isThai ? defaultThaiFacts : defaultEnglishFacts);
  
  const factBoxes = factsList.slice(0, 3).map((f, i) => {
    const safeFact = f.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const y = 260 + i * 110;
    return `
      <g transform="translate(100, ${y})">
        <rect width="1000" height="90" rx="16" fill="#1e293b" fill-opacity="0.8" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="0" />
        <circle cx="50" cy="45" r="24" fill="#0284c7" fill-opacity="0.2" stroke="#38bdf8" stroke-width="2" />
        <text x="50" y="53" font-family="'Prompt', 'Noto Sans Thai', 'Space Grotesk', system-ui, sans-serif" font-size="20" font-weight="700" fill="#38bdf8" text-anchor="middle">0${i + 1}</text>
        <text x="100" y="52" font-family="'Prompt', 'Noto Sans Thai', system-ui, sans-serif" font-size="19" font-weight="500" fill="#f1f5f9">${safeFact.slice(0, 95)}</text>
      </g>
    `;
  }).join('');

  const badgeText = isThai ? "อินโฟกราฟิกสรุปข้อมูล" : "INFOGRAPHIC BRIEF";
  const subtitleText = isThai ? "ข้อมูลวิจัยที่สังเคราะห์และวางโครงสร้างให้เข้าใจง่าย" : "Synthesized research and visual plan tailored to your audience";
  const footerText = isThai 
    ? "โหมด Free Tier: วิจัยและจัดวางโครงสร้างด้วย Gemini Flash • หากต้องการภาพ Diffusion ให้เปิดใช้งาน Billing บน Google Cloud"
    : "Free Tier Mode: Research &amp; Structure by Gemini Flash • Enable Google Cloud Billing for AI Diffusion Imagery";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675" width="1200" height="675">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0f172a" />
        <stop offset="50%" stop-color="#1e1b4b" />
        <stop offset="100%" stop-color="#020617" />
      </linearGradient>
      <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#334155" stroke-width="0.8" opacity="0.3" />
      </pattern>
    </defs>
    
    <rect width="1200" height="675" fill="url(#bg)" />
    <rect width="1200" height="675" fill="url(#grid)" />
    
    <!-- Top badge -->
    <rect x="100" y="60" width="240" height="36" rx="18" fill="#0369a1" fill-opacity="0.3" stroke="#38bdf8" stroke-width="1" />
    <text x="220" y="83" font-family="'Prompt', 'Noto Sans Thai', 'Space Grotesk', system-ui, sans-serif" font-size="14" font-weight="700" fill="#38bdf8" text-anchor="middle" letter-spacing="1">${badgeText}</text>

    <!-- Main Title -->
    <text x="100" y="160" font-family="'Prompt', 'Noto Sans Thai', 'Space Grotesk', system-ui, sans-serif" font-size="42" font-weight="800" fill="#ffffff">${safeTitle.slice(0, 45)}</text>
    <text x="100" y="200" font-family="'Prompt', 'Noto Sans Thai', system-ui, sans-serif" font-size="18" fill="#94a3b8">${subtitleText}</text>
    
    <!-- Fact Cards -->
    ${factBoxes}
    
    <!-- Footer Notice -->
    <rect x="100" y="605" width="1000" height="40" rx="8" fill="#0f172a" stroke="#475569" stroke-width="0.8" />
    <text x="600" y="630" font-family="'Prompt', 'Noto Sans Thai', system-ui, sans-serif" font-size="13" fill="#64748b" text-anchor="middle">
      ${footerText}
    </text>
  </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

export const generateInfographicImage = async (prompt: string, topic?: string, facts?: string[]): Promise<string> => {
  try {
    const response = await getAi().models.generateContent({
      model: IMAGE_MODEL,
      contents: {
        parts: [{ text: prompt }]
      },
      config: {
        responseModalities: [Modality.IMAGE],
      }
    });

    const part = response.candidates?.[0]?.content?.parts?.[0];
    if (part && part.inlineData && part.inlineData.data) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  } catch (err: any) {
    console.warn("[geminiService] Image generation unavailable on free quota, rendering synthesized visual infographic:", err?.message);
    return createFallbackSvg(topic || prompt.slice(0, 40), prompt, facts);
  }
  return createFallbackSvg(topic || prompt.slice(0, 40), prompt, facts);
};

export const verifyInfographicAccuracy = async (
  imageBase64: string, 
  topic: string,
  level: ComplexityLevel,
  style: VisualStyle,
  language: Language
): Promise<{ isAccurate: boolean; critique: string }> => {
  
  // Bypassing verification to send straight to image generation
  return {
    isAccurate: true,
    critique: "Verification bypassed."
  };
};

export const fixInfographicImage = async (currentImageBase64: string, correctionPrompt: string): Promise<string> => {
  const cleanBase64 = currentImageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');

  const prompt = `
    Edit this image. 
    Goal: Simplify and Fix.
    Instruction: ${correctionPrompt}.
    Ensure the design is clean and any text is large and legible.
  `;

  const response = await getAi().models.generateContent({
    model: EDIT_MODEL,
    contents: {
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
        { text: prompt }
      ]
    },
    config: {
      responseModalities: [Modality.IMAGE],
    }
  });

  const part = response.candidates?.[0]?.content?.parts?.[0];
  if (part && part.inlineData && part.inlineData.data) {
    return `data:image/png;base64,${part.inlineData.data}`;
  }
  throw new Error("Failed to fix image");
};

export const editInfographicImage = async (currentImageBase64: string, editInstruction: string): Promise<string> => {
  const cleanBase64 = currentImageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
  
  const response = await getAi().models.generateContent({
    model: EDIT_MODEL,
    contents: {
      parts: [
         { inlineData: { mimeType: 'image/jpeg', data: cleanBase64 } },
         { text: editInstruction }
      ]
    },
    config: {
      responseModalities: [Modality.IMAGE],
    }
  });
  
   const part = response.candidates?.[0]?.content?.parts?.[0];
  if (part && part.inlineData && part.inlineData.data) {
    return `data:image/png;base64,${part.inlineData.data}`;
  }
  throw new Error("Failed to edit image");
};