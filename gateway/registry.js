// 音源注册表。默认顺序：GDStudio 按 ID → 酷我波点 → 酷我移动 → GDStudio 搜索。
// 「优先音源」只调整族顺序，「停用」开关直接剔除整族。
import { flag, setting } from "../i18n.js";
import gdstudio from "./sources/gdstudio.js";
import gdstudioSearch from "./sources/gdstudio-search.js";
import kuwoBodian from "./sources/kuwo-bodian.js";
import kuwoMobi from "./sources/kuwo-mobi.js";

export const ALL_PROVIDERS = [gdstudio, kuwoBodian, kuwoMobi, gdstudioSearch];

export function providerList() {
  const disabledGdstudio = flag("disableGdstudio");
  const disabledKuwo = flag("disableKuwo");
  return ALL_PROVIDERS.filter((provider) => (
    provider.family === "gdstudio" ? !disabledGdstudio : !disabledKuwo
  ));
}

export function orderedProviders() {
  const list = providerList();
  const prefer = setting("prefer");
  if (prefer === "gdstudio") {
    return [...list.filter((provider) => provider.family === "gdstudio"), ...list.filter((provider) => provider.family !== "gdstudio")];
  }
  if (prefer === "kuwo") {
    return [...list.filter((provider) => provider.family === "kuwo"), ...list.filter((provider) => provider.family !== "kuwo")];
  }
  return list;
}
