export interface TextureLoadTarget<T> {
  img: Pick<HTMLImageElement, "onload" | "onerror" | "removeAttribute">;
  error?: number;
  load_callback?: null | ((texture: T) => void);
  stopWatcher(): void;
}

export function cancelTextureLoad<T extends TextureLoadTarget<T>>(texture: T): void {
  texture.img.onload = null;
  texture.img.onerror = null;
  texture.load_callback = undefined;
  texture.img.removeAttribute("src");
  try { texture.stopWatcher(); } catch { /* The failed texture will be discarded. */ }
}

/** Keep the workspace active until Blockbench has finished its native onload. */
export function awaitTextureLoad<T extends TextureLoadTarget<T>>(
  texture: T,
  start: () => void,
  options: { timeoutMs?: number; isCurrentProject?: () => boolean } = {}
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const image = texture.img;
    const nativeLoad = image.onload;
    const nativeError = image.onerror;
    let nativeCallback = texture.load_callback;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error("Texture loading timed out.")), options.timeoutMs ?? 15_000);

    function fail(error: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // This texture will be discarded by Undo.cancelEdit. Do not restore native
      // callbacks: an already queued image event must not mutate a later scope.
      cancelTextureLoad(texture);
      reject(error);
    }

    const loaded = (value: T): void => {
      if (settled) return;
      try {
        if (texture.error) throw new Error(`Texture loading failed (error ${texture.error}).`);
        // Defer completion until native onload has returned and cleared its
        // callback, including any promise returned by the original callback.
        Promise.resolve(nativeCallback?.(value)).then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          image.onload = nativeLoad;
          image.onerror = nativeError;
          if (texture.load_callback === loaded) texture.load_callback = undefined;
          resolve();
        }, fail);
      } catch (error) {
        fail(error);
      }
    };

    image.onload = function (event): void {
      if (settled) return;
      if (options.isCurrentProject && !options.isCurrentProject()) {
        fail(new Error("The active project changed while the texture was loading."));
        return;
      }
      try {
        nativeLoad?.call(this, event);
      } catch (error) {
        fail(error);
      }
    };
    image.onerror = () => fail(new Error("Unable to decode the texture image."));
    texture.load_callback = loaded;
    try {
      start();
      // fromFile/fromPath can install an EditSession callback of their own.
      if (!settled && texture.load_callback !== loaded) {
        nativeCallback = texture.load_callback;
        texture.load_callback = loaded;
      }
    } catch (error) {
      fail(error);
    }
  });
}

/** Snapshot a file into the workspace instead of starting a native file watcher. */
export function textureFileDataUrl(
  input: string,
  readFile: (path: string) => Uint8Array
): string {
  let path = input;
  if (/^file:\/\//i.test(input)) {
    const url = new URL(input);
    path = decodeURIComponent(url.pathname);
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    if (url.hostname) path = `//${url.hostname}${path}`;
  }
  const extension = path.match(/\.([^.\/\\]+)$/)?.[1].toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    gif: "image/gif", bmp: "image/bmp", avif: "image/avif", svg: "image/svg+xml",
  };
  const mimeType = extension && mimeTypes[extension];
  if (!mimeType) {
    throw new Error("For an isolated texture, use a PNG, JPEG, WebP, GIF, BMP, AVIF or SVG file, or an image data URL.");
  }
  return `data:${mimeType};base64,${Buffer.from(readFile(path)).toString("base64")}`;
}
