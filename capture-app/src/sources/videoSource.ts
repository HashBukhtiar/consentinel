// Pluggable video sources — the pipeline only ever sees an HTMLVideoElement, so
// it doesn't care whether frames come from a webcam, the Meta glasses (via the
// iOS relay in `glasses-relay/`, or a screen-shared WhatsApp call as a fallback),
// or a clip.

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

export function startCamera(deviceId?: string): Promise<MediaStream> {
  // request 1080p so the fine beacon sampler has more native pixels to crop;
  // `ideal` degrades gracefully if the camera can't do it.
  const video: MediaTrackConstraints = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  if (deviceId) video.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

// Screen capture — pick the WhatsApp Desktop window showing the glasses feed.
export function startScreen(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
}

// Meta glasses, via the iOS relay app in `glasses-relay/`. The glasses reach the
// phone over Bluetooth and nothing else, so the phone re-serves the frames as
// JPEGs on a WebSocket; here they're painted to a canvas whose captureStream()
// the pipeline treats like any other camera.
export function startGlasses(url: string): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { return reject(new Error(`"${url}" isn't a valid ws:// address.`)); }
    ws.binaryType = "blob";

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    let stream: MediaStream | null = null;

    ws.onerror = () =>
      reject(new Error(`Couldn't reach the relay at ${url}. Is the relay app running, and is this laptop on the phone's hotspot?`));

    // Resolve on connect rather than on the first frame: the glasses can take a
    // few seconds to start, and a black canvas still gives the pipeline a stream
    // with real dimensions to work with.
    ws.onopen = () => {
      canvas.width = 720; canvas.height = 1280;
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      stream = canvas.captureStream(30);
      resolve(stream);
    };

    // Decode one frame at a time and keep only the newest waiting — if frames
    // arrive faster than they paint, queuing them would only add lag.
    let busy = false;
    let pending: Blob | null = null;
    const paint = async (blob: Blob) => {
      busy = true;
      try {
        const bmp = await createImageBitmap(blob);
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width; canvas.height = bmp.height;
        }
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
      } catch { /* a corrupt frame is dropped; the next one repaints */ }
      busy = false;
      if (pending) { const next = pending; pending = null; paint(next); }
    };
    ws.onmessage = (e) => {
      // Stop() on the pipeline ends the track; that's our cue to drop the socket.
      if (stream && stream.getVideoTracks()[0]?.readyState === "ended") { ws.close(); return; }
      if (busy) pending = e.data as Blob; else paint(e.data as Blob);
    };

    ws.onclose = () => stream?.getTracks().forEach((t) => t.stop());
  });
}
