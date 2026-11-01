// Type declarations for fuli-avatar (dist/avatar.js and the FuliAvatar browser global).

export type RenderVersion = 3 | 4 | 5 | '3' | '4' | '5';

/** Integer trait indexes. Render version 5 (default) uses every field; v4 has no outfit colours, mask or hat pose. */
export interface Traits {
  palette: number;
  skin: number;
  hairColor: number;
  hair: number;
  eyes: number;
  brows: number;
  mouth: number;
  outfit: number;
  /** v5: main garment colour, index into outfitColors. */
  outfitColor?: number;
  /** v5: garment accent colour (collar, trim, lining, pocket), index into outfitColors. */
  outfitAccent?: number;
  /** 0-6 everyday accessories; v5 adds 7-10 sunglasses and 11-16 masks. */
  accessory: number;
  /** v5: 0 straight, 1 tilted left, 2 tilted right; only changes a beanie. */
  hatPose?: number;
}

export interface AvatarConfig {
  /** Pixel width and height, integer 16-4096. Default 256. */
  size?: number;
  /** Omit the background fill. */
  transparent?: boolean;
  /** Rounded background (default true); false for square. */
  rounded?: boolean;
  /** Override individual traits; invalid values are ignored. */
  traits?: Partial<Traits>;
  /** Render version. Default 5; 4 and 3 redraw stored identities byte-identically. */
  version?: RenderVersion;
  /** v4/v5: draw the seed's easter egg, if it has one (about one seed in eight). */
  eggs?: boolean;
  /** v4/v5: force a specific egg by id (previews, tests). */
  egg?: string;
  /**
   * v4/v5: false keeps any egg decoration but removes every animation, leaving its still pose
   * (the one prefers-reduced-motion shows). Use it when a host's own reduced-motion setting cannot
   * reach inside an <img>. Default true.
   */
  animate?: boolean;
}

export interface Palette { name: string; bg: string; shirt: string; accent: string; }
export interface HairColor { name: string; base: string; }
export interface OutfitColor { name: string; hex: string; }
export interface Mask { name: string; en: string; }
export interface Egg {
  id: string;
  name: string;
  en: string;
  /** Seconds after which every part of the egg's animation repeats. */
  loop: number;
}
export interface NameDetails { name: string; locale: 'es' | 'zh' | 'en'; given: string; family: string; }
export interface NameConfig { locales?: Array<'es' | 'zh' | 'en'>; }

export declare const VERSION: '5';
export declare const VERSIONS: readonly ['3', '4', '5'];
export declare const palettes: readonly Palette[];
export declare const hairColors: readonly HairColor[];
export declare const outfitColors: readonly OutfitColor[];
/** Curated [main, accent] outfit colour pairs that random characters draw from. */
export declare const outfitCombos: readonly (readonly [number, number])[];
export declare const masks: readonly Mask[];
/** Share of seeds whose accessory is a mask (all masks together). */
export declare const maskRate: number;
export declare const options: Readonly<Record<keyof Traits, number>>;
export declare const combinationCount: number;
export declare const partNames: Readonly<Record<'hairColor' | 'hair' | 'eyes' | 'brows' | 'mouth' | 'outfit' | 'outfitColor' | 'outfitAccent' | 'accessory' | 'hatPose', readonly string[]>>;
export declare const eggs: readonly Egg[];
export declare const eggRate: number;
export declare const nameLocales: readonly ['es', 'zh', 'en'];

export declare function createAvatar(seed?: string | number, config?: AvatarConfig | null): string;
export declare function getTraits(seed?: string | number, overrides?: Partial<Traits>, config?: { version?: RenderVersion }): Traits;
export declare function getEgg(seed?: string | number, overrides?: Partial<Traits>, config?: { version?: RenderVersion }): Egg | null;
/** A still frame `seconds` into an egg's animation; SVGs without an egg come back unchanged. */
export declare function freezeFrame(svg: string, seconds: number): string;
export declare function nameFor(seed?: string | number, config?: NameConfig | null): string;
export declare function nameDetails(seed?: string | number, config?: NameConfig | null): NameDetails;

interface VersionApi {
  VERSION: string;
  palettes: readonly unknown[];
  options: Readonly<Record<string, number>>;
  combinationCount: number;
  getTraits(seed?: string | number, overrides?: Partial<Traits>): Traits;
  createAvatar(seed?: string | number, config?: AvatarConfig | null): string;
}
export declare const v3: Readonly<VersionApi>;
export declare const v4: Readonly<VersionApi & { partNames: Readonly<Record<string, readonly string[]>> }>;
