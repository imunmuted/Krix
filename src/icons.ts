// Embedded icon assets for Krix MCP Gateway
// Provides both HTTPS URL generators and embedded Base64 Data URIs for universal compatibility across MCP clients.

export interface McpIcon {
  src: string;
  url?: string;
  mimeType: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

export const ICON_48_DATA_URI = "data:image/png;base64,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";
export const ICON_24_DATA_URI = "data:image/png;base64,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";

export const ICON_48_BUFFER = Buffer.from(ICON_48_DATA_URI.split(",")[1], "base64");
export const ICON_24_BUFFER = Buffer.from(ICON_24_DATA_URI.split(",")[1], "base64");
export const GITHUB_RAW_BASE_URL = "https://raw.githubusercontent.com/imunmuted/Krix/gem/assets";
export const GITHUB_ICON_48_URL = `${GITHUB_RAW_BASE_URL}/icon-48.png`;
export const GITHUB_ICON_128_URL = `${GITHUB_RAW_BASE_URL}/icon-128.png`;
export const GITHUB_LOGO_URL = `${GITHUB_RAW_BASE_URL}/logo.png`;
export const GITHUB_ICON_24_URL = `${GITHUB_RAW_BASE_URL}/icon-24.png`;

export const RENDER_PUBLIC_URL = "https://krix.onrender.com";
export const RENDER_ICON_48_URL = `${RENDER_PUBLIC_URL}/icon-48.png`;
export const RENDER_ICON_128_URL = `${RENDER_PUBLIC_URL}/icon-128.png`;
export const RENDER_LOGO_URL = `${RENDER_PUBLIC_URL}/logo.png`;
export const RENDER_ICON_24_URL = `${RENDER_PUBLIC_URL}/icon-24.png`;

export const DEFAULT_PUBLIC_URL = GITHUB_RAW_BASE_URL;

export function getServerIcons(baseUrl: string = DEFAULT_PUBLIC_URL): McpIcon[] {
  const base = baseUrl ? baseUrl.replace(/\/+$/, "") : GITHUB_RAW_BASE_URL;

  const icons: McpIcon[] = [
    // 1. High-availability public raw GitHub HTTPS URLs (HTTP 200, CORS *, max-age 300)
    {
      src: GITHUB_ICON_48_URL,
      url: GITHUB_ICON_48_URL,
      mimeType: "image/png",
      sizes: ["48x48"],
      theme: "light"
    },
    {
      src: GITHUB_ICON_48_URL,
      url: GITHUB_ICON_48_URL,
      mimeType: "image/png",
      sizes: ["48x48"],
      theme: "dark"
    },
    // 2. Active Render web service HTTPS endpoints (HTTP 200, immutable cache)
    {
      src: RENDER_ICON_48_URL,
      url: RENDER_ICON_48_URL,
      mimeType: "image/png",
      sizes: ["48x48"],
      theme: "light"
    },
    {
      src: RENDER_ICON_48_URL,
      url: RENDER_ICON_48_URL,
      mimeType: "image/png",
      sizes: ["48x48"],
      theme: "dark"
    },
    // 3. Higher resolution assets
    {
      src: GITHUB_ICON_128_URL,
      url: GITHUB_ICON_128_URL,
      mimeType: "image/png",
      sizes: ["128x128"]
    },
    {
      src: RENDER_ICON_128_URL,
      url: RENDER_ICON_128_URL,
      mimeType: "image/png",
      sizes: ["128x128"]
    },
    {
      src: GITHUB_LOGO_URL,
      url: GITHUB_LOGO_URL,
      mimeType: "image/png",
      sizes: ["320x320"]
    },
    {
      src: RENDER_LOGO_URL,
      url: RENDER_LOGO_URL,
      mimeType: "image/png",
      sizes: ["320x320"]
    }
  ];

  // Clients (e.g. Gemini) only trust icons hosted on the server's own origin, so when the server is
  // reached through its own host, advertise those first and keep the GitHub copies as fallbacks.
  if (base && !base.includes("raw.githubusercontent.com") && !base.includes("krix-gateway.onrender.com")) {
    const own: McpIcon[] = [
      { src: `${base}/icon-48.png`, url: `${base}/icon-48.png`, mimeType: "image/png", sizes: ["48x48"], theme: "light" },
      { src: `${base}/icon-48.png`, url: `${base}/icon-48.png`, mimeType: "image/png", sizes: ["48x48"], theme: "dark" },
      { src: `${base}/icon-128.png`, url: `${base}/icon-128.png`, mimeType: "image/png", sizes: ["128x128"] },
      { src: `${base}/logo.png`, url: `${base}/logo.png`, mimeType: "image/png", sizes: ["320x320"] }
    ];
    const seen = new Set<string>();
    return [...own, ...icons].filter((i) => {
      const key = `${i.src}|${i.theme ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return icons;
}

export const SERVER_ICONS: McpIcon[] = getServerIcons();

