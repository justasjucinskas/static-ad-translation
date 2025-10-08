// Figma plugin for extracting text with mixed-style ranges and posting to webhook

const WEBHOOK_URL = 'https://n8n.flmng.tools/webhook/7a7db071-5fe1-449e-85c6-4463ffd3de84';
const UPLOAD_URL = 'https://n8n.flmng.tools/webhook/022b465e-e27e-4976-ac01-6ef33425e81c';
const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB
const CHUNK_SIZE = 200; // nodes per chunk

figma.showUI(__html__, { width: 300, height: 470 });

// State management for review workflow
interface ReviewState {
  duplicatedFrames: Map<string, FrameNode>; // lang -> frame
  originalFrames: Map<string, FrameNode>; // lang -> original frame
  pendingReviews: Map<string, ReviewTranslation[]>; // lang -> translations to review
  nodeIdMappings: Map<string, Map<string, TextNode>>; // lang -> (originalNodeId -> duplicateNode)
  languageOrder: string[]; // Ordered list of languages with pending reviews
}

const reviewState: ReviewState = {
  duplicatedFrames: new Map(),
  originalFrames: new Map(),
  pendingReviews: new Map(),
  nodeIdMappings: new Map(),
  languageOrder: [],
};

interface TextNodeData {
  nodeId: string;
  name: string;
  characters: string;
  html: string;
}

interface Payload {
  meta: {
    fileKey: string;
    fileName?: string;
    pageName: string;
    exportedAt: string;
  };
  frame: {
    id: string;
    name: string;
    image?: string;
  };
  texts: TextNodeData[];
  chunk?: { index: number; total: number };
  lang?: string;
}

interface TranslationResponse {
  frameId: string;
  version: number;
  lang: string;
  dir: string;
  texts: Array<{
    nodeId: string;
    characters: string;
    html: string;
    isNew: boolean;
  }>;
}

interface ReviewTranslation {
  nodeId: string;
  charactersOriginal: string;
  characters: string;
  charactersTranslated: string;
  html: string;
  appliedToFrame?: boolean; // Track if changes have been applied
}

interface UploadPayload {
  frame: {
    id: string;
    name: string;
  };
  body: {
    texts: Array<{
      nodeId: string;
      characters: string;
      characters_translated: string;
    }>;
    lang: string;
  };
}

interface ParsedHTMLSegment {
  text: string;
  styles: {
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
    fontSize?: string;
    color?: string;
    textDecoration?: string;
    letterSpacing?: string;
    lineHeight?: string;
  };
}

