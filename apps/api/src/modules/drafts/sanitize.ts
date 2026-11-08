import sanitizeHtml from 'sanitize-html';

/**
 * Draft HTML comes from the browser and is shown again in the editor and in exports, so it is
 * reduced to the structure the editor produces (TipTap StarterKit): no scripts, styles, event
 * handlers, iframes or links with javascript: URLs. Anything else is dropped, keeping its text.
 */
export const DRAFT_HTML_MAX_BYTES = 1024 * 1024;

const ALLOWED_TAGS = ['h1', 'h2', 'h3', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li'];

export function sanitizeDraftHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { ol: ['start'] },
    allowedSchemes: [],
    disallowedTagsMode: 'discard',
    // Text inside script/style is dropped entirely, not kept as text.
    nonTextTags: ['script', 'style', 'textarea', 'noscript', 'iframe', 'object'],
  });
}
