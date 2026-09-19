// Pluggable video sources — the pipeline only ever sees an HTMLVideoElement, so
// it doesn't care whether frames come from a webcam, a screen-shared WhatsApp
// call (the Meta-glasses path), or a fallback clip.

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

export function startCamera(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId } } : { width: 1280, height: 720 },
    audio: false,
  });
}

// Screen capture — pick the WhatsApp Desktop window showing the glasses feed.
export function startScreen(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
}
