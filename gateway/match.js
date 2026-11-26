// 关键词搜索结果的匹配规则，移植自 qplayer-qqmusic-plugin/src/unblock.js。
// 目标：宁可返回 null，也不能把伴奏、DJ 版、翻唱、同名不同歌手当成原曲。

export function text(value) {
  return String(value == null ? "" : value);
}

export function normalizeName(name) {
  return text(name).toLowerCase()
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, "")
    // 酷我常在歌名后拼「-《剧名》主题曲」这类说明，不参与歌名匹配。
    .replace(/[-—]\s*《[^》]*》[\s\S]*$/, "")
    .replace(/\s+-\s+[\s\S]*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 比较版本限定语本身：原版不能匹配「宿命版」，DJ 名龙版不能匹配 DJ 哭包版。
export function versionKey(name) {
  const extras = [];
  function add(inner) {
    let value = text(inner).toLowerCase().trim();
    if (/^(feat\.?|ft\.?|featuring|with)\s/.test(value)) return;
    value = value.replace(/[\s._-]+/g, "");
    if (!value || /^(remastered?|explicit|clean|hq|高音质|高音質|完整版本)$/.test(value)) return;
    extras.push(value);
  }
  text(name).replace(/[（(【\[]([^）)】\]]*)[）)】\]]/g, (_, inner) => {
    add(inner);
    return "";
  });
  const dashed = text(name).split(/\s+-\s+/);
  for (let index = 1; index < dashed.length; index += 1) add(dashed[index]);
  return extras.sort().join("|");
}

export function normalizeArtist(artist) {
  return text(artist).toLowerCase().replace(/[&/、，,;；]/g, " ").replace(/\s+/g, " ").trim();
}

export function artistTokens(artist) {
  return normalizeArtist(artist).split(" ").filter(Boolean);
}

export function artistsOverlap(want, got) {
  const original = text(want);
  const result = text(got);
  if (!original || !result) return false;
  if (result.includes(original) || original.includes(result)) return true;
  const wantTokens = artistTokens(original);
  const gotTokens = artistTokens(result);
  for (const left of wantTokens) {
    for (const right of gotTokens) {
      if (left === right || left.includes(right) || right.includes(left)) return true;
    }
  }
  return false;
}

export function durationMsOf(raw) {
  const value = Number(raw);
  if (!value || value < 0) return 0;
  return value > 10000 ? value : value * 1000;
}

export function isMatch(resultName, resultArtist, wantName, wantArtist, wantMs, gotMs) {
  const resultNormalized = normalizeName(resultName);
  const wantNormalized = normalizeName(wantName);
  if (!resultNormalized || !wantNormalized || resultNormalized !== wantNormalized) return false;
  if (versionKey(wantName) !== versionKey(resultName)) return false;
  const originalArtist = normalizeArtist(wantArtist);
  const resultArtistName = normalizeArtist(resultArtist);
  if (originalArtist) {
    if (!resultArtistName) return false;
    if (!artistsOverlap(originalArtist, resultArtistName)) return false;
  }
  if (wantMs && gotMs && Math.abs(wantMs - gotMs) > 8000) return false;
  // 没有歌手又缺时长时放弃，避免同名覆盖把别人的歌当成原曲。
  if (!originalArtist && wantMs && !gotMs) return false;
  return true;
}

export function pickMatch(list, nameOf, artistOf, durationOf, wantName, wantArtist, wantMs) {
  let best = null;
  let bestScore = -1;
  (list || []).forEach((item, index) => {
    const itemName = nameOf(item);
    const itemArtist = artistOf(item);
    const itemMs = durationMsOf(durationOf(item));
    if (!isMatch(itemName, itemArtist, wantName, wantArtist, wantMs, itemMs)) return;
    let score = 0;
    if (normalizeName(itemName) === normalizeName(wantName)) score += 100;
    if (wantMs && itemMs && Math.abs(wantMs - itemMs) <= 3000) score += 50;
    else if (wantMs && itemMs) score += 20;
    if (wantArtist && normalizeArtist(itemArtist) === normalizeArtist(wantArtist)) score += 30;
    score -= index;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  });
  return best;
}

export function artistText(track) {
  return (track?.artists || []).map((value) => value?.name || "").filter(Boolean).join(" ");
}

// 搜索关键词由宽到窄：先精确到歌手，再退到歌名。
export function keywordVariants(track) {
  const name = text(track?.name).trim();
  if (!name) return [];
  const artists = artistText(track);
  const variants = [];
  if (artists) {
    variants.push(`${name}-${artists}`);
    variants.push(`${name} ${artists}`);
  }
  variants.push(name);
  return [...new Set(variants)].filter(Boolean).slice(0, 2);
}
