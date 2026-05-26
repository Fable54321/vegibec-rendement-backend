type FacebookPostResponse = {
  id?: string;
  error?: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
};

export async function postMessageToFacebook(message: string) {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const pageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const graphVersion = process.env.FACEBOOK_GRAPH_VERSION || "v25.0";

  if (!pageId || !pageAccessToken) {
    throw new Error("Missing Facebook Page config");
  }

  const response = await fetch(
    `https://graph.facebook.com/${graphVersion}/${pageId}/feed`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        access_token: pageAccessToken,
      }),
    }
  );

  const data = (await response.json()) as FacebookPostResponse;

  if (!response.ok || data.error) {
    console.error("Facebook post failed:", data.error || data);
    throw new Error(data.error?.message || "Failed to create Facebook post");
  }

  return data;
}