figma.ui.onmessage = async (msg: {
  type: string;
  languages?: string[];
  nodeId?: string;
  translations?: ReviewTranslation[];
  translation?: ReviewTranslation;
  lang?: string;
}) => {
  if (msg.type === 'export-frame') {
    try {
      // Validate selection
      if (figma.currentPage.selection.length !== 1) {
        figma.notify('⚠️ Please select exactly one frame', { error: true });
        return;
      }

      const selected = figma.currentPage.selection[0];
      if (selected.type !== 'FRAME') {
        figma.notify('⚠️ Selection must be a FRAME', { error: true });
        return;
      }

      const frame = selected as FrameNode;
      const languages = msg.languages || ['es']; // Default to Spanish if not provided

      // Show initial progress notification
      figma.notify('🔄 Processing frame...');

      // Extract data
      const textNodes: TextNodeData[] = [];
      const fontsToLoad = new Set<string>();

      // First pass: collect all fonts
      await collectFonts(frame, fontsToLoad);

      // Load fonts
      for (const fontKey of fontsToLoad) {
        const [family, style] = fontKey.split('::');
        try {
          await figma.loadFontAsync({ family, style });
        } catch (e) {
          console.warn(`Could not load font: ${family} ${style}`);
        }
      }

      // Second pass: extract data
      await extractNodes(frame, textNodes);

      // Export frame as PNG and convert to base64
      figma.notify('📸 Exporting frame image...');
      let frameImageBase64 = '';
      try {
        const imageBytes = await frame.exportAsync({
          format: 'PNG',
          constraint: { type: 'SCALE', value: 1 },
        });
        frameImageBase64 = uint8ArrayToBase64(imageBytes);
        console.log(`Frame image exported: ${frameImageBase64.length} characters`);
      } catch (error) {
        console.warn('Failed to export frame image:', error);
        figma.notify('⚠️ Could not export frame image', { error: false });
      }

      // Build payload
      const fileKey = figma.fileKey || 'unknown';
      const fileName = figma.root.name;
      const pageName = figma.currentPage.name;

      const basePayload: Omit<Payload, 'texts' | 'chunk' | 'lang'> = {
        meta: {
          fileKey,
          fileName,
          pageName,
          exportedAt: new Date().toISOString(),
        },
        frame: {
          id: frame.id,
          name: frame.name,
          image: frameImageBase64 || undefined,
        },
      };

      // Check payload size and chunk if needed
      const testPayload = JSON.stringify({ ...basePayload, texts: textNodes });

      const duplicatedFrames: FrameNode[] = [];

      // Notify user that translations are starting
      const langList = languages.map(l => l.toUpperCase()).join(', ');
      figma.notify(`🔄 Translating to ${langList}...`);

      // Process all languages in parallel
      const translationPromises = languages.map(async (lang, langIndex) => {
        try {
          let translationResponse: TranslationResponse | null = null;

          if (testPayload.length > MAX_PAYLOAD_SIZE) {
            // Chunk the texts
            const chunks: TextNodeData[][] = [];
            for (let i = 0; i < textNodes.length; i += CHUNK_SIZE) {
              chunks.push(textNodes.slice(i, i + CHUNK_SIZE));
            }

            for (let i = 0; i < chunks.length; i++) {
              const payload: Payload = {
                ...basePayload,
                texts: chunks[i],
                chunk: { index: i + 1, total: chunks.length },
                lang,
              };

              const response = await postToWebhook(payload);
              if (i === chunks.length - 1 && response) {
                translationResponse = response;
              }
            }
          } else {
            const payload: Payload = { ...basePayload, texts: textNodes, lang };
            translationResponse = await postToWebhook(payload);
          }

          // Apply translation if received
          if (translationResponse && translationResponse.texts && translationResponse.texts.length > 0) {
            console.log(`Translation response for ${lang}:`, JSON.stringify(translationResponse, null, 2));

            const duplicatedFrame = await applyTranslation(frame, translationResponse, langIndex);

            // Store the duplicated frame for review workflow
            reviewState.duplicatedFrames.set(lang, duplicatedFrame);
            reviewState.originalFrames.set(lang, frame);

            // Check for new translations that need review
            const newTranslations = translationResponse.texts.filter((t) => t.isNew);

            if (newTranslations.length > 0) {
              // Create a map of nodeId -> original text for lookup
              const originalTextMap = new Map<string, string>();
              for (const textNode of textNodes) {
                originalTextMap.set(textNode.nodeId, textNode.characters);
              }

              // Prepare review data
              const reviewData: ReviewTranslation[] = newTranslations.map((t) => ({
                nodeId: t.nodeId,
                charactersOriginal: originalTextMap.get(t.nodeId) || t.characters,
                characters: t.characters,
                charactersTranslated: extractPlainTextFromHTML(t.html),
                html: t.html,
              }));

              reviewState.pendingReviews.set(lang, reviewData);

              // Build node ID mapping for this language
              const originalTextNodes: TextNode[] = [];
              collectTextNodes(frame, originalTextNodes);

              const duplicateTextNodes: TextNode[] = [];
              collectTextNodes(duplicatedFrame, duplicateTextNodes);

              const nodeMapping = new Map<string, TextNode>();
              for (let i = 0; i < originalTextNodes.length; i++) {
                if (i < duplicateTextNodes.length) {
                  nodeMapping.set(originalTextNodes[i].id, duplicateTextNodes[i]);
                }
              }
              reviewState.nodeIdMappings.set(lang, nodeMapping);
            }

            return { lang, duplicatedFrame, success: true };
          } else {
            console.log(`No translation response received for ${lang} or empty texts array`);
            console.log('Response:', translationResponse);
            return { lang, duplicatedFrame: null, success: false };
          }
        } catch (error) {
          console.error(`Error translating ${lang}:`, error);
          return { lang, duplicatedFrame: null, success: false };
        }
      });

      // Wait for all translations to complete
      const results = await Promise.all(translationPromises);

      // Collect successful duplicated frames
      for (const result of results) {
        if (result.success && result.duplicatedFrame) {
          duplicatedFrames.push(result.duplicatedFrame);
        }
      }

      const successCount = results.filter(r => r.success).length;
      if (successCount > 0) {
        figma.notify(`✅ Received ${successCount} translation${successCount === 1 ? '' : 's'}`);
      }

      // Check if there are any reviews pending
      if (reviewState.pendingReviews.size > 0) {
        // Build ordered list of languages for review
        reviewState.languageOrder = Array.from(reviewState.pendingReviews.keys());

        // Switch to review UI
        figma.ui.resize(450, 600);

        // Load the first review
        const firstLang = reviewState.languageOrder[0];
        const firstReview = reviewState.pendingReviews.get(firstLang);

        if (firstReview) {
          // Send review data to UI with language position
          figma.ui.postMessage({
            type: 'load-review',
            translations: firstReview,
            lang: firstLang,
            langIndex: 1,
            totalLangs: reviewState.languageOrder.length,
          });

          figma.notify(`📝 Please review ${reviewState.pendingReviews.size} language${reviewState.pendingReviews.size === 1 ? '' : 's'}`);
        }
      } else {
        // No reviews needed, proceed with normal completion
        if (duplicatedFrames.length > 0) {
          figma.currentPage.selection = duplicatedFrames;
          figma.viewport.scrollAndZoomIntoView(duplicatedFrames);
          const langList = languages.join(', ');
          figma.notify(`✅ Translated to ${languages.length} language${languages.length === 1 ? '' : 's'}: ${langList}`);
        }

        figma.closePlugin();
      }
    } catch (error) {
      figma.notify(`❌ Error: ${error}`, { error: true });
      console.error(error);
    }
  } else if (msg.type === 'highlight-node') {
    // Highlight the node in the current duplicated frame
    if (msg.nodeId) {
      await highlightNodeInFrame(msg.nodeId);
    }
  } else if (msg.type === 'apply-changes') {
    // Apply the edited translation to the duplicated frame
    if (msg.translation && msg.lang) {
      await applyChangesToFrame(msg.translation, msg.lang);
    }
  } else if (msg.type === 'upload-translations') {
    // Upload the finalized translations
    if (msg.translations && msg.lang) {
      await uploadTranslations(msg.translations, msg.lang);
    }
  }
};

