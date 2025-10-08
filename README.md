# Static Ad Translation - Figma Plugin

A Figma plugin for extracting text from ad frames, sending it to a translation webhook, and automatically applying translated content back to duplicated frames with preserved styling.

## Features

- **Multi-Language Support**: Select one or more target languages (Spanish, French, German, Italian, Portuguese, Dutch, Polish, Swedish, Lithuanian, Turkish, Norwegian) for simultaneous translation
- **Text Extraction**: Extracts all text nodes from a selected frame with full style information (font family, size, weight, colors, decorations, spacing, line-height)
- **Mixed-Style Support**: Uses `getStyledTextSegments()` to capture character-level styling - handles text with multiple fonts, sizes, colors, and weights within a single text box
- **HTML Export**: Generates styled HTML with inline CSS for each text segment, preserving exact formatting
- **Visual Context Export**: Exports frame as base64-encoded PNG for AI-powered translation with visual context
- **Optimized Payload**: Minimal data structure containing only translation-essential information
- **Webhook Integration**: Posts structured JSON to a translation endpoint for each selected language
- **Translation Memory Review**: Interactive review interface for new translations with:
  - Side-by-side display of original, source, and translated text
  - Real-time node highlighting in the duplicated frame
  - Inline editing with live preview functionality
  - Change detection (Apply button only enabled when edits are made)
- **Automatic Import**: Creates translated frame copies applying all styles from returned HTML (fonts, sizes, colors, spacing)
- **Comprehensive Style Application**: Applies font-family, font-size, font-weight (400/500/600/700/900), colors (rgb/rgba), letter-spacing (em/px/%), line-height (unitless/px/%)
- **Large Payload Handling**: Automatically chunks payloads >5MB into batches

## Workflow

1. **Select Languages**: Choose one or more target languages from the plugin UI (Spanish checked by default)
2. **Export**: Select a frame and click "Export & Translate (X languages)"
3. **Translate**: The plugin sends webhook requests for **all selected languages in parallel** for maximum efficiency
4. **Review New Translations** (if applicable):
   - If the response includes translations marked as `isNew: true`, a review interface appears
   - **Language Progress**: Header shows current language being reviewed (e.g., "ES (1/4)" for Spanish, first of 4 languages)
   - Navigate through new translations using Previous/Next buttons or arrow keys
   - Each translation shows:
     - Node ID
     - Original text (English source)
     - Translated text (editable with reverse button)
   - The corresponding text node is automatically highlighted in the duplicated frame
   - Edit translations as needed
   - **Reverse Button (↶)**: Restore the original translation if accidentally deleted or modified
   - **Apply Changes to Frame**: Click to preview edited translations in the design (button only enabled when changes are made)
     - Applied changes persist through the upload process
   - **Upload All Translations**: Save all reviewed translations to translation memory
   - After upload, automatically loads next language for review
5. **Import**: Receives translated HTML for each language and creates duplicated frames with translations applied
6. **Result**: New frames positioned vertically below original (157px spacing), each named `[original] [lang]` (e.g., "Ad Frame [es]", "Ad Frame [fr]")

## Translation Response Format

The webhook should return:

```json
{
  "frameId": "123:456",
  "version": 1,
  "lang": "es",
  "dir": "ltr",
  "texts": [
    {
      "nodeId": "123:457",
      "characters": "Source text",
      "html": "<span style=\"font-weight:700\">Translated text</span>",
      "isNew": true
    },
    {
      "nodeId": "123:458",
      "characters": "Another text",
      "html": "<span style=\"font-weight:400\">Otro texto</span>",
      "isNew": false
    }
  ]
}
```

**New Fields:**
- `characters` - The original source text (used for review interface)
- `isNew` - Boolean flag indicating if this translation is new and requires review
  - `true` - Shows in review interface, allows editing, uploads to translation memory
  - `false` - Applied directly to frame, bypasses review

## Payload Structure

The plugin sends a minimal, optimized payload containing only translation-essential data:

```json
{
  "meta": {
    "fileKey": "abc123def456",
    "fileName": "Marketing Ads 2025",
    "pageName": "Mobile Ads",
    "exportedAt": "2025-01-15T10:30:00.000Z"
  },
  "frame": {
    "id": "123:456",
    "name": "Ad Frame",
    "image": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  },
  "texts": [
    {
      "nodeId": "123:457",
      "name": "Headline",
      "characters": "Hello bold world",
      "html": "<span style=\"font-family:Inter;font-weight:400;font-size:16px\">Hello </span><span style=\"font-family:Inter;font-weight:600;font-size:16px\">bold</span><span style=\"font-family:Inter;font-weight:400;font-size:16px\"> world</span>"
    }
  ],
  "lang": "es"
}
```

