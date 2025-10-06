# Static Ad Translation - Figma Plugin

A Figma plugin for extracting text from ad frames, sending it to a translation webhook, and automatically applying translated content back to duplicated frames with preserved styling.

## Features

- **Text Extraction**: Extracts all text nodes from a selected frame with full style information (font family, size, weight, colors, decorations, spacing, line-height)
- **Mixed-Style Support**: Uses `getStyledTextSegments()` to capture character-level styling - handles text with multiple fonts, sizes, colors, and weights within a single text box
- **HTML Export**: Generates styled HTML with inline CSS for each text segment, preserving exact formatting
- **Webhook Integration**: Posts structured JSON to a translation endpoint with both structured `runs` array and `html` string
- **Automatic Import**: Creates translated frame copies applying all styles from returned HTML (fonts, sizes, colors, spacing)
- **Comprehensive Style Application**: Applies font-family, font-size, font-weight (400/500/600/700/900), colors (rgb/rgba), letter-spacing (em/px/%), line-height (unitless/px/%)
- **Large Payload Handling**: Automatically chunks payloads >5MB into batches

## Workflow

1. **Export**: Select a frame and click "Export selected frame → Webhook"
2. **Translate**: The plugin sends text data to the webhook endpoint
3. **Import**: Receives translated HTML and creates a duplicated frame with translations applied
4. **Result**: New frame positioned next to original, named `[original] [lang]`

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
      "html": "<span style=\"font-weight:700\">Translated text</span>"
    }
  ]
}
```

## Text Extraction Details

The plugin extracts text with character-level precision using Figma's `getStyledTextSegments()` API:

**For each styled segment, it captures:**
- Font family & style (e.g., "Inter Semi Bold")
- Font size in pixels
- Text color (RGB)
- Letter spacing (percent or pixels)
- Line height (percent or pixels)
- Text decoration (underline, strikethrough)
- Character range (start/end indices)

**Export format includes:**
1. **`runs` array**: Structured data for each styled segment with exact properties
2. **`html` string**: Styled HTML with inline CSS for easy translation/editing

**Example extraction:**
```json
{
  "characters": "Hello bold world",
  "runs": [
    {"start": 0, "end": 6, "text": "Hello ", "font": {"family": "Inter", "style": "Regular"}, "fontSize": 16},
    {"start": 6, "end": 10, "text": "bold", "font": {"family": "Inter", "style": "Semi Bold"}, "fontSize": 16},
    {"start": 10, "end": 16, "text": " world", "font": {"family": "Inter", "style": "Regular"}, "fontSize": 16}
  ],
  "html": "<span style=\"font-family:Inter;font-weight:400;font-size:16px\">Hello </span><span style=\"font-family:Inter;font-weight:600;font-size:16px\">bold</span><span style=\"font-family:Inter;font-weight:400;font-size:16px\"> world</span>"
}
```

## Supported HTML Styles (Import)

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

## Configuration

Update the webhook URL in [code.ts:3](code.ts#L3):

```typescript
const WEBHOOK_URL = 'https://your-endpoint.com/webhook';
```

Then rebuild: `npm run build`

## Requirements

- Figma Desktop or Web
- Node.js 14+
- TypeScript 5.3+
