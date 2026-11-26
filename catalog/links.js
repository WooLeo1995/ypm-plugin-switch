// 跨源曲目里的歌手链接：酷我 / QQ 只知道歌手名，点击后由 artist() 现查网易云或 QQ。
const PREFIX = "artist:";

export function artistLink(name) {
  const value = String(name == null ? "" : name).trim();
  return value ? `${PREFIX}${value}` : "";
}

export function isArtistLink(value) {
  return String(value ?? "").startsWith(PREFIX);
}

export function artistNameOf(value) {
  const raw = String(value ?? "");
  return isArtistLink(raw) ? raw.slice(PREFIX.length).trim() : "";
}