**New Field:**
- `frame.image` - Base64-encoded PNG image of the entire frame (1x scale)
  - Provides visual context to AI for better translation decisions
  - Includes all design elements, layouts, and styling
  - Optional field (omitted if export fails)

## Text Extraction Details

The plugin extracts text with character-level precision using Figma's `getStyledTextSegments()` API:

**For each text node, it generates:**
- **`characters`**: Plain text content
- **`html`**: Styled HTML with inline CSS preserving all formatting

**Supported inline styles in HTML:**
- `font-family` - Font name (e.g., "Inter")
- `font-weight` - Weight mapping: 400 (Regular), 500 (Medium), 600 (Semi Bold), 700 (Bold), 900 (Black)
- `font-style` - Italic detection from font style name
- `font-size` - Size in pixels
- `color` - RGB color values
- `letter-spacing` - Spacing in pixels or percent
- `line-height` - Line height in pixels or percent
- `text-decoration` - Underline or strikethrough

**Example HTML output:**
```html
<span style="font-family:Inter;font-weight:400;font-size:16px;color:rgb(0,0,0)">Hello </span><span style="font-family:Inter;font-weight:600;font-size:16px;color:rgb(0,0,0)">bold</span><span style="font-family:Inter;font-weight:400;font-size:16px;color:rgb(0,0,0)"> world</span>
```

## Supported Languages

The plugin supports translation to the following languages:

- Spanish (es)
- French (fr)
- German (de)
- Italian (it)
- Portuguese (pt)
- Dutch (nl)
- Polish (pl)
- Swedish (sv)
- Lithuanian (lt)
- Turkish (tr)
- Norwegian (no)

## Translation Import - Supported HTML Styles

The plugin applies these CSS properties from the webhook HTML response:

- **`font-family`** - Changes font (e.g., "Inter" → "Roboto")
- **`font-weight`** - Maps to Figma styles:
  - `400` → Regular
  - `500` → Medium
  - `600` → Semi Bold
  - `700` → Bold
  - `900` → Black
- **`font-size`** - Size in pixels (e.g., `32px`)
- **`color`** - `rgb(r,g,b)` or `rgba(r,g,b,a)` with opacity
- **`line-height`** - Unitless (e.g., `1.18`), pixels, or percent
- **`letter-spacing`** - Em units (e.g., `-0.025em`), pixels, or percent
- **`font-style`** - `italic` via `<em>` tags
- **`text-decoration`** - `underline`, `strikethrough`
- **Line breaks** - `<br/>` converted to newlines

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the plugin:
   ```bash
   npm run build
   ```

3. In Figma: **Plugins → Development → Import plugin from manifest**

4. Select [manifest.json](manifest.json)

## Development

- **Build once**: `npm run build`
- **Watch mode**: `npm run watch`
- **Lint**: `npm run lint`

## Translation Memory Upload

After users review and approve new translations, the plugin uploads them to a separate endpoint for storage in the translation memory database.

**Upload Endpoint Format:**

```json
{
  "frame": {
    "id": "1204:147",
    "name": "Ad Frame [es]"
  },
  "body": {
    "texts": [
      {
        "nodeId": "1204:149",
        "characters": "HEALTH-TIME.COM",
        "characters_translated": "HEALTH-TIME.COM"
      },
      {
        "nodeId": "1204:150",
        "characters": "Results may vary",
        "characters_translated": "Los resultados pueden variar"
      }
    ],
    "lang": "es"
  }
}
```

**Fields:**
- `frame.id` - The duplicated frame's Figma node ID
- `frame.name` - The duplicated frame's name (includes language suffix)
- `body.texts` - Array of translations
  - `nodeId` - The text node's Figma ID
  - `characters` - Original English source text
  - `characters_translated` - The translated text
- `body.lang` - Target language code (e.g., "es", "fr", "de")

**Note:** Only translations where `isNew: true` are uploaded to this endpoint.

## Configuration

Update the webhook URLs in [code.ts](code.ts):

```typescript
const WEBHOOK_URL = 'https://your-endpoint.com/webhook';
const UPLOAD_URL = 'https://your-endpoint.com/upload-translations';
```

Then rebuild: `npm run build`

## Requirements

- Figma Desktop or Web
- Node.js 14+
- TypeScript 5.3+
