// JotDrop Web Clipper — pure transport/protocol helpers.
//
// Plain classic script so both the popup (browser) and the Node regression
// check can load it without a bundler. Exposes a single global object,
// `JotDropProtocol`; in Node it is also exported via CommonJS.

const JotDropProtocol = {
  // Windows/custom-protocol launchers can silently fail on very long URIs;
  // refuse anything longer instead of truncating the user's selection.
  DIRECT_URI_MAX_LENGTH: 1900,

  /**
   * Chooses the transport for a clip: the authenticated localhost server when
   * a token is configured, otherwise the zero-config direct obsidian:// URI.
   */
  pickRoute(settings) {
    return settings && settings.token ? "server" : "direct";
  },

  /**
   * Serializes a clip payload as an obsidian://jotdrop-clip URI.
   * Always includes pinned (true|false); omits empty optional fields.
   */
  buildClipUri(payload) {
    const qs = new URLSearchParams();
    qs.set("url", payload.url);
    if (payload.title) qs.set("title", payload.title);
    if (payload.selection) qs.set("selection", payload.selection);
    if (payload.tags && payload.tags.length) qs.set("tags", payload.tags.join(","));
    if (payload.color && payload.color !== "default") qs.set("color", payload.color);
    qs.set("pinned", payload.pinned ? "true" : "false");
    // URLSearchParams encodes spaces as "+"; Obsidian decodes %20 but leaves a
    // literal "+" untouched, so rewrite every "+" (a real "+" is always %2B)
    // back to "%20".
    const query = qs.toString().replace(/\+/g, "%20");
    return `obsidian://jotdrop-clip?${query}`;
  },

  /**
   * Serializes a clip for the direct route, refusing URIs over the safe
   * length limit rather than silently truncating the selection.
   * Returns { ok: true, uri } or { ok: false, reason: "uri-too-long", length }.
   */
  serializeDirectClip(payload) {
    const uri = JotDropProtocol.buildClipUri(payload);
    if (uri.length > JotDropProtocol.DIRECT_URI_MAX_LENGTH) {
      return { ok: false, reason: "uri-too-long", length: uri.length };
    }
    return { ok: true, uri };
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = JotDropProtocol;
}