async function collectFonts(node: SceneNode, fonts: Set<string>): Promise<void> {
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    const segments = textNode.getStyledTextSegments([
      'fontName',
      'fontSize',
      'fills',
      'textDecoration',
      'letterSpacing',
      'lineHeight',
    ]);

    for (const segment of segments) {
      const fontName = segment.fontName as FontName;
      fonts.add(`${fontName.family}::${fontName.style}`);
    }
  }

  if ('children' in node) {
    for (const child of node.children) {
      await collectFonts(child, fonts);
    }
  }
}

async function extractNodes(
  node: SceneNode,
  textNodes: TextNodeData[]
): Promise<void> {
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    const data = await extractTextNode(textNode);
    textNodes.push(data);
  }

  if ('children' in node) {
    for (const child of node.children) {
      await extractNodes(child, textNodes);
    }
  }
}

async function extractTextNode(textNode: TextNode): Promise<TextNodeData> {
  const characters = textNode.characters;

  // Get styled segments
  const segments = textNode.getStyledTextSegments([
    'fontName',
    'fontSize',
    'fills',
    'textDecoration',
    'letterSpacing',
    'lineHeight',
  ]);

  // Internal interface for building HTML
  interface StyleRun {
    text: string;
    font: { family: string; style: string };
    fontSize: number;
    fill?: { r: number; g: number; b: number };
    textDecoration?: string;
    letterSpacing?: { value: number; unit: string };
    lineHeight?: { value: number; unit: string } | { value: number };
  }

  const htmlParts: string[] = [];
  let lastEnd = 0;

  for (const segment of segments) {
    const fontName = segment.fontName as FontName;
    const fontSize = segment.fontSize as number;
    const fills = segment.fills as readonly Paint[];
    const textDecoration = segment.textDecoration as TextDecoration;
    const letterSpacing = segment.letterSpacing as LetterSpacing;
    const lineHeight = segment.lineHeight as LineHeight;

    const run: StyleRun = {
      text: characters.substring(segment.start, segment.end),
      font: { family: fontName.family, style: fontName.style },
      fontSize,
    };

    // Extract first solid fill color
    const solidFill = fills.find((f) => f.type === 'SOLID') as SolidPaint | undefined;
    if (solidFill && solidFill.visible !== false) {
      run.fill = {
        r: Math.round(solidFill.color.r * 255),
        g: Math.round(solidFill.color.g * 255),
        b: Math.round(solidFill.color.b * 255),
      };
    }

    if (textDecoration !== 'NONE') {
      run.textDecoration = textDecoration;
    }

    if (letterSpacing && 'value' in letterSpacing) {
      run.letterSpacing = { value: letterSpacing.value, unit: letterSpacing.unit };
    }

    if (lineHeight && typeof lineHeight === 'object' && 'value' in lineHeight) {
      if ('unit' in lineHeight) {
        run.lineHeight = { value: (lineHeight as any).value, unit: (lineHeight as any).unit };
      } else {
        run.lineHeight = { value: (lineHeight as any).value };
      }
    }

    // Build HTML
    const style = buildStyleString(run);
    const escapedText = escapeHtml(run.text);
    const htmlText = escapedText.replace(/\n/g, '<br/>');

    // Handle gap if there was text between segments
    if (segment.start > lastEnd) {
      const gapText = characters.substring(lastEnd, segment.start);
      htmlParts.push(escapeHtml(gapText).replace(/\n/g, '<br/>'));
    }

    htmlParts.push(`<span style="${style}">${htmlText}</span>`);
    lastEnd = segment.end;
  }

  // Handle any remaining text after last segment
  if (lastEnd < characters.length) {
    const remainingText = characters.substring(lastEnd);
    htmlParts.push(escapeHtml(remainingText).replace(/\n/g, '<br/>'));
  }

  const html = htmlParts.join('');

  return {
    nodeId: textNode.id,
    name: textNode.name,
    characters,
    html,
  };
}

