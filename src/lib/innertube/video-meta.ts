import { invoke } from "@tauri-apps/api/core";

export type VideoMeta = {
  title: string | null;
  channel: string | null;
  channelId: string | null;
  channelIsVerified: boolean | null;
  categories: string[];
  viewCount: number | null;
  duration: number | null;
};

export type VideoBrief = {
  id: string;
  title: string | null;
  channel: string | null;
};

export async function getVideoMeta(videoId: string): Promise<VideoMeta | null> {
  try {
    return await invoke<VideoMeta>("probe_video_meta", { videoId });
  } catch {
    return null;
  }
}

export async function getVideoBriefs(
  videoIds: string[],
): Promise<Map<string, VideoBrief>> {
  const byId = new Map<string, VideoBrief>();
  if (videoIds.length === 0) return byId;
  try {
    const briefs = await invoke<VideoBrief[]>("probe_video_briefs", { videoIds });
    for (const brief of briefs) {
      if (brief.title || brief.channel) byId.set(brief.id, brief);
    }
  } catch {
    return byId;
  }
  return byId;
}
