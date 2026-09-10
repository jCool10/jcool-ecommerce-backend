// Narrower than `MediaFacade` on purpose — the read path has no business attaching or detaching.
export const MEDIA_QUERY = Symbol('CATALOG_MEDIA_QUERY');

export interface MediaQueryPort {
  /**
   * Keyed by asset id; an id with no live asset is absent. Called after the cache read, never
   * before: a resolved URL can expire, and a cached one would outlive its signature.
   */
  resolveUrls(assetIds: string[]): Promise<Map<string, string>>;
}