function buildStyleString(run: {
  font: { family: string; style: string };
  fontSize: number;
  fill?: { r: number; g: number; b: number };
  textDecoration?: string;
  letterSpacing?: { value: number; unit: string };
  lineHeight?: { value: number; unit: string } | { value: number };
}): string {
  const parts: string[] = [];

  parts.push(`font-family:${run.font.family}`);

  // Map font style to weight (check semibold/semi bold BEFORE bold)
  const style = run.font.style.toLowerCase();
  if (style.includes('semibold') || style.includes('semi bold')) {
    parts.push('font-weight:600');
  } else if (style.includes('bold')) {
    parts.push('font-weight:700');
  } else if (style.includes('medium')) {
    parts.push('font-weight:500');
  } else if (style.includes('light')) {
    parts.push('font-weight:300');
  } else if (style.includes('thin')) {
    parts.push('font-weight:100');
  } else if (style.includes('black') || style.includes('heavy')) {
    parts.push('font-weight:900');
  } else {
    parts.push('font-weight:400');
  }

  if (style.includes('italic')) {
    parts.push('font-style:italic');
  }

  parts.push(`font-size:${run.fontSize}px`);

  if (run.fill) {
    parts.push(`color:rgb(${run.fill.r},${run.fill.g},${run.fill.b})`);
  }

  if (run.textDecoration && run.textDecoration !== 'NONE') {
    const decoration = run.textDecoration.toLowerCase().replace('_', '-');
    parts.push(`text-decoration:${decoration}`);
  }

  if (run.letterSpacing && 'value' in run.letterSpacing) {
    const unit = run.letterSpacing.unit === 'PERCENT' ? '%' : 'px';
    parts.push(`letter-spacing:${run.letterSpacing.value}${unit}`);
  }

  if (run.lineHeight && 'value' in run.lineHeight) {
    const lh = run.lineHeight as { value: number; unit?: string };
    if ('unit' in lh && lh.unit) {
      const unit = lh.unit === 'PERCENT' ? '%' : 'px';
      parts.push(`line-height:${lh.value}${unit}`);
    } else {
      parts.push(`line-height:${lh.value}px`);
    }
  }

  return parts.join(';');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sha1Hash(input: string): string {
  // Pure JS SHA-1 implementation for Figma plugin sandbox
  function rotateLeft(n: number, s: number): number {
    return (n << s) | (n >>> (32 - s));
  }

  function toHex(n: number): string {
    let hex = '';
    for (let i = 7; i >= 0; i--) {
      hex += ((n >>> (i * 4)) & 0x0f).toString(16);
    }
    return hex;
  }

  // Convert string to UTF-8 bytes
  const utf8 = unescape(encodeURIComponent(input));
  const msgLen = utf8.length;
  const words: number[] = [];

  for (let i = 0; i < msgLen; i++) {
    words[i >>> 2] |= (utf8.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8);
  }

  // Padding
  words[msgLen >>> 2] |= 0x80 << (24 - (msgLen % 4) * 8);
  words[(((msgLen + 8) >>> 6) << 4) + 15] = msgLen * 8;

  // SHA-1 algorithm
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w: number[] = new Array(80);

  for (let i = 0; i < words.length; i += 16) {
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let j = 0; j < 80; j++) {
      if (j < 16) {
        w[j] = words[i + j] || 0;
      } else {
        w[j] = rotateLeft(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
      }

      let f: number;
      let k: number;

      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rotateLeft(a, 5) + f + e + k + w[j]) & 0xffffffff;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) & 0xffffffff;
    h1 = (h1 + b) & 0xffffffff;
    h2 = (h2 + c) & 0xffffffff;
    h3 = (h3 + d) & 0xffffffff;
    h4 = (h4 + e) & 0xffffffff;
  }

  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
}

async function postToWebhook(payload: Payload): Promise<TranslationResponse | null> {
  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    const preview = text.substring(0, 200);
    throw new Error(`HTTP ${response.status}: ${preview}`);
  }

  try {
    const data = await response.json();
    // Handle both array and single object responses
    if (Array.isArray(data) && data.length > 0) {
      return data[0] as TranslationResponse;
    }
    return data as TranslationResponse;
  } catch (e) {
    // Response might not be JSON, that's okay
    return null;
  }
}

async function applyTranslation(
  originalFrame: FrameNode,
  translation: TranslationResponse,
  langIndex: number
): Promise<FrameNode> {
  // Create a map of original nodeId -> translated HTML
  const translationMap = new Map<string, string>();
  for (const text of translation.texts) {
    translationMap.set(text.nodeId, text.html);
  }

  console.log('Translation node IDs:', Array.from(translationMap.keys()));

  // Duplicate the frame
  const duplicate = originalFrame.clone();
  duplicate.name = `${originalFrame.name} [${translation.lang}]`;
  duplicate.x = originalFrame.x;
  duplicate.y = originalFrame.y + (originalFrame.height + 157) * (langIndex + 1);

  // Collect all text nodes from the original frame to build node ID mapping
  const originalTextNodes: TextNode[] = [];
  collectTextNodes(originalFrame, originalTextNodes);

  // Create a map from original ID to index
  const originalIdToIndex = new Map<string, number>();
  for (let i = 0; i < originalTextNodes.length; i++) {
    originalIdToIndex.set(originalTextNodes[i].id, i);
  }

  // Collect text nodes from duplicate in same order
  const duplicateTextNodes: TextNode[] = [];
  collectTextNodes(duplicate, duplicateTextNodes);

  console.log('Original text node IDs:', originalTextNodes.map(n => n.id));
  console.log('Duplicate text node IDs:', duplicateTextNodes.map(n => n.id));

  // Apply translations by matching original node IDs to duplicate nodes via index
  for (const [originalNodeId, translatedHTML] of translationMap) {
    const index = originalIdToIndex.get(originalNodeId);

    if (index !== undefined && index < duplicateTextNodes.length) {
      const duplicateNode = duplicateTextNodes[index];
      console.log(`Applying translation for original ${originalNodeId} to duplicate ${duplicateNode.id}:`, translatedHTML.substring(0, 50) + '...');
      await applyHTMLToTextNode(duplicateNode, translatedHTML);
    } else {
      console.warn(`Could not find node ${originalNodeId} in original frame`);
    }
  }

  return duplicate;
}

