import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type MouseEvent, type MutableRefObject, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import type { AppInfo, GameVersionInfo, LegacyRuntimeMigrationCheck } from "../../../core/types";
import type { PreviewSpineBundle, RuntimeMod, RuntimeStatus } from "../../../core/runtime-loader";
import * as PIXI from "pixi.js";
import { TextureAtlas } from "@pixi-spine/base";
import { AtlasAttachmentLoader, SkeletonBinary, SkeletonJson } from "@pixi-spine/runtime-4.1";
import { Spine } from "pixi-spine";
import characterAssetsJson from "./data/bd2-characters.json";
import {
  LIBRARY_BACKDROP_CHARACTER_EVENT,
  LIBRARY_BACKDROP_SETTINGS_EVENT,
  LibraryHalftoneBackdrop,
  type LibraryBackdropCharacterDetail,
  type LibraryBackdropSettingsDetail
} from "./LibraryHalftoneBackdrop";

// Runtime-based BD-SpineX. The interaction model follows the original offline patch UI.
// Stage 3 of the liquid-glass redesign: the top toolbar is replaced by a left glass
// rail with routed views (Library / Roster / Preview / Stats / Logs / Settings).
// All runtime logic and window.bd2 calls are unchanged.

type LogEntry = { id: string; time: string; message: string; tone?: "ok" | "warn" | "err" };
type ModSortKey = "folder" | "name" | "category" | "status";
type ModSort = { key: ModSortKey; direction: "asc" | "desc" };
type ModCategory = "char" | "dating" | "cutscene" | "other";
type PendingTone = "added" | "removed" | "conflict";
type RuntimeChange = { folder: string; key: string; enabled: boolean; implicit?: boolean; conflict?: boolean };
type AuthorRule = { id: string; name: string; color: string; keywords: string[]; custom?: boolean };
type DetectedAuthor = { id: string; name: string; color: string };
type CharacterAsset = {
  id: string | string[];
  character: string;
  costume: string;
  dating_id?: string | null;
  npc_id?: string | null;
  standing?: boolean;
};
type CharacterAssetsJson = {
  characters: CharacterAsset[];
  dating: Record<string, string>;
};
type DetectedCharacter = {
  id: string;
  imageId: string;
  character: string;
  costume: string;
};

type PreviewSlotKey = "a" | "b";
type PreviewRuntimeStatus = "empty" | "loading" | "ready" | "error";
type PreviewAnimationInfo = { name: string; duration: number };
type PreviewSkinInfo = { name: string };
type PreviewPartInfo = { name: string; alpha: number };
type PreviewAnimLayer = { id: string; trackIndex: number; animation: string; alpha: number };
type ConfirmTone = "info" | "warn" | "danger";
type ConfirmDialogOptions = {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  hideCancel?: boolean;
  tone?: ConfirmTone;
};
type ConfirmDialogState = ConfirmDialogOptions & {
  id: number;
  closing?: boolean;
  resolve: (confirmed: boolean) => void;
};
type ViewMotionPhase = "idle" | "leaving" | "entering";
type ViewMotionDirection = "forward" | "back";
type PreviewRuntimeInfo = {
  status: PreviewRuntimeStatus;
  error?: string;
  animations: PreviewAnimationInfo[];
  skins: PreviewSkinInfo[];
  parts: PreviewPartInfo[];
  selectedAnimation: string;
  selectedSkin: string;
  playing: boolean;
  speed: number;
  progress: number;
};
type PreviewStageControls = {
  togglePlayback: () => void;
  setAnimation: (name: string) => void;
  setSkin: (name: string) => void;
  setSpeed: (speed: number) => void;
  setPartAlpha: (name: string, alpha: number) => void;
  setAnimationLayer: (layerId: string, animation: string) => void;
  setAnimationLayerAlpha: (layerId: string, alpha: number) => void;
  resetView: () => void;
};

const PREVIEW_SPEED_OPTIONS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

type ViewKey = "library" | "roster" | "profiles" | "preview" | "stats" | "logs" | "settings";
type NavItem = { key: ViewKey; label: string; subtitle: string; icon: string; group: "collection" | "tools" | "system" };

const NAV_ITEMS: NavItem[] = [
  { key: "library", label: "Library", subtitle: "Curate cartridges. Apply cleanly.", icon: "📚", group: "collection" },
  { key: "roster", label: "Roster", subtitle: "Find mods by character.", icon: "🎭", group: "collection" },
  { key: "profiles", label: "Profiles", subtitle: "Save loadouts for later.", icon: "💼", group: "collection" },
  { key: "preview", label: "Preview", subtitle: "Inspect Spine before install.", icon: "👁️", group: "tools" },
  { key: "stats", label: "Stats", subtitle: "Read coverage at a glance.", icon: "📊", group: "tools" },
  { key: "logs", label: "Logs", subtitle: "Trace runtime events.", icon: "🧾", group: "tools" },
  { key: "settings", label: "Settings", subtitle: "Tune paths, labels, and effects.", icon: "⚙️", group: "system" }
];
const HIDDEN_NAV_KEYS = new Set<ViewKey>(["profiles"]);
const VISIBLE_NAV_ITEMS = NAV_ITEMS.filter((item) => !HIDDEN_NAV_KEYS.has(item.key));
const VIEW_MOTION_EXIT_MS = 110;
const VIEW_MOTION_ENTER_MS = 320;
const CONFIRM_EXIT_MS = 120;
const NAV_GROUPS: { id: NavItem["group"]; label: string; en: string }[] = [
  { id: "collection", label: "收藏", en: "Collection" },
  { id: "tools", label: "工具", en: "Tools" },
  { id: "system", label: "系統", en: "System" }
];

const defaultAppInfo: AppInfo = { name: "BD-SpineX", subtitle: "PlayCover Mod Manager", version: "0.1.0", supportedGameVersion: "0.1.0", development: false };
const MODSDIR_KEY = "bd-spinex:runtime-modsdir";
const MIGRATION_DISMISSED_KEY = "bd-spinex:legacy-runtime-migration-dismissed";
const MODVIEW_KEY = "bd-spinex:mod-view";
const AUTHOR_RULES_KEY = "bd-spinex:author-rules";
const THEME_KEY = "bd-spinex:theme";
const TAURI_CANVAS_CARTRIDGE_KEY = "bd-spinex:tauri-canvas-cartridge";
const TAURI_CSS_CARTRIDGE_KEY = "bd-spinex:tauri-css-cartridge";
const BD_SPINEX_RELEASES_URL = "https://github.com/suzumiyahifumi/BD-SpineX/releases";
type ModView = "grid" | "list";
type Theme = "night";
const ACTIVE_THEME: Theme = "night";
const THEMES: { key: Theme; label: string }[] = [
  { key: ACTIVE_THEME, label: "Night Press" }
];

// Color palettes — the print "skin" (data-theme=night) stays; only the color
// tokens are swapped via data-accent. Add a palette by overriding tokens under
// :root[data-theme="night"][data-accent="<key>"] in styles.css.
type Accent = "press" | "violet" | "orchid";
const ACCENT_KEY = "bd-spinex:accent";
const PALETTES: { key: Accent; label: string }[] = [
  { key: "press", label: "Night Press" },
  { key: "violet", label: "Violet Press" },
  { key: "orchid", label: "Orchid Press" }
];
function readAccent(): Accent {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    return v === "violet" || v === "orchid" ? v : "press";
  } catch {
    return "press";
  }
}

const AUTHOR_COLORS = [
  "#3f5365",
  "#7a3f3c",
  "#836a3a",
  "#46665d",
  "#5e5276",
  "#795b3f",
  "#4b6686",
  "#81506a",
  "#63714c",
  "#7a6548",
  "#56617c",
  "#8a6145",
  "#6d5870",
  "#6c7473"
];

const LEGACY_AUTHOR_COLORS = [
  "#d98a22",
  "#5f8fb9",
  "#8c6bb1",
  "#4f9c7a",
  "#bf5f57",
  "#b49a45",
  "#6f88c7",
  "#c46d9b",
  "#5f9fa8",
  "#9a7551",
  "#7c8a59",
  "#a7664b",
  "#6d78a8",
  "#9298a6"
];

const DEFAULT_AUTHOR_RULES: AuthorRule[] = [
  makeAuthorRule("anextra", "AnExtra", AUTHOR_COLORS[0]),
  makeAuthorRule("hardcracker", "HardCracker", AUTHOR_COLORS[1]),
  makeAuthorRule("hcoel", "H.Coel", AUTHOR_COLORS[2]),
  makeAuthorRule("linr", "linr熊", AUTHOR_COLORS[3]),
  makeAuthorRule("mr_miagi", "Mr. Miagi", AUTHOR_COLORS[4]),
  makeAuthorRule("mr_phaps", "Mr. Phaps", AUTHOR_COLORS[5]),
  makeAuthorRule("na0h", "Na0h", AUTHOR_COLORS[6]),
  makeAuthorRule("nimloth", "Nimloth", AUTHOR_COLORS[7]),
  makeAuthorRule("qi", "Qi齊", AUTHOR_COLORS[8]),
  makeAuthorRule("sloth", "Sloth", AUTHOR_COLORS[9]),
  makeAuthorRule("synae", "Synae", AUTHOR_COLORS[10]),
  makeAuthorRule("yuk11sh1d4", "Yuk11sh1d4", AUTHOR_COLORS[11]),
  makeAuthorRule("tazmanyakk", "Tazmanyakk", AUTHOR_COLORS[12]),
  makeAuthorRule("xian", "XiAn", AUTHOR_COLORS[13])
];

const PUBLIC_ASSET_BASE = import.meta.env.BASE_URL || "/";

function publicAssetPath(path: string) {
  const normalizedBase = PUBLIC_ASSET_BASE.endsWith("/") ? PUBLIC_ASSET_BASE : `${PUBLIC_ASSET_BASE}/`;
  return `${normalizedBase}${path.replace(/^\/+/, "")}`;
}

const HEATSEAL_FILM_OVERLAY_URL = publicAssetPath("cartridge/heatseal-film-overlay.png");

const LEGACY_AUTHOR_COLORS_BY_ID = new Map(DEFAULT_AUTHOR_RULES.map((rule, index) => [rule.id, LEGACY_AUTHOR_COLORS[index]?.toLowerCase()]));

const CHARACTER_ASSETS = characterAssetsJson as CharacterAssetsJson;
const CHARACTER_BY_ID = new Map<string, DetectedCharacter>();
const CHARACTER_BY_NPC_ID = new Map<string, DetectedCharacter>();

for (const character of CHARACTER_ASSETS.characters) {
  const ids = Array.isArray(character.id) ? character.id : [character.id];
  for (const id of ids) {
    CHARACTER_BY_ID.set(id, {
      id,
      imageId: id,
      character: character.character,
      costume: character.costume
    });
  }
  if (character.npc_id) {
    const imageId = ids[0];
    CHARACTER_BY_NPC_ID.set(character.npc_id, {
      id: character.npc_id,
      imageId,
      character: character.character,
      costume: character.costume
    });
  }
}
const BACKDROP_SLOT_ROLL_TICK_MS = 72;
const BACKDROP_SLOT_ROLL_MIN_MS = 1200;
const BACKDROP_SLOT_ROLL_MAX_MS = 3600;
const BACKDROP_SLOT_CANDIDATES = Array.from(CHARACTER_BY_ID.values());

function typeToCategory(type: RuntimeMod["type"]): ModCategory {
  return type === "skillcut" ? "cutscene" : type === "dating" ? "dating" : type === "standing" ? "char" : "other";
}

function chunkRows<T>(items: T[], columns: number) {
  const size = Math.max(1, columns);
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

function emptyPreviewRuntimeInfo(): PreviewRuntimeInfo {
  return {
    status: "empty",
    animations: [],
    skins: [],
    parts: [],
    selectedAnimation: "",
    selectedSkin: "",
    playing: false,
    speed: 1,
    progress: 0
  };
}

function createPreviewAnimLayer(animation: string, trackIndex: number): PreviewAnimLayer {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    trackIndex,
    animation,
    alpha: 1
  };
}

function baseName(pathLike: string) {
  return pathLike.split(/[\\/]/).pop() ?? pathLike;
}

function base64ToBytes(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base64ToText(data: string) {
  return new TextDecoder().decode(base64ToBytes(data));
}

function waitForBaseTexture(texture: PIXI.Texture) {
  const baseTexture = texture.baseTexture;
  if (baseTexture.valid) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      baseTexture.off("loaded", handleLoaded);
      baseTexture.off("error", handleError);
    };
    const handleLoaded = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    baseTexture.once("loaded", handleLoaded);
    baseTexture.once("error", handleError);
    const resource = baseTexture.resource as { load?: () => Promise<unknown> | unknown } | undefined;
    try {
      const loaded = resource?.load?.();
      if (loaded instanceof Promise) loaded.catch(handleError);
    } catch (error) {
      handleError(error);
    }
  });
}

async function createPreviewTextures(bundle: PreviewSpineBundle) {
  const textures = new Map<string, PIXI.Texture>();
  const owned: PIXI.Texture[] = [];
  for (const image of bundle.images) {
    const texture = PIXI.Texture.from(`data:${image.mime};base64,${image.data}`);
    await waitForBaseTexture(texture);
    textures.set(image.name, texture);
    textures.set(baseName(image.name), texture);
    owned.push(texture);
  }
  return { textures, owned };
}

function createPreviewAtlas(bundle: PreviewSpineBundle, textures: Map<string, PIXI.Texture>) {
  return new Promise<TextureAtlas>((resolve, reject) => {
    new TextureAtlas(bundle.atlasText, (pageName, done) => {
      const texture = textures.get(pageName) ?? textures.get(baseName(pageName));
      if (!texture) {
        reject(new Error(`Texture page not found: ${pageName}`));
        return;
      }
      done(texture.baseTexture);
    }, (readyAtlas) => resolve(readyAtlas));
  });
}

function parsePreviewSkeleton(bundle: PreviewSpineBundle, atlas: TextureAtlas) {
  const attachmentLoader = new AtlasAttachmentLoader(atlas);
  if (bundle.skeletonType === "json") {
    const parser = new SkeletonJson(attachmentLoader);
    return parser.readSkeletonData(JSON.parse(base64ToText(bundle.skeletonData)));
  }
  const parser = new SkeletonBinary(attachmentLoader);
  return parser.readSkeletonData(base64ToBytes(bundle.skeletonData));
}

function collectPreviewInfo(spine: Spine, patch: Partial<PreviewRuntimeInfo> = {}): PreviewRuntimeInfo {
  const animations = spine.spineData.animations.map((animation) => ({
    name: animation.name,
    duration: Number.isFinite(animation.duration) ? animation.duration : 0
  }));
  const skins = spine.spineData.skins.map((skin) => ({ name: skin.name }));
  const parts = spine.skeleton.slots.map((slot) => ({
    name: slot.data.name,
    alpha: Math.max(0, Math.min(1, Number(slot.color.a) || 0))
  }));
  return {
    status: "ready",
    animations,
    skins,
    parts,
    selectedAnimation: patch.selectedAnimation ?? animations[0]?.name ?? "",
    selectedSkin: patch.selectedSkin ?? skins[0]?.name ?? "default",
    playing: patch.playing ?? animations.length > 0,
    speed: patch.speed ?? 1,
    progress: patch.progress ?? 0
  };
}

function defaultPreviewAnimation(animations: PreviewAnimationInfo[]) {
  return animations.find((animation) => /idle|wait|loop/i.test(animation.name))?.name ?? animations[0]?.name ?? "";
}

function previewTrackProgress(spine: Spine) {
  const current = (spine.state as unknown as {
    getCurrent: (trackIndex: number) => { animation?: { duration?: number }; trackTime: number } | null;
  }).getCurrent(0);
  const duration = current?.animation?.duration ?? 0;
  if (!current || duration <= 0) return 0;
  return ((current.trackTime % duration) / duration) * 100;
}

function previewSpineTransform(spine: Spine, host: HTMLElement, zoom: number, panX: number, panY: number) {
  const width = Math.max(1, host.clientWidth);
  const height = Math.max(1, host.clientHeight);
  let bounds = spine.getLocalBounds();
  const spineMetrics = spine.spineData as typeof spine.spineData & { x?: number; y?: number; width?: number; height?: number };
  if (!Number.isFinite(bounds.width) || bounds.width < 2 || !Number.isFinite(bounds.height) || bounds.height < 2) {
    bounds = new PIXI.Rectangle(
      spineMetrics.x || -160,
      spineMetrics.y || -320,
      spineMetrics.width || 320,
      spineMetrics.height || 480
    );
  }
  const baseScale = Math.min(width / bounds.width * 0.74, height / bounds.height * 0.86);
  const scale = Math.max(0.01, baseScale * zoom);
  return {
    scale,
    x: width / 2 - (bounds.x + bounds.width / 2) * scale + panX,
    y: height * 0.88 - (bounds.y + bounds.height) * scale + panY
  };
}

function fitPreviewSpine(spine: Spine, host: HTMLElement, zoom: number, panX: number, panY: number) {
  const transform = previewSpineTransform(spine, host, zoom, panX, panY);
  spine.scale.set(transform.scale);
  spine.position.set(transform.x, transform.y);
}

function applyPreviewAnimationLayers(spine: Spine, layers: PreviewAnimLayer[], fallbackAnimation: string, playing: boolean, speed: number) {
  spine.state.clearTracks();
  const available = new Set(spine.spineData.animations.map((animation) => animation.name));
  const usableLayers = layers
    .filter((layer) => available.has(layer.animation))
    .sort((a, b) => a.trackIndex - b.trackIndex);
  const appliedLayers = usableLayers.length > 0
    ? usableLayers
    : fallbackAnimation
      ? [{ id: "default", trackIndex: 0, animation: fallbackAnimation, alpha: 1 }]
      : [];

  for (const layer of appliedLayers) {
    const entry = spine.state.setAnimation(layer.trackIndex, layer.animation, true);
    (entry as typeof entry & { alpha?: number }).alpha = Math.max(0, Math.min(1, layer.alpha));
  }
  spine.state.timeScale = playing ? speed : 0;
}

function applyPreviewPartAlphaOverrides(spine: Spine, overrides: Map<string, number>) {
  if (overrides.size === 0) return;
  for (const [name, alpha] of overrides) {
    const slot = spine.skeleton.findSlot(name);
    if (!slot) continue;
    const nextAlpha = Math.max(0, Math.min(1, alpha));
    slot.color.a = nextAlpha;
    const slotContainer = spine.slotContainers[slot.data.index];
    if (slotContainer) slotContainer.alpha = nextAlpha;
  }
}

function updatePreviewSpinePose(spine: Spine, dt: number, partAlphaOverrides: Map<string, number>) {
  // Pixi Spine does not reset setup pose before applying state; without this,
  // switching partial animations can leave stale slot attachments/colors behind.
  spine.skeleton.setToSetupPose();
  spine.update(dt);
  applyPreviewPartAlphaOverrides(spine, partAlphaOverrides);
}