function collectTextNodes(node: SceneNode, textNodes: TextNode[]): void {
  if (node.type === 'TEXT') {
    textNodes.push(node as TextNode);
  }

  if ('children' in node) {
    for (const child of node.children) {
      collectTextNodes(child, textNodes);
    }
  }
}

async function applyHTMLToTextNode(textNode: TextNode, html: string): Promise<void> {
  // Parse HTML and extract segments with styles
  const segments = parseHTML(html);

  console.log('HTML:', html);
  console.log('Segments:', segments);

  // Build new text content
  let newText = '';
  for (const segment of segments) {
    newText += segment.text;
  }

  console.log('New text:', newText);

  // Load the original font to ensure we can modify the text
  const originalFontRaw = textNode.fontName;
  let originalFont: FontName;

  if (originalFontRaw === figma.mixed || typeof originalFontRaw !== 'object') {
    // If mixed, load any font from the first character
    const firstCharFont = textNode.getRangeFontName(0, 1);
    if (firstCharFont !== figma.mixed && typeof firstCharFont === 'object') {
      originalFont = firstCharFont as FontName;
    } else {
      // Fallback to a default font
      originalFont = { family: 'Inter', style: 'Regular' };
    }
  } else {
    originalFont = originalFontRaw as FontName;
  }

  try {
    await figma.loadFontAsync(originalFont);
  } catch (e) {
    console.warn(`Could not load font: ${originalFont.family} ${originalFont.style}`);
  }

  // Set the new text
  textNode.characters = newText;

  // Apply styles to each segment
  let position = 0;
  for (const segment of segments) {
    const start = position;
    const end = position + segment.text.length;

    if (end <= start) {
      position = end;
      continue;
    }

    // Apply font changes (family, weight, style)
    if (segment.styles.fontFamily || segment.styles.fontWeight || segment.styles.fontStyle) {
      // Get current font
      let currentFont = textNode.getRangeFontName(start, end);

      // Handle mixed fonts or invalid fonts - use the original font
      let fontName: FontName;
      if (
        currentFont === figma.mixed ||
        !currentFont ||
        typeof currentFont !== 'object'
      ) {
        fontName = originalFont;
      } else {
        fontName = currentFont as FontName;
      }

      // Use font family from styles if provided, otherwise keep current
      const family = segment.styles.fontFamily || fontName.family;
      const currentStyle = fontName.style;

      // Determine font style based on weight and italic
      const weight = segment.styles.fontWeight;
      const isItalic = segment.styles.fontStyle === 'italic';

      // Determine target font style
      let targetStyle = currentStyle; // Keep current by default

      if (weight === '900' || weight === 'black') {
        targetStyle = isItalic ? 'Black Italic' : 'Black';
      } else if (weight === '700' || weight === 'bold') {
        targetStyle = isItalic ? 'Bold Italic' : 'Bold';
      } else if (weight === '600' || weight === 'semibold') {
        targetStyle = isItalic ? 'Semi Bold Italic' : 'Semi Bold';
      } else if (weight === '500' || weight === 'medium') {
        targetStyle = isItalic ? 'Medium Italic' : 'Medium';
      } else if (weight === '400' || weight === 'normal' || weight === 'regular') {
        targetStyle = isItalic ? 'Italic' : 'Regular';
      } else if (weight === '300' || weight === 'light') {
        targetStyle = isItalic ? 'Light Italic' : 'Light';
      } else if (isItalic) {
        targetStyle = 'Italic';
      }

      // Apply font if family changed or style changed
      if (family !== fontName.family || targetStyle !== currentStyle) {
        try {
          await figma.loadFontAsync({ family, style: targetStyle });
          textNode.setRangeFontName(start, end, { family, style: targetStyle });
          console.log(`Applied font: ${family} ${targetStyle} to range ${start}-${end}`);
        } catch (e) {
          console.warn(`Could not load ${family} ${targetStyle}, trying alternatives`);
          // Font style might not exist, try alternatives based on weight
          const alternatives = isItalic
            ? ['Bold Italic', 'SemiBold Italic', 'Semi Bold Italic', 'Medium Italic', 'Italic', 'Bold', 'SemiBold', 'Semi Bold', 'Medium', 'Regular']
            : ['Bold', 'SemiBold', 'Semi Bold', 'Medium', 'Regular'];

          for (const alt of alternatives) {
            try {
              await figma.loadFontAsync({ family, style: alt });
              textNode.setRangeFontName(start, end, { family, style: alt });
              console.log(`Applied fallback font: ${family} ${alt} to range ${start}-${end}`);
              break;
            } catch (e2) {
              // Continue to next alternative
            }
          }
        }
      }
    }

    // Get font size for this segment (needed for em/unitless conversions)
    let segmentFontSize: number | undefined;
    if (segment.styles.fontSize) {
      const size = parseFloat(segment.styles.fontSize);
      if (!isNaN(size)) {
        textNode.setRangeFontSize(start, end, size);
        segmentFontSize = size;
      }
    } else {
      // Get current font size for conversions
      const currentSize = textNode.getRangeFontSize(start, end);
      if (typeof currentSize === 'number') {
        segmentFontSize = currentSize;
      }
    }

    if (segment.styles.color) {
      const colorData = parseColor(segment.styles.color);
      if (colorData) {
        const { r, g, b, opacity } = colorData;
        const fill: SolidPaint = opacity !== undefined
          ? {
              type: 'SOLID',
              color: { r, g, b },
              opacity,
            }
          : {
              type: 'SOLID',
              color: { r, g, b },
            };
        textNode.setRangeFills(start, end, [fill]);
      }
    }

    if (segment.styles.textDecoration) {
      const decoration = segment.styles.textDecoration.toUpperCase().replace('-', '_');
      if (decoration === 'UNDERLINE' || decoration === 'STRIKETHROUGH') {
        textNode.setRangeTextDecoration(start, end, decoration as TextDecoration);
      }
    }

    if (segment.styles.letterSpacing) {
      const ls = parseLetterSpacing(segment.styles.letterSpacing, segmentFontSize);
      if (ls) {
        textNode.setRangeLetterSpacing(start, end, ls);
      }
    }

    if (segment.styles.lineHeight) {
      const lh = parseLineHeight(segment.styles.lineHeight, segmentFontSize);
      if (lh) {
        textNode.setRangeLineHeight(start, end, lh);
      }
    }

    position = end;
  }
}

function parseHTML(html: string): ParsedHTMLSegment[] {
  const segments: ParsedHTMLSegment[] = [];

  // Replace <br/> with newlines first
  html = html.replace(/<br\s*\/?>/gi, '\n');

  // Process the HTML character by character to handle nested tags properly
  let i = 0;
  let currentText = '';
  let currentStyles: ParsedHTMLSegment['styles'] = {};

  while (i < html.length) {
    // Check for <span> tag
    if (html.substr(i, 5) === '<span') {
      // Save any accumulated text
      if (currentText) {
        segments.push({ text: decodeHTML(currentText), styles: { ...currentStyles } });
        currentText = '';
      }

      // Find the style attribute
      const styleMatch = html.substr(i).match(/<span\s+style="([^"]+)">/);
      if (styleMatch) {
        const newStyles = parseStyleString(styleMatch[1]);
        const tagEnd = i + styleMatch[0].length;

        // Find the closing </span>
        const closeTag = '</span>';
        const closeIndex = html.indexOf(closeTag, tagEnd);

        if (closeIndex !== -1) {
          const innerContent = html.substring(tagEnd, closeIndex);
          // Recursively parse inner content with these styles
          const innerSegments = parseHTMLRecursive(innerContent, newStyles);
          segments.push(...innerSegments);
          i = closeIndex + closeTag.length;
          continue;
        }
      }
    }

    // Check for <em> tag
    if (html.substr(i, 4) === '<em>') {
      // Save any accumulated text
      if (currentText) {
        segments.push({ text: decodeHTML(currentText), styles: { ...currentStyles } });
        currentText = '';
      }

      const closeTag = '</em>';
      const closeIndex = html.indexOf(closeTag, i + 4);

      if (closeIndex !== -1) {
        const innerContent = html.substring(i + 4, closeIndex);
        const emStyles = { ...currentStyles, fontStyle: 'italic' };
        segments.push({ text: decodeHTML(innerContent), styles: emStyles });
        i = closeIndex + closeTag.length;
        continue;
      }
    }

    // Regular character
    currentText += html[i];
    i++;
  }

  // Add any remaining text
  if (currentText) {
    segments.push({ text: decodeHTML(currentText), styles: { ...currentStyles } });
  }

  return segments;
}

function parseHTMLRecursive(html: string, baseStyles: ParsedHTMLSegment['styles']): ParsedHTMLSegment[] {
  const segments: ParsedHTMLSegment[] = [];
  let i = 0;
  let currentText = '';

  while (i < html.length) {
    // Check for <em> tag inside span
    if (html.substr(i, 4) === '<em>') {
      if (currentText) {
        segments.push({ text: decodeHTML(currentText), styles: { ...baseStyles } });
        currentText = '';
      }

      const closeTag = '</em>';
      const closeIndex = html.indexOf(closeTag, i + 4);

      if (closeIndex !== -1) {
        const innerContent = html.substring(i + 4, closeIndex);
        const emStyles = { ...baseStyles, fontStyle: 'italic' };
        segments.push({ text: decodeHTML(innerContent), styles: emStyles });
        i = closeIndex + closeTag.length;
        continue;
      }
    }

    currentText += html[i];
    i++;
  }

  if (currentText) {
    segments.push({ text: decodeHTML(currentText), styles: { ...baseStyles } });
  }

  return segments;
}