function PreviewSpineRenderer({
  mod,
  animationLayers,
  layoutKey,
  slot,
  controlsRef,
  onStateChange,
  onDefaultAnimation
}: {
  mod: RuntimeMod | null;
  animationLayers: PreviewAnimLayer[];
  layoutKey: string;
  slot: PreviewSlotKey;
  controlsRef: MutableRefObject<Record<PreviewSlotKey, PreviewStageControls | null>>;
  onStateChange: (slot: PreviewSlotKey, info: PreviewRuntimeInfo) => void;
  onDefaultAnimation: (slot: PreviewSlotKey, animation: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const spineRef = useRef<Spine | null>(null);
  const animationLayersRef = useRef(animationLayers);
  const partAlphaOverridesRef = useRef(new Map<string, number>());
  const fitRef = useRef<(() => void) | null>(null);
  const emitRef = useRef<(() => void) | null>(null);
  const runtimeRef = useRef({
    defaultAnimation: "",
    playing: true,
    selectedAnimation: "",
    selectedSkin: "",
    speed: 1
  });

  useEffect(() => {
    animationLayersRef.current = animationLayers;
    const spine = spineRef.current;
    if (spine) {
      const runtime = runtimeRef.current;
      runtime.selectedAnimation = animationLayers.find((layer) => layer.trackIndex === 0)?.animation ?? runtime.defaultAnimation;
      applyPreviewAnimationLayers(spine, animationLayers, runtime.defaultAnimation, runtime.playing, runtime.speed);
      updatePreviewSpinePose(spine, 0, partAlphaOverridesRef.current);
    }
    emitRef.current?.();
  }, [animationLayers]);

  useEffect(() => {
    let secondFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      fitRef.current?.();
      secondFrame = window.requestAnimationFrame(() => fitRef.current?.());
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [layoutKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !mod) {
      controlsRef.current[slot] = null;
      spineRef.current = null;
      partAlphaOverridesRef.current.clear();
      onStateChange(slot, emptyPreviewRuntimeInfo());
      return;
    }

    let disposed = false;
    let spine: Spine | null = null;
    let textures: PIXI.Texture[] = [];
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let lastProgressAt = 0;
    partAlphaOverridesRef.current.clear();
    const app = new PIXI.Application<HTMLCanvasElement>({
      resizeTo: host,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2)
    });
    app.view.className = "pvCanvas";
    host.replaceChildren(app.view);

    const emit = (patch: Partial<PreviewRuntimeInfo> = {}) => {
      if (!spine || disposed) return;
      const runtime = runtimeRef.current;
      onStateChange(slot, collectPreviewInfo(spine, {
        selectedAnimation: runtime.selectedAnimation,
        selectedSkin: runtime.selectedSkin,
        playing: runtime.playing,
        speed: runtime.speed,
        progress: previewTrackProgress(spine),
        ...patch
      }));
    };
    emitRef.current = emit;

    const applyFit = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      app.renderer.resize(width, height);
      app.view.style.width = "100%";
      app.view.style.height = "100%";
      if (spine) fitPreviewSpine(spine, host, zoom, panX, panY);
    };
    fitRef.current = applyFit;

    const resizeObserver = new ResizeObserver(applyFit);
    resizeObserver.observe(host);

    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let startPanX = 0;
    let startPanY = 0;
    const onPointerDown = (event: PointerEvent) => {
      if (!spine || event.button !== 0) return;
      dragging = true;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      startPanX = panX;
      startPanY = panY;
      host.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      panX = startPanX + event.clientX - dragStartX;
      panY = startPanY + event.clientY - dragStartY;
      applyFit();
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    };
    const onWheel = (event: WheelEvent) => {
      if (!spine) return;
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const previousZoom = zoom;
      const before = previewSpineTransform(spine, host, zoom, panX, panY);
      const nextZoom = Math.max(0.1, Math.min(48, zoom * (event.deltaY < 0 ? 1.14 : 0.88)));
      const factor = nextZoom / previousZoom;
      const desiredX = before.x - (pointerX - before.x) * (factor - 1);
      const desiredY = before.y - (pointerY - before.y) * (factor - 1);
      const after = previewSpineTransform(spine, host, nextZoom, panX, panY);
      panX += desiredX - after.x;
      panY += desiredY - after.y;
      zoom = nextZoom;
      applyFit();
    };
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointercancel", onPointerUp);
    host.addEventListener("wheel", onWheel, { passive: false });

    onStateChange(slot, { ...emptyPreviewRuntimeInfo(), status: "loading" });

    (async () => {
      try {
        const bundle = await window.bd2.runtimePreviewSpine(mod.path, mod.key);
        if (disposed) return;
        const createdTextures = await createPreviewTextures(bundle);
        if (disposed) {
          createdTextures.owned.forEach((texture) => texture.destroy(true));
          return;
        }
        textures = createdTextures.owned;
        const atlas = await createPreviewAtlas(bundle, createdTextures.textures);
        if (disposed) return;
        const skeletonData = parsePreviewSkeleton(bundle, atlas);
        spine = new Spine(skeletonData as unknown as ConstructorParameters<typeof Spine>[0]);
        spineRef.current = spine;
        spine.autoUpdate = false;
        spine.stateData.defaultMix = 0.16;
        app.stage.addChild(spine);

        const initialInfo = collectPreviewInfo(spine);
        const defaultAnimation = defaultPreviewAnimation(initialInfo.animations);
        const selectedSkin = initialInfo.skins.find((skin) => skin.name === "default")?.name ?? initialInfo.skins[0]?.name ?? "";
        runtimeRef.current = {
          defaultAnimation,
          playing: Boolean(defaultAnimation),
          selectedAnimation: animationLayersRef.current.find((layer) => layer.trackIndex === 0)?.animation ?? defaultAnimation,
          selectedSkin,
          speed: 1
        };
        if (selectedSkin) {
          spine.skeleton.setSkinByName(selectedSkin);
          spine.skeleton.setSlotsToSetupPose();
        }
        if (defaultAnimation && animationLayersRef.current.length === 0) {
          onDefaultAnimation(slot, defaultAnimation);
        }
        applyPreviewAnimationLayers(spine, animationLayersRef.current, defaultAnimation, runtimeRef.current.playing, runtimeRef.current.speed);
        updatePreviewSpinePose(spine, 0, partAlphaOverridesRef.current);
        applyFit();

        controlsRef.current[slot] = {
          togglePlayback: () => {
            if (!spine) return;
            const runtime = runtimeRef.current;
            runtime.playing = !runtime.playing;
            spine.state.timeScale = runtime.playing ? runtime.speed : 0;
            emit();
          },
          setAnimation: (name: string) => {
            if (!spine || !name) return;
            runtimeRef.current.selectedAnimation = name;
            const nextLayers = animationLayersRef.current.length > 0
              ? animationLayersRef.current.map((layer) => layer.trackIndex === 0 ? { ...layer, animation: name } : layer)
              : [createPreviewAnimLayer(name, 0)];
            animationLayersRef.current = nextLayers;
            applyPreviewAnimationLayers(spine, nextLayers, runtimeRef.current.defaultAnimation, runtimeRef.current.playing, runtimeRef.current.speed);
            updatePreviewSpinePose(spine, 0, partAlphaOverridesRef.current);
            emit({ progress: 0 });
          },
          setSkin: (name: string) => {
            if (!spine || !name) return;
            runtimeRef.current.selectedSkin = name;
            spine.skeleton.setSkinByName(name);
            updatePreviewSpinePose(spine, 0, partAlphaOverridesRef.current);
            emit();
          },
          setSpeed: (nextSpeed: number) => {
            if (!spine) return;
            const runtime = runtimeRef.current;
            runtime.speed = Math.max(0, Math.min(2, nextSpeed));
            spine.state.timeScale = runtime.playing ? runtime.speed : 0;
            emit();
          },
          setPartAlpha: (name: string, alpha: number) => {
            if (!spine) return;
            const part = spine.skeleton.findSlot(name);
            if (!part) return;
            partAlphaOverridesRef.current.set(name, Math.max(0, Math.min(1, alpha)));
            applyPreviewPartAlphaOverrides(spine, partAlphaOverridesRef.current);
            emit();
          },
          setAnimationLayer: (layerId: string, animation: string) => {
            if (!spine) return;
            const nextLayers = animationLayersRef.current.map((layer) => layer.id === layerId ? { ...layer, animation } : layer);
            animationLayersRef.current = nextLayers;
            runtimeRef.current.selectedAnimation = nextLayers.find((layer) => layer.trackIndex === 0)?.animation ?? runtimeRef.current.defaultAnimation;
            applyPreviewAnimationLayers(spine, nextLayers, runtimeRef.current.defaultAnimation, runtimeRef.current.playing, runtimeRef.current.speed);
            updatePreviewSpinePose(spine, 0, partAlphaOverridesRef.current);
            emit();
          },
          setAnimationLayerAlpha: (layerId: string, alpha: number) => {
            if (!spine) return;
            const nextLayers = animationLayersRef.current.map((layer) => layer.id === layerId ? { ...layer, alpha } : layer);
            animationLayersRef.current = nextLayers;
            applyPreviewAnimationLayers(spine, nextLayers, runtimeRef.current.defaultAnimation, runtimeRef.current.playing, runtimeRef.current.speed);
            updatePreviewSpinePose(spine, 0, partAlphaOverridesRef.current);
            emit();
          },
          resetView: () => {
            zoom = 1;
            panX = 0;
            panY = 0;
            applyFit();
          }
        };
        emit();
      } catch (error) {
        if (disposed) return;
        controlsRef.current[slot] = null;
        onStateChange(slot, {
          ...emptyPreviewRuntimeInfo(),
          status: "error",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();

    const tick = () => {
      if (!spine) return;
      updatePreviewSpinePose(spine, app.ticker.deltaMS / 1000, partAlphaOverridesRef.current);
      const now = performance.now();
      if (now - lastProgressAt > 100) {
        lastProgressAt = now;
        emit();
      }
    };
    app.ticker.add(tick);

    return () => {
      disposed = true;
      controlsRef.current[slot] = null;
      resizeObserver.disconnect();
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerUp);
      host.removeEventListener("wheel", onWheel);
      app.ticker.remove(tick);
      app.stage.removeChildren();
      if (spine) spine.destroy({ children: true });
      textures.forEach((texture) => texture.destroy(true));
      if (spineRef.current === spine) spineRef.current = null;
      if (fitRef.current === applyFit) fitRef.current = null;
      app.destroy(true);
      if (host.firstChild === app.view) host.replaceChildren();
    };
  }, [controlsRef, mod?.key, mod?.path, onDefaultAnimation, onStateChange, slot]);

  return <div ref={hostRef} className="pvCanvasHost" />;
}

export function App() {
  useTauriCustomScrollbars();
  const htmlAltTooltip = useHtmlAltTooltip();

  const [appInfo, setAppInfo] = useState<AppInfo>(defaultAppInfo);
  const [gameVersionInfo, setGameVersionInfo] = useState<GameVersionInfo | null>(null);
  const [view, setActiveView] = useState<ViewKey>("library");
  const [viewMotion, setViewMotion] = useState<{ phase: ViewMotionPhase; direction: ViewMotionDirection }>({
    phase: "idle",
    direction: "forward"
  });
  const viewRef = useRef<ViewKey>("library");
  const pendingViewRef = useRef<ViewKey>("library");
  const viewLeaveTimerRef = useRef<number | null>(null);
  const viewEnterTimerRef = useRef<number | null>(null);
  const [rosterSearch, setRosterSearch] = useState("");
  const [rosterMode, setRosterMode] = useState<"mods" | "az" | "modded">("mods");
  const [openRosterChar, setOpenRosterChar] = useState<string | null>(null);
  const [rosterColumns, setRosterColumns] = useState(1);
  const [logFilter, setLogFilter] = useState<"all" | "ok" | "warn" | "err">("all");
  const [pvMode, setPvMode] = useState<"single" | "dual">("single");
  const [pvChar, setPvChar] = useState<string | null>(null);
  const [pvCharSearch, setPvCharSearch] = useState("");
  const [pvSlotA, setPvSlotA] = useState<RuntimeMod | null>(null);
  const [pvSlotB, setPvSlotB] = useState<RuntimeMod | null>(null);
  const [pvFocus, setPvFocus] = useState<"a" | "b">("a");
  const [pvPartSearch, setPvPartSearch] = useState("");
  const [pvAnimLayers, setPvAnimLayers] = useState<Record<PreviewSlotKey, PreviewAnimLayer[]>>({ a: [], b: [] });
  const [pvActiveAnimLayerId, setPvActiveAnimLayerId] = useState<Record<PreviewSlotKey, string | null>>({ a: null, b: null });
  const [pvRuntime, setPvRuntime] = useState<Record<PreviewSlotKey, PreviewRuntimeInfo>>(() => ({
    a: emptyPreviewRuntimeInfo(),
    b: emptyPreviewRuntimeInfo()
  }));
  const pvControlsRef = useRef<Record<PreviewSlotKey, PreviewStageControls | null>>({ a: null, b: null });
  const [modsDir, setModsDir] = useState<string>("");
  const [library, setLibrary] = useState<RuntimeMod[]>([]);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [desired, setDesired] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<LogEntry[]>(() => [createLogEntry("Ready.")]);
  const [busy, setBusy] = useState(false);
  const [modFilter, setModFilter] = useState("");
  const [modSort, setModSort] = useState<ModSort>({ key: "folder", direction: "asc" });
  const [modView, setModView] = useState<ModView>(() => (localStorage.getItem(MODVIEW_KEY) === "list" ? "list" : "grid"));
  const [backgroundCharacter, setBackgroundCharacter] = useState<DetectedCharacter | null>(null);
  const [backdropSlotRolling, setBackdropSlotRolling] = useState(false);
  const [backdropParticlesEnabled, setBackdropParticlesEnabled] = useState(true);
  const [tauriCanvasCartridges] = useState(readTauriCanvasCartridgeMode);
  const theme = ACTIVE_THEME;
  const [accent, setAccent] = useState<Accent>(readAccent);

  useEffect(() => {
    document.documentElement.setAttribute("data-accent", accent);
    try { localStorage.setItem(ACCENT_KEY, accent); } catch { /* ignore */ }
  }, [accent]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", ACTIVE_THEME);
    localStorage.setItem(THEME_KEY, ACTIVE_THEME);
  }, []);
  const [authorRules, setAuthorRules] = useState<AuthorRule[]>(readAuthorRules);
  const [newAuthorName, setNewAuthorName] = useState("");
  const [migrationCheck, setMigrationCheck] = useState<LegacyRuntimeMigrationCheck | null>(null);
  const [migrationRunning, setMigrationRunning] = useState(false);
  const [migrationDismissed, setMigrationDismissed] = useState(false);
  const [hoveredPendingFolder, setHoveredPendingFolder] = useState<string | null>(null);
  const [pendingScrollTarget, setPendingScrollTarget] = useState<string | null>(null);
  const [spotlitPendingFolder, setSpotlitPendingFolder] = useState<string | null>(null);
  const cartNodeRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const rosterGridRef = useRef<HTMLDivElement | null>(null);
  const pendingSpotlightTimerRef = useRef<number | null>(null);
  const backdropSlotTimerRef = useRef<number | null>(null);
  const confirmDialogRef = useRef<ConfirmDialogState | null>(null);
  const confirmDialogIdRef = useRef(0);
  const confirmCloseTimerRef = useRef<number | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  const log = useCallback((message: string, tone?: LogEntry["tone"]) => pushLog(setLogs, message, tone), []);

  const clearViewMotionTimers = useCallback(() => {
    if (viewLeaveTimerRef.current) {
      window.clearTimeout(viewLeaveTimerRef.current);
      viewLeaveTimerRef.current = null;
    }
    if (viewEnterTimerRef.current) {
      window.clearTimeout(viewEnterTimerRef.current);
      viewEnterTimerRef.current = null;
    }
  }, []);

  const navigateToView = useCallback((nextView: ViewKey) => {
    const fromView = pendingViewRef.current;
    if (nextView === fromView) return;

    const fromIndex = Math.max(0, VISIBLE_NAV_ITEMS.findIndex((item) => item.key === fromView));
    const nextIndex = Math.max(0, VISIBLE_NAV_ITEMS.findIndex((item) => item.key === nextView));
    const direction: ViewMotionDirection = nextIndex >= fromIndex ? "forward" : "back";

    pendingViewRef.current = nextView;
    clearViewMotionTimers();

    if (prefersReducedMotion()) {
      viewRef.current = nextView;
      setActiveView(nextView);
      setViewMotion({ phase: "idle", direction });
      return;
    }

    setViewMotion({ phase: "leaving", direction });
    viewLeaveTimerRef.current = window.setTimeout(() => {
      viewRef.current = nextView;
      setActiveView(nextView);
      setViewMotion({ phase: "entering", direction });
      viewLeaveTimerRef.current = null;
      viewEnterTimerRef.current = window.setTimeout(() => {
        setViewMotion((current) => current.phase === "entering" ? { phase: "idle", direction } : current);
        viewEnterTimerRef.current = null;
      }, VIEW_MOTION_ENTER_MS);
    }, VIEW_MOTION_EXIT_MS);
  }, [clearViewMotionTimers]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const requestConfirm = useCallback((options: ConfirmDialogOptions) => new Promise<boolean>((resolve) => {
    if (confirmCloseTimerRef.current) {
      window.clearTimeout(confirmCloseTimerRef.current);
      confirmCloseTimerRef.current = null;
    }
    if (confirmDialogRef.current) confirmDialogRef.current.resolve(false);
    const request: ConfirmDialogState = {
      tone: "warn",
      confirmLabel: "Confirm",
      cancelLabel: "Cancel",
      ...options,
      id: confirmDialogIdRef.current += 1,
      resolve
    };
    confirmDialogRef.current = request;
    setConfirmDialog(request);
  }), []);

  const closeConfirmDialog = useCallback((confirmed: boolean) => {
    const request = confirmDialogRef.current;
    if (!request || request.closing) return;
    const closeDelay = prefersReducedMotion() ? 0 : CONFIRM_EXIT_MS;
    const closingRequest = { ...request, closing: true };
    confirmDialogRef.current = closingRequest;
    setConfirmDialog((current) => current?.id === request.id ? closingRequest : current);
    confirmCloseTimerRef.current = window.setTimeout(() => {
      confirmDialogRef.current = null;
      confirmCloseTimerRef.current = null;
      setConfirmDialog(null);
      request.resolve(confirmed);
    }, closeDelay);
  }, []);

  useEffect(() => {
    if (!confirmDialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeConfirmDialog(false);
      if ((event.key === "Enter" || event.key === " ") && event.metaKey) closeConfirmDialog(true);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeConfirmDialog, confirmDialog]);

  const stopBackdropSlotRoll = useCallback((finalCharacter?: DetectedCharacter | null) => {
    if (backdropSlotTimerRef.current) {
      window.clearTimeout(backdropSlotTimerRef.current);
      backdropSlotTimerRef.current = null;
    }
    if (finalCharacter) setBackgroundCharacter(finalCharacter);
    setBackdropSlotRolling(false);
  }, []);

  const startBackdropSlotRoll = useCallback((targetCharacter: DetectedCharacter, duration?: number) => {
    stopBackdropSlotRoll(null);
    const rollDuration = backdropSlotRollDuration(duration);
    const startedAt = performance.now();
    let tick = 0;
    const roll = () => {
      const progress = Math.min(1, (performance.now() - startedAt) / rollDuration);
      if (progress >= 1) {
        stopBackdropSlotRoll(targetCharacter);
        return;
      }

      tick += 1;
      setBackgroundCharacter(pickBackdropSlotCharacter(targetCharacter.id, tick));
      backdropSlotTimerRef.current = window.setTimeout(roll, backdropSlotRollDelay(progress));
    };

    setBackdropSlotRolling(true);
    roll();
  }, [stopBackdropSlotRoll]);

  const refreshStatus = useCallback(async () => {
    const s = await window.bd2.runtimeStatus();
    setStatus(s);
    return s;
  }, []);

  const scanLibrary = useCallback(
    async (dir: string) => {
      if (!dir) { setLibrary([]); return; }
      const mods = await window.bd2.runtimeListLibrary(dir);
      setLibrary(mods);
      log(`Scanned ${mods.length} mod(s).`);
    },
    [log]
  );

  useEffect(() => {
    void (async () => {
      try { setAppInfo(await window.bd2.getAppInfo()); } catch { /* ignore */ }
      try { setGameVersionInfo(await window.bd2.detectGameVersion()); } catch { /* ignore */ }
      try {
        const migration = await window.bd2.runtimeMigrationCheck();
        const signature = migrationSignature(migration);
        const dismissed = localStorage.getItem(MIGRATION_DISMISSED_KEY);
        setMigrationCheck(migration.needed && dismissed !== signature ? migration : null);
      } catch { /* ignore */ }
      await refreshStatus();
      const saved = localStorage.getItem(MODSDIR_KEY) ?? "";
      if (saved) { setModsDir(saved); await scanLibrary(saved); }
    })();
  }, [refreshStatus, scanLibrary]);

  useEffect(() => {
    return () => {
      if (pendingSpotlightTimerRef.current) window.clearTimeout(pendingSpotlightTimerRef.current);
      if (backdropSlotTimerRef.current) window.clearTimeout(backdropSlotTimerRef.current);
      if (confirmCloseTimerRef.current) window.clearTimeout(confirmCloseTimerRef.current);
      if (confirmDialogRef.current) confirmDialogRef.current.resolve(false);
      clearViewMotionTimers();
    };
  }, [clearViewMotionTimers]);

  useEffect(() => {
    const handleBackdropCharacter = (event: Event) => {
      const detail = (event as CustomEvent<LibraryBackdropCharacterDetail>).detail;
      if (!detail?.id) return;
      const nextCharacter = resolveBackdropCharacter(detail.id);
      if (detail.phase === "transition") {
        startBackdropSlotRoll(nextCharacter, detail.duration);
        return;
      }
      stopBackdropSlotRoll(nextCharacter);
    };

    window.addEventListener(LIBRARY_BACKDROP_CHARACTER_EVENT, handleBackdropCharacter);
    return () => window.removeEventListener(LIBRARY_BACKDROP_CHARACTER_EVENT, handleBackdropCharacter);
  }, [startBackdropSlotRoll, stopBackdropSlotRoll]);

  useEffect(() => {
    const syncBackdropParticles = () => {
      setBackdropParticlesEnabled(window.bdLibraryBackdrop?.getParticlesEnabled() ?? true);
    };
    const handleBackdropSettings = (event: Event) => {
      const detail = (event as CustomEvent<LibraryBackdropSettingsDetail>).detail;
      setBackdropParticlesEnabled(detail?.particlesEnabled ?? true);
    };

    syncBackdropParticles();
    const frame = window.requestAnimationFrame(syncBackdropParticles);
    window.addEventListener(LIBRARY_BACKDROP_SETTINGS_EVENT, handleBackdropSettings);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener(LIBRARY_BACKDROP_SETTINGS_EVENT, handleBackdropSettings);
    };
  }, []);

  const updateBackdropParticlesEnabled = useCallback((enabled: boolean) => {
    setBackdropParticlesEnabled(enabled);
    window.bdLibraryBackdrop?.setParticlesEnabled(enabled);
  }, []);

  const mountedMods = useMemo(() => status?.mountedMods ?? [], [status]);
  const mountedFolders = useMemo(() => new Set(mountedMods.map((m) => m.folder)), [mountedMods]);
  const isDesired = useCallback((folder: string) => desired[folder] ?? mountedFolders.has(folder), [desired, mountedFolders]);
  const modsEnabled = status?.modsEnabled ?? true;

  const visibleMods = useMemo(() => filterAndSortMods(library, modFilter, modSort, mountedFolders), [library, modFilter, modSort, mountedFolders]);

  const pendingChanges = useMemo(
    () => getRuntimePendingRows(library, mountedMods, isDesired),
    [library, mountedMods, isDesired]
  );
  const tones = useMemo(() => {
    const t: Record<string, PendingTone> = {};
    for (const c of pendingChanges) t[c.folder] = c.conflict ? "conflict" : c.enabled ? "added" : "removed";
    return t;
  }, [pendingChanges]);
  const hasConflict = useMemo(() => pendingChanges.some((c) => c.conflict), [pendingChanges]);

  const versionLocked = isGameVersionMismatch(appInfo, gameVersionInfo);
  const showVersionReleaseLink = isDetectedGameVersionMismatch(appInfo, gameVersionInfo);
  const injectionVersionLocked = isDetectedGameVersionMismatch(appInfo, gameVersionInfo);
  const injectionVersionLockMessage = formatInjectionVersionLockMessage(appInfo, gameVersionInfo);
  const appReady = Boolean(status?.appFound && status?.loaderAvailable);
  const injectionMissing = Boolean(status && appReady && !status.injected);
  const gameRunning = Boolean(status?.gameRunning);
  const backgroundCharacterCode = backgroundCharacter?.id ?? "------";
  const backgroundCharacterName = backgroundCharacter
    ? `${backgroundCharacter.character} · ${backgroundCharacter.costume}`
    : "Backdrop character loading";
  const backgroundCharacterTitle = backgroundCharacter
    ? `${backgroundCharacter.character}\n${backgroundCharacter.costume}\nCharacter ID ${backgroundCharacter.id}`
    : "Waiting for backdrop character";
  const injectionInstallLocked = busy || injectionVersionLocked;
  const injectionRemoveLocked = busy;
  const injectionInstallTitle = injectionVersionLocked
    ? injectionVersionLockMessage
    : busy
      ? "Action running"
      : "";
  const injectionRemoveTitle = busy ? "Action running" : "";
  const missingModsDir = !modsDir;
  const modsActionLocked = busy;
  const modsLocked = busy || versionLocked || !appReady || injectionMissing || missingModsDir;
  const modsLockReason = formatModsLockReason(versionLocked, appReady, injectionMissing, missingModsDir, modsActionLocked);
  const showMigrationPanel = Boolean(migrationCheck?.needed && !migrationDismissed);
  const useCanvasCartridges = tauriCanvasCartridges;

  const selectableVisibleMods = visibleMods;
  const allVisibleModsSelected = selectableVisibleMods.length > 0 && selectableVisibleMods.every((m) => isDesired(m.folder));
  const hasChanges = pendingChanges.some((c) => !c.implicit);

  const handleOpenGithubReleases = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void window.bd2.openExternal(BD_SPINEX_RELEASES_URL).catch(() => {
      window.open(BD_SPINEX_RELEASES_URL, "_blank", "noopener,noreferrer");
    });
  }, []);

  const registerCartNode = useCallback((folder: string, node: HTMLButtonElement | null) => {
    if (node) cartNodeRefs.current.set(folder, node);
    else cartNodeRefs.current.delete(folder);
  }, []);

  const spotlightPendingFolder = useCallback((folder: string) => {
    setSpotlitPendingFolder(folder);
    if (pendingSpotlightTimerRef.current) window.clearTimeout(pendingSpotlightTimerRef.current);
    pendingSpotlightTimerRef.current = window.setTimeout(() => {
      setSpotlitPendingFolder((current) => current === folder ? null : current);
      pendingSpotlightTimerRef.current = null;
    }, 1400);
  }, []);

  const scrollCartIntoView = useCallback((folder: string) => {
    const node = cartNodeRefs.current.get(folder);
    if (!node) return false;
    if (!isElementFullyInViewport(node)) {
      node.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "center",
        inline: "nearest"
      });
    }
    spotlightPendingFolder(folder);
    return true;
  }, [spotlightPendingFolder]);

  useEffect(() => {
    if (!pendingScrollTarget || view !== "library" || modView !== "grid") return;
    if (!library.some((mod) => mod.folder === pendingScrollTarget)) {
      setPendingScrollTarget(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (scrollCartIntoView(pendingScrollTarget)) setPendingScrollTarget(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [library, modView, pendingScrollTarget, scrollCartIntoView, view, visibleMods]);

  const handlePendingChangeClick = useCallback((folder: string) => {
    setHoveredPendingFolder(folder);
    setPendingScrollTarget(folder);
    spotlightPendingFolder(folder);
    if (view !== "library") navigateToView("library");
    if (modView !== "grid") {
      setModView("grid");
      localStorage.setItem(MODVIEW_KEY, "grid");
    }
    if (!visibleMods.some((mod) => mod.folder === folder) && library.some((mod) => mod.folder === folder)) {
      setModFilter("");
    }
    window.requestAnimationFrame(() => {
      if (scrollCartIntoView(folder)) setPendingScrollTarget(null);
    });
  }, [library, modView, navigateToView, scrollCartIntoView, spotlightPendingFolder, view, visibleMods]);

  const selectDir = useCallback(async () => {
    const dir = await window.bd2.selectDirectory();
    if (!dir) return;
    setModsDir(dir);
    localStorage.setItem(MODSDIR_KEY, dir);
    await scanLibrary(dir);
  }, [scanLibrary]);

  function updateDesired(folder: string, enabled: boolean) {
    setDesired((cur) => ({ ...cur, [folder]: enabled }));
  }
  function toggleVisible() {
    const enabled = !allVisibleModsSelected;
    setDesired((cur) => {
      const next = { ...cur };
      for (const m of selectableVisibleMods) next[m.folder] = enabled;
      return next;
    });
  }
  function resetChanges() {
    setDesired({});
    log("Reset staged changes.");
  }
  function refreshModsFolder() {
    void runTask(async () => {
      if (!modsDir) {
        log("Choose a Mods Folder before refreshing.", "warn");
        return;
      }
      await scanLibrary(modsDir);
    });
  }
  function updateModSort(key: ModSortKey) {
    setModSort((cur) => ({ key, direction: cur.key === key && cur.direction === "asc" ? "desc" : "asc" }));
  }
  function updateModView(next: ModView) {
    setModView(next);
    localStorage.setItem(MODVIEW_KEY, next);
  }
  function updateTheme(next: Theme) {
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
  }
  function updateAuthorColor(id: string, color: string) {
    setAuthorRules((cur) => {
      const next = cur.map((rule) => rule.id === id ? { ...rule, color } : rule);
      persistAuthorRules(next);
      return next;
    });
  }
  function addAuthorRule() {
    const name = newAuthorName.trim();
    if (!name) return;
    setAuthorRules((cur) => {
      const id = normalizeAuthorId(name) || `author_${cur.length + 1}`;
      if (cur.some((rule) => rule.id === id || normalizeForMatch(rule.name) === normalizeForMatch(name))) return cur;
      const next = [...cur, makeAuthorRule(id, name, AUTHOR_COLORS[cur.length % AUTHOR_COLORS.length], true)];
      persistAuthorRules(next);
      return next;
    });
    setNewAuthorName("");
  }
  const removeAuthorRule = useCallback((id: string) => {
    const rule = authorRules.find((item) => item.id === id);
    if (!rule?.custom) return;
    void (async () => {
      const confirmed = await requestConfirm({
        title: "Remove Author Label?",
        body: <>Remove <b>{rule.name}</b> from Author Labels. Existing cartridges will fall back to the default author matching rules.</>,
        confirmLabel: "Remove",
        tone: "danger"
      });
      if (!confirmed) return;
      setAuthorRules((cur) => {
        const next = cur.filter((item) => item.id !== id || !item.custom);
        persistAuthorRules(next);
        return next;
      });
    })();
  }, [authorRules, requestConfirm]);

  const resetAuthorRules = useCallback(() => {
    void (async () => {
      const confirmed = await requestConfirm({
        title: "Reset Author Labels?",
        body: "Restore the default Author Labels and remove every custom label you added.",
        confirmLabel: "Reset",
        tone: "danger"
      });
      if (!confirmed) return;
      setAuthorRules(DEFAULT_AUTHOR_RULES);
      persistAuthorRules(DEFAULT_AUTHOR_RULES);
    })();
  }, [requestConfirm]);

  const runTask = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try { await fn(); }
      catch (e) { log(`Error: ${String(e)}`, "err"); }
      finally { setBusy(false); await refreshStatus(); }
    },
    [log, refreshStatus]
  );

  const guardGameClosed = useCallback(async (actionLabel: string) => {
    try {
      const latest = await refreshStatus();
      if (!latest.gameRunning) return true;
      log(`${actionLabel} blocked: close BrownDust II first.`, "warn");
      await requestConfirm({
        title: "BrownDust II Is Running",
        body: `${actionLabel} cannot continue while BrownDust II is running. Close the game, then try again.`,
        confirmLabel: "OK",
        hideCancel: true,
        tone: "danger"
      });
      return false;
    } catch (error) {
      log(`Could not check game status: ${String(error)}`, "err");
      await requestConfirm({
        title: "Could Not Check Game Status",
        body: "BD-SpineX could not verify whether BrownDust II is running. Close the game, then try again.",
        confirmLabel: "OK",
        hideCancel: true,
        tone: "danger"
      });
      return false;
    }
  }, [log, refreshStatus, requestConfirm]);

  const installLoader = useCallback(() => {
    void (async () => {
      if (!(await guardGameClosed("Install Runtime Injection"))) return;
      if (injectionVersionLocked) {
        log(injectionVersionLockMessage, "err");
        return;
      }
      if (!window.confirm("Install Runtime Injection into the BrownDust II executable? Close the game before continuing.")) return;
      if (!(await guardGameClosed("Install Runtime Injection"))) return;
      void runTask(async () => {
        const r = await window.bd2.runtimeInstall();
        log(r.message, r.ok ? "ok" : "err");
      });
    })();
  }, [guardGameClosed, injectionVersionLocked, injectionVersionLockMessage, runTask, log]);

  const uninstallLoader = useCallback(() => {
    void (async () => {
      if (!(await guardGameClosed("Remove Runtime Injection"))) return;
      if (!window.confirm("Remove Runtime Injection and restore the original BrownDust II executable? Close the game before continuing.")) return;
      if (!(await guardGameClosed("Remove Runtime Injection"))) return;
      void runTask(async () => {
        const r = await window.bd2.runtimeUninstall();
        log(r.message, r.ok ? "ok" : "warn");
      });
    })();
  }, [guardGameClosed, runTask, log]);

  const toggleModPower = useCallback(() => {
    void (async () => {
      if (!(await guardGameClosed("Mod Power"))) return;
      const nextEnabled = !modsEnabled;
      const confirmed = await requestConfirm({
        title: nextEnabled ? "Restore Mod Power?" : "Turn Off Mod Power?",
        body: nextEnabled
          ? "Enable runtime mod loading again. Mounted files stay in place and will take effect when the game reads them."
          : "Disable all runtime mods without uninstalling mounted files. You can turn Mod Power back on later.",
        confirmLabel: nextEnabled ? "Turn On" : "Turn Off",
        tone: nextEnabled ? "warn" : "danger"
      });
      if (!confirmed) return;
      if (!(await guardGameClosed("Mod Power"))) return;
      void runTask(async () => {
        const r = await window.bd2.runtimeSetEnabled(!modsEnabled);
        log(r.message, r.ok ? "ok" : "err");
      });
    })();
  }, [guardGameClosed, requestConfirm, runTask, modsEnabled, log]);

  const applyChanges = useCallback(() => {
    void (async () => {
      if (modsLocked || pendingChanges.length === 0 || hasConflict) return;
      if (!(await guardGameClosed("Apply Changes"))) return;
      const mountCount = pendingChanges.filter((change) => change.enabled).length;
      const unmountCount = pendingChanges.length - mountCount;
      const confirmed = await requestConfirm({
        title: "Apply Changes?",
        body: (
          <>
            Apply <b>{pendingChanges.length}</b> staged change{pendingChanges.length === 1 ? "" : "s"}:
            {" "}<b>{mountCount}</b> mount, <b>{unmountCount}</b> unmount. Restart Brown Dust II after applying.
          </>
        ),
        confirmLabel: "Apply",
        tone: "warn"
      });
      if (!confirmed) return;
      if (!(await guardGameClosed("Apply Changes"))) return;
      void runTask(async () => {
        const byFolder = new Map(library.map((m) => [m.folder, m]));
        let mounted = 0, unmounted = 0;
        for (const c of pendingChanges.filter((c) => !c.enabled)) {
          const r = await window.bd2.runtimeUnmount(c.folder);
          log(`${r.message}${c.implicit ? " (auto)" : ""}`, r.ok ? "ok" : "warn");
          if (r.ok) unmounted++;
        }
        for (const c of pendingChanges.filter((c) => c.enabled)) {
          const mod = byFolder.get(c.folder);
          if (!mod) continue;
          const r = await window.bd2.runtimeMount(mod.path, mod.folder);
          log(r.message, r.ok ? "ok" : "err");
          if (r.ok) mounted++;
        }
        setDesired({});
        log(`Applied: ${mounted} mounted, ${unmounted} unmounted. Restart the game to apply changes.`, "ok");
        if (mounted > 0 && !status?.injected) {
          log("Runtime Injection is not installed yet. Mounted mods will not take effect until injection is installed.", "warn");
        }
      });
    })();
  }, [guardGameClosed, requestConfirm, runTask, modsLocked, pendingChanges, hasConflict, status, library, log]);

  const restoreAll = useCallback(() => {
    void (async () => {
      if (!(await guardGameClosed("Restore All"))) return;
      if (mountedMods.length === 0) {
        await requestConfirm({
          title: "Nothing To Restore",
          body: "There are no mounted runtime mods to unmount right now.",
          confirmLabel: "OK",
          hideCancel: true,
          tone: "info"
        });
        return;
      }
      const confirmed = await requestConfirm({
        title: "Restore All Mounted Mods?",
        body: (
          <>
            Unmount all <b>{mountedMods.length}</b> mounted mod{mountedMods.length === 1 ? "" : "s"}. Runtime Injection stays installed, and your source Mods Folder will not be changed.
          </>
        ),
        confirmLabel: "Restore All",
        tone: "danger"
      });
      if (!confirmed) return;
      if (!(await guardGameClosed("Restore All"))) return;
      void runTask(async () => {
        for (const m of mountedMods) {
          const r = await window.bd2.runtimeUnmount(m.folder);
          log(r.message, r.ok ? "ok" : "warn");
        }
        const p = await window.bd2.runtimeSetEnabled(true);
        log(p.message, p.ok ? "ok" : "warn");
        setDesired({});
      });
    })();
  }, [guardGameClosed, requestConfirm, runTask, mountedMods, log]);

  const launchGame = useCallback(() => {
    void runTask(async () => {
      const r = await window.bd2.runtimeLaunch();
      log(r.message, r.ok ? "ok" : "err");
    });
  }, [runTask, log]);

  function logMigrationResult(r: Awaited<ReturnType<typeof window.bd2.runtimeMigrateLegacy>>) {
    log(r.message, r.ok ? "ok" : "err");
    if (r.restoredBundles.length) log(`Restored clean __data for ${r.restoredBundles.length} bundle(s).`, "ok");
    if (r.mountedMods.length) log(`Mounted migrated mod(s): ${r.mountedMods.slice(0, 6).join(", ")}${r.mountedMods.length > 6 ? " ..." : ""}`, "ok");
    if (r.missingMods.length) log(`Missing source mod folder(s): ${r.missingMods.join(", ")}`, "warn");
    for (const err of r.errors.slice(0, 6)) log(err, "err");
  }

  function finishMigrationChoice() {
    setMigrationCheck(null);
    setMigrationDismissed(true);
  }

  const chooseNoMigration = useCallback(() => {
    window.alert("No changes will be made. You can keep using BD-SpineX. If you want clean __data files later, reinstall BrownDust II in PlayCover.");
    if (migrationCheck) {
      localStorage.setItem(MIGRATION_DISMISSED_KEY, migrationSignature(migrationCheck));
    }
    finishMigrationChoice();
  }, [migrationCheck]);

  const runLegacyUnpatch = useCallback(() => {
    void (async () => {
      if (!window.confirm("Restore clean __data from legacy backups and remove old patch index/history data? Runtime Injection and runtime mods will not be installed.")) return;
      setMigrationRunning(true);
      setBusy(true);
      try {
        const r = await window.bd2.runtimeUnpatchLegacy();
        logMigrationResult(r);
        if (r.ok) finishMigrationChoice();
        await refreshStatus();
      } catch (e) {
        log(`Unpatch error: ${String(e)}`, "err");
      } finally {
        setMigrationRunning(false);
        setBusy(false);
      }
    })();
  }, [log, refreshStatus]);

  const runLegacyMigration = useCallback(() => {
    void (async () => {
      if (!modsDir) {
        log("Choose a Mods Folder before migrating legacy patches.", "warn");
        return;
      }
      if (!window.confirm("BD-SpineX found legacy __data patches. It will restore clean __data, install Runtime Injection, mount the previously patched mods, then remove old patch index/history data. Continue?")) {
        return;
      }
      setMigrationRunning(true);
      setBusy(true);
      try {
        const r = await window.bd2.runtimeMigrateLegacy(modsDir);
        logMigrationResult(r);
        if (r.ok) finishMigrationChoice();
        await refreshStatus();
        if (modsDir) await scanLibrary(modsDir);
      } catch (e) {
        log(`Migration error: ${String(e)}`, "err");
      } finally {
        setMigrationRunning(false);
        setBusy(false);
      }
    })();
  }, [modsDir, log, refreshStatus, scanLibrary]);

  // ===== view fragments =====
  const activeNav = VISIBLE_NAV_ITEMS.find((n) => n.key === view) ?? VISIBLE_NAV_ITEMS[0];

  const globalBanners = (
    <div className="bannerStack">
      {versionLocked && (
        <div className="errorPill">Version mismatch: this manager supports {appInfo.supportedGameVersion}, but the detected game version is {gameVersionInfo?.version ?? "unknown"}. Use the matching BD-SpineX release.</div>
      )}
      {status && !status.appFound && (<div className="errorPill">Could not find BrownDust II in PlayCover.</div>)}
      {status && !status.loaderAvailable && (<div className="errorPill">Runtime loader is missing. In development mode, run npm run tauri:prepare first.</div>)}
      {gameRunning && (
        <div className="warningPill">BrownDust II is running. Close the game before installing or removing Runtime Injection.</div>
      )}
      {showMigrationPanel && migrationCheck && (
        <section className="panel migrationPanel">
          <div>
            <div className="inheritHistoryTitle">Legacy Patch Migration</div>
            <div className="inheritHistoryText">
              BD-SpineX found legacy Patch __data records from {migrationCheck.sourceVersions.join(", ")}. Choose how much cleanup to perform now. You can continue using the app with any option.
            </div>
            <div className="inheritHistoryText">
              {migrationCheck.modNames.length} previously patched mod(s) detected. Do Nothing keeps files as-is; Unpatch Only restores clean __data and removes old patch records; Migrate also installs Runtime Injection and mounts matching mods from your Mods Folder.
            </div>
          </div>
          <div className="migrationActions">
            <button disabled={busy || migrationRunning} onClick={chooseNoMigration} type="button">
              Do Nothing
            </button>
            <button disabled={busy || migrationRunning || gameRunning} onClick={runLegacyUnpatch} type="button">
              Unpatch Only
            </button>
            <button disabled={busy || migrationRunning || !modsDir || gameRunning} onClick={runLegacyMigration} type="button">
              Migrate
            </button>
          </div>
        </section>
      )}
    </div>
  );

  const pendingDiffDock = pendingChanges.length > 0 ? (
    <aside className={`pendingDiffDock ${hasConflict ? "has-conflict" : ""}`} role="status" aria-live="polite" aria-label="Pending changes">
      <div className="pendingDiffHead">
        <span>Pending Changes</span>
        <strong>{pendingChanges.length}</strong>
      </div>
      <div className="pendingDiffList">
        {pendingChanges.map((c) => {
          const active = hoveredPendingFolder === c.folder || spotlitPendingFolder === c.folder;
          return (
            <button
              key={c.folder}
              type="button"
              className={`pendingDiffItem ${formatPendingToneClass(tones[c.folder])} ${active ? "is-active" : ""}`}
              title={`${c.folder}\nClick to locate cartridge`}
              onMouseEnter={() => setHoveredPendingFolder(c.folder)}
              onMouseLeave={() => setHoveredPendingFolder((current) => current === c.folder ? null : current)}
              onFocus={() => setHoveredPendingFolder(c.folder)}
              onBlur={() => setHoveredPendingFolder((current) => current === c.folder ? null : current)}
              onClick={() => handlePendingChangeClick(c.folder)}
            >
              <span className="pendingDiffColor" aria-hidden="true" />
              <span className="pendingDiffName">{formatFolderName(c.folder)}</span>
            </button>
          );
        })}
      </div>
    </aside>
  ) : null;

  const logCounts = useMemo(() => {
    let ok = 0, warn = 0, err = 0;
    for (const e of logs) {
      if (e.tone === "warn") warn++;
      else if (e.tone === "err") err++;
      else ok++;
    }
    return { ok, warn, err };
  }, [logs]);
  const filteredLogs = useMemo(() => {
    if (logFilter === "all") return logs;
    if (logFilter === "ok") return logs.filter((e) => !e.tone || e.tone === "ok");
    return logs.filter((e) => e.tone === logFilter);
  }, [logs, logFilter]);
  const copyLogs = useCallback(() => {
    const text = logs.map((e) => `${e.time}  ${e.message}`).join("\n");
    navigator.clipboard?.writeText(text).then(() => log("Log copied to clipboard.", "ok")).catch(() => {});
  }, [logs, log]);
  const clearLogs = useCallback(() => setLogs([createLogEntry("Log cleared.")]), []);

  const logView = (
    <section className="panel logPanel logPage">
      <div className="lgTools">
        <div className="lgChips">
          <span className="lgChip ok"><i aria-hidden="true" /><b>{logCounts.ok}</b> OK</span>
          <span className="lgChip warn"><i aria-hidden="true" /><b>{logCounts.warn}</b> Warn</span>
          <span className="lgChip err"><i aria-hidden="true" /><b>{logCounts.err}</b> Err</span>
        </div>
        <span className="lgSpace" />
        <div className="segmentedControl lgFilter" role="tablist" aria-label="Log filter">
          {(["all", "ok", "warn", "err"] as const).map((f) => (
            <button key={f} type="button" className={logFilter === f ? "active" : ""} onClick={() => setLogFilter(f)} aria-pressed={logFilter === f}>
              <span>{f === "all" ? "All" : f === "ok" ? "OK" : f === "warn" ? "Warn" : "Err"}</span>
            </button>
          ))}
        </div>
        <button type="button" className="lgBtn" onClick={copyLogs} disabled={logs.length === 0}>Copy</button>
        <button type="button" className="lgBtn" onClick={clearLogs}>Clear</button>
      </div>
      <div className="lgConsole">
        <div className="lgStream logStream" role="log" aria-live="polite">
          {filteredLogs.length === 0 ? (
            <div className="lgEmpty">No entries.</div>
          ) : filteredLogs.map((entry) => {
            const tone = entry.tone === "warn" ? "warn" : entry.tone === "err" ? "err" : "ok";
            return (
              <div key={entry.id} className={`lgRow ${tone}`}>
                <span className="lgMark" aria-hidden="true" />
                <span className="lgTime">{entry.time}</span>
                <span className="lgMsg">{entry.message}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );

  const libraryView = (
    <>
      <section className="scanGrid libraryFlow">
        <div className="panel tablePanel modsPanel cartridgePanel">
          <div className="modsHeader cartridgeToolbar">
            <div className="cartridgeToolbarIntro">
              <div className="panelTitle titleWithHelp">
                <span>Cartridges</span>
                <HelpButton title="Mod cartridges">
                  Click a cartridge to stage it. Click a mounted cartridge to stage removal. Gold contact pins mean mounted. Green means mount, red means remove, and purple means conflict. Use List when you want sorting.
                </HelpButton>
              </div>
              <div className="tableHint">{visibleMods.length} shown / {library.length} scanned</div>
            </div>
            <div className="cartridgeToolbarModes">
              <div className="modViewToggle segmentedControl" role="tablist" aria-label="Mod view">
                <button className={modView === "grid" ? "active" : ""} onClick={() => updateModView("grid")} type="button" aria-pressed={modView === "grid"}>
                  <span>Cartridges</span>
                </button>
                <button className={modView === "list" ? "active" : ""} onClick={() => updateModView("list")} type="button" aria-pressed={modView === "list"}>
                  <span>List</span>
                </button>
              </div>
            </div>
            <div className="modsHeaderControls cartridgeToolbarActions">
              <label className="modFilterField">
                <span>Filter</span>
                <input value={modFilter} onChange={(e) => setModFilter(e.target.value)} placeholder="Search folder, key, category, status" />
              </label>
              <button disabled={modsLocked || selectableVisibleMods.length === 0} onClick={toggleVisible} title={allVisibleModsSelected ? "Clear all visible" : "Select all visible"} type="button">
                {allVisibleModsSelected ? "Clear All" : "Select All"}
              </button>
              <button disabled={busy || !modsDir} onClick={refreshModsFolder} title="Scan the selected Mods Folder again" type="button">
                Refresh Mods
              </button>
              <button disabled={busy || modsLocked || !hasChanges} onClick={resetChanges} title="Reset staged changes before applying" type="button">
                Reset Changes
              </button>
            </div>
          </div>

          <div className={`modsTableFrame ${modView === "grid" ? "is-grid" : "is-list"} ${modsLocked ? "locked" : ""}`}>
            {modView === "grid" ? (
              <div className={`cartShelf cartShelf--collector ${useCanvasCartridges ? "cartShelf--canvas" : ""}`}>
                {library.length === 0 ? (
                  <div className="cartEmpty">{modsDir ? "No mods found." : "Choose a Mods Folder in Settings to load your cartridges."}</div>
                ) : visibleMods.length === 0 ? (
                  <div className="cartEmpty">No mods match this filter.</div>
                ) : visibleMods.map((mod) => {
                  const CartComp = useCanvasCartridges ? CanvasCartridge : CartridgeRealistic;
                  const pendingLinked = hoveredPendingFolder === mod.folder || spotlitPendingFolder === mod.folder;
                  return (
                    <CartComp
                      key={mod.path}
                      mod={mod}
                      have={mountedFolders.has(mod.folder)}
                      selected={isDesired(mod.folder)}
                      tone={tones[mod.folder]}
                      locked={modsLocked}
                      lockedReason={modsLocked ? modsLockReason : undefined}
                      onToggle={() => updateDesired(mod.folder, !isDesired(mod.folder))}
                      authorRules={authorRules}
                      buttonRef={(node) => registerCartNode(mod.folder, node)}
                      isPendingLinked={pendingLinked}
                      isPendingTarget={spotlitPendingFolder === mod.folder}
                      onPreview={() => openInPreview(detectModCharacter(mod)?.character ?? formatFolderName(mod.folder), mod)}
                    />
                  );
                })}
                {modsLocked && (
                  <div className="cartShelfLockOverlay" role="status">
                    <div className="cartShelfLockCard">
                      <strong>Mod actions locked</strong>
                      <span>{modsLockReason}</span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
            <table>
              <colgroup>
                <col className="patchCol" />
                <col className="folderCol" />
                <col className="nameCol" />
                <col className="categoryCol" />
                <col className="statusCol" />
              </colgroup>
              <thead>
                <tr>
                  <th className="patchColumn">
                    <div className="patchBulkControls" aria-label="Bulk selection">
                      <button disabled={modsLocked || selectableVisibleMods.length === 0} onClick={toggleVisible} title={allVisibleModsSelected ? "Clear all visible" : "Select all visible"} type="button">
                        {allVisibleModsSelected ? "×" : "✓"}
                      </button>
                    </div>
                  </th>
                  <th>{renderModSortButton("Folder", "folder", modSort, updateModSort)}</th>
                  <th>{renderModSortButton("Key", "name", modSort, updateModSort)}</th>
                  <th>{renderModSortButton("Category", "category", modSort, updateModSort)}</th>
                  <th>{renderModSortButton("Status", "status", modSort, updateModSort)}</th>
                </tr>
              </thead>
              <tbody>
                {library.length === 0 ? (
                  <tr><td colSpan={5} className="empty">{modsDir ? "No mods found." : "Choose a Mods Folder in Settings to load your cartridges."}</td></tr>
                ) : visibleMods.length === 0 ? (
                  <tr><td colSpan={5} className="empty">No mods match this filter.</td></tr>
                ) : visibleMods.map((mod) => {
                  const tone = tones[mod.folder];
                  const have = mountedFolders.has(mod.folder);
                  const category = typeToCategory(mod.type);
                  const folderName = formatFolderName(mod.folder);
                  const pendingLinked = hoveredPendingFolder === mod.folder || spotlitPendingFolder === mod.folder;
                  return (
                    <tr key={mod.path} className={`${tone ? `pendingPatchChange ${formatPendingToneClass(tone)}` : ""} ${pendingLinked ? "is-pending-linked" : ""}`}>
                      <td className="patchColumn">
                        <input
                          aria-label={`Mount ${mod.folder}`}
                          type="checkbox"
                          checked={isDesired(mod.folder)}
                          disabled={modsLocked}
                          onChange={(e) => updateDesired(mod.folder, e.target.checked)}
                        />
                      </td>
                      <td className="folderCell" title={mod.folder}>{folderName}</td>
                      <td title={mod.key}><code>{mod.key}</code></td>
                      <td><span className={`categoryBadge ${category}`}>{category}</span></td>
                      <td title={mod.skeleton === "skel" ? "Binary .skel file. BD-SpineX converts it to .json while mounting when possible." : ""}>
                        <span className={`badge ${have ? "patched" : "ready"}`}>{have ? "mounted" : "available"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            )}
            {modsLocked && modView === "list" && (
              <div className="modsLockOverlay" aria-hidden="true">
                <span>{modsLockReason}</span>
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );

  const stats = useMemo(() => {
    const authorMap = new Map<string, { id: string; name: string; color: string; count: number }>();
    const charMap = new Map<string, { id: string; name: string; count: number }>();
    const catCount: Record<ModCategory, number> = { char: 0, dating: 0, cutscene: 0, other: 0 };
    for (const mod of library) {
      const a = detectModAuthor(mod, authorRules);
      const ae = authorMap.get(a.id);
      if (ae) ae.count++; else authorMap.set(a.id, { id: a.id, name: a.name, color: a.color, count: 1 });
      catCount[typeToCategory(mod.type)]++;
      const ch = detectModCharacter(mod);
      if (ch) {
        const ce = charMap.get(ch.id);
        if (ce) ce.count++; else charMap.set(ch.id, { id: ch.id, name: ch.character, count: 1 });
      }
    }
    const authors = [...authorMap.values()].sort((x, y) => y.count - x.count);
    const characters = [...charMap.values()].sort((x, y) => y.count - x.count);
    const catLabels: Record<ModCategory, string> = { char: "Character", cutscene: "Cutscene", dating: "Dating", other: "NPC" };
    const categories = (["char", "cutscene", "dating", "other"] as ModCategory[]).map((key) => ({ key, label: catLabels[key], count: catCount[key] }));
    const topAuthors = authors.slice(0, 5).map((a) => ({ id: a.id, name: a.name, count: a.count }));
    const restCount = authors.slice(5).reduce((sum, a) => sum + a.count, 0);
    if (restCount > 0) topAuthors.push({ id: "__others", name: "Others", count: restCount });
    return {
      authors,
      characters,
      categories,
      topAuthors,
      maxChar: characters.length ? characters[0].count : 1,
      maxAuthor: topAuthors.length ? Math.max(...topAuthors.map((a) => a.count)) : 1,
      maxCat: Math.max(1, ...categories.map((c) => c.count))
    };
  }, [library, authorRules]);

  const roster = useMemo(() => {
    const modGroups = new Map<string, { mods: RuntimeMod[]; imageId: string }>();
    for (const mod of library) {
      const ch = detectModCharacter(mod);
      if (!ch?.character) continue;
      const g = modGroups.get(ch.character);
      if (g) g.mods.push(mod);
      else modGroups.set(ch.character, { mods: [mod], imageId: ch.imageId });
    }
    const meta = new Map<string, string | null>();
    for (const c of CHARACTER_ASSETS.characters) {
      const id = (Array.isArray(c.id) ? c.id : [c.id])[0];
      if (!meta.has(c.character)) meta.set(c.character, c.standing ? id : null);
      else if (c.standing && !meta.get(c.character)) meta.set(c.character, id);
    }
    const names = new Set<string>([...meta.keys(), ...modGroups.keys()]);
    return [...names].map((name) => {
      const g = modGroups.get(name);
      return { name, count: g?.mods.length ?? 0, mods: g?.mods ?? [], imageId: g?.imageId ?? meta.get(name) ?? null };
    });
  }, [library]);

  const rosterList = useMemo(() => {
    const q = rosterSearch.trim().toLowerCase();
    let list = q ? roster.filter((c) => c.name.toLowerCase().includes(q)) : roster;
    if (rosterMode === "modded") list = list.filter((c) => c.count > 0);
    return [...list].sort(rosterMode === "az"
      ? (a, b) => a.name.localeCompare(b.name)
      : (a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [roster, rosterSearch, rosterMode]);

  useLayoutEffect(() => {
    if (view !== "roster") return;
    const grid = rosterGridRef.current;
    if (!grid) return;

    const updateColumns = () => {
      const columns = getComputedStyle(grid).gridTemplateColumns
        .split(" ")
        .filter((track) => track && track !== "none").length;
      setRosterColumns(Math.max(1, columns));
    };

    updateColumns();
    const observer = new ResizeObserver(updateColumns);
    observer.observe(grid);
    window.addEventListener("resize", updateColumns);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateColumns);
    };
  }, [rosterList.length, view]);

  const rosterRows = useMemo(() => chunkRows(rosterList, rosterColumns), [rosterList, rosterColumns]);

  const pvChars = useMemo(() => roster.filter((c) => c.count > 0), [roster]);
  const pvFilteredChars = useMemo(() => {
    const q = pvCharSearch.trim().toLowerCase();
    return q ? pvChars.filter((c) => c.name.toLowerCase().includes(q)) : pvChars;
  }, [pvChars, pvCharSearch]);
  const pvCurrentChar = useMemo(() => pvChars.find((c) => c.name === pvChar) ?? null, [pvChars, pvChar]);
  const pvFocusedSlot: PreviewSlotKey = pvMode === "dual" && pvFocus === "b" ? "b" : "a";
  const pvFocusedMod = pvFocusedSlot === "b" ? pvSlotB : pvSlotA;
  const pvFocusedAnimLayers = pvAnimLayers[pvFocusedSlot];
  const pvFocusedInfo = pvRuntime[pvFocusedSlot];
  const pvFilteredParts = useMemo(() => {
    const q = pvPartSearch.trim().toLowerCase();
    return q ? pvFocusedInfo.parts.filter((part) => part.name.toLowerCase().includes(q)) : pvFocusedInfo.parts;
  }, [pvFocusedInfo.parts, pvPartSearch]);
  const handlePvRuntimeChange = useCallback((slot: PreviewSlotKey, info: PreviewRuntimeInfo) => {
    setPvRuntime((current) => ({ ...current, [slot]: info }));
  }, []);
  const setPreviewPartAlpha = useCallback((slot: PreviewSlotKey, name: string, alpha: number) => {
    pvControlsRef.current[slot]?.setPartAlpha(name, alpha);
    setPvRuntime((current) => ({
      ...current,
      [slot]: {
        ...current[slot],
        parts: current[slot].parts.map((part) => part.name === name ? { ...part, alpha } : part)
      }
    }));
  }, []);
  const replacePreviewMod = useCallback((slot: PreviewSlotKey, mod: RuntimeMod | null) => {
    if (slot === "b") setPvSlotB(mod);
    else setPvSlotA(mod);
    setPvAnimLayers((current) => ({ ...current, [slot]: [] }));
    setPvActiveAnimLayerId((current) => ({ ...current, [slot]: null }));
    if (!mod) {
      pvControlsRef.current[slot] = null;
      setPvRuntime((current) => ({ ...current, [slot]: emptyPreviewRuntimeInfo() }));
    }
  }, []);
  const setDefaultPreviewAnimation = useCallback((slot: PreviewSlotKey, animation: string) => {
    const layer = createPreviewAnimLayer(animation, 0);
    setPvAnimLayers((current) => current[slot].length > 0 ? current : {
      ...current,
      [slot]: [layer]
    });
    setPvActiveAnimLayerId((current) => current[slot] ? current : {
      ...current,
      [slot]: layer.id
    });
  }, []);
  const selectPreviewAnimLayer = useCallback((slot: PreviewSlotKey, layerId: string) => {
    setPvActiveAnimLayerId((current) => ({ ...current, [slot]: layerId }));
  }, []);
  const addPreviewAnimLayer = useCallback((slot: PreviewSlotKey) => {
    const info = pvRuntime[slot];
    if (info.status !== "ready" || info.animations.length === 0) return;
    const existing = pvAnimLayers[slot];
    const used = new Set(existing.map((layer) => layer.animation));
    const animation = info.animations.find((item) => !used.has(item.name))?.name ?? info.animations[0].name;
    const nextTrack = existing.reduce((max, layer) => Math.max(max, layer.trackIndex), -1) + 1;
    const layer = createPreviewAnimLayer(animation, nextTrack);
    setPvAnimLayers((current) => {
      return { ...current, [slot]: [...existing, layer] };
    });
    setPvActiveAnimLayerId((active) => ({ ...active, [slot]: layer.id }));
  }, [pvAnimLayers, pvRuntime]);
  const removePreviewAnimLayer = useCallback((slot: PreviewSlotKey, layerId: string) => {
    const nextActiveLayer = pvAnimLayers[slot]
      .filter((layer) => layer.id !== layerId || layer.trackIndex === 0)
      .map((layer, index) => ({ ...layer, trackIndex: index }))[0]?.id ?? null;
    setPvAnimLayers((current) => {
      const nextLayers = current[slot]
        .filter((layer) => layer.id !== layerId || layer.trackIndex === 0)
        .map((layer, index) => ({ ...layer, trackIndex: index }));
      return { ...current, [slot]: nextLayers };
    });
    setPvActiveAnimLayerId((active) => active[slot] === layerId ? { ...active, [slot]: nextActiveLayer } : active);
  }, [pvAnimLayers]);
  const setPreviewAnimLayerAnimation = useCallback((slot: PreviewSlotKey, layerId: string, animation: string) => {
    pvControlsRef.current[slot]?.setAnimationLayer(layerId, animation);
    setPvAnimLayers((current) => ({
      ...current,
      [slot]: current[slot].map((layer) => layer.id === layerId ? { ...layer, animation } : layer)
    }));
  }, []);
  const setPreviewAnimLayerAlpha = useCallback((slot: PreviewSlotKey, layerId: string, alpha: number) => {
    const clamped = Math.max(0, Math.min(1, alpha));
    pvControlsRef.current[slot]?.setAnimationLayerAlpha(layerId, clamped);
    setPvAnimLayers((current) => ({
      ...current,
      [slot]: current[slot].map((layer) => layer.id === layerId ? { ...layer, alpha: clamped } : layer)
    }));
  }, []);
  const getPreviewModMountLockReason = useCallback((mod: RuntimeMod) => {
    const wouldStageMount = !isDesired(mod.folder);
    const alreadyMounted = mountedFolders.has(mod.folder);
    if (wouldStageMount && !alreadyMounted && mod.skeleton === "unknown") {
      return "Missing .json or .skel skeleton file";
    }
    return "";
  }, [isDesired, mountedFolders]);
  function stagePreviewModSelection(mod: RuntimeMod) {
    if (modsLocked) {
      log(modsLockReason || "Mod selection is locked.", "warn");
      return;
    }
    const mountLockReason = getPreviewModMountLockReason(mod);
    if (mountLockReason) {
      log(`${formatFolderName(mod.folder)} cannot be mounted: ${mountLockReason}.`, "warn");
      return;
    }
    const enabled = !isDesired(mod.folder);
    updateDesired(mod.folder, enabled);
    setHoveredPendingFolder(mod.folder);
    setPendingScrollTarget(mod.folder);
    spotlightPendingFolder(mod.folder);
    if (!visibleMods.some((visibleMod) => visibleMod.folder === mod.folder) && library.some((libraryMod) => libraryMod.folder === mod.folder)) {
      setModFilter("");
    }
    log(`${enabled ? "Staged" : "Cleared"} ${formatFolderName(mod.folder)} from Preview.`, enabled ? "ok" : undefined);
  }
  const loadPreviewMod = (mod: RuntimeMod) => {
    replacePreviewMod(pvFocusedSlot, mod);
  };
  const switchPreviewMode = (mode: "single" | "dual") => {
    setPvMode(mode);
    if (mode === "single") {
      setPvFocus("a");
      replacePreviewMod("b", null);
    }
  };
  const openInPreview = (name: string, mod?: RuntimeMod) => {
    const target = mod ?? roster.find((c) => c.name === name)?.mods[0] ?? null;
    setPvChar(name);
    replacePreviewMod("a", target);
    replacePreviewMod("b", null);
    setPvMode("single");
    setPvFocus("a");
    navigateToView("preview");
  };
  const renderPvStage = (slot: PreviewSlotKey) => {
    const mod = slot === "b" ? pvSlotB : pvSlotA;
    const ch = mod ? detectModCharacter(mod) : null;
    const info = pvRuntime[slot];
    const ready = info.status === "ready";
    const layers = pvAnimLayers[slot];
    const activeLayer = layers.find((layer) => layer.id === pvActiveAnimLayerId[slot]) ?? layers[0] ?? null;
    return (
      <div className={`pvStage ${pvFocus === slot ? "focus" : ""}`} onClick={() => setPvFocus(slot)}>
        <span className={`pvTag ${slot}`}>{slot.toUpperCase()}</span>
        <div className="pvField">
          <span className="pvReg" style={{ left: 10, top: 10 }} />
          <PreviewSpineRenderer mod={mod} animationLayers={pvAnimLayers[slot]} layoutKey={pvMode} slot={slot} controlsRef={pvControlsRef} onStateChange={handlePvRuntimeChange} onDefaultAnimation={setDefaultPreviewAnimation} />
          {!mod && (
            <div className="pvEmpty2">Select a mod</div>
          )}
          {mod && info.status === "loading" && <div className="pvLoad">Loading Spine…</div>}
          {mod && info.status === "error" && <div className="pvErr"><b>Preview failed</b><span>{info.error}</span></div>}
          {mod && <span className="pvName">{ch?.character ?? "Mod"} · {formatFolderName(mod.folder)}</span>}
          {mod && (
            <button type="button" className="pvClear" onClick={(e) => { e.stopPropagation(); replacePreviewMod(slot, null); }} aria-label="Clear stage">×</button>
          )}
        </div>
        <div className="pvPlay" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="pvTb play"
            disabled={!ready}
            title="Play / pause"
            onClick={() => pvControlsRef.current[slot]?.togglePlayback()}
          >
            {info.playing ? "Ⅱ" : "▶"}
          </button>
          <label className="pvSel pvTrackWrap">
            <span>Track</span>
            <select
              className="pvSelect"
              disabled={!ready || layers.length === 0}
              value={activeLayer?.id ?? ""}
              onChange={(event) => selectPreviewAnimLayer(slot, event.target.value)}
              aria-label={`Preview ${slot.toUpperCase()} animation track`}
            >
              {layers.length === 0 ? <option value="">T0</option> : layers.map((layer) => (
                <option key={layer.id} value={layer.id}>T{layer.trackIndex}</option>
              ))}
            </select>
          </label>
          <label className="pvSel pvSelectWrap">
            <span>Anim</span>
            <select
              className="pvSelect"
              disabled={!ready || info.animations.length === 0 || !activeLayer}
              value={activeLayer?.animation ?? ""}
              onChange={(event) => {
                const animation = event.target.value;
                if (!activeLayer) return;
                setPreviewAnimLayerAnimation(slot, activeLayer.id, animation);
              }}
              aria-label={`Preview ${slot.toUpperCase()} animation`}
            >
              {info.animations.length === 0 ? <option value="">none</option> : info.animations.map((animation) => (
                <option key={animation.name} value={animation.name}>{animation.name}</option>
              ))}
            </select>
          </label>
          <label className="pvSel pvSelectWrap">
            <span>Skin</span>
            <select
              className="pvSelect"
              disabled={!ready || info.skins.length === 0}
              value={info.selectedSkin}
              onChange={(event) => pvControlsRef.current[slot]?.setSkin(event.target.value)}
              aria-label={`Preview ${slot.toUpperCase()} skin`}
            >
              {info.skins.length === 0 ? <option value="">default</option> : info.skins.map((skin) => (
                <option key={skin.name} value={skin.name}>{skin.name}</option>
              ))}
            </select>
          </label>
          <span className="pvScrub"><i style={{ width: `${Math.max(0, Math.min(100, info.progress))}%` }} /></span>
          <label className="pvSel pvSpeed">
            <span>Speed</span>
            <select
              className="pvSelect"
              disabled={!ready}
              value={info.speed}
              onChange={(event) => pvControlsRef.current[slot]?.setSpeed(Number(event.target.value))}
              aria-label={`Preview ${slot.toUpperCase()} speed`}
            >
              {PREVIEW_SPEED_OPTIONS.map((speed) => (
                <option key={speed} value={speed}>{speed}×</option>
              ))}
            </select>
          </label>
          <button type="button" className="pvTb" disabled={!ready} title="Reset view" onClick={() => pvControlsRef.current[slot]?.resetView()}>⌖</button>
        </div>
      </div>
    );
  };

  const previewView = (
    <div className="pvView">
      <div className="pvBar">
        <span className="pvTitle">Preview</span>
        <span className="pvCrumb">{pvFocusedMod ? <>▶ Previewing <b>{detectModCharacter(pvFocusedMod)?.character ?? formatFolderName(pvFocusedMod.folder)}</b></> : "Pick a character, then a mod"}</span>
        <span className="pvSp" />
        <div className="segmentedControl rstSort pvModeSeg" role="tablist" aria-label="Preview mode">
          <button type="button" className={pvMode === "single" ? "active" : ""} onClick={() => switchPreviewMode("single")} aria-pressed={pvMode === "single"}><span>Single</span></button>
          <button type="button" className={pvMode === "dual" ? "active" : ""} onClick={() => switchPreviewMode("dual")} aria-pressed={pvMode === "dual"}><span>Dual · 比較</span></button>
        </div>
      </div>
      <div className="pvTop">
        <div className="pvFinder">
          <div className="pvSearchRow pvFinderSearch"><input value={pvCharSearch} onChange={(e) => setPvCharSearch(e.target.value)} placeholder="Search characters…" spellCheck={false} aria-label="Search character" /></div>
          <div className="pvCol pvCharCol">
            <div className="pvColHd"><span className="tc">角色</span> Chars</div>
            <div className="pvList">
              {pvFilteredChars.length === 0 ? (
                <div className="pvHint">{library.length === 0 ? "Load a Mods Folder" : "No modded characters"}</div>
              ) : pvFilteredChars.map((c) => (
                <button key={c.name} type="button" className={`pvItem char ${pvChar === c.name ? "on" : ""}`} onClick={() => setPvChar(c.name)} title={`${c.name} · ${c.count} mod${c.count === 1 ? "" : "s"}`} aria-label={`${c.name}, ${c.count} mods`}>
                  <span className="pvAvatar" aria-hidden="true">
                    <img
                      src={publicAssetPath(`characters/heads/${c.imageId ?? "050001"}.png`)}
                      alt=""
                      loading="lazy"
                      draggable={false}
                      onError={(event) => {
                        if (event.currentTarget.dataset.fallback === "1") return;
                        event.currentTarget.dataset.fallback = "1";
                        event.currentTarget.src = publicAssetPath("characters/heads/050001.png");
                      }}
                    />
                  </span>
                  <span className="ct">{c.count}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="pvCol pvModCol">
            <div className="pvColHd"><span className="tc">模組</span> {pvCurrentChar ? pvCurrentChar.name : "Mods"}</div>
            <div className="pvList">
              {!pvCurrentChar ? (
                <div className="pvHint">Select a character</div>
              ) : pvCurrentChar.mods.map((mod) => {
                const active = pvSlotA?.path === mod.path || pvSlotB?.path === mod.path;
                const desiredMod = isDesired(mod.folder);
                const mountLockReason = getPreviewModMountLockReason(mod);
                const selectionLocked = modsLocked || Boolean(mountLockReason);
                const selectionLockReason = modsLocked ? modsLockReason : mountLockReason;
                const pendingTone = tones[mod.folder];
                return (
                  <div key={mod.path} className={`pvModRow ${active ? "on" : ""} ${desiredMod ? "is-selected" : ""} ${selectionLocked ? "is-locked" : ""} ${pendingTone ? formatPendingToneClass(pendingTone) : ""}`}>
                    <button type="button" className={`pvItem mod ${active ? "on" : ""}`} onClick={() => loadPreviewMod(mod)} title="Load into stage">
                      <span className="dot" aria-hidden="true" /><span className="nm">{formatFolderName(mod.folder)}</span>
                    </button>
                    <button
                      type="button"
                      className={`pvModSelect ${desiredMod ? "is-selected" : ""} ${selectionLocked ? "is-locked" : ""}`}
                      disabled={selectionLocked}
                      onClick={(event) => {
                        event.stopPropagation();
                        stagePreviewModSelection(mod);
                      }}
                      title={selectionLockReason || (desiredMod ? "Stage removal / clear add" : "Stage mount / clear removal")}
                      aria-pressed={desiredMod}
                      aria-label={`${selectionLockReason ? "Locked" : desiredMod ? "Clear or remove" : "Select"} ${mod.folder}`}
                    >
                      {desiredMod ? "−" : "+"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="pvWork">
          <div className={`pvStageWrap ${pvMode === "dual" ? "dual" : ""}`}>
            {renderPvStage("a")}
            {pvMode === "dual" && renderPvStage("b")}
          </div>
          <div className="pvInspect">
            <div className="pvSec pvLayerSec">
              <div className="h"><span className="num">▤</span>Layers · 圖層<i aria-hidden="true" /></div>
              {pvFocusedInfo.status === "ready" && pvFocusedAnimLayers.length > 0 ? (
                <>
                  <div className="pvLayerList">
                    {pvFocusedAnimLayers.map((layer) => (
                      <div
                        key={layer.id}
                        className={`pvLayer ${layer.trackIndex === 0 ? "on" : ""} ${pvActiveAnimLayerId[pvFocusedSlot] === layer.id ? "is-selected" : ""}`}
                        onPointerDownCapture={() => selectPreviewAnimLayer(pvFocusedSlot, layer.id)}
                      >
                        <span className="gr" aria-hidden="true">T{layer.trackIndex}</span>
                        <select
                          className="pvLayerAnim"
                          value={layer.animation}
                          onChange={(event) => setPreviewAnimLayerAnimation(pvFocusedSlot, layer.id, event.target.value)}
                          aria-label={`Track ${layer.trackIndex} animation`}
                        >
                          {pvFocusedInfo.animations.map((animation) => (
                            <option key={animation.name} value={animation.name}>{animation.name}</option>
                          ))}
                        </select>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={layer.alpha}
                          onChange={(event) => setPreviewAnimLayerAlpha(pvFocusedSlot, layer.id, Number(event.target.value))}
                          aria-label={`Track ${layer.trackIndex} alpha`}
                        />
                        <span className="op">{Math.round(layer.alpha * 100)}%</span>
                        <button type="button" className="pvLayerRemove" disabled={layer.trackIndex === 0} onClick={() => removePreviewAnimLayer(pvFocusedSlot, layer.id)} aria-label="Remove animation layer">×</button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="pvAddLayer"
                    disabled={pvFocusedInfo.animations.length === 0}
                    onClick={() => addPreviewAnimLayer(pvFocusedSlot)}
                  >
                    ＋ Stack animation track
                  </button>
                </>
              ) : (
                <div className="pvHint">{pvFocusedInfo.status === "loading" ? "Loading anim tracks" : "Load a spine mod"}</div>
              )}
            </div>
            <div className="pvSec">
              <div className="h"><span className="num">◳</span>Parts · 部件<i aria-hidden="true" /></div>
              <div className="pvSearchRow"><input value={pvPartSearch} onChange={(event) => setPvPartSearch(event.target.value)} placeholder="Search slot…" disabled={pvFocusedInfo.status !== "ready"} aria-label="Search slot" /></div>
              {pvFocusedInfo.status === "ready" ? (
                <div className="pvPartList">
                  {pvFilteredParts.length === 0 ? (
                    <div className="pvHint">No matching parts</div>
                  ) : pvFilteredParts.map((part) => (
                    <div key={part.name} className="pvPart">
                      <button
                        type="button"
                        className="pvEye"
                        title={part.alpha <= 0.01 ? "Show part" : "Hide part"}
                        onClick={() => setPreviewPartAlpha(pvFocusedSlot, part.name, part.alpha <= 0.01 ? 1 : 0)}
                      >
                        {part.alpha <= 0.01 ? "○" : "●"}
                      </button>
                      <span className="nm" title={part.name}>{part.name}</span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={part.alpha}
                        onChange={(event) => setPreviewPartAlpha(pvFocusedSlot, part.name, Number(event.target.value))}
                        aria-label={`${part.name} opacity`}
                      />
                      <span className="op">{Math.round(part.alpha * 100)}%</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="pvPending">
                  {pvFocusedInfo.status === "loading" ? "Loading Spine slots…" : pvFocusedInfo.status === "error" ? (pvFocusedInfo.error ?? "Preview failed") : "Load a mod to inspect Spine parts."}
                </div>
              )}
            </div>
            <div className="pvSec pvRenderSec">
              <div className="h"><span className="num">◷</span>Render<i aria-hidden="true" /></div>
              <div className="pvRow"><span className="k">Stage</span><span className="v">{pvFocusedSlot.toUpperCase()}</span></div>
              <div className="pvRow"><span className="k">Tracks</span><span className="v">{pvFocusedAnimLayers.length}</span></div>
              <div className="pvRow"><span className="k">Skin</span><span className="v">{pvFocusedInfo.selectedSkin || "default"}</span></div>
              <div className="pvRow"><span className="k">Anim</span><span className="v">{pvFocusedInfo.selectedAnimation || "none"}</span></div>
              <div className="pvRow"><span className="k">Speed</span><span className="v">{pvFocusedInfo.speed.toFixed(1)}×</span></div>
              <div className="pvRow"><span className="k">Parts</span><span className="v">{pvFocusedInfo.parts.length}</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const statsView = (
    <div className="stxView">
      <div className="stxNums">
        <div className="stxNum"><b>{library.length}</b><span>Mods Scanned</span></div>
        <div className="stxNum"><b>{mountedMods.length}</b><span>Mounted</span></div>
        <div className="stxNum"><b>{stats.authors.length}</b><span>Authors</span></div>
        <div className="stxNum"><b>{stats.characters.length}</b><span>Characters</span></div>
      </div>
      <div className="stxGrid">
        <div className="stxHeatCol">
          <div className="stxHead"><span className="ico" aria-hidden="true">▦</span><span>Character Coverage</span><span className="cjk">角色覆蓋熱力圖</span><i aria-hidden="true" /></div>
          {stats.characters.length > 0 ? (
            <>
              <div className="stxHeat" role="img" aria-label={`Character coverage heatmap, ${stats.characters.length} characters`}>
                {stats.characters.map((c) => (
                  <span
                    key={c.id}
                    className="stxCell"
                    style={{ opacity: 0.14 + 0.86 * (c.count / stats.maxChar) }}
                    title={`${c.name} · ${c.count} mod${c.count > 1 ? "s" : ""}`}
                  />
                ))}
              </div>
              <div className="stxLegend">
                Less
                <i style={{ opacity: 0.12 }} /><i style={{ opacity: 0.32 }} /><i style={{ opacity: 0.55 }} /><i style={{ opacity: 0.8 }} /><i />
                More · {stats.characters.length} characters
              </div>
            </>
          ) : (
            <div className="stxEmpty">No character data yet — choose a Mods Folder in Settings.</div>
          )}
        </div>
        <div className="stxSideCol">
          <div className="stxHead"><span className="ico" aria-hidden="true">▮</span><span>Top Authors</span><i aria-hidden="true" /></div>
          {stats.topAuthors.length > 0 ? (
            <div className="stxBars">
              {stats.topAuthors.map((a) => (
                <div className="stxBar" key={a.id}>
                  <span className="nm" title={a.name}>{a.name}</span>
                  <span className="track"><i style={{ width: `${Math.max(6, Math.round((a.count / stats.maxAuthor) * 100))}%` }} /></span>
                  <span className="v">{a.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="stxEmpty">—</div>
          )}
          <div className="stxHead" style={{ marginTop: 18 }}><span className="ico" aria-hidden="true">◷</span><span>By Category</span><i aria-hidden="true" /></div>
          <div className="stxBars">
            {stats.categories.map((c) => (
              <div className="stxBar" key={c.key}>
                <span className="nm">{c.label}</span>
                <span className="track"><i style={{ width: `${c.count ? Math.max(6, Math.round((c.count / stats.maxCat) * 100)) : 0}%` }} /></span>
                <span className="v">{c.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const rosterView = (
    <div className="rstView">
      <div className="rstToolbar">
        <span className="rstSearch">
          <input value={rosterSearch} onChange={(e) => setRosterSearch(e.target.value)} placeholder="Search character…" spellCheck={false} aria-label="Search character" />
        </span>
        <div className="segmentedControl rstSort" role="tablist" aria-label="Roster order">
          <button type="button" className={rosterMode === "mods" ? "active" : ""} onClick={() => setRosterMode("mods")} aria-pressed={rosterMode === "mods"}><span>Most Mods</span></button>
          <button type="button" className={rosterMode === "az" ? "active" : ""} onClick={() => setRosterMode("az")} aria-pressed={rosterMode === "az"}><span>A–Z</span></button>
          <button type="button" className={rosterMode === "modded" ? "active" : ""} onClick={() => setRosterMode("modded")} aria-pressed={rosterMode === "modded"}><span>Modded</span></button>
        </div>
      </div>
      {rosterList.length === 0 ? (
        <div className="stxEmpty">{library.length === 0 ? "Choose a Mods Folder in Settings to populate the roster." : "No characters match."}</div>
      ) : (
        <div className="rstGrid" ref={rosterGridRef}>
          {rosterRows.map((row, rowIndex) => {
            const expanded = row.find((ch) => openRosterChar === ch.name && ch.count > 0);
            return (
              <Fragment key={`row-${rowIndex}-${row[0]?.name ?? "empty"}`}>
                {row.map((ch) => (
                  <button
                    key={ch.name}
                    type="button"
                    className={`rstCard ${ch.count === 0 ? "dim" : ""} ${openRosterChar === ch.name ? "open" : ""}`}
                    onClick={() => setOpenRosterChar((cur) => (cur === ch.name ? null : ch.name))}
                    aria-expanded={openRosterChar === ch.name}
                    disabled={ch.count === 0}
                    title={ch.count === 0 ? `${ch.name} — no mods` : `${ch.name} — ${ch.count} mod${ch.count > 1 ? "s" : ""}`}
                  >
                    <span className={`rstStamp ${ch.count === 0 ? "zero" : ""}`}>{ch.count === 0 ? "0" : `${ch.count} Mod${ch.count > 1 ? "s" : ""}`}</span>
                    <span className="rstPort">
                      {ch.imageId ? (
                        <img src={publicAssetPath(`characters/standing/${ch.imageId}.png`)} alt="" draggable={false} loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                      ) : null}
                      <span className="rstSil" aria-hidden="true" />
                    </span>
                    <span className="rstPlate">
                      <span className="k"><span>Roster</span><span>{ch.count > 0 ? "★" : "—"}</span></span>
                      <span className="nm">{ch.name}</span>
                    </span>
                  </button>
                ))}
                {expanded && (
                  <div className="rstExpand">
                    <div className="rstExpandInner">
                      <div className="rstExpandHead">
                        <span className="t">{expanded.name}</span>
                        <span className="c">{expanded.count} cartridge{expanded.count > 1 ? "s" : ""}</span>
                        <button type="button" className="rstPreview" onClick={() => openInPreview(expanded.name)} title="Open this character in Preview">▶ Preview</button>
                        <button type="button" className="rstClose" onClick={() => setOpenRosterChar(null)} aria-label="Close">×</button>
                      </div>
                      <div className={`cartShelf cartShelf--collector ${useCanvasCartridges ? "cartShelf--canvas" : ""}`}>
                        {expanded.mods.map((mod) => {
                          const CartComp = useCanvasCartridges ? CanvasCartridge : CartridgeRealistic;
                          return (
                            <CartComp
                              key={mod.path}
                              mod={mod}
                              have={mountedFolders.has(mod.folder)}
                              selected={isDesired(mod.folder)}
                              tone={tones[mod.folder]}
                              locked={modsLocked}
                              lockedReason={modsLocked ? modsLockReason : undefined}
                              onToggle={() => updateDesired(mod.folder, !isDesired(mod.folder))}
                              authorRules={authorRules}
                              onPreview={() => openInPreview(expanded.name, mod)}
                            />
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );

  const settingsView = (
    <div className="cfgConsole">
      <div className="cfgBody">
        <section className="cfgGroup" id="cfg-runtime">
          <div className="cfgGroupHead"><span className="num">01</span><span>Runtime</span><span className="cjk">執行時</span><i aria-hidden="true" /></div>

          <div className={`cfgCard cfgInjection ${injectionVersionLocked ? "is-locked" : ""}`}>
            <div className="cfgConsoleRow">
              <span className={`cfgSeal ${status?.injected ? "" : "bad"}`} aria-hidden="true">{status?.injected ? "✓" : "✗"}</span>
              <div className="cfgConsoleLbl">
                <b>Runtime Injection · BepInEx</b>
                <span>{status?.injected ? "Installed · re-signed" : "Not installed"}</span>
              </div>
              <HelpButton title="Runtime Injection">
                Install this once before using runtime mods. Close BrownDust II before installing or removing it. Remove it when the game updates or when you want to restore the original app. Mounted mods stay in place.
              </HelpButton>
              <div className="cfgConsoleBtns" aria-disabled={(injectionInstallLocked || !appReady || Boolean(status?.injected)) && (injectionRemoveLocked || !status?.injected)}>
                <button
                  type="button"
                  className="cfgBtn primary"
                  disabled={injectionInstallLocked || !appReady || Boolean(status?.injected)}
                  onClick={installLoader}
                  title={injectionInstallTitle}
                >
                  Install
                </button>
                <button
                  type="button"
                  className="cfgBtn"
                  disabled={injectionRemoveLocked || !status?.injected}
                  onClick={uninstallLoader}
                  title={injectionRemoveTitle}
                >
                  Remove
                </button>
              </div>
            </div>
            {injectionVersionLocked && (
              <div className="cfgLockNotice" role="status">{injectionVersionLockMessage}</div>
            )}
          </div>

          <div className="cfgCard">
            <div className="cfgFieldHead">
              <span>Mods Folder</span>
              <HelpButton title="Mods Folder">Choose the folder where your downloaded mods are stored. After choosing it, Library scans the folder and shows the mods as cartridges.</HelpButton>
            </div>
            <div className={`cfgSlot ${missingModsDir ? "is-invalid" : ""}`}>
              <input className="cfgPath" value={modsDir} onChange={(e) => setModsDir(e.target.value)} placeholder="No folder selected — choose one to load cartridges" spellCheck={false} />
              <button type="button" className="cfgBtn" onClick={selectDir}>Browse</button>
            </div>
          </div>
        </section>

        <section className="cfgGroup" id="cfg-library">
          <div className="cfgGroupHead"><span className="num">02</span><span>Library</span><span className="cjk">編目</span><i aria-hidden="true" /></div>
          <div className="cfgCard">
            <div className="cfgFieldHead">
              <span>Author Labels</span>
              <HelpButton title="Author Labels">Use this when an author sticker is missing or wrong. Add an author name or alias, choose its color, and the matching cartridges will use that label. Reset restores the default list.</HelpButton>
              <button type="button" className="cfgBtn cfgHeadBtn" onClick={resetAuthorRules}>Reset</button>
            </div>
            <form className="cfgAuthorAdd" onSubmit={(e) => { e.preventDefault(); addAuthorRule(); }}>
              <input value={newAuthorName} onChange={(e) => setNewAuthorName(e.target.value)} placeholder="Add author name" />
              <button type="submit" className="cfgBtn" disabled={!newAuthorName.trim()}>Add</button>
            </form>
            <div className="cfgChips">
              {authorRules.map((rule) => (
                <span className="cfgChip" key={rule.id} title={rule.keywords.join(", ")}>
                  <input type="color" className="cfgChipSwatch" value={rule.color} onChange={(e) => updateAuthorColor(rule.id, e.target.value)} aria-label={`Color for ${rule.name}`} />
                  <span className="cfgChipName">{rule.name}</span>
                  {rule.custom ? (
                    <button type="button" className="cfgChipRemove" onClick={() => removeAuthorRule(rule.id)} title={`Remove ${rule.name}`}>×</button>
                  ) : (
                    <span className="cfgChipLock" title="Default author" aria-label="Default author">·</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section className="cfgGroup" id="cfg-appearance">
          <div className="cfgGroupHead"><span className="num">03</span><span>Appearance</span><span className="cjk">外觀</span><i aria-hidden="true" /></div>
          <div className="cfgCard cfgAppearance">
            <div className="cfgFieldHead">
              <span>Theme</span>
              <HelpButton title="Theme">Pick the print color palette. Night Press is the warm Soviet-print default; Violet Press recolors the same print chrome in iridescent violet + cyan to match the app icon. Cartridge artwork is unchanged.</HelpButton>
            </div>
            <div className="themeSwitch segmentedControl" role="tablist" aria-label="Theme">
              {PALETTES.map((p) => (
                <button key={p.key} type="button" className={accent === p.key ? "active" : ""} onClick={() => setAccent(p.key)} aria-pressed={accent === p.key}>
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="cfgCard cfgBackdropEffects">
            <div className="cfgFieldHead">
              <span>Backdrop Effects</span>
              <HelpButton title="Backdrop Effects">Turn Square Particles on or off. Disable them if you want a calmer background or smoother scrolling.</HelpButton>
            </div>
            <label className="cfgToggleRow">
              <span className="cfgToggleCopy">
                <b>Square Particles</b>
                <span>{backdropParticlesEnabled ? "Enabled" : "Disabled"}</span>
              </span>
              <input
                type="checkbox"
                className="cfgSwitchInput"
                checked={backdropParticlesEnabled}
                onChange={(event) => updateBackdropParticlesEnabled(event.currentTarget.checked)}
              />
              <span className="cfgSwitchTrack" aria-hidden="true">
                <span className="cfgSwitchThumb" />
              </span>
            </label>
          </div>
        </section>

        <section className="cfgGroup" id="cfg-about">
          <div className="cfgGroupHead"><span className="num">04</span><span>About</span><span className="cjk">版本</span><i aria-hidden="true" /></div>
          <div className="cfgColophon">
            <div className="cfgColoRow"><span className="cfgColoReg" aria-hidden="true" /><span className="k">App</span><span className="v">{appInfo.name} · {appInfo.subtitle} · v{appInfo.version}</span></div>
            <div className="cfgColoRow"><span className="cfgColoReg" aria-hidden="true" /><span className="k">Game</span><span className="v">BrownDust II · {gameVersionInfo?.version ?? "unknown"}</span></div>
            {showVersionReleaseLink && (
              <div className="cfgVersionNotice" role="status">
                <span className="cfgColoReg" aria-hidden="true" />
                <div className="cfgVersionCopy">
                  <span className="cfgVersionK">Version mismatch</span>
                  <span className="cfgVersionV">Supported BrownDust II {appInfo.supportedGameVersion || appInfo.version} · detected {gameVersionInfo?.version ?? "unknown"}</span>
                </div>
                <a className="cfgGithubLink" href={BD_SPINEX_RELEASES_URL} target="_blank" rel="noreferrer" onClick={handleOpenGithubReleases}>
                  Open GitHub
                </a>
              </div>
            )}
            <div className="cfgColoRow"><span className="cfgColoReg" aria-hidden="true" /><span className="k">Runtime</span><span className="v">{status?.injected ? "Injected" : "Not injected"} · {mountedMods.length} mounted · {status?.loaderAvailable ? "loader ready" : "loader missing"}</span></div>
          </div>
        </section>
      </div>
    </div>
  );

  const placeholderView = (key: ViewKey) => {
    const copy: Record<string, { icon: string; title: string; body: string }> = {
      roster: { icon: "🎭", title: "角色名冊 Roster", body: "把模組依角色聚合的牆面：每位角色顯示卡匣數量，點開可查看哪些作者為其製作模組（Discover），支援多 ID 角色與前 NPC。" },
      profiles: { icon: "💼", title: "卡匣盒 Profiles", body: "建立多組掛載組合，一鍵切換並同步進遊戲，並可匯入舊版 profile。底部的卡匣播放器會顯示目前載入的組合。" },
      preview: { icon: "👁️", title: "預覽 Preview", body: "內建 Spine 動畫檢視器，套用前先看模組的實際動作與外觀。" },
      stats: { icon: "📊", title: "統計 Stats", body: "模組總數、作者數、分類分布與最近活動的儀表板。" }
    };
    const c = copy[key];
    return (
      <section className="panel comingSoon">
        <div className="csIcon">{c.icon}</div>
        <h2>{c.title}</h2>
        <p>{c.body}</p>
        <span className="csTag">✦ 規劃中 · 設計書第 6 階段</span>
      </section>
    );
  };

  const dockSpinning = modsEnabled && mountedMods.length > 0;
  const applyDisabled = modsLocked || pendingChanges.length === 0 || hasConflict;
  const launchDisabled = busy || !appReady;

  const playerDock = (
    <div className={`dock ${modsEnabled ? "" : "is-off"}`} role="region" aria-label="Cartridge player">
      <div className="dockNow">
        <div className={`dockCover ${dockSpinning ? "spinning" : ""}`} aria-hidden="true" />
        <div className="dockMeta">
          <div className="dockEyebrow">Now Loading</div>
          <div className="dockTitle">
            {pendingChanges.length > 0
              ? `${pendingChanges.length} change${pendingChanges.length > 1 ? "s" : ""} staged`
              : mountedMods.length > 0
                ? `${mountedMods.length} cartridge${mountedMods.length > 1 ? "s" : ""} loaded`
                : "No cartridges loaded"}
          </div>
          <div className="dockSub">
            <span>{mountedMods.length} mounted</span>
            {hasConflict && <span className="conflict"> · conflict</span>}
            {!modsEnabled && <span className="off"> · mods off</span>}
            {gameRunning && <span className="warn"> · game running</span>}
          </div>
        </div>
      </div>

      <div className="dockControls">
        <button
          type="button"
          className={`dockBtn ${modsEnabled ? "on" : ""}`}
          disabled={busy}
          onClick={toggleModPower}
          title={modsEnabled ? "Mod Power: on — click to turn all mods off" : "Mod Power: off — click to restore mods"}
          aria-pressed={modsEnabled}
        >
          ⏻
        </button>
        <button
          type="button"
          className="dockBtn"
          disabled={busy}
          onClick={restoreAll}
          title={mountedMods.length === 0 ? "No mounted mods to remove" : "Restore All — unmount every mounted cartridge"}
        >
          ↩
        </button>
        <span className="dockDivider" aria-hidden="true" />
        <button
          type="button"
          className="dockBtn apply"
          disabled={applyDisabled}
          onClick={applyChanges}
          title={versionLocked ? "Update BD-SpineX version" : hasConflict ? "Resolve same-key conflicts first" : pendingChanges.length === 0 ? "No staged changes" : "Apply staged changes"}
        >
          <span className="dockApplyIcon" aria-hidden="true">▶</span>
          <span>Apply</span>
          {pendingChanges.length ? <span className="dockApplyCount">{pendingChanges.length}</span> : null}
        </button>
        <button
          type="button"
          className="dockBtn launch"
          disabled={launchDisabled}
          onClick={launchGame}
          title={appReady ? "Launch BrownDust II" : "PlayCover BrownDust II not ready"}
          aria-label="Launch game"
        >
          Launch
        </button>
      </div>
    </div>
  );

  const activeViewContent = (
    <>
      {view !== "preview" && (
        <div className="viewHead">
          <div>
            <h1>{activeNav.label}</h1>
            <div className="viewSub">{activeNav.subtitle}</div>
          </div>
          <div className="spacer" />
          <div className={`backdropMeta ${backdropSlotRolling ? "is-rolling" : ""}`} title={backgroundCharacterTitle}>
            <div className="viewCount">
              <b>{backgroundCharacterCode}</b><span>Character<br />ID</span>
            </div>
            <div className="backdropMetaName">
              {backgroundCharacterName}
            </div>
          </div>
        </div>
      )}

      {globalBanners}

      {view === "library" && libraryView}
      {view === "logs" && logView}
      {view === "settings" && settingsView}
      {view === "stats" && statsView}
      {view === "roster" && rosterView}
      {view === "preview" && previewView}
      {view !== "library" && view !== "logs" && view !== "settings" && view !== "stats" && view !== "roster" && view !== "preview" && placeholderView(view)}
    </>
  );
  const viewMotionClassName = `viewMotion is-${viewMotion.phase} dir-${viewMotion.direction}`;

  const confirmDialogView = confirmDialog
    ? createPortal(
      <div className={`confirmOverlay ${confirmDialog.closing ? "is-closing" : "is-entering"}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeConfirmDialog(false); }}>
        <div
          className={`confirmDialog tone-${confirmDialog.tone ?? "warn"} ${confirmDialog.closing ? "is-closing" : ""}`}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`confirm-title-${confirmDialog.id}`}
          aria-describedby={`confirm-body-${confirmDialog.id}`}
        >
          <div className="confirmKicker">Confirm Action</div>
          <h2 id={`confirm-title-${confirmDialog.id}`}>{confirmDialog.title}</h2>
          <div id={`confirm-body-${confirmDialog.id}`} className="confirmBody">{confirmDialog.body}</div>
          <div className="confirmActions">
            {!confirmDialog.hideCancel && (
              <button type="button" className="confirmBtn secondary" onClick={() => closeConfirmDialog(false)}>{confirmDialog.cancelLabel ?? "Cancel"}</button>
            )}
            <button type="button" className="confirmBtn primary" onClick={() => closeConfirmDialog(true)}>{confirmDialog.confirmLabel ?? "Confirm"}</button>
          </div>
        </div>
      </div>,
      document.body
    )
    : null;

  return (
    <div className="appShell">
      <div className="tauriTitlebarDragRegion" data-tauri-drag-region aria-hidden="true" onMouseDown={startTauriWindowDrag} />
      <nav className="appRail" onMouseDown={startTauriWindowDrag}>
        <div className="tauriRailDragRegion" data-tauri-drag-region aria-hidden="true" onMouseDown={startTauriWindowDrag} />
        <div className="railBrand">
          <span className="railLogo">B</span>
          <div>
            <div className="railName">{appInfo.name}</div>
            <div className="railSub">{appInfo.subtitle}</div>
            <div className="railEdition"><i aria-hidden="true" />Brown Dust Ⅱ</div>
          </div>
        </div>

        <div className="railNav">
          {NAV_GROUPS.map((group) => {
            const groupItems = VISIBLE_NAV_ITEMS.filter((item) => item.group === group.id);
            if (groupItems.length === 0) return null;
            return (
              <div key={group.id}>
                <div className="railGroup">
                  <span className="railGroupCjk">{group.label}</span>
                  <span>{group.en}</span>
                  <i aria-hidden="true" />
                </div>
                {groupItems.map((item) => {
                  const isActive = view === item.key;
                  const badge = item.key === "library" && pendingChanges.length > 0 ? pendingChanges.length : undefined;
                  const num = String(VISIBLE_NAV_ITEMS.indexOf(item) + 1).padStart(2, "0");
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`railItem ${isActive ? "active" : ""}`}
                      onClick={() => navigateToView(item.key)}
                      aria-current={isActive ? "page" : undefined}
                    >
                      <span className="railNum" aria-hidden="true">{num}</span>
                      <span className="railLabel">{item.label}</span>
                      {badge ? <span className="railBadge">{badge}</span> : null}
                      {isActive ? <span className="railStar" aria-hidden="true">★</span> : <span className="railTick" aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="railFoot">
          <div className={`railStamp ${status?.injected ? "is-installed" : "is-missing"}`}>
            <span className="railSeal" aria-hidden="true">{status?.injected ? "✓" : "✗"}</span>
            <div>
              <div className="railStampMain">{status?.injected ? "Runtime installed" : "Not installed"}</div>
              <div className="railStampSub">Loader · Mac PlayCover{gameRunning ? " · running" : ""}</div>
            </div>
          </div>
          <div className="railCount" aria-hidden="true">
            <b>{mountedMods.length}</b>
            <span>Mounted<br />of {library.length}</span>
          </div>
          <div className="railGauge" aria-hidden="true">
            <i style={{ width: `${library.length ? Math.min(100, Math.round((mountedMods.length / library.length) * 100)) : 0}%` }} />
          </div>
          <button
            type="button"
            className={`railVersion ${versionLocked ? "locked" : ""}`}
            title={`${formatVersionTitle(appInfo, gameVersionInfo)}\nOpen Settings`}
            aria-label="Open Settings"
            onClick={() => navigateToView("settings")}
          >
            <span className="railReg" aria-hidden="true" />
            <span className="railVersionLabel">Version</span>
            <strong>{formatVersionBadge(appInfo, gameVersionInfo)}</strong>
          </button>
        </div>
      </nav>

      <main className={`appMain view-${view} ${viewMotionClassName}`}>
        <LibraryHalftoneBackdrop />
        <div className="viewMotionVeil" aria-hidden="true" />
        {activeViewContent}

        {playerDock}
        {pendingDiffDock}
      </main>
      {confirmDialogView}
      {htmlAltTooltip}
    </div>
  );
}

// ===== logic helpers =====
function startTauriWindowDrag(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0 || document.documentElement.getAttribute("data-runtime") !== "tauri") return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("button,a,input,textarea,select,summary,[contenteditable='true'],[role='button'],[data-no-tauri-drag]")) return;
  event.preventDefault();
  void window.bd2.startWindowDrag?.().catch(() => undefined);
}

function isElementFullyInViewport(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const width = window.innerWidth || document.documentElement.clientWidth;
  const height = window.innerHeight || document.documentElement.clientHeight;
  return rect.top >= 0 && rect.left >= 0 && rect.bottom <= height && rect.right <= width;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function useTauriCustomScrollbars() {
  useEffect(() => {
    if (document.documentElement.getAttribute("data-runtime") !== "tauri") return;
    return installTauriCustomScrollbars();
  }, []);
}

type CustomScrollbarEntry = {
  target: HTMLElement;
  bar: HTMLDivElement;
  thumb: HTMLDivElement;
  scrollListenerTarget: HTMLElement | Window;
  isDocument: boolean;
};

const TAURI_SCROLL_CONTAIN_SELECTOR = ".pendingDiffList, .modsPanel table, .sharedPanel table, .historyTableFrame, .logStream";
const TAURI_SCROLLBAR_SKIP_SELECTOR = ".pvCharCol .pvList";

function installTauriCustomScrollbars() {
  const layer = document.createElement("div");
  layer.className = "tauriScrollbarLayer";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);

  const entries = new Map<HTMLElement, CustomScrollbarEntry>();
  let raf = 0;
  let rescanTimer = 0;
  let activeDrag: {
    entry: CustomScrollbarEntry;
    pointerId: number;
    startY: number;
    startScrollTop: number;
  } | null = null;

  const getMetrics = (entry: CustomScrollbarEntry) => {
    if (entry.isDocument) {
      const root = entry.target;
      return {
        rect: new DOMRect(0, 0, window.innerWidth, window.innerHeight),
        scrollTop: root.scrollTop,
        scrollHeight: Math.max(root.scrollHeight, document.body.scrollHeight),
        clientHeight: window.innerHeight
      };
    }

    return {
      rect: entry.target.getBoundingClientRect(),
      scrollTop: entry.target.scrollTop,
      scrollHeight: entry.target.scrollHeight,
      clientHeight: entry.target.clientHeight
    };
  };

  const renderEntry = (entry: CustomScrollbarEntry) => {
    const { rect, scrollTop, scrollHeight, clientHeight } = getMetrics(entry);
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const visible =
      maxScroll > 2 &&
      rect.width > 0 &&
      rect.height > 36 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth;

    entry.bar.classList.toggle("is-visible", visible);
    if (!visible) return;

    const width = 8;
    const inset = entry.isDocument ? 2 : 3;
    const top = Math.max(2, rect.top + inset);
    const bottom = Math.min(window.innerHeight - 2, rect.bottom - inset);
    const trackHeight = Math.max(0, bottom - top);
    const thumbHeight = Math.max(28, Math.round(trackHeight * Math.min(1, clientHeight / scrollHeight)));
    const travel = Math.max(1, trackHeight - thumbHeight);
    const thumbTop = top + (scrollTop / maxScroll) * travel;
    const right = entry.isDocument ? window.innerWidth - 3 : Math.min(window.innerWidth - 3, rect.right - 3);

    entry.bar.style.left = `${Math.round(right - width)}px`;
    entry.bar.style.top = `${Math.round(top)}px`;
    entry.bar.style.width = `${width}px`;
    entry.bar.style.height = `${Math.round(trackHeight)}px`;
    entry.thumb.style.height = `${Math.round(thumbHeight)}px`;
    entry.thumb.style.transform = `translateY(${Math.round(thumbTop - top)}px)`;
  };

  const render = () => {
    raf = 0;
    for (const entry of entries.values()) renderEntry(entry);
  };

  const scheduleRender = () => {
    if (raf) return;
    raf = window.requestAnimationFrame(render);
  };

  const isScrollable = (element: HTMLElement) => {
    if (element === layer || layer.contains(element)) return false;
    if (element.matches(TAURI_SCROLLBAR_SKIP_SELECTOR)) return false;
    if (element.clientHeight <= 0 || element.scrollHeight <= element.clientHeight + 2) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return /(auto|scroll|overlay)/.test(style.overflowY);
  };

  const collectTargets = () => {
    const root = (document.scrollingElement || document.documentElement) as HTMLElement;
    const targets: HTMLElement[] = [];
    if (root.scrollHeight > window.innerHeight + 2) targets.push(root);
    for (const element of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      if (isScrollable(element)) targets.push(element);
    }
    return targets;
  };

  const removeEntry = (entry: CustomScrollbarEntry) => {
    entry.scrollListenerTarget.removeEventListener("scroll", scheduleRender);
    entry.target.classList.remove("tauriNativeScrollbarHidden");
    entry.bar.remove();
  };

  const ensureEntry = (target: HTMLElement) => {
    const current = entries.get(target);
    if (current) return current;

    const isDocument = target === document.scrollingElement || target === document.documentElement || target === document.body;
    const bar = document.createElement("div");
    const thumb = document.createElement("div");
    bar.className = "tauriCustomScrollbar";
    thumb.className = "tauriCustomScrollbarThumb";
    bar.appendChild(thumb);
    layer.appendChild(bar);

    const entry: CustomScrollbarEntry = {
      target,
      bar,
      thumb,
      isDocument,
      scrollListenerTarget: isDocument ? window : target
    };

    if (!isDocument) {
      target.classList.add("tauriNativeScrollbarHidden");
    }

    entry.scrollListenerTarget.addEventListener("scroll", scheduleRender, { passive: true });
    thumb.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      thumb.setPointerCapture(event.pointerId);
      activeDrag = {
        entry,
        pointerId: event.pointerId,
        startY: event.clientY,
        startScrollTop: getMetrics(entry).scrollTop
      };
      thumb.classList.add("is-dragging");
    });

    entries.set(target, entry);
    return entry;
  };

  const rescan = () => {
    rescanTimer = 0;
    const targets = new Set(collectTargets());
    for (const target of targets) ensureEntry(target);
    for (const [target, entry] of entries) {
      if (!targets.has(target) || !target.isConnected) {
        removeEntry(entry);
        entries.delete(target);
      }
    }
    scheduleRender();
  };

  const scheduleRescan = () => {
    if (rescanTimer) return;
    rescanTimer = window.setTimeout(rescan, 80);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
    const { entry, startY, startScrollTop } = activeDrag;
    const { scrollHeight, clientHeight } = getMetrics(entry);
    const maxScroll = Math.max(1, scrollHeight - clientHeight);
    const trackHeight = Math.max(1, entry.bar.getBoundingClientRect().height);
    const thumbHeight = Math.max(1, entry.thumb.getBoundingClientRect().height);
    const travel = Math.max(1, trackHeight - thumbHeight);
    entry.target.scrollTop = startScrollTop + ((event.clientY - startY) / travel) * maxScroll;
    scheduleRender();
  };

  const stopDrag = (event: PointerEvent) => {
    if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
    activeDrag.entry.thumb.classList.remove("is-dragging");
    activeDrag = null;
  };

  const normalizeWheelDelta = (event: WheelEvent, target: HTMLElement) => {
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * target.clientHeight;
    return event.deltaY;
  };

  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
    const path = event.composedPath();
    const entry = path
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .map((node) => entries.get(node))
      .find((item): item is CustomScrollbarEntry => Boolean(item && !item.isDocument && item.target.matches(TAURI_SCROLL_CONTAIN_SELECTOR)));
    if (!entry) return;

    const { scrollTop, scrollHeight, clientHeight } = getMetrics(entry);
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    if (maxScroll <= 2) return;

    event.preventDefault();
    event.stopPropagation();
    const nextScrollTop = Math.min(maxScroll, Math.max(0, scrollTop + normalizeWheelDelta(event, entry.target)));
    if (nextScrollTop !== scrollTop) {
      entry.target.scrollTop = nextScrollTop;
      scheduleRender();
    }
  };

  const observer = new MutationObserver(scheduleRescan);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
  const resizeObserver = new ResizeObserver(scheduleRescan);
  resizeObserver.observe(document.body);
  window.addEventListener("resize", scheduleRescan);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", stopDrag);
  window.addEventListener("pointercancel", stopDrag);

  rescan();

  return () => {
    if (raf) window.cancelAnimationFrame(raf);
    if (rescanTimer) window.clearTimeout(rescanTimer);
    observer.disconnect();
    resizeObserver.disconnect();
    window.removeEventListener("resize", scheduleRescan);
    window.removeEventListener("wheel", onWheel, { capture: true });
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDrag);
    window.removeEventListener("pointercancel", stopDrag);
    for (const entry of entries.values()) removeEntry(entry);
    entries.clear();
    layer.remove();
  };
}

function getRuntimePendingRows(library: RuntimeMod[], mountedMods: RuntimeMod[], isDesired: (folder: string) => boolean): RuntimeChange[] {
  const mountedFolders = new Set(mountedMods.map((m) => m.folder));
  const rows: RuntimeChange[] = [];
  const seen = new Set<string>();
  // 明確變更：library 中 desired != mounted
  for (const mod of library) {
    const want = isDesired(mod.folder);
    const have = mountedFolders.has(mod.folder);
    if (want !== have) { rows.push({ folder: mod.folder, key: mod.key, enabled: want }); seen.add(mod.folder); }
  }
  // 同 key 自動移除：被掛載中、且 key 與「要新增掛載」的某項相同 → 自動加入移除
  const addedKeys = new Set(rows.filter((r) => r.enabled).map((r) => r.key));
  if (addedKeys.size) {
    for (const m of mountedMods) {
      if (seen.has(m.folder)) continue;
      if (isDesired(m.folder) === false) continue; // 使用者已主動取消的會在上面處理
      if (addedKeys.has(m.key)) { rows.push({ folder: m.folder, key: m.key, enabled: false, implicit: true }); seen.add(m.folder); }
    }
  }
  // 衝突：同時勾選多個「相同 key 且未掛載」的 mod → 無法判斷掛哪個 → 標記衝突（紫底、無法 Apply）
  const enabledByKey = new Map<string, RuntimeChange[]>();
  for (const r of rows) {
    if (!r.enabled) continue;
    const list = enabledByKey.get(r.key) ?? [];
    list.push(r);
    enabledByKey.set(r.key, list);
  }
  for (const list of enabledByKey.values()) {
    if (list.length >= 2) for (const r of list) r.conflict = true;
  }
  return rows;
}

function filterAndSortMods(mods: RuntimeMod[], filter: string, sort: ModSort, mountedFolders: Set<string>) {
  const f = filter.trim().toLowerCase();
  const filtered = f
    ? mods.filter((m) => `${m.folder} ${m.key} ${typeToCategory(m.type)} ${mountedFolders.has(m.folder) ? "mounted" : "available"}`.toLowerCase().includes(f))
    : mods;
  return [...filtered].sort((a, b) => {
    const va = sortValue(a, sort.key, mountedFolders);
    const vb = sortValue(b, sort.key, mountedFolders);
    const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: "base" });
    return sort.direction === "asc" ? cmp : -cmp;
  });
}
function sortValue(mod: RuntimeMod, key: ModSortKey, mountedFolders: Set<string>) {
  if (key === "name") return mod.key;
  if (key === "category") return typeToCategory(mod.type);
  if (key === "status") return mountedFolders.has(mod.folder) ? "mounted" : "available";
  return mod.folder;
}

function pushLog(setLogs: Dispatch<SetStateAction<LogEntry[]>>, message: string, tone?: LogEntry["tone"]) {
  setLogs((cur) => [createLogEntry(message, tone), ...cur].slice(0, 200));
}
function createLogEntry(message: string, tone?: LogEntry["tone"]): LogEntry {
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, time, message, tone };
}
function formatFolderName(folder: string) {
  const normalized = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? folder;
}
function formatModsLockReason(versionLocked: boolean, appReady: boolean, injectionMissing: boolean, missingModsDir: boolean, modsActionLocked: boolean) {
  if (versionLocked) return "Update BD-SpineX version";
  if (!appReady) return "PlayCover BrownDust II / loader not found";
  if (injectionMissing) return "Install Runtime Injection";
  if (missingModsDir) return "Select a Mods Folder";
  if (modsActionLocked) return "Action running";
  return "Mods are locked";
}
function formatPendingToneClass(tone?: PendingTone) {
  return tone === "conflict" ? "pendingPatchConflict" : tone === "added" ? "pendingPatchAdd" : tone === "removed" ? "pendingPatchRemove" : "";
}

function makeAuthorRule(id: string, name: string, color: string, custom = false): AuthorRule {
  return {
    id,
    name,
    color,
    keywords: buildAuthorKeywords(id, name),
    custom
  };
}

function buildAuthorKeywords(id: string, name: string, extra: string[] = []) {
  const source = [
    id,
    name,
    id.replace(/[_-]+/g, " "),
    name.replace(/[._-]+/g, " "),
    compactForMatch(id),
    compactForMatch(name),
    ...extra
  ];
  return Array.from(new Set(source.map((value) => value.trim()).filter(Boolean)));
}

function normalizeAuthorId(name: string) {
  return name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "");
}

function normalizeForMatch(value: string) {
  return value.normalize("NFKC").toLowerCase();
}

function compactForMatch(value: string) {
  return normalizeForMatch(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function readTauriCanvasCartridgeMode() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("tauriCanvasCartridge");
  if (requested === "1" || requested === "true") {
    localStorage.setItem(TAURI_CANVAS_CARTRIDGE_KEY, "1");
    localStorage.removeItem(TAURI_CSS_CARTRIDGE_KEY);
  } else if (requested === "0" || requested === "false") {
    localStorage.removeItem(TAURI_CANVAS_CARTRIDGE_KEY);
    localStorage.setItem(TAURI_CSS_CARTRIDGE_KEY, "1");
  }

  if (document.documentElement.getAttribute("data-runtime") !== "tauri") return false;
  if (localStorage.getItem(TAURI_CSS_CARTRIDGE_KEY) === "1") return false;
  return true;
}

function readAuthorRules(): AuthorRule[] {
  try {
    const raw = localStorage.getItem(AUTHOR_RULES_KEY);
    if (!raw) return DEFAULT_AUTHOR_RULES;
    const stored = JSON.parse(raw) as AuthorRule[];
    if (!Array.isArray(stored)) return DEFAULT_AUTHOR_RULES;

    const byId = new Map(stored.filter((rule) => rule && typeof rule.id === "string").map((rule) => [rule.id, rule]));
    const merged = DEFAULT_AUTHOR_RULES.map((base) => {
      const storedRule = byId.get(base.id);
      const storedColor = storedRule?.color?.toLowerCase();
      const legacyColor = LEGACY_AUTHOR_COLORS_BY_ID.get(base.id);
      const color = !storedColor || storedColor === legacyColor ? base.color : storedRule?.color;
      return sanitizeAuthorRule({ ...base, ...storedRule, color, custom: false }, base);
    });
    for (const rule of stored) {
      if (rule?.custom && !DEFAULT_AUTHOR_RULES.some((base) => base.id === rule.id)) {
        merged.push(sanitizeAuthorRule(rule));
      }
    }
    return merged;
  } catch {
    return DEFAULT_AUTHOR_RULES;
  }
}

function sanitizeAuthorRule(rule: Partial<AuthorRule>, fallback?: AuthorRule): AuthorRule {
  const name = (rule.name || fallback?.name || "Unknown").trim();
  const id = normalizeAuthorId(rule.id || fallback?.id || name) || "unknown";
  const color = /^#[0-9a-f]{6}$/i.test(rule.color || "") ? rule.color as string : fallback?.color || "#8d97aa";
  const keywords = buildAuthorKeywords(id, name, [...(fallback?.keywords ?? []), ...(Array.isArray(rule.keywords) ? rule.keywords : [])]);
  return { id, name, color, keywords, custom: Boolean(rule.custom) };
}

function persistAuthorRules(rules: AuthorRule[]) {
  localStorage.setItem(AUTHOR_RULES_KEY, JSON.stringify(rules));
}

function detectModAuthor(mod: RuntimeMod, authorRules: AuthorRule[]): DetectedAuthor {
  const meta = mod as RuntimeMod & { author?: string };
  if (meta.author) {
    const exact = authorRules.find((rule) => normalizeForMatch(rule.name) === normalizeForMatch(meta.author || "") || rule.id === normalizeAuthorId(meta.author || ""));
    return exact ? { id: exact.id, name: exact.name, color: exact.color } : { id: normalizeAuthorId(meta.author), name: meta.author, color: "#8d97aa" };
  }

  const target = `${mod.path} ${mod.folder} ${mod.key}`;
  const haystack = normalizeForMatch(target);
  const compactHaystack = compactForMatch(target);
  for (const rule of authorRules) {
    for (const keyword of rule.keywords) {
      if (matchesAuthorKeyword(haystack, compactHaystack, keyword)) {
        return { id: rule.id, name: rule.name, color: rule.color };
      }
    }
  }
  return { id: "unknown", name: "Unknown", color: "#8d97aa" };
}

function detectModCharacter(mod: RuntimeMod): DetectedCharacter | null {
  const key = mod.key.toLowerCase();
  const cutsceneCharacter = lookupCharacterById(extractModAssetId(key, "cutscene_char"));
  const standingCharacter = lookupCharacterById(extractModAssetId(key, "char"));
  const datingCharacter = lookupDatingCharacterById(extractModAssetId(key, "illust_dating"));

  if (mod.type === "skillcut") {
    return cutsceneCharacter;
  }

  if (mod.type === "standing") {
    return standingCharacter;
  }

  if (mod.type === "dating") {
    return datingCharacter;
  }

  const npcId = extractModAssetId(key, "npc");
  return cutsceneCharacter ?? standingCharacter ?? datingCharacter ?? (npcId ? CHARACTER_BY_NPC_ID.get(npcId) ?? null : null);
}

function lookupCharacterById(id: string | null | undefined) {
  return id ? CHARACTER_BY_ID.get(id) ?? null : null;
}

function resolveBackdropCharacter(id: string): DetectedCharacter {
  return lookupCharacterById(id) ?? {
    id,
    imageId: id,
    character: `Character ${id}`,
    costume: "Backdrop source"
  };
}

function backdropSlotRollDuration(duration?: number) {
  const requested = Number.isFinite(duration) ? Number(duration) * 0.82 : BACKDROP_SLOT_ROLL_MAX_MS;
  return Math.max(BACKDROP_SLOT_ROLL_MIN_MS, Math.min(BACKDROP_SLOT_ROLL_MAX_MS, requested));
}

function backdropSlotRollDelay(progress: number) {
  const eased = easeInCubic(Math.max(0, Math.min(1, progress)));
  return Math.round(BACKDROP_SLOT_ROLL_TICK_MS + eased * 188);
}

function easeInCubic(t: number) {
  return t * t * t;
}

function pickBackdropSlotCharacter(targetId: string, tick: number): DetectedCharacter {
  if (!BACKDROP_SLOT_CANDIDATES.length) return resolveBackdropCharacter(targetId);
  const index = Math.floor((Math.random() * BACKDROP_SLOT_CANDIDATES.length + tick * 7) % BACKDROP_SLOT_CANDIDATES.length);
  const candidate = BACKDROP_SLOT_CANDIDATES[index];
  if (candidate.id === targetId && BACKDROP_SLOT_CANDIDATES.length > 1) {
    return BACKDROP_SLOT_CANDIDATES[(index + tick + 1) % BACKDROP_SLOT_CANDIDATES.length];
  }
  return candidate;
}

function lookupDatingCharacterById(datingId: string | null | undefined) {
  if (!datingId) return null;
  const characterId = CHARACTER_ASSETS.dating[datingId] ?? CHARACTER_ASSETS.dating[String(Number(datingId))];
  return lookupCharacterById(characterId ?? null);
}

function extractModAssetId(key: string, prefix: string) {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return key.match(new RegExp(`^${escapedPrefix}[\\s_.-]*(\\d+)`))?.[1] ?? null;
}

function matchesAuthorKeyword(haystack: string, compactHaystack: string, keyword: string) {
  const normalized = normalizeForMatch(keyword);
  const compact = compactForMatch(keyword);
  if (!normalized && !compact) return false;
  if (/^[a-z0-9]{1,2}$/.test(compact)) {
    return haystack.split(/[^\p{L}\p{N}]+/u).includes(compact);
  }
  return (normalized && haystack.includes(normalized)) || (compact.length >= 3 && compactHaystack.includes(compact));
}

function categoryTypeIconPath(category: ModCategory) {
  const icon = category === "char" ? "standing" : category === "dating" ? "dating" : category === "cutscene" ? "cutscene" : "npc";
  return publicAssetPath(`bd2modmanager-icons/${icon}.png`);
}

function categoryTypeLabel(category: ModCategory) {
  return category === "char" ? "Standing" : category === "dating" ? "Dating" : category === "cutscene" ? "Cutscene" : "NPC";
}

function normalizeVersionForCompare(version?: string) {
  return version?.trim().replace(/^v/i, "").split(/[+-]/)[0];
}
function isDetectedGameVersionMismatch(appInfo: AppInfo, gameVersionInfo: GameVersionInfo | null) {
  const g = normalizeVersionForCompare(gameVersionInfo?.version);
  const s = normalizeVersionForCompare(appInfo.supportedGameVersion || appInfo.version);
  return Boolean(g && s && g !== s);
}
function formatInjectionVersionLockMessage(appInfo: AppInfo, gameVersionInfo: GameVersionInfo | null) {
  const supported = appInfo.supportedGameVersion || appInfo.version;
  const detected = gameVersionInfo?.version ?? "unknown";
  return `Runtime Injection is locked: this BD-SpineX app supports BrownDust II ${supported}, but the detected game version is ${detected}. Update BD-SpineX to the matching app version.`;
}
function formatVersionBadge(appInfo: AppInfo, gameVersionInfo: GameVersionInfo | null) {
  const managerVersion = `v${appInfo.version}`;
  const gameVersion = gameVersionInfo?.version;
  const supported = appInfo.supportedGameVersion || appInfo.version;
  return gameVersion && normalizeVersionForCompare(gameVersion) !== normalizeVersionForCompare(supported) ? `${managerVersion} [${gameVersion}]` : managerVersion;
}
function formatVersionTitle(appInfo: AppInfo, gameVersionInfo: GameVersionInfo | null) {
  const gameVersion = gameVersionInfo?.version;
  const supported = appInfo.supportedGameVersion || appInfo.version;
  return `Manager: ${appInfo.version}${supported !== appInfo.version ? `\nSupported game: ${supported}` : ""}${gameVersion ? `\nGame: ${gameVersion}` : ""}`;
}
function isGameVersionMismatch(appInfo: AppInfo, gameVersionInfo: GameVersionInfo | null) {
  if (appInfo.development) return false;
  return isDetectedGameVersionMismatch(appInfo, gameVersionInfo);
}

function migrationSignature(migration: LegacyRuntimeMigrationCheck) {
  return JSON.stringify({
    sourceVersions: migration.sourceVersions,
    modNames: migration.modNames
  });
}

function renderModSortButton(label: string, key: ModSortKey, sort: ModSort, onSort: (key: ModSortKey) => void) {
  const active = sort.key === key;
  const direction = active ? sort.direction : undefined;
  return (
    <button className={`sortButton ${active ? "active" : ""}`} type="button" onClick={() => onSort(key)}>
      <span>{label}</span>
      <span aria-hidden="true">{direction === "asc" ? "▲" : direction === "desc" ? "▼" : "↕"}</span>
    </button>
  );
}

function Cartridge(props: {
  mod: RuntimeMod;
  have: boolean;
  selected: boolean;
  tone?: PendingTone;
  locked: boolean;
  lockedReason?: string;
  onToggle: () => void;
  authorRules?: AuthorRule[];
  buttonRef?: (node: HTMLButtonElement | null) => void;
  isPendingLinked?: boolean;
  isPendingTarget?: boolean;
}) {
  const { mod, have, selected, tone, locked, lockedReason, onToggle, buttonRef, isPendingLinked = false, isPendingTarget = false } = props;
  const category = typeToCategory(mod.type);
  const folderName = formatFolderName(mod.folder);
  const stateClass =
    tone === "conflict" ? "is-conflict" :
    tone === "added" ? "is-add" :
    tone === "removed" ? "is-remove" :
    have ? "is-mounted" : "";
  const status =
    tone === "conflict" ? "conflict · same key" :
    tone === "added" ? "staged · mount" :
    tone === "removed" ? "staged · unmount" :
    have ? "mounted" : "available";
  const title = `${folderName}\n${mod.key} · ${category}\n${have ? "mounted" : "available"}${mod.skeleton === "skel" ? "\nBinary .skel (converted to .json on mount when possible)" : ""}${lockedReason ? `\nLocked: ${lockedReason}` : ""}`;
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`cart cat-${category} ${stateClass} ${selected ? "is-selected" : ""} ${isPendingLinked ? "is-pending-linked" : ""} ${isPendingTarget ? "is-pending-target" : ""}`}
      disabled={locked}
      onClick={onToggle}
      aria-pressed={selected}
      title={title}
    >
      <span className="cartCheck" aria-hidden="true">✓</span>
      <span className="cartLabel">
        <span className="cartArt" aria-hidden="true" />
        <span className="cartCap">{mod.key}</span>
      </span>
      <span className="cartBody">
        <span className="cartText">
          <span className="cartTitle">{folderName}</span>
          <span className="cartStatus">{status}</span>
        </span>
        <span className="cartCatDot" aria-hidden="true" />
      </span>
      <span className="cartPins" aria-hidden="true">
        <i /><i /><i /><i /><i /><i /><i /><i />
      </span>
    </button>
  );
}

// Skeuomorphic collector cartridge: type-colored handheld-game plastic with a
// printed mod label, top-left issue badge, optional wrapper/warning overlays,
// molded ridges, and a shallow bottom groove.
function CartridgeRealistic(props: {
  mod: RuntimeMod;
  have: boolean;
  selected: boolean;
  tone?: PendingTone;
  locked: boolean;
  lockedReason?: string;
  onToggle: () => void;
  authorRules?: AuthorRule[];
  buttonRef?: (node: HTMLButtonElement | null) => void;
  isPendingLinked?: boolean;
  isPendingTarget?: boolean;
  onPreview?: () => void;
}) {
  const { mod, have, selected, tone, locked, lockedReason, onToggle, authorRules = DEFAULT_AUTHOR_RULES, buttonRef, isPendingLinked = false, isPendingTarget = false, onPreview } = props;
  const meta = mod as RuntimeMod & { author?: string; cover?: string };
  const category = typeToCategory(mod.type);
  const folderName = formatFolderName(mod.folder);
  const hasIssue = tone === "conflict" || mod.skeleton === "unknown";
  const mountBlocked = !have && mod.skeleton === "unknown";
  const stateClass =
    hasIssue ? "is-warning" :
    tone === "added" ? "is-add" :
    tone === "removed" ? "is-remove" :
    have ? "is-mounted" : "";
  const skinClass = `${hasIssue ? "is-problem" : ""} ${!have ? "is-wrapped" : ""}`;
  const pack = categoryPack(category);
  const typeIcon = categoryTypeIconPath(category);
  const typeLabel = categoryTypeLabel(category);
  const detectedAuthor = detectModAuthor(mod, authorRules);
  const showAuthorSticker = detectedAuthor.id !== "unknown";
  const detectedCharacter = detectModCharacter(mod);
  const authorStyle = { "--author-color": detectedAuthor.color } as CSSProperties;
  const displayTitle = cartridgeHeadline(folderName, mod.key);
  const runtimeLabel =
    tone === "conflict" ? "CONFLICT" :
    mod.skeleton === "unknown" ? "CHECK FILES" :
    tone === "added" ? "STAGED MOUNT" :
    tone === "removed" ? "STAGED UNMOUNT" :
    have ? "MOUNTED" : "AVAILABLE";
  const title = `${folderName}\n${mod.key} · ${category}\nAuthor: ${detectedAuthor.name}\n${have ? "mounted" : "available"}${mod.skeleton === "skel" ? "\nBinary .skel (converted to .json on mount when possible)" : ""}${mod.skeleton === "unknown" ? "\nMissing .json or .skel skeleton file" : ""}${lockedReason ? `\nLocked: ${lockedReason}` : ""}`;
  const coverStyle = meta.cover ? ({ "--rcart-cover": `url("${meta.cover}")` } as CSSProperties) : undefined;
  const podTone = tone === "removed" ? "minus" : have ? "check" : "plus";
  const podMark = podTone === "minus" ? "-" : podTone === "check" ? "✓" : "+";
  return (
    <span className="rcartWrap">
      <button
        type="button"
        ref={buttonRef}
        className={`rcart cat-${category} ${stateClass} ${skinClass} ${have ? "is-have" : ""} ${selected ? "is-on" : ""} ${isPendingLinked ? "is-pending-linked" : ""} ${isPendingTarget ? "is-pending-target" : ""}`}
        disabled={locked || mountBlocked}
        onClick={onToggle}
        aria-pressed={selected}
        title={title}
      >
        <span className="rcartShell">
          <span className="rcartRidges rcartRidges--left" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></span>
          <span className="rcartRidges rcartRidges--right" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></span>
          <span className={`rcartNo rcartTypeBadge is-${category}`} aria-hidden="true" title={typeLabel}>
            <img src={typeIcon} alt="" draggable={false} />
          </span>
          <span className="rcartLabel">
            <span className="rcartArt" style={coverStyle} aria-hidden="true" />
            <span className="rcartAged" aria-hidden="true" />
            <span className="rcartGloss" aria-hidden="true" />
            {detectedCharacter ? (
              <span className="rcartPortrait" aria-hidden="true" title={`${detectedCharacter.character} - ${detectedCharacter.costume}`}>
                <img src={publicAssetPath(`characters/standing/${detectedCharacter.imageId}.png`)} alt="" draggable={false} loading="lazy" />
              </span>
            ) : null}
            <span className="rcartHead">
              <span className="rcartPack">{pack}</span>
              <span className="rcartCode">{mod.key}</span>
            </span>
            <span className="rcartTitle2">{displayTitle}</span>
            <span className="rcartCredits" aria-hidden="true">
              <span>ASSET {mod.key}</span>
              <span>{`MOD BY ${detectedAuthor.name.toUpperCase()}`}</span>
              <span>RUNTIME {runtimeLabel}</span>
            </span>
          </span>
          {showAuthorSticker ? (
            <span className="rcartAuthorSticker" style={authorStyle} aria-hidden="true">
              <span className="rcartAuthorLabel">Author</span>
              <strong><span className="rcartAuthorName">{detectedAuthor.name}</span></strong>
            </span>
          ) : null}
          <span className="rcartPlastic" aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="rcartWarningSticker" aria-hidden="true">
            <svg className="rcartWarningIcon" viewBox="0 0 64 58" focusable="false">
              <path className="rcartWarningTriangle" d="M32 6 C34.8 6 36.2 8 37.8 10.8 L58.3 47 C60.1 50.2 58.1 54 54.3 54 H9.7 C5.9 54 3.9 50.2 5.7 47 L26.2 10.8 C27.8 8 29.2 6 32 6 Z" />
              <path className="rcartWarningInnerLine" d="M32 16 C33.1 16 33.8 17.1 34.5 18.4 L49.1 44.2 C49.9 45.6 49 47.2 47.4 47.2 H16.6 C15 47.2 14.1 45.6 14.9 44.2 L29.5 18.4 C30.2 17.1 30.9 16 32 16 Z" />
              <path className="rcartWarningBang" d="M32 25.4 L32 34.6" />
              <circle className="rcartWarningDot" cx="32" cy="40.9" r="1.8" />
            </svg>
          </span>
          <span className="rcartBottomGroove" aria-hidden="true" />
        </span>
        <span className={`rcartPod is-${podTone} ${selected ? "on" : ""}`} aria-hidden="true"><span className="rcartPodMark">{podMark}</span></span>
        <span className="rcartNamePlate" aria-hidden="true">
          <span className="rcartNameKind">
            {pack}
            {onPreview ? (
              <span
                className="rcartPreviewButton"
                role="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onPreview();
                }}
                title={`Preview ${folderName}`}
                aria-label={`Preview ${folderName}`}
              >
                ▶ Preview
              </span>
            ) : null}
          </span>
          <strong>{displayTitle}</strong>
        </span>
      </button>
    </span>
  );
}

type CanvasImageEntry = {
  image: HTMLImageElement;
  loaded: boolean;
  failed: boolean;
  listeners: Set<() => void>;
};

type CanvasCartridgePaint = {
  category: ModCategory;
  have: boolean;
  tone?: PendingTone;
  hasIssue: boolean;
  cover: HTMLImageElement | null;
  portrait: HTMLImageElement | null;
  plastic: HTMLImageElement | null;
};

const CANVAS_IMAGE_CACHE = new Map<string, CanvasImageEntry>();

function CanvasCartridge(props: {
  mod: RuntimeMod;
  have: boolean;
  selected: boolean;
  tone?: PendingTone;
  locked: boolean;
  lockedReason?: string;
  onToggle: () => void;
  authorRules?: AuthorRule[];
  buttonRef?: (node: HTMLButtonElement | null) => void;
  isPendingLinked?: boolean;
  isPendingTarget?: boolean;
  onPreview?: () => void;
}) {
  const { mod, have, selected, tone, locked, lockedReason, onToggle, authorRules = DEFAULT_AUTHOR_RULES, buttonRef, isPendingLinked = false, isPendingTarget = false, onPreview } = props;
  const meta = mod as RuntimeMod & { author?: string; cover?: string };
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const plasticCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [imageVersion, setImageVersion] = useState(0);
  const category = typeToCategory(mod.type);
  const folderName = formatFolderName(mod.folder);
  const hasIssue = tone === "conflict" || mod.skeleton === "unknown";
  const mountBlocked = !have && mod.skeleton === "unknown";
  const stateClass =
    hasIssue ? "is-warning" :
    tone === "added" ? "is-add" :
    tone === "removed" ? "is-remove" :
    have ? "is-mounted" : "";
  const skinClass = `${hasIssue ? "is-problem" : ""} ${!have ? "is-wrapped" : ""}`;
  const detectedAuthor = detectModAuthor(mod, authorRules);
  const showAuthorSticker = detectedAuthor.id !== "unknown";
  const detectedCharacter = detectModCharacter(mod);
  const pack = categoryPack(category);
  const displayTitle = cartridgeHeadline(folderName, mod.key);
  const typeIcon = categoryTypeIconPath(category);
  const typeLabel = categoryTypeLabel(category);
  const authorStyle = { "--author-color": detectedAuthor.color } as CSSProperties;
  const coverUrl = meta.cover || null;
  const portraitUrl = detectedCharacter ? publicAssetPath(`characters/standing/${detectedCharacter.imageId}.png`) : null;
  const runtimeLabel =
    tone === "conflict" ? "CONFLICT" :
    mod.skeleton === "unknown" ? "CHECK FILES" :
    tone === "added" ? "STAGED MOUNT" :
    tone === "removed" ? "STAGED UNMOUNT" :
    have ? "MOUNTED" : "AVAILABLE";
  const title = `${folderName}\n${mod.key} · ${category}\nAuthor: ${detectedAuthor.name}\n${have ? "mounted" : "available"}${mod.skeleton === "skel" ? "\nBinary .skel (converted to .json on mount when possible)" : ""}${mod.skeleton === "unknown" ? "\nMissing .json or .skel skeleton file" : ""}${lockedReason ? `\nLocked: ${lockedReason}` : ""}`;

  useEffect(() => {
    const urls = [coverUrl, portraitUrl, HEATSEAL_FILM_OVERLAY_URL].filter(Boolean) as string[];
    const onReady = () => setImageVersion((value) => value + 1);
    const cleanups = urls.map((url) => subscribeCanvasImage(url, onReady));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [coverUrl, portraitUrl]);

  useLayoutEffect(() => {
    const baseCanvas = baseCanvasRef.current;
    const plasticCanvas = plasticCanvasRef.current;
    if (!baseCanvas || !plasticCanvas) return;

    let paintFrame = 0;
    const paint = () => {
      const paintModel: CanvasCartridgePaint = {
        category,
        have,
        tone,
        hasIssue,
        cover: getReadyCanvasImage(coverUrl),
        portrait: getReadyCanvasImage(portraitUrl),
        plastic: getReadyCanvasImage(HEATSEAL_FILM_OVERLAY_URL)
      };
      paintMeasuredCanvas(baseCanvas, (ctx, width, height) => drawCanvasCartridgeBase(ctx, width, height, paintModel));
      paintMeasuredCanvas(plasticCanvas, (ctx, width, height) => drawCanvasCartridgePlastic(ctx, width, height, paintModel));
    };
    const schedulePaint = () => {
      window.cancelAnimationFrame(paintFrame);
      paintFrame = window.requestAnimationFrame(paint);
    };

    schedulePaint();
    const observer = new ResizeObserver(schedulePaint);
    observer.observe(baseCanvas);
    observer.observe(plasticCanvas);
    return () => {
      window.cancelAnimationFrame(paintFrame);
      observer.disconnect();
    };
  }, [
    category,
    coverUrl,
    hasIssue,
    have,
    imageVersion,
    portraitUrl,
    tone
  ]);

  const podTone = tone === "removed" ? "minus" : have ? "check" : "plus";
  const podMark = podTone === "minus" ? "-" : podTone === "check" ? "✓" : "+";

  return (
    <span className="rcartWrap">
      <button
        type="button"
        ref={buttonRef}
        className={`rcart rcart--canvas cat-${category} ${stateClass} ${skinClass} ${have ? "is-have" : ""} ${selected ? "is-on" : ""} ${isPendingLinked ? "is-pending-linked" : ""} ${isPendingTarget ? "is-pending-target" : ""}`}
        disabled={locked || mountBlocked}
        onClick={onToggle}
        aria-pressed={selected}
        title={title}
      >
        <span className="rcartShell">
          <canvas className="rcartCanvasBase" ref={baseCanvasRef} aria-hidden="true" />
          <span className={`rcartNo rcartTypeBadge is-${category}`} aria-hidden="true" title={typeLabel}>
            <img src={typeIcon} alt="" draggable={false} />
          </span>
          <span className="rcartLabel">
            <span className="rcartHead">
              <span className="rcartPack">{pack}</span>
              <span className="rcartCode">{mod.key}</span>
            </span>
            <span className="rcartTitle2">{displayTitle}</span>
            <span className="rcartCredits" aria-hidden="true">
              <span>ASSET {mod.key}</span>
              <span>{`MOD BY ${detectedAuthor.name.toUpperCase()}`}</span>
              <span>RUNTIME {runtimeLabel}</span>
            </span>
          </span>
          {showAuthorSticker ? (
            <span className="rcartAuthorSticker" style={authorStyle} aria-hidden="true">
              <span className="rcartAuthorLabel">Author</span>
              <strong><span className="rcartAuthorName">{detectedAuthor.name}</span></strong>
            </span>
          ) : null}
          <canvas className="rcartCanvasPlastic" ref={plasticCanvasRef} aria-hidden="true" />
          <span className="rcartWarningSticker" aria-hidden="true">
            <svg className="rcartWarningIcon" viewBox="0 0 64 58" focusable="false">
              <path className="rcartWarningTriangle" d="M32 6 C34.8 6 36.2 8 37.8 10.8 L58.3 47 C60.1 50.2 58.1 54 54.3 54 H9.7 C5.9 54 3.9 50.2 5.7 47 L26.2 10.8 C27.8 8 29.2 6 32 6 Z" />
              <path className="rcartWarningInnerLine" d="M32 16 C33.1 16 33.8 17.1 34.5 18.4 L49.1 44.2 C49.9 45.6 49 47.2 47.4 47.2 H16.6 C15 47.2 14.1 45.6 14.9 44.2 L29.5 18.4 C30.2 17.1 30.9 16 32 16 Z" />
              <path className="rcartWarningBang" d="M32 25.4 L32 34.6" />
              <circle className="rcartWarningDot" cx="32" cy="40.9" r="1.8" />
            </svg>
          </span>
          <span className="rcartBottomGroove" aria-hidden="true" />
        </span>
        <span className={`rcartPod is-${podTone} ${selected ? "on" : ""}`} aria-hidden="true"><span className="rcartPodMark">{podMark}</span></span>
        <span className="rcartNamePlate" aria-hidden="true">
          <span className="rcartNameKind">
            {pack}
            {onPreview ? (
              <span
                className="rcartPreviewButton"
                role="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onPreview();
                }}
                title={`Preview ${folderName}`}
                aria-label={`Preview ${folderName}`}
              >
                ▶ Preview
              </span>
            ) : null}
          </span>
          <strong>{displayTitle}</strong>
        </span>
      </button>
    </span>
  );
}

function subscribeCanvasImage(src: string, onReady: () => void) {
  const entry = ensureCanvasImage(src);
  if (entry.loaded || entry.failed) return () => {};
  entry.listeners.add(onReady);
  return () => entry.listeners.delete(onReady);
}

function ensureCanvasImage(src: string) {
  const cached = CANVAS_IMAGE_CACHE.get(src);
  if (cached) return cached;

  const image = new Image();
  const entry: CanvasImageEntry = { image, loaded: false, failed: false, listeners: new Set() };
  image.onload = () => {
    entry.loaded = true;
    for (const listener of entry.listeners) listener();
    entry.listeners.clear();
  };
  image.onerror = () => {
    entry.failed = true;
    for (const listener of entry.listeners) listener();
    entry.listeners.clear();
  };
  image.src = src;
  CANVAS_IMAGE_CACHE.set(src, entry);
  return entry;
}

function getReadyCanvasImage(src: string | null | undefined) {
  if (!src) return null;
  const entry = ensureCanvasImage(src);
  return entry.loaded ? entry.image : null;
}

function paintMeasuredCanvas(canvas: HTMLCanvasElement, draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw(ctx, width, height);
}

function drawCanvasCartridgeBase(ctx: CanvasRenderingContext2D, width: number, height: number, paint: CanvasCartridgePaint) {
  ctx.clearRect(0, 0, width, height);
  const palette = canvasCartridgePalette(paint.category);
  const scale = width / 224;
  const plugDepth = Math.min(12 * scale, height * 0.12);
  const bodyHeight = height - plugDepth;

  ctx.save();
  canvasCartridgeShellPath(ctx, width, bodyHeight, plugDepth, 7 * scale);
  ctx.clip();
  const shell = ctx.createLinearGradient(0, 0, 0, height);
  const shoulderStop = bodyHeight / height;
  shell.addColorStop(0, palette.shellLight);
  shell.addColorStop(0.18, colorMixHex(palette.shellLight, "#ffffff", 0.16));
  shell.addColorStop(Math.min(0.52, shoulderStop - 0.26), palette.shellMid);
  shell.addColorStop(Math.max(0.72, shoulderStop - 0.08), colorMixHex(palette.shellDark, "#000000", 0.06));
  shell.addColorStop(shoulderStop, palette.shellDark);
  shell.addColorStop(1, colorMixHex(palette.shellDark, palette.shellEdge, 0.22));
  ctx.fillStyle = shell;
  ctx.fillRect(0, 0, width, height);

  const sideShade = ctx.createLinearGradient(0, 0, width, 0);
  sideShade.addColorStop(0, "rgba(7, 20, 42, 0.38)");
  sideShade.addColorStop(0.06, "rgba(7, 20, 42, 0.18)");
  sideShade.addColorStop(0.12, "rgba(255, 255, 255, 0)");
  sideShade.addColorStop(0.88, "rgba(255, 255, 255, 0)");
  sideShade.addColorStop(0.95, "rgba(7, 20, 42, 0.16)");
  sideShade.addColorStop(1, "rgba(7, 20, 42, 0.32)");
  ctx.fillStyle = sideShade;
  ctx.fillRect(0, 0, width, height);

  const plugThickness = ctx.createLinearGradient(0, bodyHeight + plugDepth - 8 * scale, 0, bodyHeight + plugDepth);
  plugThickness.addColorStop(0, "rgba(7, 20, 42, 0)");
  plugThickness.addColorStop(1, paint.category === "char" ? "rgba(45, 52, 61, 0.38)" : "rgba(3, 12, 28, 0.46)");
  ctx.fillStyle = plugThickness;
  ctx.fillRect(0, bodyHeight + plugDepth - 8 * scale, width, 8 * scale);

  const moldedInset = ctx.createLinearGradient(0, 0, 0, height);
  moldedInset.addColorStop(0, "rgba(255, 255, 255, 0.26)");
  moldedInset.addColorStop(0.08, "rgba(255, 255, 255, 0)");
  moldedInset.addColorStop(0.86, "rgba(0, 0, 0, 0)");
  moldedInset.addColorStop(1, "rgba(5, 18, 39, 0.34)");
  ctx.fillStyle = moldedInset;
  roundedRectPath(ctx, 7 * scale, 7 * scale, width - 14 * scale, bodyHeight - 17 * scale, 4 * scale);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundedRectPath(ctx, 8 * scale, 0, width - 16 * scale, 14 * scale, 5 * scale);
  const top = ctx.createLinearGradient(0, 0, 0, 14 * scale);
  top.addColorStop(0, paint.category === "char" ? "rgba(245, 248, 250, 0.42)" : paint.category === "other" ? "rgba(255, 190, 112, 0.38)" : "rgba(174, 202, 238, 0.4)");
  top.addColorStop(1, paint.category === "char" ? "rgba(125, 134, 145, 0.24)" : paint.category === "other" ? "rgba(184, 73, 28, 0.24)" : "rgba(78, 119, 178, 0.3)");
  ctx.fillStyle = top;
  ctx.fill();
  ctx.restore();

  const sideDark = paint.category === "char" ? "rgba(77, 84, 93, 0.82)" : paint.category === "cutscene" ? "rgba(16, 18, 25, 0.9)" : paint.category === "other" ? "rgba(126, 38, 20, 0.84)" : "rgba(24, 51, 86, 0.76)";
  const sideLight = paint.category === "char" ? "rgba(143, 153, 164, 0.38)" : paint.category === "cutscene" ? "rgba(78, 84, 98, 0.36)" : paint.category === "other" ? "rgba(255, 154, 74, 0.42)" : "rgba(70, 110, 165, 0.4)";
  const sideHighlight = paint.category === "other" ? "rgba(255, 199, 126, 0.14)" : "rgba(255, 255, 255, 0.11)";
  const leftSide = ctx.createLinearGradient(0, 0, 13 * scale, 0);
  leftSide.addColorStop(0, sideDark);
  leftSide.addColorStop(1, sideLight);
  const rightSide = ctx.createLinearGradient(width - 13 * scale, 0, width, 0);
  rightSide.addColorStop(0, sideLight);
  rightSide.addColorStop(1, sideDark);
  for (let index = 0; index < 9; index += 1) {
    const ridgeY = (35 + index * 8.7) * scale;
    roundedRectPath(ctx, 0, ridgeY, 11 * scale, 5.5 * scale, 3 * scale);
    ctx.fillStyle = leftSide;
    ctx.fill();
    ctx.fillStyle = sideHighlight;
    ctx.fillRect(8.5 * scale, ridgeY + 1 * scale, 1 * scale, 3.5 * scale);

    roundedRectPath(ctx, width - 11 * scale, ridgeY, 11 * scale, 5.5 * scale, 3 * scale);
    ctx.fillStyle = rightSide;
    ctx.fill();
    ctx.fillStyle = sideHighlight;
    ctx.fillRect(width - 9.5 * scale, ridgeY + 1 * scale, 1 * scale, 3.5 * scale);
  }

  drawCanvasShellScuffs(ctx, width, bodyHeight, paint, scale);
  drawCanvasCover(ctx, 29 * scale, 30 * scale, width - 60 * scale, bodyHeight - 65 * scale, palette, paint, scale);

  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
  ctx.lineWidth = 1 * scale;
  roundedRectPath(ctx, 8 * scale, 8 * scale, width - 15 * scale, bodyHeight - 18 * scale, 4 * scale);
  ctx.stroke();
  ctx.restore();

}

function drawCanvasCover(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, palette: ReturnType<typeof canvasCartridgePalette>, paint: CanvasCartridgePaint, scale: number) {
  ctx.save();
  roundedRectPath(ctx, x, y, width, height, 5 * scale);
  ctx.clip();
  ctx.fillStyle = paint.category === "char" ? "#f4f4ef" : "#050508";
  ctx.fillRect(x, y, width, height);

  if (paint.cover) {
    drawCoverImage(ctx, paint.cover, x, y, width, height, paint.category);
  } else {
    const fallback = ctx.createLinearGradient(x, y, x + width, y + height);
    fallback.addColorStop(0, paint.category === "char" ? "#f0efe9" : "#090a0f");
    fallback.addColorStop(0.35, paint.category === "char" ? "#f0efe9" : "#090a0f");
    fallback.addColorStop(0.36, paint.category === "char" ? "#96a0a2" : "#2d3038");
    fallback.addColorStop(1, paint.category === "char" ? "#96a0a2" : "#2d3038");
    ctx.fillStyle = fallback;
    ctx.fillRect(x, y, width, height);
  }

  const veil = ctx.createLinearGradient(x, y, x + width, y);
  if (paint.category === "char") {
    veil.addColorStop(0, "rgba(247, 247, 243, 0.98)");
    veil.addColorStop(0.34, "rgba(247, 247, 243, 0.98)");
    veil.addColorStop(1, "rgba(247, 247, 243, 0.36)");
  } else {
    veil.addColorStop(0, "rgba(3, 4, 7, 0.98)");
    veil.addColorStop(0.33, "rgba(3, 4, 7, 0.98)");
    veil.addColorStop(1, "rgba(3, 4, 7, 0.2)");
  }
  ctx.fillStyle = veil;
  ctx.fillRect(x, y, width, height);

  ctx.save();
  ctx.translate(x + width * 0.55, y + height * 0.5);
  ctx.rotate(paint.category === "char" ? -0.18 : -0.24);
  ctx.fillStyle = paint.category === "char" ? "rgba(205, 211, 211, 0.36)" : palette.labelRed;
  ctx.fillRect(-width * 0.09, -height, width * 0.24, height * 2);
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = paint.category === "char" ? "multiply" : "screen";
  ctx.globalAlpha = paint.category === "char" ? 0.42 : 0.55;
  ctx.fillStyle = paint.category === "char" ? "rgba(82, 88, 92, 0.24)" : "rgba(10, 10, 14, 0.8)";
  ctx.beginPath();
  ctx.moveTo(x, y + height * 0.55);
  ctx.lineTo(x + width, y + height * 0.18);
  ctx.lineTo(x + width, y + height * 0.24);
  ctx.lineTo(x, y + height * 0.61);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  if (paint.portrait) {
    drawCanvasPortrait(ctx, paint.portrait, x, y, width, height, paint.category, scale);
  } else if (!paint.cover) {
    ctx.fillStyle = paint.category === "char" ? "rgba(255, 255, 255, 0.48)" : "rgba(240, 241, 237, 0.58)";
    for (const [cx, cy, rx, ry] of [[0.75, 0.28, 0.14, 0.26], [0.76, 0.72, 0.2, 0.48], [0.54, 0.58, 0.12, 0.24]]) {
      ctx.beginPath();
      ctx.ellipse(x + width * cx, y + height * cy, width * rx, height * ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const aged = ctx.createRadialGradient(x + width * 0.48, y + height * 0.32, height * 0.2, x + width * 0.48, y + height * 0.32, width * 0.78);
  aged.addColorStop(0, "rgba(0, 0, 0, 0)");
  aged.addColorStop(0.72, "rgba(0, 0, 0, 0.12)");
  aged.addColorStop(1, "rgba(0, 0, 0, 0.42)");
  ctx.fillStyle = aged;
  ctx.fillRect(x, y, width, height);

  ctx.globalAlpha = paint.category === "char" ? 0.25 : 0.38;
  ctx.fillStyle = paint.category === "char" ? "rgba(0, 0, 0, 0.035)" : "rgba(255, 255, 255, 0.045)";
  for (let lineY = y; lineY < y + height; lineY += 3 * scale) {
    ctx.fillRect(x, lineY, width, 1 * scale);
  }
  ctx.globalAlpha = 1;

  const gloss = ctx.createLinearGradient(x, y, x + width, y + height);
  gloss.addColorStop(0, "rgba(255, 255, 255, 0.18)");
  gloss.addColorStop(0.3, "rgba(255, 255, 255, 0)");
  gloss.addColorStop(0.76, "rgba(255, 255, 255, 0)");
  gloss.addColorStop(1, "rgba(255, 255, 255, 0.06)");
  ctx.fillStyle = gloss;
  ctx.fillRect(x, y, width, height);

  drawCanvasPaperAge(ctx, x, y, width, height, paint, scale);
  ctx.restore();

  if (paint.category !== "char") {
    ctx.save();
    roundedRectPath(ctx, x, y, width, height, 5 * scale);
    ctx.lineWidth = 3 * scale;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.stroke();
    ctx.restore();
  }
}

function drawCanvasPortrait(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number, category: ModCategory, scale: number) {
  const portraitW = Math.min(width * 0.78, 124 * scale);
  const portraitH = portraitW * (image.naturalHeight / Math.max(1, image.naturalWidth));
  const portraitX = x + width - portraitW + 10 * scale;
  const portraitY = y + height - portraitH + 43 * scale;

  ctx.save();
  ctx.globalAlpha = category === "char" ? 0.82 : 0.9;
  ctx.filter = category === "char" ? "saturate(0.68) contrast(0.9) brightness(1.06)" : "sepia(0.08) saturate(0.78) contrast(0.94) brightness(1.05)";
  ctx.shadowColor = category === "char" ? "rgba(0, 0, 0, 0.42)" : "rgba(0, 0, 0, 0.58)";
  ctx.shadowBlur = 8 * scale;
  ctx.shadowOffsetY = 5 * scale;
  ctx.drawImage(image, portraitX, portraitY, portraitW, portraitH);
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = category === "char" ? 0.22 : 0.32;
  ctx.fillStyle = "rgba(255, 255, 244, 0.13)";
  const lineTop = Math.max(y, portraitY);
  const lineBottom = Math.min(y + height, portraitY + portraitH);
  for (let lineY = lineTop; lineY < lineBottom; lineY += 4 * scale) {
    ctx.fillRect(Math.max(x, portraitX + 4 * scale), lineY, Math.min(width, portraitW - 2 * scale), 1 * scale);
  }
  const sheen = ctx.createLinearGradient(portraitX, portraitY, portraitX + portraitW, portraitY + portraitH);
  sheen.addColorStop(0, "rgba(247, 239, 216, 0.16)");
  sheen.addColorStop(1, "rgba(97, 92, 82, 0.08)");
  ctx.fillStyle = sheen;
  ctx.fillRect(portraitX, Math.max(y, portraitY), portraitW, Math.min(height, portraitH));
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = category === "char" ? 0.12 : 0.2;
  ctx.fillStyle = "rgba(66, 54, 39, 0.26)";
  for (let index = 0; index < 14; index += 1) {
    const dotX = portraitX + (((index * 29) % 100) / 100) * portraitW;
    const dotY = Math.max(y, portraitY) + (((index * 41) % 100) / 100) * Math.min(height, portraitH);
    ctx.beginPath();
    ctx.arc(dotX, dotY, (0.7 + (index % 3) * 0.25) * scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawCanvasShellScuffs(ctx: CanvasRenderingContext2D, width: number, height: number, paint: CanvasCartridgePaint, scale: number) {
  ctx.save();
  ctx.globalAlpha = paint.category === "char" ? 0.22 : 0.18;
  for (let index = 0; index < 26; index += 1) {
    const x = (17 + ((index * 37) % 188)) * scale;
    const y = (18 + ((index * 53) % 116)) * scale;
    const length = (5 + (index % 9)) * scale;
    ctx.strokeStyle = index % 3 === 0 ? "rgba(255, 255, 255, 0.36)" : "rgba(16, 28, 48, 0.28)";
    ctx.lineWidth = Math.max(0.55, 0.7 * scale);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + length, y + ((index % 5) - 2) * 0.7 * scale);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = paint.category === "char" ? "rgba(255, 255, 255, 0.18)" : "rgba(255, 255, 255, 0.12)";
  for (const [x, y, r] of [[18, 21, 2.2], [207, 126, 1.8], [37, 139, 1.5], [189, 24, 1.6]]) {
    ctx.beginPath();
    ctx.arc(x * scale, y * scale, r * scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawCanvasPaperAge(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, paint: CanvasCartridgePaint, scale: number) {
  ctx.save();
  ctx.globalCompositeOperation = paint.category === "char" ? "multiply" : "screen";
  for (let index = 0; index < 36; index += 1) {
    const px = x + ((index * 47) % 100) / 100 * width;
    const py = y + ((index * 31) % 100) / 100 * height;
    const radius = (0.7 + (index % 5) * 0.22) * scale;
    ctx.globalAlpha = paint.category === "char" ? 0.13 : 0.08;
    ctx.fillStyle = paint.category === "char" ? "rgba(93, 72, 46, 0.42)" : "rgba(255, 236, 204, 0.32)";
    ctx.beginPath();
    ctx.ellipse(px, py, radius * 1.4, radius, (index % 7) * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = paint.category === "char" ? 0.2 : 0.18;
  ctx.strokeStyle = paint.category === "char" ? "rgba(76, 65, 51, 0.32)" : "rgba(255, 239, 214, 0.28)";
  ctx.lineWidth = Math.max(0.5, 0.6 * scale);
  for (let index = 0; index < 10; index += 1) {
    const sx = x + (8 + index * 13) * scale;
    const sy = y + (18 + ((index * 17) % 54)) * scale;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(sx + 8 * scale, sy - 2 * scale, sx + 17 * scale, sy + 3 * scale, sx + 27 * scale, sy);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCoverImage(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number, category: ModCategory) {
  const imageRatio = image.naturalWidth / Math.max(1, image.naturalHeight);
  const targetRatio = width / height;
  let drawWidth = width;
  let drawHeight = height;
  if (imageRatio > targetRatio) {
    drawWidth = height * imageRatio;
  } else {
    drawHeight = width / imageRatio;
  }
  ctx.save();
  ctx.globalAlpha = category === "char" ? 0.62 : 0.78;
  ctx.filter = category === "char" ? "grayscale(0.28) contrast(0.95) saturate(0.78) brightness(1.08)" : "contrast(1.04) saturate(0.95)";
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) * 0.24, drawWidth, drawHeight);
  ctx.restore();
}

function drawCanvasCartridgePlastic(ctx: CanvasRenderingContext2D, width: number, height: number, paint: CanvasCartridgePaint) {
  ctx.clearRect(0, 0, width, height);
  if (paint.have && !paint.hasIssue) return;

  if (paint.plastic) {
    drawGeneratedHeatsealFilm(ctx, width, height, paint.plastic, paint);
    return;
  }

  drawCanvasHeatsealStudy(ctx, width, height, paint, 0.92);
  drawHeatsealMatteNoise(ctx, width, height, paint, 1);
  return;
}

function drawGeneratedHeatsealFilm(ctx: CanvasRenderingContext2D, width: number, height: number, image: HTMLImageElement, paint: CanvasCartridgePaint) {
  ctx.save();
  ctx.globalAlpha = paint.hasIssue ? 0.9 : 0.84;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, width, height);
  ctx.restore();

  drawCanvasHeatsealStudy(ctx, width, height, paint, 0.2);
  drawHeatsealMatteNoise(ctx, width, height, paint, 1.08);
}

function drawHeatsealMatteNoise(ctx: CanvasRenderingContext2D, width: number, height: number, paint: CanvasCartridgePaint, opacity = 1) {
  const sx = width / 244;
  const sy = height / 164;

  ctx.save();
  roundedRectPath(ctx, 20 * sx, 18 * sy, width - 40 * sx, height - 40 * sy, 12 * sx);
  ctx.clip();
  ctx.globalAlpha = opacity * (paint.hasIssue ? 1.06 : 1);

  const fog = ctx.createRadialGradient(width * 0.5, height * 0.48, width * 0.035, width * 0.5, height * 0.5, width * 0.52);
  fog.addColorStop(0, "rgba(255, 255, 255, 0.14)");
  fog.addColorStop(0.34, "rgba(248, 252, 255, 0.095)");
  fog.addColorStop(0.74, "rgba(255, 255, 255, 0.052)");
  fog.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = fog;
  ctx.fillRect(0, 0, width, height);

  const verticalFog = ctx.createLinearGradient(0, 19 * sy, 0, height - 22 * sy);
  verticalFog.addColorStop(0, "rgba(255, 255, 255, 0.088)");
  verticalFog.addColorStop(0.18, "rgba(255, 255, 255, 0.052)");
  verticalFog.addColorStop(0.62, "rgba(255, 255, 255, 0.064)");
  verticalFog.addColorStop(1, "rgba(255, 255, 255, 0.026)");
  ctx.fillStyle = verticalFog;
  ctx.fillRect(20 * sx, 18 * sy, width - 40 * sx, height - 40 * sy);

  ctx.save();
  ctx.filter = `blur(${Math.max(2, 4.8 * sx)}px)`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.078)";
  ctx.beginPath();
  ctx.ellipse(width * 0.46, height * 0.47, width * 0.28, height * 0.18, -0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(240, 247, 255, 0.054)";
  ctx.beginPath();
  ctx.ellipse(width * 0.6, height * 0.59, width * 0.34, height * 0.22, 0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.046)";
  ctx.beginPath();
  ctx.ellipse(width * 0.36, height * 0.62, width * 0.22, height * 0.15, 0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.globalAlpha = opacity * 0.88;
  for (let index = 0; index < 260; index += 1) {
    const x = (24 + ((index * 47) % 196)) * sx;
    const y = (23 + ((index * 71) % 118)) * sy;
    const alpha = 0.022 + (index % 5) * 0.0058;
    const size = Math.max(0.48, (0.52 + (index % 3) * 0.16) * sx);
    ctx.fillStyle = index % 7 === 0 ? `rgba(210, 218, 226, ${alpha * 0.72})` : `rgba(255, 255, 255, ${alpha})`;
    ctx.fillRect(x, y, size, Math.max(0.45, size * 0.9));
  }

  ctx.globalAlpha = opacity * 0.62;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.115)";
  ctx.lineWidth = Math.max(0.5, 0.65 * sx);
  for (let index = 0; index < 22; index += 1) {
    const x = (31 + ((index * 53) % 174)) * sx;
    const y = (38 + ((index * 29) % 82)) * sy;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + 10 * sx, y - 1.5 * sy, x + 21 * sx, y + 1.8 * sy, x + 34 * sx, y);
    ctx.stroke();
  }

  ctx.restore();
}

function drawCanvasHeatsealStudy(ctx: CanvasRenderingContext2D, width: number, height: number, paint: CanvasCartridgePaint, opacity = 1) {
  const sx = width / 244;
  const sy = height / 164;

  ctx.save();
  ctx.globalAlpha = opacity * (paint.hasIssue ? 1.08 : 1);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.save();
  roundedRectPath(ctx, 20 * sx, 21 * sy, width - 40 * sx, height - 43 * sy, 10 * sx);
  ctx.clip();
  const membrane = ctx.createRadialGradient(width * 0.5, height * 0.48, width * 0.08, width * 0.5, height * 0.52, width * 0.46);
  membrane.addColorStop(0, "rgba(255, 255, 255, 0.055)");
  membrane.addColorStop(0.58, "rgba(238, 246, 255, 0.036)");
  membrane.addColorStop(1, "rgba(255, 255, 255, 0.012)");
  ctx.fillStyle = membrane;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  const topSeal = ctx.createLinearGradient(0, 6 * sy, 0, 26 * sy);
  topSeal.addColorStop(0, "rgba(255, 255, 255, 0.44)");
  topSeal.addColorStop(0.3, "rgba(255, 255, 255, 0.18)");
  topSeal.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = topSeal;
  roundedRectPath(ctx, 17 * sx, 7 * sy, width - 34 * sx, 22 * sy, 9 * sx);
  ctx.fill();

  const bottomSeal = ctx.createLinearGradient(0, height - 30 * sy, 0, height - 4 * sy);
  bottomSeal.addColorStop(0, "rgba(255, 255, 255, 0)");
  bottomSeal.addColorStop(0.58, "rgba(255, 255, 255, 0.16)");
  bottomSeal.addColorStop(1, "rgba(255, 255, 255, 0.34)");
  ctx.fillStyle = bottomSeal;
  roundedRectPath(ctx, 18 * sx, height - 30 * sy, width - 36 * sx, 24 * sy, 8 * sx);
  ctx.fill();

  for (const side of [1, -1]) {
    ctx.save();
    const edgeX = side === 1 ? 15 * sx : width - 15 * sx;
    ctx.translate(edgeX, 0);
    ctx.scale(side, 1);
    const sideSeal = ctx.createLinearGradient(0, 0, 23 * sx, 0);
    sideSeal.addColorStop(0, "rgba(255, 255, 255, 0.4)");
    sideSeal.addColorStop(0.28, "rgba(255, 255, 255, 0.14)");
    sideSeal.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = sideSeal;
    roundedRectPath(ctx, 0, 15 * sy, 24 * sx, height - 30 * sy, 10 * sx);
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.56)";
    ctx.lineWidth = Math.max(0.9, 1.15 * sx);
    ctx.beginPath();
    ctx.moveTo(5 * sx, 17 * sy);
    ctx.bezierCurveTo(2 * sx, 52 * sy, 3 * sx, 101 * sy, 6 * sx, height - 18 * sy);
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.shadowColor = "rgba(255, 255, 255, 0.2)";
  ctx.shadowBlur = 3 * sx;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
  ctx.lineWidth = Math.max(1.2, 1.55 * sx);
  ctx.beginPath();
  ctx.moveTo(31 * sx, 28 * sy);
  ctx.bezierCurveTo(49 * sx, 37 * sy, 58 * sx, 44 * sy, 68 * sx, 46 * sy);
  ctx.moveTo(width - 66 * sx, 52 * sy);
  ctx.bezierCurveTo(width - 43 * sx, 39 * sy, width - 32 * sx, 27 * sy, width - 24 * sx, 20 * sy);
  ctx.moveTo(width * 0.43, height * 0.45);
  ctx.bezierCurveTo(width * 0.51, height * 0.38, width * 0.63, height * 0.34, width * 0.69, height * 0.31);
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.34)";
  ctx.lineWidth = Math.max(0.8, 1 * sx);
  ctx.beginPath();
  ctx.moveTo(22 * sx, height - 18 * sy);
  ctx.bezierCurveTo(48 * sx, height - 12 * sy, 73 * sx, height - 17 * sy, 99 * sx, height - 15 * sy);
  ctx.moveTo(width - 100 * sx, height - 15 * sy);
  ctx.bezierCurveTo(width - 72 * sx, height - 17 * sy, width - 46 * sx, height - 12 * sy, width - 22 * sx, height - 18 * sy);
  ctx.stroke();

  ctx.restore();
}

function tracePlasticBagPath(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number) {
  ctx.beginPath();
  ctx.moveTo(16 * scale, 8 * scale);
  ctx.bezierCurveTo(68 * scale, 6 * scale, 144 * scale, 7 * scale, width - 16 * scale, 8 * scale);
  ctx.bezierCurveTo(width - 10 * scale, 9 * scale, width - 7 * scale, 14 * scale, width - 8 * scale, 24 * scale);
  ctx.lineTo(width - 8 * scale, height - 39 * scale);
  ctx.bezierCurveTo(width - 7 * scale, height - 28 * scale, width - 12 * scale, height - 18 * scale, width - 24 * scale, height - 10 * scale);
  ctx.bezierCurveTo(width - 77 * scale, height - 7 * scale, 76 * scale, height - 7 * scale, 24 * scale, height - 10 * scale);
  ctx.bezierCurveTo(12 * scale, height - 18 * scale, 7 * scale, height - 28 * scale, 8 * scale, height - 39 * scale);
  ctx.lineTo(8 * scale, 24 * scale);
  ctx.bezierCurveTo(7 * scale, 14 * scale, 10 * scale, 9 * scale, 16 * scale, 8 * scale);
  ctx.closePath();
}

function drawPlasticOuterSilhouette(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number) {
  ctx.save();
  ctx.filter = `blur(${1.15 * scale}px)`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.075)";
  tracePlasticBagPath(ctx, width, height, scale);
  ctx.fill();
  ctx.restore();

  ctx.save();
  const edgeShade = ctx.createLinearGradient(0, 0, 0, height);
  edgeShade.addColorStop(0, "rgba(255, 255, 255, 0.28)");
  edgeShade.addColorStop(0.08, "rgba(64, 66, 69, 0.055)");
  edgeShade.addColorStop(0.48, "rgba(255, 255, 255, 0)");
  edgeShade.addColorStop(0.83, "rgba(55, 57, 60, 0.07)");
  edgeShade.addColorStop(1, "rgba(255, 255, 255, 0.28)");
  ctx.strokeStyle = edgeShade;
  ctx.lineWidth = Math.max(1, 1.2 * scale);
  tracePlasticBagPath(ctx, width, height, scale);
  ctx.stroke();
  ctx.restore();
}

function drawPlasticNoise(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number) {
  ctx.save();
  const logicalWidth = width / scale;
  const logicalHeight = height / scale;
  for (let index = 0; index < 90; index += 1) {
    const x = ((index * 37) % logicalWidth) * scale;
    const y = ((index * 61) % logicalHeight) * scale;
    const size = Math.max(0.45, (0.36 + (index % 3) * 0.12) * scale);
    const lightAlpha = 0.011 + (index % 5) * 0.0025;
    ctx.fillStyle = index % 5 === 0 ? `rgba(48, 52, 56, ${lightAlpha * 0.75})` : `rgba(255, 255, 255, ${lightAlpha})`;
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

function drawPlasticHeatSeal(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number) {
  ctx.save();
  const topSeal = ctx.createLinearGradient(0, 5 * scale, 0, 25 * scale);
  topSeal.addColorStop(0, "rgba(255, 255, 255, 0.5)");
  topSeal.addColorStop(0.2, "rgba(255, 255, 255, 0.2)");
  topSeal.addColorStop(0.62, "rgba(255, 255, 255, 0.045)");
  topSeal.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = topSeal;
  ctx.beginPath();
  ctx.moveTo(15 * scale, 7 * scale);
  ctx.bezierCurveTo(63 * scale, 9 * scale, 102 * scale, 7 * scale, 143 * scale, 8 * scale);
  ctx.bezierCurveTo(184 * scale, 9 * scale, 210 * scale, 6 * scale, width - 15 * scale, 8 * scale);
  ctx.lineTo(width - 12 * scale, 22 * scale);
  ctx.bezierCurveTo(181 * scale, 20 * scale, 142 * scale, 21 * scale, 101 * scale, 19 * scale);
  ctx.bezierCurveTo(66 * scale, 18 * scale, 37 * scale, 19 * scale, 13 * scale, 17 * scale);
  ctx.closePath();
  ctx.fill();

  const bottomSeal = ctx.createLinearGradient(0, height - 35 * scale, 0, height);
  bottomSeal.addColorStop(0, "rgba(255, 255, 255, 0)");
  bottomSeal.addColorStop(0.34, "rgba(255, 255, 255, 0.075)");
  bottomSeal.addColorStop(0.72, "rgba(255, 255, 255, 0.28)");
  bottomSeal.addColorStop(1, "rgba(255, 255, 255, 0.44)");
  ctx.fillStyle = bottomSeal;
  ctx.beginPath();
  ctx.moveTo(17 * scale, height - 27 * scale);
  ctx.bezierCurveTo(56 * scale, height - 22 * scale, 94 * scale, height - 31 * scale, 129 * scale, height - 27 * scale);
  ctx.bezierCurveTo(166 * scale, height - 22 * scale, 202 * scale, height - 31 * scale, width - 17 * scale, height - 27 * scale);
  ctx.lineTo(width - 26 * scale, height - 8 * scale);
  ctx.bezierCurveTo(182 * scale, height - 5 * scale, 67 * scale, height - 5 * scale, 26 * scale, height - 8 * scale);
  ctx.closePath();
  ctx.fill();

  ctx.save();
  ctx.shadowColor = "rgba(255, 255, 255, 0.2)";
  ctx.shadowBlur = 4 * scale;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.74)";
  ctx.lineWidth = Math.max(1, 1.45 * scale);
  ctx.beginPath();
  ctx.moveTo(17 * scale, 8 * scale);
  ctx.bezierCurveTo(56 * scale, 10 * scale, 96 * scale, 7 * scale, 139 * scale, 8 * scale);
  ctx.bezierCurveTo(180 * scale, 9 * scale, 209 * scale, 6 * scale, width - 17 * scale, 9 * scale);
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
  ctx.lineWidth = Math.max(0.7, 0.8 * scale);
  ctx.beginPath();
  ctx.moveTo(23 * scale, 18 * scale);
  ctx.bezierCurveTo(62 * scale, 20 * scale, 102 * scale, 17 * scale, 142 * scale, 18 * scale);
  ctx.bezierCurveTo(179 * scale, 20 * scale, 205 * scale, 18 * scale, width - 23 * scale, 19 * scale);
  ctx.stroke();

  ctx.save();
  ctx.shadowColor = "rgba(255, 255, 255, 0.2)";
  ctx.shadowBlur = 4 * scale;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.68)";
  ctx.lineWidth = Math.max(1, 1.45 * scale);
  ctx.beginPath();
  ctx.moveTo(25 * scale, height - 9 * scale);
  ctx.bezierCurveTo(59 * scale, height - 6 * scale, 94 * scale, height - 11 * scale, 126 * scale, height - 9 * scale);
  ctx.bezierCurveTo(160 * scale, height - 8 * scale, 194 * scale, height - 12 * scale, width - 25 * scale, height - 9 * scale);
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = Math.max(0.7, 0.82 * scale);
  ctx.beginPath();
  ctx.moveTo(26 * scale, height - 24 * scale);
  ctx.bezierCurveTo(66 * scale, height - 20 * scale, 104 * scale, height - 28 * scale, 138 * scale, height - 24 * scale);
  ctx.bezierCurveTo(175 * scale, height - 21 * scale, 204 * scale, height - 28 * scale, width - 26 * scale, height - 24 * scale);
  ctx.stroke();
  ctx.restore();
}

function drawPlasticSideFolds(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number) {
  ctx.save();
  for (const side of [1, -1]) {
    const edgeX = side === 1 ? 8 * scale : width - 8 * scale;
    ctx.save();
    ctx.translate(edgeX, 0);
    ctx.scale(side, 1);

    const fold = ctx.createLinearGradient(-4 * scale, 0, 23 * scale, 0);
    fold.addColorStop(0, "rgba(255, 255, 255, 0.28)");
    fold.addColorStop(0.2, "rgba(255, 255, 255, 0.15)");
    fold.addColorStop(0.62, "rgba(255, 255, 255, 0.045)");
    fold.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = fold;
    ctx.beginPath();
    ctx.moveTo(2 * scale, 20 * scale);
    ctx.bezierCurveTo(-4 * scale, 45 * scale, -3 * scale, 92 * scale, 4 * scale, height - 34 * scale);
    ctx.lineTo(22 * scale, height - 25 * scale);
    ctx.bezierCurveTo(18 * scale, height - 58 * scale, 19 * scale, 86 * scale, 18 * scale, 52 * scale);
    ctx.bezierCurveTo(17 * scale, 34 * scale, 13 * scale, 23 * scale, 2 * scale, 20 * scale);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    ctx.beginPath();
    ctx.moveTo(0, 28 * scale);
    ctx.lineTo(-5 * scale, 37 * scale);
    ctx.lineTo(0, 48 * scale);
    ctx.lineTo(9 * scale, 42 * scale);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    ctx.beginPath();
    ctx.moveTo(2 * scale, height - 42 * scale);
    ctx.lineTo(-4 * scale, height - 33 * scale);
    ctx.lineTo(5 * scale, height - 22 * scale);
    ctx.lineTo(16 * scale, height - 26 * scale);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    ctx.lineWidth = Math.max(0.7, 0.82 * scale);
    ctx.beginPath();
    ctx.moveTo(3 * scale, 20 * scale);
    ctx.bezierCurveTo(-2 * scale, 54 * scale, 2 * scale, 91 * scale, 4 * scale, height - 34 * scale);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.13)";
    ctx.lineWidth = Math.max(0.6, 0.68 * scale);
    ctx.beginPath();
    ctx.moveTo(16 * scale, 25 * scale);
    ctx.bezierCurveTo(18 * scale, 58 * scale, 14 * scale, 88 * scale, 17 * scale, height - 31 * scale);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawPlasticCornerWraps(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number) {
  ctx.save();
  const corners: Array<[number, number, number, number, number, number]> = [
    [13, 9, 1, 1, -0.06, 0],
    [width / scale - 13, 9, -1, 1, 0.06, 1],
    [14, height / scale - 10, 1, -1, 0.1, 2],
    [width / scale - 14, height / scale - 10, -1, -1, -0.1, 3]
  ];
  for (const [cx, cy, sx, sy, rotation, index] of corners) {
    const x = cx * scale;
    const y = cy * scale;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sx, sy);
    ctx.rotate(rotation);
    const fold = ctx.createLinearGradient(-7 * scale, -4 * scale, 35 * scale, 32 * scale);
    fold.addColorStop(0, "rgba(255, 255, 255, 0.52)");
    fold.addColorStop(0.36, "rgba(255, 255, 255, 0.2)");
    fold.addColorStop(0.72, "rgba(255, 255, 255, 0.055)");
    fold.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = fold;
    ctx.beginPath();
    ctx.moveTo(-7 * scale, -1 * scale);
    ctx.lineTo(29 * scale, -1 * scale);
    ctx.lineTo(20 * scale, 8 * scale);
    ctx.lineTo(34 * scale, 25 * scale);
    ctx.lineTo(12 * scale, 20 * scale);
    ctx.lineTo(1 * scale, 34 * scale);
    ctx.lineTo(-7 * scale, 18 * scale);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.42)";
    ctx.lineWidth = Math.max(0.75, 0.86 * scale);
    ctx.beginPath();
    ctx.moveTo(-2 * scale, 2 * scale);
    ctx.lineTo(21 * scale, 3 * scale);
    ctx.lineTo(7 * scale, 22 * scale);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = Math.max(0.55, 0.66 * scale);
    ctx.beginPath();
    ctx.moveTo(9 * scale, 7 * scale);
    ctx.lineTo(27 * scale, 22 * scale);
    ctx.stroke();

    if (index > 1) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.24)";
      ctx.lineWidth = Math.max(0.65, 0.78 * scale);
      ctx.beginPath();
      ctx.moveTo(-6 * scale, 14 * scale);
      ctx.bezierCurveTo(7 * scale, 23 * scale, 17 * scale, 22 * scale, 29 * scale, 31 * scale);
      ctx.stroke();
    }
    if (index === 1) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.44)";
      ctx.lineWidth = Math.max(0.7, 0.84 * scale);
      ctx.beginPath();
      ctx.moveTo(11 * scale, 1 * scale);
      ctx.lineTo(30 * scale, 18 * scale);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
  ctx.beginPath();
  ctx.moveTo(29 * scale, height - 13 * scale);
  ctx.lineTo(width - 29 * scale, height - 13 * scale);
  ctx.lineTo(width - 25 * scale, height - 6 * scale);
  ctx.lineTo(25 * scale, height - 6 * scale);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
  ctx.lineWidth = Math.max(0.65, 0.78 * scale);
  ctx.beginPath();
  ctx.moveTo(29 * scale, height - 13 * scale);
  ctx.lineTo(25 * scale, height - 6 * scale);
  ctx.moveTo(width - 29 * scale, height - 13 * scale);
  ctx.lineTo(width - 25 * scale, height - 6 * scale);
  ctx.stroke();
  ctx.restore();
}

function drawPlasticSoftHighlights(ctx: CanvasRenderingContext2D, width: number, height: number, paint: CanvasCartridgePaint, scale: number) {
  ctx.save();
  ctx.globalAlpha = paint.hasIssue ? 0.52 : 0.44;

  const diagonal = ctx.createLinearGradient(width * 0.14, 0, width * 0.9, height);
  diagonal.addColorStop(0, "rgba(255, 255, 255, 0)");
  diagonal.addColorStop(0.18, "rgba(255, 255, 255, 0.052)");
  diagonal.addColorStop(0.225, "rgba(255, 255, 255, 0.01)");
  diagonal.addColorStop(0.64, "rgba(255, 255, 255, 0)");
  diagonal.addColorStop(0.82, "rgba(255, 255, 255, 0.044)");
  diagonal.addColorStop(0.85, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = diagonal;
  ctx.fillRect(0, 0, width, height);

  const topGleam = ctx.createLinearGradient(18 * scale, 0, width - 18 * scale, 0);
  topGleam.addColorStop(0, "rgba(255, 255, 255, 0)");
  topGleam.addColorStop(0.08, "rgba(255, 255, 255, 0.26)");
  topGleam.addColorStop(0.5, "rgba(255, 255, 255, 0.06)");
  topGleam.addColorStop(0.92, "rgba(255, 255, 255, 0.24)");
  topGleam.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.strokeStyle = topGleam;
  ctx.lineWidth = Math.max(0.9, 1.1 * scale);
  ctx.beginPath();
  ctx.moveTo(18 * scale, 12 * scale);
  ctx.bezierCurveTo(78 * scale, 9 * scale, 137 * scale, 15 * scale, width - 18 * scale, 11 * scale);
  ctx.stroke();

  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.44)";
  ctx.lineWidth = Math.max(1.1, 1.35 * scale);
  ctx.shadowColor = "rgba(255, 255, 255, 0.16)";
  ctx.shadowBlur = 3 * scale;
  ctx.beginPath();
  ctx.moveTo(width - 48 * scale, 18 * scale);
  ctx.lineTo(width - 13 * scale, 55 * scale);
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = Math.max(0.7, 0.78 * scale);
  ctx.beginPath();
  ctx.moveTo(14 * scale, 22 * scale);
  ctx.lineTo(14 * scale, height - 43 * scale);
  ctx.moveTo(width - 14 * scale, 24 * scale);
  ctx.lineTo(width - 14 * scale, height - 43 * scale);
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 255, 255, 0.065)";
  ctx.beginPath();
  ctx.ellipse(width * 0.5, height * 0.56, width * 0.37, height * 0.3, -0.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function colorMixHex(base: string, mix: string, amount: number) {
  const a = parseHexColor(base);
  const b = parseHexColor(mix);
  if (!a || !b) return base;
  const c = a.map((value, index) => Math.round(value + (b[index] - value) * amount));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function parseHexColor(value: string) {
  const match = value.match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;
  const int = Number.parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function canvasCartridgePalette(category: ModCategory) {
  if (category === "char") {
    return { shellLight: "#bcc2c8", shellMid: "#858e98", shellDark: "#5f6873", shellEdge: "#4c545f", labelRed: "#d8dad6", labelRedDeep: "#a8b2b4" };
  }
  if (category === "cutscene") {
    return { shellLight: "#595e6c", shellMid: "#343845", shellDark: "#20232d", shellEdge: "#151822", labelRed: "#92dce9", labelRedDeep: "#4f8e9d" };
  }
  if (category === "other") {
    return { shellLight: "#ff9a4a", shellMid: "#f36b21", shellDark: "#b8491c", shellEdge: "#7d2614", labelRed: "#ff8a2a", labelRedDeep: "#b94119" };
  }
  return { shellLight: "#7193c8", shellMid: "#4d73aa", shellDark: "#31598d", shellEdge: "#244674", labelRed: "#d3192e", labelRedDeep: "#8d0f20" };
}

function canvasCartridgeShellPath(ctx: CanvasRenderingContext2D, width: number, bodyHeight: number, plugDepth: number, radius: number) {
  const r = Math.min(radius, width / 2, bodyHeight / 2);
  const plugTopLeft = width * 0.07;
  const plugTopRight = width * 0.93;
  const plugBottomLeft = width * 0.068;
  const plugBottomRight = width * 0.932;
  const plugCorner = Math.min(2.5 * (width / 224), plugDepth * 0.35);
  const shoulderCorner = Math.min(4 * (width / 224), plugDepth * 0.48);
  const totalHeight = bodyHeight + plugDepth;

  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(width - r, 0);
  ctx.quadraticCurveTo(width, 0, width, r);
  ctx.lineTo(width, bodyHeight - shoulderCorner);
  ctx.quadraticCurveTo(width, bodyHeight, width - shoulderCorner, bodyHeight);
  ctx.lineTo(plugTopRight, bodyHeight);
  ctx.lineTo(plugBottomRight, totalHeight - plugCorner);
  ctx.quadraticCurveTo(plugBottomRight, totalHeight, plugBottomRight - plugCorner, totalHeight);
  ctx.lineTo(plugBottomLeft + plugCorner, totalHeight);
  ctx.quadraticCurveTo(plugBottomLeft, totalHeight, plugBottomLeft, totalHeight - plugCorner);
  ctx.lineTo(plugTopLeft, bodyHeight);
  ctx.lineTo(shoulderCorner, bodyHeight);
  ctx.quadraticCurveTo(0, bodyHeight, 0, bodyHeight - shoulderCorner);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function categoryPack(category: ModCategory) {
  return category === "char" ? "CHARACTER PACK" : category === "dating" ? "DATING PACK" : category === "cutscene" ? "CUTSCENE PACK" : "NPC PACK";
}

function cartridgeHeadline(folderName: string, fallback: string) {
  const cleaned = folderName
    .replace(/[_-]+/g, " ")
    .replace(/\b(?:rc|v)\s*\d+[a-z0-9.-]*\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).split(" ").slice(0, 4).join(" ");
}

function PathField(props: { label: string; value: string; onChange: (v: string) => void; onBrowse?: () => void; invalid?: boolean; helpTitle?: string; helpText?: string }) {
  return (
    <label className={`field ${props.invalid ? "invalid" : ""}`}>
      <span className="fieldLabel">
        <span>{props.label}</span>
        {props.helpTitle && props.helpText && <HelpButton title={props.helpTitle}>{props.helpText}</HelpButton>}
      </span>
      <div className="pathRow">
        <input type="text" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
        {props.onBrowse && <button type="button" onClick={props.onBrowse}>Browse</button>}
      </div>
    </label>
  );
}

function HelpButton(props: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [popupPosition, setPopupPosition] = useState({ left: 0, top: 0, placement: "below" as "below" | "above" });
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const popupRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popupRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    function updatePopupPosition() {
      const root = rootRef.current;
      const popup = popupRef.current;
      if (!root || !popup) {
        return;
      }

      const margin = 16;
      const gap = 8;
      const rootRect = root.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const desiredViewportLeft = rootRect.left + rootRect.width / 2 - popupRect.width / 2;
      const maxViewportLeft = Math.max(margin, window.innerWidth - popupRect.width - margin);
      const clampedViewportLeft = Math.min(Math.max(desiredViewportLeft, margin), maxViewportLeft);
      const hasBelowSpace = rootRect.bottom + gap + popupRect.height <= window.innerHeight - margin;
      const hasAboveSpace = rootRect.top - gap - popupRect.height >= margin;
      const placement = !hasBelowSpace && hasAboveSpace ? "above" : "below";
      const desiredViewportTop = placement === "above"
        ? rootRect.top - gap - popupRect.height
        : rootRect.bottom + gap;
      const maxViewportTop = Math.max(margin, window.innerHeight - popupRect.height - margin);
      const clampedViewportTop = Math.min(Math.max(desiredViewportTop, margin), maxViewportTop);

      setPopupPosition({
        left: clampedViewportLeft,
        top: clampedViewportTop,
        placement
      });
    }

    updatePopupPosition();
    window.addEventListener("resize", updatePopupPosition);
    window.addEventListener("scroll", updatePopupPosition, true);

    return () => {
      window.removeEventListener("resize", updatePopupPosition);
      window.removeEventListener("scroll", updatePopupPosition, true);
    };
  }, [open]);

  const popup = open
    ? createPortal(
      <span
        className={`helpPopup ${popupPosition.placement === "above" ? "above" : "below"}`}
        ref={popupRef}
        role="dialog"
        aria-label={props.title}
        style={{ left: `${popupPosition.left}px`, top: `${popupPosition.top}px` }}
      >
        <span className="helpPopupTitle">{props.title}</span>
        <div className="helpPopupText">{props.children}</div>
        <button
          aria-label="Close help"
          className="helpCloseButton"
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }}
        >
          Close
        </button>
      </span>,
      document.body
    )
    : null;

  return (
    <span className="helpRoot" ref={rootRef}>
      <button
        type="button"
        className="helpButton"
        aria-expanded={open}
        aria-label={`About ${props.title}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        ?
      </button>
      {popup}
    </span>
  );
}

type HtmlAltTooltipState = {
  left: number;
  placement: "above" | "below";
  ready: boolean;
  text: string;
  top: number;
};

const HTML_ALT_TOOLTIP_SELECTOR = "[data-tooltip], [title], img[alt]";
const SLOW_HTML_ALT_TOOLTIP_DELAY_MS = 1500;

function useHtmlAltTooltip() {
  const [tooltip, setTooltip] = useState<HtmlAltTooltipState | null>(null);
  const activeTargetRef = useRef<HTMLElement | null>(null);
  const mutedTitleRef = useRef<WeakMap<HTMLElement, string>>(new WeakMap());
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const delayTimerRef = useRef<number | null>(null);

  const restoreNativeTitle = useCallback(() => {
    const target = activeTargetRef.current;
    if (!target) return;

    const title = mutedTitleRef.current.get(target);
    if (title !== undefined) {
      if (!target.hasAttribute("title")) target.setAttribute("title", title);
      mutedTitleRef.current.delete(target);
    }
    activeTargetRef.current = null;
  }, []);

  const closeTooltip = useCallback(() => {
    if (delayTimerRef.current !== null) {
      window.clearTimeout(delayTimerRef.current);
      delayTimerRef.current = null;
    }
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    restoreNativeTitle();
    setTooltip(null);
  }, [restoreNativeTitle]);

  const updateTooltipPosition = useCallback(() => {
    frameRef.current = null;
    const target = activeTargetRef.current;
    const popup = tooltipRef.current;
    if (!target || !popup) return;

    const margin = 14;
    const gap = 8;
    const targetRect = target.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - popupRect.width - margin);
    const desiredLeft = targetRect.left + targetRect.width / 2 - popupRect.width / 2;
    const left = Math.round(Math.min(Math.max(desiredLeft, margin), maxLeft));
    const hasBelowSpace = targetRect.bottom + gap + popupRect.height <= window.innerHeight - margin;
    const hasAboveSpace = targetRect.top - gap - popupRect.height >= margin;
    const placement = !hasBelowSpace && hasAboveSpace ? "above" : "below";
    const desiredTop = placement === "above"
      ? targetRect.top - gap - popupRect.height
      : targetRect.bottom + gap;
    const maxTop = Math.max(margin, window.innerHeight - popupRect.height - margin);
    const top = Math.round(Math.min(Math.max(desiredTop, margin), maxTop));

    setTooltip((current) => {
      if (!current) return current;
      if (current.left === left && current.top === top && current.placement === placement && current.ready) return current;
      return { ...current, left, top, placement, ready: true };
    });
  }, []);

  const scheduleTooltipPosition = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(updateTooltipPosition);
  }, [updateTooltipPosition]);

  const openTooltip = useCallback((target: HTMLElement, delayMs = getHtmlAltTooltipDelayMs(target)) => {
    const text = getHtmlAltTooltipText(target);
    if (!text) {
      closeTooltip();
      return;
    }

    if (delayTimerRef.current !== null) {
      window.clearTimeout(delayTimerRef.current);
      delayTimerRef.current = null;
    }
    if (activeTargetRef.current && activeTargetRef.current !== target) {
      restoreNativeTitle();
    }
    activeTargetRef.current = target;
    muteNativeTitle(target, mutedTitleRef.current);

    if (delayMs > 0) {
      setTooltip(null);
      delayTimerRef.current = window.setTimeout(() => {
        delayTimerRef.current = null;
        if (activeTargetRef.current === target) {
          setTooltip({ left: 0, top: 0, placement: "below", ready: false, text });
        }
      }, delayMs);
      return;
    }

    setTooltip({ left: 0, top: 0, placement: "below", ready: false, text });
  }, [closeTooltip, restoreNativeTitle]);

  useEffect(() => {
    function handlePointerOver(event: PointerEvent) {
      const target = findHtmlAltTooltipTarget(event.target);
      if (!target || target === activeTargetRef.current) return;
      openTooltip(target);
    }

    function handlePointerOut(event: PointerEvent) {
      const target = activeTargetRef.current;
      if (!target) return;
      const related = event.relatedTarget;
      if (related instanceof Node && target.contains(related)) return;
      closeTooltip();
    }

    function handleFocusIn(event: FocusEvent) {
      const target = findHtmlAltTooltipTarget(event.target);
      if (target) openTooltip(target, 0);
    }

    function handleFocusOut(event: FocusEvent) {
      const target = activeTargetRef.current;
      const related = event.relatedTarget;
      if (!target) return;
      if (related instanceof Node && target.contains(related)) return;
      closeTooltip();
    }

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);

    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
      closeTooltip();
    };
  }, [closeTooltip, openTooltip]);

  useLayoutEffect(() => {
    if (!tooltip) return;
    scheduleTooltipPosition();
  }, [scheduleTooltipPosition, tooltip?.text]);

  useEffect(() => {
    if (!tooltip) return;
    window.addEventListener("resize", scheduleTooltipPosition);
    window.addEventListener("scroll", scheduleTooltipPosition, true);
    return () => {
      window.removeEventListener("resize", scheduleTooltipPosition);
      window.removeEventListener("scroll", scheduleTooltipPosition, true);
    };
  }, [scheduleTooltipPosition, tooltip]);

  if (!tooltip) return null;

  return createPortal(
    <div
      className={`htmlAltTooltip ${tooltip.ready ? "is-ready" : ""} is-${tooltip.placement}`}
      ref={tooltipRef}
      role="tooltip"
      style={{ left: `${tooltip.left}px`, top: `${tooltip.top}px` }}
    >
      {tooltip.text.split(/\r?\n/).map((line, index) => (
        <span className="htmlAltTooltipLine" key={`${index}-${line}`}>{line}</span>
      ))}
    </div>,
    document.body
  );
}

function findHtmlAltTooltipTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  let tooltipTarget = target.closest(HTML_ALT_TOOLTIP_SELECTOR);
  while (tooltipTarget instanceof HTMLElement) {
    if (getHtmlAltTooltipText(tooltipTarget)) return tooltipTarget;
    tooltipTarget = tooltipTarget.parentElement?.closest(HTML_ALT_TOOLTIP_SELECTOR) ?? null;
  }
  return null;
}

function getHtmlAltTooltipText(target: HTMLElement) {
  const customTooltip = target.getAttribute("data-tooltip")?.trim();
  if (customTooltip) return customTooltip;

  const nativeTitle = target.getAttribute("title")?.trim();
  if (nativeTitle) return nativeTitle;

  if (target instanceof HTMLImageElement) {
    const alt = target.getAttribute("alt")?.trim();
    if (alt) return alt;
  }

  return "";
}

function getHtmlAltTooltipDelayMs(target: HTMLElement) {
  const configuredDelay = target.getAttribute("data-tooltip-delay");
  if (configuredDelay && /^\d+$/.test(configuredDelay)) return Number(configuredDelay);
  return target.closest(".view-library, .view-roster") ? SLOW_HTML_ALT_TOOLTIP_DELAY_MS : 0;
}

function muteNativeTitle(target: HTMLElement, mutedTitles: WeakMap<HTMLElement, string>) {
  const title = target.getAttribute("title");
  if (!title?.trim()) return;
  if (!mutedTitles.has(target)) mutedTitles.set(target, title);
  target.removeAttribute("title");
}