function parseStyleString(styleString: string): ParsedHTMLSegment['styles'] {
  const styles: ParsedHTMLSegment['styles'] = {};
  const parts = styleString.split(';');

  for (const part of parts) {
    const colonIndex = part.indexOf(':');
    if (colonIndex === -1) continue;

    const key = part.substring(0, colonIndex).trim();
    const value = part.substring(colonIndex + 1).trim();

    if (!key || !value) continue;

    switch (key) {
      case 'font-family':
        // Remove quotes if present
        styles.fontFamily = value.replace(/^['"]|['"]$/g, '');
        break;
      case 'font-weight':
        styles.fontWeight = value;
        break;
      case 'font-style':
        styles.fontStyle = value;
        break;
      case 'font-size':
        styles.fontSize = value.replace('px', '');
        break;
      case 'color':
        styles.color = value;
        break;
      case 'text-decoration':
        styles.textDecoration = value;
        break;
      case 'letter-spacing':
        styles.letterSpacing = value;
        break;
      case 'line-height':
        styles.lineHeight = value;
        break;
    }
  }

  return styles;
}

function decodeHTML(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseColor(colorStr: string): { r: number; g: number; b: number; opacity?: number } | null {
  // Try rgba first
  const rgbaMatch = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (rgbaMatch) {
    const result = {
      r: parseInt(rgbaMatch[1]) / 255,
      g: parseInt(rgbaMatch[2]) / 255,
      b: parseInt(rgbaMatch[3]) / 255,
    };

    if (rgbaMatch[4]) {
      return { ...result, opacity: parseFloat(rgbaMatch[4]) };
    }

    return result;
  }
  return null;
}

function parseLetterSpacing(lsStr: string, fontSize?: number): LetterSpacing | null {
  if (lsStr.endsWith('%')) {
    return { value: parseFloat(lsStr), unit: 'PERCENT' };
  } else if (lsStr.endsWith('em')) {
    // Convert em to pixels using font size
    const emValue = parseFloat(lsStr);
    if (fontSize) {
      return { value: emValue * fontSize, unit: 'PIXELS' };
    }
    // If no fontSize provided, assume 16px default
    return { value: emValue * 16, unit: 'PIXELS' };
  } else if (lsStr.endsWith('px')) {
    return { value: parseFloat(lsStr), unit: 'PIXELS' };
  }
  return null;
}

function parseLineHeight(lhStr: string, fontSize?: number): LineHeight | null {
  if (lhStr.endsWith('%')) {
    return { value: parseFloat(lhStr), unit: 'PERCENT' };
  } else if (lhStr.endsWith('px')) {
    return { value: parseFloat(lhStr), unit: 'PIXELS' };
  } else {
    // Unitless value (e.g., "1.18") - convert to percentage
    const numValue = parseFloat(lhStr);
    if (!isNaN(numValue) && fontSize) {
      // Figma expects line height in pixels or percent
      // Unitless CSS means multiply by font-size
      return { value: numValue * fontSize, unit: 'PIXELS' };
    } else if (!isNaN(numValue)) {
      // If no fontSize, treat as percentage (multiply by 100)
      return { value: numValue * 100, unit: 'PERCENT' };
    }
  }
  return null;
}

async function highlightNodeInFrame(originalNodeId: string): Promise<void> {
  // Find which language we're currently reviewing
  let currentLang = '';
  for (const [lang, mapping] of reviewState.nodeIdMappings) {
    if (mapping.has(originalNodeId)) {
      currentLang = lang;
      break;
    }
  }

  if (!currentLang) {
    console.warn(`Could not find language for node ${originalNodeId}`);
    return;
  }

  const nodeMapping = reviewState.nodeIdMappings.get(currentLang);
  if (!nodeMapping) return;

  const duplicateNode = nodeMapping.get(originalNodeId);
  if (duplicateNode) {
    figma.currentPage.selection = [duplicateNode];
    figma.viewport.scrollAndZoomIntoView([duplicateNode]);
  } else {
    console.warn(`Could not find duplicate node for ${originalNodeId}`);
  }
}

async function applyChangesToFrame(
  translation: ReviewTranslation,
  lang: string
): Promise<void> {
  try {
    const nodeMapping = reviewState.nodeIdMappings.get(lang);
    if (!nodeMapping) {
      figma.notify('⚠️ Could not find node mapping', { error: true });
      return;
    }

    const duplicateNode = nodeMapping.get(translation.nodeId);
    if (!duplicateNode) {
      figma.notify('⚠️ Could not find text node', { error: true });
      return;
    }

    // Update the HTML to reflect the edited translation
    // Replace the text content in the original HTML while preserving styling
    const updatedHtml = updateHtmlText(translation.html, translation.charactersTranslated);

    // Update the translation object with the new HTML
    translation.html = updatedHtml;
    translation.appliedToFrame = true; // Mark as applied

    // Apply the updated translation to the node
    await applyHTMLToTextNode(duplicateNode, updatedHtml);

    figma.notify('✅ Changes applied to frame');
  } catch (error) {
    figma.notify(`❌ Failed to apply changes: ${error}`, { error: true });
    console.error('Apply changes error:', error);
  }
}

function updateHtmlText(originalHtml: string, newText: string): string {
  // Extract the first span's style attributes if they exist
  const styleMatch = originalHtml.match(/<span[^>]*style="([^"]*)"[^>]*>/);
  const style = styleMatch ? styleMatch[1] : '';

  // Escape the new text for HTML
  const escapedText = escapeHtml(newText);

  // Create updated HTML with preserved styling
  if (style) {
    return `<span style="${style}">${escapedText}</span>`;
  } else {
    return `<span>${escapedText}</span>`;
  }
}

async function uploadTranslations(
  translations: ReviewTranslation[],
  lang: string
): Promise<void> {
  try {
    figma.notify(`📤 Uploading ${translations.length} translation${translations.length === 1 ? '' : 's'} for ${lang.toUpperCase()}...`);

    // Get the duplicated frame for this language
    const duplicateFrame = reviewState.duplicatedFrames.get(lang);
    if (!duplicateFrame) {
      throw new Error('Could not find duplicated frame');
    }

    const payload: UploadPayload = {
      frame: {
        id: duplicateFrame.id,
        name: duplicateFrame.name,
      },
      body: {
        texts: translations.map((t) => ({
          nodeId: t.nodeId,
          characters: t.charactersOriginal,
          characters_translated: t.charactersTranslated,
        })),
        lang: lang,
      },
    };

    const response = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    figma.notify(`✅ Uploaded translations for ${lang.toUpperCase()}`);

    // Don't re-apply translations - they were already applied during initial translation
    // or manually by the user with the "Apply Changes" button

    // Clear review state for this language
    reviewState.pendingReviews.delete(lang);
    reviewState.nodeIdMappings.delete(lang);

    // Check if there are more reviews pending
    const nextLang = Array.from(reviewState.pendingReviews.keys())[0];
    if (nextLang) {
      // Calculate the position of this language in the review order
      const currentIndex = reviewState.languageOrder.indexOf(nextLang);
      const langIndex = currentIndex >= 0 ? currentIndex + 1 : reviewState.languageOrder.length - reviewState.pendingReviews.size + 1;

      // Load next review
      const nextReviews = reviewState.pendingReviews.get(nextLang);
      if (nextReviews) {
        figma.ui.postMessage({
          type: 'load-review',
          translations: nextReviews,
          lang: nextLang,
          langIndex: langIndex,
          totalLangs: reviewState.languageOrder.length,
        });
      }
    } else {
      // All reviews complete, show all duplicated frames and close
      const allFrames = Array.from(reviewState.duplicatedFrames.values());
      if (allFrames.length > 0) {
        figma.currentPage.selection = allFrames;
        figma.viewport.scrollAndZoomIntoView(allFrames);
      }

      // Switch back to main UI
      figma.ui.resize(300, 470);
      figma.ui.show();

      figma.notify(`✅ All translations complete!`);
      figma.closePlugin();
    }
  } catch (error) {
    figma.notify(`❌ Upload failed: ${error}`, { error: true });
    console.error('Upload error:', error);
  }
}

async function applyEditedTranslations(
  duplicateFrame: FrameNode,
  translations: ReviewTranslation[],
  lang: string
): Promise<void> {
  const nodeMapping = reviewState.nodeIdMappings.get(lang);
  if (!nodeMapping) return;

  for (const translation of translations) {
    const duplicateNode = nodeMapping.get(translation.nodeId);
    if (duplicateNode) {
      // Apply the edited translation HTML to the node
      await applyHTMLToTextNode(duplicateNode, translation.html);

      // Update the characters with the translated text
      // Parse the HTML to extract plain text
      const plainText = extractPlainTextFromHTML(translation.html);
      if (plainText !== duplicateNode.characters) {
        // Only update if the text actually changed
        try {
          duplicateNode.characters = plainText;
        } catch (e) {
          console.warn(`Could not update text for node ${translation.nodeId}:`, e);
        }
      }
    }
  }
}

function extractPlainTextFromHTML(html: string): string {
  // Remove HTML tags and decode entities
  let text = html.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHTML(text);
  return text;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const base64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  const len = bytes.length;

  while (i < len) {
    const a = bytes[i++];
    const b = i < len ? bytes[i++] : 0;
    const c = i < len ? bytes[i++] : 0;

    const bitmap = (a << 16) | (b << 8) | c;

    result += base64chars.charAt((bitmap >> 18) & 63);
    result += base64chars.charAt((bitmap >> 12) & 63);
    result += i > len + 1 ? '=' : base64chars.charAt((bitmap >> 6) & 63);
    result += i > len ? '=' : base64chars.charAt(bitmap & 63);
  }

  return result;
}
